import { basename, grepLines, type RepoFile, snippet } from "./files.js";
import type { Dependency, DependencyInventory, DependencyScope, Evidence } from "./types.js";

function lineOf(file: RepoFile, needle: string): number | undefined {
  const i = file.lines.findIndex((l) => l.includes(needle));
  return i === -1 ? undefined : i + 1;
}

function ev(file: RepoFile, needle: string): Evidence {
  const line = lineOf(file, needle);
  return line
    ? { path: file.path, line, snippet: snippet(file.lines[line - 1] ?? "") }
    : { path: file.path };
}

function parseJson(file: RepoFile): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(file.text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function stringMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

function fromNpm(file: RepoFile): Dependency[] {
  const pkg = parseJson(file);
  if (!pkg) return [];
  const deps: Dependency[] = [];
  const add = (map: unknown, scope: DependencyScope): void => {
    for (const [name, version] of Object.entries(stringMap(map))) {
      deps.push({ ecosystem: "npm", name, version, scope, evidence: [ev(file, `"${name}"`)] });
    }
  };
  add(pkg["dependencies"], "runtime");
  add(pkg["devDependencies"], "dev");
  const engines = stringMap(pkg["engines"]);
  for (const [name, version] of Object.entries(engines)) {
    deps.push({ ecosystem: "npm", name, version, scope: "platform", evidence: [ev(file, `"${name}"`)] });
  }
  return deps;
}

function fromComposer(file: RepoFile): Dependency[] {
  const pkg = parseJson(file);
  if (!pkg) return [];
  const deps: Dependency[] = [];
  const add = (map: unknown, scope: DependencyScope): void => {
    for (const [name, version] of Object.entries(stringMap(map))) {
      const platform = name === "php" || name.startsWith("ext-") || name.startsWith("lib-");
      deps.push({
        ecosystem: "composer",
        name,
        version,
        scope: platform ? "platform" : scope,
        evidence: [ev(file, `"${name}"`)],
      });
    }
  };
  add(pkg["require"], "runtime");
  add(pkg["require-dev"], "dev");
  return deps;
}

function fromRequirements(file: RepoFile): Dependency[] {
  const deps: Dependency[] = [];
  file.lines.forEach((raw, i) => {
    const line = raw.replace(/#.*/, "").trim();
    if (!line || line.startsWith("-")) return;
    const m = /^([A-Za-z0-9_.\-[\]]+)\s*((?:==|>=|<=|~=|!=|>|<).*)?$/.exec(line);
    if (!m || !m[1]) return;
    deps.push({
      ecosystem: "pypi",
      name: m[1],
      version: m[2]?.trim() ?? "unpinned",
      scope: /dev|test/i.test(file.path) ? "dev" : "runtime",
      evidence: [{ path: file.path, line: i + 1, snippet: snippet(raw) }],
    });
  });
  return deps;
}

function fromPom(file: RepoFile): Dependency[] {
  const deps: Dependency[] = [];
  const re =
    /<dependency>\s*<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>(?:\s*<version>([^<]+)<\/version>)?(?:\s*<scope>([^<]+)<\/scope>)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(file.text)) !== null) {
    const artifact = m[2] ?? "";
    deps.push({
      ecosystem: "maven",
      name: `${m[1] ?? ""}:${artifact}`,
      version: m[3] ?? "managed",
      scope: m[4] === "test" ? "dev" : "runtime",
      evidence: [ev(file, `<artifactId>${artifact}</artifactId>`)],
    });
  }
  const java = /<(?:java\.version|maven\.compiler\.source|release)>([^<]+)</.exec(file.text);
  if (java?.[1]) {
    deps.push({ ecosystem: "maven", name: "java", version: java[1], scope: "platform", evidence: [ev(file, java[0])] });
  }
  return deps;
}

const FRONTEND_LIBS =
  /<script[^>]+src=["'][^"']*?\b(jquery(?:-ui)?|bootstrap|angular|backbone|underscore|prototype|mootools|moment|knockout|dojo)[-.]?(\d+(?:\.\d+){0,2})?[^"']*["']/i;

function fromScriptTags(files: RepoFile[]): Dependency[] {
  return grepLines(
    files.filter((f) => /\.(html?|php|jsp|aspx?|erb|hbs|ejs|twig|tpl|cshtml)$/i.test(f.path)),
    FRONTEND_LIBS,
  ).map((m) => ({
    ecosystem: "script-tag",
    name: (m.match[1] ?? "").toLowerCase(),
    version: m.match[2] ?? "unknown",
    scope: "frontend-asset" as const,
    evidence: [{ path: m.file.path, line: m.line, snippet: snippet(m.text) }],
  }));
}

const MANIFESTS: Record<string, { parse: (f: RepoFile) => Dependency[]; locks: string[] }> = {
  "package.json": {
    parse: fromNpm,
    locks: ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json"],
  },
  "composer.json": { parse: fromComposer, locks: ["composer.lock"] },
  "pom.xml": { parse: fromPom, locks: [] },
  "requirements.txt": { parse: fromRequirements, locks: [] },
  "requirements-dev.txt": { parse: fromRequirements, locks: [] },
};

const OTHER_LOCKFILES = new Set(["Pipfile.lock", "poetry.lock", "Gemfile.lock", "go.sum"]);

/** Parse every dependency manifest in the repo and note which lockfiles are present or missing. */
export function dependencyInventory(files: RepoFile[]): DependencyInventory {
  const manifests: string[] = [];
  const lockfiles: string[] = [];
  const missingLockfiles: string[] = [];
  const dependencies: Dependency[] = [];
  const present = new Set(files.map((f) => f.path));

  for (const file of files) {
    const name = basename(file.path);
    const spec = MANIFESTS[name];
    if (spec) {
      manifests.push(file.path);
      dependencies.push(...spec.parse(file));
      const dir = file.path.slice(0, file.path.length - name.length);
      if (spec.locks.length > 0) {
        const found = spec.locks.map((l) => dir + l).filter((l) => present.has(l));
        if (found.length > 0) lockfiles.push(...found);
        else missingLockfiles.push(`${file.path} (expected one of: ${spec.locks.join(", ")})`);
      }
    } else if (OTHER_LOCKFILES.has(name)) {
      lockfiles.push(file.path);
    }
  }
  dependencies.push(...fromScriptTags(files));
  return { manifests, lockfiles, missingLockfiles, dependencies };
}
