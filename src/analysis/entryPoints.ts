import { evidenceFrom, mergeFindings } from "./evidence.js";
import { basename, ext, grepLines, isCode, type RepoFile, snippet } from "./files.js";
import type { Finding } from "./types.js";

const WEB_ROOTS = ["public/", "www/", "htdocs/", "web/", "html/", "public_html/", "webroot/"];

function webRootOf(p: string): string | undefined {
  return WEB_ROOTS.find((r) => p.startsWith(r) || p.includes(`/${r}`));
}

function firstCodeLine(file: RepoFile): number {
  const i = file.lines.findIndex((l) => l.trim() !== "" && !/^<\?php\s*$/.test(l.trim()));
  return i === -1 ? 1 : i + 1;
}

/** Server-rendered pages that the web server maps straight to a URL (PHP, ASP, JSP, CFM). */
function scriptPages(files: RepoFile[]): Finding[] {
  const out: Finding[] = [];
  for (const f of files) {
    if (!/^(php|asp|aspx|jsp|cfm)$/.test(ext(f.path))) continue;
    const root = webRootOf(f.path);
    const atRepoRoot = !f.path.includes("/");
    if (!root && !atRepoRoot) continue;
    const url = root ? `/${f.path.slice(f.path.indexOf(root) + root.length)}` : `/${f.path}`;
    const isApi = /(^|\/)api\//.test(url) || /json_encode|Content-Type:\s*application\/json/i.test(f.text);
    const line = firstCodeLine(f);
    out.push({
      category: isApi ? "http-endpoint" : "web-page",
      name: url,
      detail: `Served directly by the web server from ${f.path}`,
      evidence: [{ path: f.path, line, snippet: snippet(f.lines[line - 1] ?? "") }],
    });
  }
  return out;
}

const ROUTE_PATTERNS: Array<{ re: RegExp; name: (m: RegExpExecArray) => string }> = [
  {
    re: /\b(?:app|router|server)\.(get|post|put|delete|patch|all)\(\s*['"`]([^'"`]+)/,
    name: (m) => `${(m[1] ?? "").toUpperCase()} ${m[2] ?? ""}`,
  },
  { re: /@\w+\.route\(\s*['"]([^'"]+)['"](?:.*methods\s*=\s*\[([^\]]+)\])?/, name: (m) => `${m[2] ? m[2].replace(/['"\s]/g, "") + " " : ""}${m[1] ?? ""}` },
  {
    re: /@(Get|Post|Put|Delete|Patch|Request)Mapping\(\s*(?:value\s*=\s*|path\s*=\s*)?["']([^"']+)/,
    name: (m) => `${m[1] === "Request" ? "ANY" : (m[1] ?? "").toUpperCase()} ${m[2] ?? ""}`,
  },
];

const PROCESS_STARTS: Array<{ re: RegExp; category: string; name: string }> = [
  { re: /\.listen\(\s*[\w.]*\s*(?:\|\|\s*)?\d*/, category: "server-start", name: "HTTP server listen()" },
  { re: /if\s+__name__\s*==\s*['"]__main__['"]/, category: "cli-script", name: "python __main__" },
  { re: /public\s+static\s+void\s+main\s*\(/, category: "cli-script", name: "java main()" },
  { re: /php_sapi_name\(\)\s*!==?\s*['"]cli['"]|PHP_SAPI\s*!==?\s*['"]cli['"]/, category: "cli-script", name: "php CLI script" },
  { re: /^#!\s*\/usr\/bin\/(?:env\s+)?\w+/, category: "cli-script", name: "shebang script" },
];

/** Find the ways a request or process enters the app. */
export function findEntryPoints(files: RepoFile[]): Finding[] {
  const out: Finding[] = [...scriptPages(files)];
  const code = files.filter(isCode);

  for (const { re, name } of ROUTE_PATTERNS) {
    for (const m of grepLines(code, re)) {
      out.push({ category: "http-route", name: name(m.match), evidence: [evidenceFrom(m)] });
    }
  }
  for (const p of PROCESS_STARTS) {
    for (const m of grepLines(code, p.re)) {
      out.push({ category: p.category, name: `${p.name}: ${m.file.path}`, evidence: [evidenceFrom(m)] });
    }
  }

  const htaccess = files.filter((f) => basename(f.path) === ".htaccess");
  for (const m of grepLines(htaccess, /^\s*RewriteRule\s+(\S+)\s+(\S+)/)) {
    out.push({
      category: "rewrite-rule",
      name: `${m.match[1] ?? ""} -> ${m.match[2] ?? ""}`,
      detail: `Apache rewrite in ${m.file.path}; external clients may depend on the rewritten URL`,
      evidence: [evidenceFrom(m)],
    });
  }

  for (const f of files.filter((x) => basename(x.path) === "package.json")) {
    try {
      const pkg = JSON.parse(f.text) as { main?: unknown; bin?: unknown; scripts?: Record<string, unknown> };
      const lineOf = (needle: string): number => Math.max(1, f.lines.findIndex((l) => l.includes(needle)) + 1);
      if (typeof pkg.main === "string") {
        out.push({ category: "package-entry", name: `main: ${pkg.main}`, evidence: [{ path: f.path, line: lineOf('"main"') }] });
      }
      for (const key of ["start", "serve", "worker"]) {
        const cmd = pkg.scripts?.[key];
        if (typeof cmd === "string") {
          out.push({ category: "package-entry", name: `npm run ${key}: ${cmd}`, evidence: [{ path: f.path, line: lineOf(`"${key}"`) }] });
        }
      }
    } catch {
      // Malformed package.json: the dependency inventory reports it as having no dependencies.
    }
  }

  const containerFiles = files.filter((f) => /^(Dockerfile(\..+)?|Procfile)$/.test(basename(f.path)));
  for (const m of grepLines(containerFiles, /^\s*(CMD|ENTRYPOINT|web:|worker:)\s*(.+)$/)) {
    out.push({ category: "process-definition", name: `${m.match[1] ?? ""} ${m.match[2] ?? ""}`.trim(), evidence: [evidenceFrom(m)] });
  }

  return mergeFindings(out);
}
