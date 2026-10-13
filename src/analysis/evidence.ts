import type { LineMatch } from "./files.js";
import { snippet } from "./files.js";
import type { Evidence, Finding } from "./types.js";

const SECRET_KEY =
  /((?:['"]?)[\w.-]*(?:pass(?:word|wd)?|secret|api[_-]?key|apikey|token|credential)[\w.-]*(?:['"]?)\s*(?:=>|=|:|,)\s*)(['"])([^'"]*)\2/gi;
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@'"]+:)([^@\s'"]+)(@)/gi;

/**
 * Mask values that look like credentials so evidence snippets (and anything the model
 * copies from them) never carry a live secret into a report.
 */
export function redact(text: string): string {
  return text
    .replace(SECRET_KEY, (_m, prefix: string, q: string, value: string) =>
      value.length === 0 ? `${prefix}${q}${q}` : `${prefix}${q}***${q}`,
    )
    .replace(URL_CREDENTIALS, "$1***$3");
}

export function evidenceFrom(m: LineMatch): Evidence {
  return { path: m.file.path, line: m.line, snippet: redact(snippet(m.text)) };
}

const MAX_EVIDENCE = 8;

/** Merge findings that share category and name, keeping a bounded, de-duplicated evidence list. */
export function mergeFindings(findings: Finding[]): Finding[] {
  const byKey = new Map<string, Finding>();
  for (const f of findings) {
    const key = `${f.category}\u0000${f.name}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...f, evidence: [...f.evidence] });
      continue;
    }
    for (const e of f.evidence) {
      const dup = existing.evidence.some((x) => x.path === e.path && x.line === e.line);
      if (!dup && existing.evidence.length < MAX_EVIDENCE) existing.evidence.push(e);
    }
    if (!existing.detail && f.detail) existing.detail = f.detail;
  }
  return [...byKey.values()].sort(
    (a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
  );
}
