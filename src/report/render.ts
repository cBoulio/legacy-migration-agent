import type { Finding, Inventory } from "../analysis/types.js";
import type { EvidenceRef, MigrationPlan } from "../plan/schema.js";
import type { CitationReport } from "../plan/verify.js";

export interface RunSummary {
  model?: string;
  numTurns: number;
  durationMs: number;
  totalCostUsd: number;
  deniedToolCalls: number;
}

export interface RenderOptions {
  /** Relative path from the report's directory to the repo root, for clickable citations. */
  linkBase?: string;
  generatedAt?: string;
  run?: RunSummary;
  citations?: CitationReport;
}

/** Table cells cannot hold newlines; keep the line structure with <br>, which GitHub renders. */
function cell(text: string): string {
  return text
    .trim()
    .replace(/\|/g, "\\|")
    .replace(/(\r?\n\s*)+/g, "<br>");
}

/** Indent continuation lines so multi-line text stays inside its list item. */
function indent(text: string, pad: string): string {
  return text
    .trim()
    .split(/\r?\n/)
    .map((l, i) => (i === 0 || l.trim() === "" ? l : pad + l))
    .join("\n");
}

export function formatEvidence(refs: EvidenceRef[], linkBase?: string): string {
  return refs
    .map((r) => {
      const label = r.line ? `${r.path}:${r.line}` : r.path;
      if (linkBase === undefined) return `\`${label}\``;
      const base = linkBase === "" ? "" : `${linkBase.replace(/\/$/, "")}/`;
      const anchor = r.line ? `#L${r.line}` : "";
      return `[\`${label}\`](${encodeURI(base + r.path)}${anchor})`;
    })
    .join(", ");
}

/** Render the validated plan as Markdown. Pure function: the JSON is the source of truth. */
export function renderReport(plan: MigrationPlan, opts: RenderOptions = {}): string {
  const ev = (refs: EvidenceRef[]): string => formatEvidence(refs, opts.linkBase);
  const out: string[] = [];
  const push = (...lines: string[]): void => {
    out.push(...lines);
  };

  push("# Migration and decommission plan", "");
  push(`**From:** ${plan.sourceStack}  `, `**To:** ${plan.targetStack}  `);
  if (opts.generatedAt) push(`**Generated:** ${opts.generatedAt}  `);
  if (opts.run) {
    const r = opts.run;
    push(
      `**Run:** ${r.numTurns} turns, ${(r.durationMs / 1000).toFixed(1)} s, estimated cost $${r.totalCostUsd.toFixed(4)}` +
        `${r.model ? `, model ${r.model}` : ""}, ${r.deniedToolCalls} tool call(s) denied by the read-only guard  `,
    );
  }
  if (opts.citations) {
    const c = opts.citations;
    push(`**Citations:** ${c.verified} of ${c.total} verified against the repo on disk`);
  }
  push("", "## Summary", "", plan.summary, "");

  push("## Inventory", "", "### Components", "", "| Component | Kind | Description | Evidence |", "|---|---|---|---|");
  for (const c of plan.inventory.components) {
    push(`| ${cell(c.name)} | ${c.kind} | ${cell(c.description)} | ${ev(c.evidence)} |`);
  }
  if (plan.inventory.dependencies.length > 0) {
    push("", "### Dependencies", "", "| Dependency | Version | Action | Reason | Evidence |", "|---|---|---|---|---|");
    for (const d of plan.inventory.dependencies) {
      push(`| ${cell(d.name)} | ${cell(d.version)} | ${d.status} | ${cell(d.reason)} | ${ev(d.evidence)} |`);
    }
  }

  push("", "## Integrations and consumers", "");
  if (plan.integrations.length === 0) push("None found.");
  else {
    push("| Integration | Direction | Protocol | What it does | Migration action | Evidence |", "|---|---|---|---|---|---|");
    for (const i of plan.integrations) {
      push(`| ${cell(i.name)} | ${i.direction} | ${cell(i.protocol)} | ${cell(i.description)} | ${cell(i.migrationAction)} | ${ev(i.evidence)} |`);
    }
  }

  push("", "## Data migration", "");
  if (plan.dataMigration.length === 0) push("No data migration steps.");
  for (const s of [...plan.dataMigration].sort((a, b) => a.order - b.order)) {
    push(`${s.order}. **${s.title}.** ${indent(s.description, "   ")}`, "");
    if (s.tables.length > 0) push(`   - Tables: ${s.tables.map((t) => `\`${t}\``).join(", ")}`);
    push(`   - Verify: ${indent(s.verification, "     ")}`, `   - Evidence: ${ev(s.evidence)}`, "");
  }

  push("", "## Cut-over phases", "");
  for (const p of plan.phases) {
    push(`### ${p.id}: ${p.name}`, "", `**Goal:** ${p.goal}`, "", "Steps:", "");
    p.steps.forEach((s, i) => push(`${i + 1}. ${indent(s, "   ")}`));
    push("", "Exit criteria:", "");
    p.exitCriteria.forEach((c) => push(`- ${c}`));
    const rollback = p.rollback.trim();
    const rollbackText = rollback.includes("\n") ? `**Rollback:**\n\n${rollback}` : `**Rollback:** ${rollback}`;
    push("", rollbackText, "", `Evidence: ${ev(p.evidence)}`, "");
  }

  push("## Decommission checklist", "");
  for (const c of plan.decommissionChecklist) push(`- [ ] ${c.item} (${ev(c.evidence)})`);

  push("", "## Risks", "");
  if (plan.risks.length === 0) push("None recorded.");
  else {
    const order = { critical: 0, high: 1, medium: 2, low: 3 } as const;
    push("| Severity | Risk | Description | Mitigation | Evidence |", "|---|---|---|---|---|");
    for (const r of [...plan.risks].sort((a, b) => order[a.severity] - order[b.severity])) {
      push(`| ${r.severity} | ${cell(r.title)} | ${cell(r.description)} | ${cell(r.mitigation)} | ${ev(r.evidence)} |`);
    }
  }

  push("", "## Open questions", "");
  if (plan.openQuestions.length === 0) push("None.");
  plan.openQuestions.forEach((q, i) => {
    push(`${i + 1}. **${q.question}** ${q.whyItMatters}${q.askWho ? ` Ask: ${q.askWho}.` : ""} (${ev(q.evidence)})`);
  });

  if (plan.reviewNotes.length > 0) {
    push("", "## Reviewer findings", "", "Raised by the risk-reviewer subagent against the draft plan, and how the plan changed:", "");
    for (const n of plan.reviewNotes) push(`- ${n.finding} **Resolution:** ${n.resolution}`);
  }

  if (opts.citations && opts.citations.problems.length > 0) {
    push("", "## Citation problems", "", "These citations did not check out against the repo and should be treated as unverified:", "");
    for (const p of opts.citations.problems) {
      push(`- ${p.where}: \`${p.path}${p.line ? `:${p.line}` : ""}\` (${p.problem})`);
    }
  }

  push("");
  return out.join("\n");
}

