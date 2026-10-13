import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** A text file in the target repo, with its path relative to the repo root (forward slashes). */
export interface RepoFile {
  path: string;
  text: string;
  lines: string[];
}

export interface RepoSnapshot {
  root: string;
  files: RepoFile[];
  /** Files that were skipped (too large, binary, minified), relative paths. */
  skipped: string[];
}

/** Directories that hold third-party or generated code. Their contents are not the app. */
export const IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "vendor",
  "bower_components",
  "dist",
  "build",
  "target",
  "out",
  ".venv",
  "venv",
  "__pycache__",
  ".idea",
  ".vscode",
]);

/**
 * Files that usually hold live credentials or keys. They are never loaded by the detectors
 * and the agent's guard refuses to Read them, so their contents cannot reach a report.
 */
const SENSITIVE_NAME =
  /^(\.env(\..*)?|.*\.(pem|key|p12|pfx|jks|keystore)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.pypirc|\.netrc|credentials(\.json)?)$/i;

export function isSensitivePath(p: string): boolean {
  const name = p.split(/[\\/]/).pop() ?? p;
  if (name === ".env.example" || name === ".env.sample" || name === ".env.dist") return false;
  return SENSITIVE_NAME.test(name);
}

const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 5000;

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function isProbablyBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Read every text file under `root` into memory once, so all detectors share one walk.
 * Symlinks are not followed: a link could point outside the target repo.
 */
export function loadRepo(root: string): RepoSnapshot {
  const absRoot = path.resolve(root);
  const files: RepoFile[] = [];
  const skipped: string[] = [];

  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      const abs = path.join(dir, entry.name);
      const rel = toPosix(path.relative(absRoot, abs));
      if (entry.isSymbolicLink()) {
        skipped.push(rel);
        continue;
      }
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isSensitivePath(entry.name) || /\.min\.(js|css)$/i.test(entry.name)) {
        skipped.push(rel);
        continue;
      }
      if (statSync(abs).size > MAX_FILE_BYTES) {
        skipped.push(rel);
        continue;
      }
      const buf = readFileSync(abs);
      if (isProbablyBinary(buf)) {
        skipped.push(rel);
        continue;
      }
      const text = buf.toString("utf8");
      files.push({ path: rel, text, lines: text.split(/\r?\n/) });
    }
  };

  walk(absRoot);
  return { root: absRoot, files, skipped };
}

export interface LineMatch {
  file: RepoFile;
  line: number;
  text: string;
  match: RegExpExecArray;
}

/** Run a regex over every line of the given files. `line` is 1-based. */
export function grepLines(files: RepoFile[], re: RegExp): LineMatch[] {
  const out: LineMatch[] = [];
  const flags = re.flags.replace("g", "");
  for (const file of files) {
    file.lines.forEach((text, i) => {
      const m = new RegExp(re.source, flags).exec(text);
      if (m) out.push({ file, line: i + 1, text, match: m });
    });
  }
  return out;
}

export function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

export function ext(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i <= 0 ? "" : b.slice(i + 1).toLowerCase();
}

export const CODE_EXTS = new Set([
  "php",
  "js",
  "mjs",
  "cjs",
  "ts",
  "jsx",
  "tsx",
  "py",
  "rb",
  "java",
  "kt",
  "cs",
  "go",
  "pl",
  "vb",
  "cfm",
  "asp",
  "aspx",
  "jsp",
]);

export function isCode(f: RepoFile): boolean {
  return CODE_EXTS.has(ext(f.path));
}

/** Trim a source line for display in evidence. */
export function snippet(text: string, max = 160): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}
