import { z } from "zod";

/** A citation into the analysed repo. Every claim in the plan carries at least one. */
export const EvidenceRef = z.object({
  path: z.string().min(1).describe("File path relative to the repo root, forward slashes"),
  line: z.number().int().positive().optional().describe("1-based line number, when the claim is about a specific line"),
  note: z.string().optional().describe("What this file or line shows"),
});

const evidence = z.array(EvidenceRef).min(1).describe("Files that support this item. Required.");

export const Severity = z.enum(["low", "medium", "high", "critical"]);

export const Component = z.object({
  name: z.string().min(1),
  kind: z.enum(["web-ui", "http-api", "scheduled-job", "background-worker", "library", "database", "file-storage", "config", "other"]),
  description: z.string().min(1),
  evidence,
});

export const DependencyNote = z.object({
  name: z.string().min(1),
  version: z.string(),
  status: z.enum(["keep", "upgrade", "replace", "remove"]),
  reason: z.string().min(1),
  evidence,
});

export const Integration = z.object({
  name: z.string().min(1),
  direction: z.enum(["inbound", "outbound"]),
  protocol: z.string().min(1).describe("e.g. HTTPS JSON, SOAP, SMTP, SQL, file drop"),
  description: z.string().min(1),
  migrationAction: z.string().min(1),
  evidence,
});

export const DataMigrationStep = z.object({
  order: z.number().int().positive(),
  title: z.string().min(1),
  description: z.string().min(1),
  tables: z.array(z.string()).default([]),
  verification: z.string().min(1).describe("How to prove the step worked, e.g. row counts or checksums"),
  evidence,
});

export const Phase = z.object({
  id: z.string().min(1).describe("Short id such as P1"),
  name: z.string().min(1),
  goal: z.string().min(1),
  steps: z.array(z.string().min(1)).min(1),
  exitCriteria: z.array(z.string().min(1)).min(1),
  rollback: z.string().min(1).describe("How to return to the previous state if this phase fails"),
  evidence,
});

export const ChecklistItem = z.object({
  item: z.string().min(1),
  evidence,
});

export const Risk = z.object({
  title: z.string().min(1),
  severity: Severity,
  description: z.string().min(1),
  mitigation: z.string().min(1),
  evidence,
});

export const OpenQuestion = z.object({
  question: z.string().min(1),
  whyItMatters: z.string().min(1),
  askWho: z.string().optional().describe("Role or team best placed to answer"),
  evidence,
});

export const ReviewNote = z.object({
  finding: z.string().min(1),
  resolution: z.string().min(1).describe("What changed in the plan because of this finding"),
});

export const MigrationPlan = z.object({
  summary: z.string().min(1).describe("Three to five sentences: what the app is, what it becomes, the main risk"),
  sourceStack: z.string().min(1),
  targetStack: z.string().min(1),
  inventory: z.object({
    components: z.array(Component).min(1),
    dependencies: z.array(DependencyNote),
  }),
  integrations: z.array(Integration),
  dataMigration: z.array(DataMigrationStep),
  phases: z.array(Phase).min(1),
  decommissionChecklist: z.array(ChecklistItem).min(1),
  risks: z.array(Risk),
  openQuestions: z.array(OpenQuestion),
  reviewNotes: z
    .array(ReviewNote)
    .describe("Findings from the risk-reviewer subagent and how the plan was changed in response"),
});

export type MigrationPlan = z.infer<typeof MigrationPlan>;
export type EvidenceRef = z.infer<typeof EvidenceRef>;

/** JSON Schema for the SDK's outputFormat. The SDK validates against draft-07. */
export function migrationPlanJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(MigrationPlan, { target: "draft-7", io: "input" }) as Record<string, unknown>;
}