function findingLines(title: string, findings: Finding[]): string[] {
  const lines = [`## ${title} (${findings.length})`, ""];
  if (findings.length === 0) return [...lines, "None found.", ""];
  for (const f of findings) {
    const where = f.evidence.map((e) => (e.line ? `${e.path}:${e.line}` : e.path)).join(", ");
    lines.push(`- [${f.category}] ${f.name}${f.detail ? ` - ${f.detail}` : ""}`, `    ${where}`);
  }
  return [...lines, ""];
}

/** Plain-text inventory for --dry-run. */
export function renderInventory(inv: Inventory): string {
  const lines: string[] = [
    "# Deterministic inventory",
    "",
    `Root: ${inv.root}`,
    `Files scanned: ${inv.fileCount}${inv.skippedFiles.length ? ` (skipped ${inv.skippedFiles.length}: ${inv.skippedFiles.join(", ")})` : ""}`,
    `File types: ${Object.entries(inv.languages).map(([k, v]) => `${k} ${v}`).join(", ")}`,
    "",
    `## Dependencies (${inv.dependencies.dependencies.length})`,
    "",
    `Manifests: ${inv.dependencies.manifests.join(", ") || "none"}`,
    `Lockfiles: ${inv.dependencies.lockfiles.join(", ") || "none"}`,
  ];
  if (inv.dependencies.missingLockfiles.length) lines.push(`Missing lockfiles: ${inv.dependencies.missingLockfiles.join("; ")}`);
  lines.push("");
  for (const d of inv.dependencies.dependencies) {
    const e = d.evidence[0];
    lines.push(`- ${d.ecosystem} ${d.name} ${d.version} [${d.scope}]${e ? `  ${e.path}${e.line ? `:${e.line}` : ""}` : ""}`);
  }
  lines.push("");
  lines.push(...findingLines("Entry points", inv.entryPoints));
  lines.push(...findingLines("Data stores", inv.dataStores));
  lines.push(...findingLines("Scheduled jobs", inv.scheduledJobs));
  lines.push(...findingLines("External integrations", inv.integrations));
  lines.push(...findingLines("Hard-coded configuration", inv.hardcodedConfig));
  return lines.join("\n");
}
