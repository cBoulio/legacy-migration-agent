import { evidenceFrom, mergeFindings } from "./evidence.js";
import { grepLines, isCode, type RepoFile } from "./files.js";
import type { Finding } from "./types.js";

const SECRET_LITERAL =
  /['"]?([\w.-]*(?:pass(?:word|wd)?|secret|api[_-]?key|apikey|token|private[_-]?key)[\w.-]*)['"]?\s*(?:,|=>|=|:)\s*['"]([^'"]{3,})['"]/i;
const ABSOLUTE_PATH = /['"](\/(?:var|srv|opt|home|usr|etc|mnt|data)\/[^'"]+|[A-Za-z]:\\\\[^'"]+)['"]/;
const ENV_READ = /\bgetenv\s*\(|\$_ENV\[|\bprocess\.env\b|\bos\.environ\b|\bSystem\.getenv\s*\(/;

function isPlaceholder(value: string): boolean {
  return /^\$|^\{\{|^%\(|^<|^\*+$|getenv|process\.env/.test(value);
}

/**
 * The literal secret values in the repo. Never shown to the model or written anywhere; the
 * CLI uses them to scrub model output, so a value the model copied from a file it read is
 * removed before the plan or report reaches disk.
 */
export function collectSecretValues(files: RepoFile[]): string[] {
  const values = new Set<string>();
  for (const m of grepLines(files.filter(isCode), SECRET_LITERAL)) {
    const value = m.match[2] ?? "";
    if (value.length >= 4 && !isPlaceholder(value)) values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/** Replace every occurrence of the given secret values with a marker. */
export function scrubSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("[redacted]");
  return out;
}

/**
 * Find credentials and environment-specific values written into source. Values are never
 * returned: evidence snippets pass through redact(), so only the key name is visible.
 */
export function findHardcodedConfig(files: RepoFile[]): Finding[] {
  const code = files.filter(isCode);
  const out: Finding[] = [];

  for (const m of grepLines(code, SECRET_LITERAL)) {
    if (isPlaceholder(m.match[2] ?? "")) continue;
    out.push({
      category: "hardcoded-secret",
      name: m.match[1] ?? "",
      detail: "Credential stored as a literal in source (value redacted). Rotate it during migration.",
      evidence: [evidenceFrom(m)],
    });
  }
  for (const m of grepLines(code, ABSOLUTE_PATH)) {
    out.push({
      category: "absolute-path",
      name: m.match[1] ?? "",
      detail: "Host-specific filesystem path",
      evidence: [evidenceFrom(m)],
    });
  }
  const envReads = grepLines(code, ENV_READ);
  if (envReads.length > 0) {
    out.push({
      category: "env-config",
      name: "reads environment variables",
      detail: `${envReads.length} line(s) read configuration from the environment`,
      evidence: envReads.slice(0, 8).map(evidenceFrom),
    });
  }
  return mergeFindings(out);
}
