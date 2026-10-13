import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { EvidenceRef, MigrationPlan } from "./schema.js";

export interface CitationProblem {
  where: string;
  path: string;
  line?: number;
  problem: "missing-file" | "outside-repo" | "line-out-of-range";
}

export interface CitationReport {
  total: number;
  verified: number;
  problems: CitationProblem[];
}

function collect(plan: MigrationPlan): Array<{ where: string; ref: EvidenceRef }> {
  const out: Array<{ where: string; ref: EvidenceRef }> = [];
  const add = (where: string, refs: EvidenceRef[]): void => {
    for (const ref of refs) out.push({ where, ref });
  };
  plan.inventory.components.forEach((c) => add(`component "${c.name}"`, c.evidence));
  plan.inventory.dependencies.forEach((d) => add(`dependency "${d.name}"`, d.evidence));
  plan.integrations.forEach((i) => add(`integration "${i.name}"`, i.evidence));
  plan.dataMigration.forEach((s) => add(`data step ${s.order}`, s.evidence));
  plan.phases.forEach((p) => add(`phase ${p.id}`, p.evidence));
  plan.decommissionChecklist.forEach((c, i) => add(`checklist item ${i + 1}`, c.evidence));
  plan.risks.forEach((r) => add(`risk "${r.title}"`, r.evidence));
  plan.openQuestions.forEach((q, i) => add(`open question ${i + 1}`, q.evidence));
  return out;
}

/**
 * Check every citation against the repo on disk: the file must exist inside the repo and
 * any line number must be in range. The model is told its citations are checked; this is
 * where that promise is kept.
 */
export function verifyCitations(plan: MigrationPlan, repoRoot: string): CitationReport {
  const root = path.resolve(repoRoot);
  const lineCounts = new Map<string, number>();
  const problems: CitationProblem[] = [];
  const refs = collect(plan);

  for (const { where, ref } of refs) {
    const cleaned = ref.path.replace(/^\.\//, "");
    const abs = path.resolve(root, cleaned);
    const rel = path.relative(root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      problems.push({ where, path: ref.path, line: ref.line, problem: "outside-repo" });
      continue;
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      // Directories are acceptable citations for components (e.g. "cron/").
      if (existsSync(abs) && statSync(abs).isDirectory() && ref.line === undefined) continue;
      problems.push({ where, path: ref.path, line: ref.line, problem: "missing-file" });
      continue;
    }
    if (ref.line !== undefined) {
      let count = lineCounts.get(abs);
      if (count === undefined) {
        count = readFileSync(abs, "utf8").split(/\r?\n/).length;
        lineCounts.set(abs, count);
      }
      if (ref.line > count) problems.push({ where, path: ref.path, line: ref.line, problem: "line-out-of-range" });
    }
  }
  return { total: refs.length, verified: refs.length - problems.length, problems };
}
