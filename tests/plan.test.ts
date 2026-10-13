import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MigrationPlan, migrationPlanJsonSchema } from "../src/plan/schema.js";
import { verifyCitations } from "../src/plan/verify.js";
import { renderInventory, renderReport } from "../src/report/render.js";
import { inventoryFor } from "../src/analysis/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../examples/legacy-invoicing/app");

const ev = (p: string, line?: number) => [{ path: p, ...(line ? { line } : {}) }];

function validPlan(): MigrationPlan {
  return MigrationPlan.parse({
    summary: "A PHP 5 invoicing app moves to Workers and Postgres.",
    sourceStack: "PHP 5, MySQL 5.1 (MyISAM), jQuery 1.7, cron",
    targetStack: "Node 22 + Postgres on Cloudflare Workers",
    inventory: {
      components: [
        { name: "Staff UI", kind: "web-ui", description: "Invoice list | charge button", evidence: ev("public/index.php", 13) },
        { name: "Overdue reminders", kind: "scheduled-job", description: "Nightly email and late fee", evidence: ev("cron/send_overdue_reminders.php", 4) },
      ],
      dependencies: [
        { name: "phpmailer/phpmailer", version: "5.2.9", status: "remove", reason: "Replaced by an email API", evidence: ev("composer.json", 6) },
      ],
    },
    integrations: [
      {
        name: "Payment gateway",
        direction: "outbound",
        protocol: "SOAP over HTTPS",
        description: "Charges cards",
        migrationAction: "Call from a Worker with fetch and a hand-built envelope",
        evidence: ev("includes/PaymentGateway.php", 8),
      },
    ],
    dataMigration: [
      {
        order: 1,
        title: "Convert latin1 to UTF-8",
        description: "Export and convert",
        tables: ["invoices"],
        verification: "Row counts and checksums match",
        evidence: ev("sql/schema.sql", 14),
      },
    ],
    phases: [
      {
        id: "P1",
        name: "Parallel run",
        goal: "Prove parity",
        steps: ["Replicate data nightly"],
        exitCriteria: ["Totals match for 7 days"],
        rollback: "Keep using the old app; discard the new database",
        evidence: ev("includes/db.php"),
      },
    ],
    decommissionChecklist: [{ item: "Remove crontab entry", evidence: ev("ops/crontab.txt", 3) }],
    risks: [
      { title: "Double late fees", severity: "high", description: "Job is not idempotent", mitigation: "Disable old cron first", evidence: ev("cron/send_overdue_reminders.php", 3) },
      { title: "Low thing", severity: "low", description: "d", mitigation: "m", evidence: ev("README.txt") },
    ],
    openQuestions: [{ question: "Who else polls /status.json?", whyItMatters: "Hidden consumer", askWho: "Accounting", evidence: ev("ops/firewall-notes.txt", 2) }],
    reviewNotes: [{ finding: "Draft missed the ERP consumer", resolution: "Added integration and open question" }],
  });
}

describe("MigrationPlan schema", () => {
  it("accepts a complete plan and fills defaults", () => {
    const plan = validPlan();
    expect(plan.dataMigration[0]?.tables).toEqual(["invoices"]);
  });

  it("rejects items without evidence", () => {
    const raw = JSON.parse(JSON.stringify(validPlan()));
    raw.risks[0].evidence = [];
    const r = MigrationPlan.safeParse(raw);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["risks", 0, "evidence"]);
  });

  it("rejects unknown severities and missing rollback", () => {
    const raw = JSON.parse(JSON.stringify(validPlan()));
    raw.risks[0].severity = "spicy";
    delete raw.phases[0].rollback;
    const r = MigrationPlan.safeParse(raw);
    expect(r.success).toBe(false);
    const paths = r.error?.issues.map((i) => i.path.join(".")) ?? [];
    expect(paths).toEqual(expect.arrayContaining(["risks.0.severity", "phases.0.rollback"]));
  });

  it("produces a draft-07 JSON schema with evidence required", () => {
    const schema = migrationPlanJsonSchema() as { $schema: string; required: string[] };
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(schema.required).toEqual(expect.arrayContaining(["summary", "phases", "risks", "decommissionChecklist"]));
    expect(JSON.stringify(schema)).toContain('"minItems":1');
  });
});

describe("verifyCitations", () => {
  it("accepts citations that exist in the repo", () => {
    const r = verifyCitations(validPlan(), ROOT);
    expect(r.problems).toEqual([]);
    expect(r.verified).toBe(r.total);
    expect(r.total).toBe(10);
  });

  it("reports missing files, out-of-range lines, and paths outside the repo", () => {
    const plan = validPlan();
    plan.risks[0]!.evidence = [{ path: "includes/nope.php" }];
    plan.risks[1]!.evidence = [{ path: "composer.json", line: 999 }];
    plan.openQuestions[0]!.evidence = [{ path: "../../package.json" }];
    const r = verifyCitations(plan, ROOT);
    expect(r.problems.map((p) => p.problem).sort()).toEqual(["line-out-of-range", "missing-file", "outside-repo"]);
    expect(r.verified).toBe(r.total - 3);
  });
});

describe("renderReport", () => {
  const plan = validPlan();
  const md = renderReport(plan, {
    linkBase: "app",
    generatedAt: "2026-10-13",
    run: { model: "test-model", numTurns: 12, durationMs: 61000, totalCostUsd: 0.4321, deniedToolCalls: 1 },
    citations: verifyCitations(plan, ROOT),
  });

  it("includes every section", () => {
    for (const h of ["## Summary", "## Inventory", "## Integrations and consumers", "## Data migration", "## Cut-over phases", "## Decommission checklist", "## Risks", "## Open questions", "## Reviewer findings"]) {
      expect(md).toContain(h);
    }
  });

  it("links citations to file and line", () => {
    expect(md).toContain("[`includes/PaymentGateway.php:8`](app/includes/PaymentGateway.php#L8)");
    expect(md).toContain("[`includes/db.php`](app/includes/db.php)");
  });

  it("shows telemetry and escapes table pipes", () => {
    expect(md).toContain("12 turns, 61.0 s, estimated cost $0.4321");
    expect(md).toContain("Invoice list \\| charge button");
    expect(md).toContain("10 of 10 verified");
  });

  it("sorts risks by severity and renders rollback per phase", () => {
    expect(md.indexOf("| high | Double late fees")).toBeLessThan(md.indexOf("| low | Low thing"));
    expect(md).toContain("**Rollback:** Keep using the old app");
    expect(md).toContain("- [ ] Remove crontab entry");
  });

  it("keeps multi-line text inside table cells and list items", () => {
    const p = validPlan();
    p.risks[0]!.mitigation = "Do this:\n- first\n- second";
    p.dataMigration[0]!.description = "Steps:\n- export\n- convert";
    const out = renderReport(p);
    expect(out).toContain("Do this:<br>- first<br>- second");
    expect(out).toContain("1. **Convert latin1 to UTF-8.** Steps:\n   - export\n   - convert");
  });

  it("renders plain backticks without a link base", () => {
    expect(renderReport(plan)).toContain("`includes/PaymentGateway.php:8`");
  });
});

describe("renderInventory", () => {
  it("prints every section of the dry-run inventory", () => {
    const text = renderInventory(inventoryFor(ROOT));
    for (const h of ["## Dependencies", "## Entry points", "## Data stores", "## Scheduled jobs", "## External integrations", "## Hard-coded configuration"]) {
      expect(text).toContain(h);
    }
    expect(text).toContain("composer phpmailer/phpmailer 5.2.9 [runtime]");
    expect(text).not.toContain("Winter2013!");
  });
});
