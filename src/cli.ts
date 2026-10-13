#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildInventory, collectSecretValues, loadRepo, scrubSecrets } from "./analysis/index.js";
import type { RepoFile } from "./analysis/files.js";
import { analyzeWithAgent } from "./agent/run.js";
import { MigrationPlan } from "./plan/schema.js";
import { verifyCitations } from "./plan/verify.js";
import { renderInventory, renderReport, type RunSummary } from "./report/render.js";

const USAGE = `legacy-migrate: plan the migration and decommission of a legacy codebase

Usage:
  legacy-migrate analyze <repo-path> [options]   Inventory + agent run, writes the plan and report
  legacy-migrate render <repo-path> --out <dir>  Re-render report.md from <dir>/plan.json (no model)

Options:
  --target <text>          Target platform (default: "Node 22 + Postgres on Cloudflare Workers")
  --out <dir>              Output directory (default: report)
  --dry-run                Run only the deterministic analysis. No model, no auth needed.
  --json                   With --dry-run, print the inventory as JSON
  --model <name>           Model alias or ID (default: Claude Code's default)
  --max-turns <n>          Agent turn limit (default: 60)
  --max-budget-usd <n>     Stop the run when estimated spend reaches this (default: 5)
  --quiet                  Do not print tool-call progress
  -h, --help               Show this help

Outputs (full run): plan.json, report.md, run.json, inventory.json in --out.
`;

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n\n${USAGE}`);
  process.exit(2);
}

function positiveNumber(v: string | undefined, name: string, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) fail(`${name} must be a positive number`);
  return n;
}

function write(file: string, content: string): void {
  writeFileSync(file, content.endsWith("\n") ? content : `${content}\n`, "utf8");
}

/** Removes literal secret values from the repo out of anything the model produced. */
function makeScrubber(files: RepoFile[]): { scrub: (v: unknown) => unknown; count: () => number } {
  const secrets = collectSecretValues(files);
  const needles = [...new Set(secrets.flatMap((s) => [s, JSON.stringify(s).slice(1, -1)]))];
  let n = 0;
  return {
    scrub: (value) => {
      const text = JSON.stringify(value);
      for (const needle of needles) n += text.split(needle).length - 1;
      return JSON.parse(scrubSecrets(text, needles)) as unknown;
    },
    count: () => n,
  };
}

function writeReport(plan: MigrationPlan, root: string, outDir: string, run: RunSummary | undefined, generatedAt: string) {
  const citations = verifyCitations(plan, root);
  write(path.join(outDir, "plan.json"), JSON.stringify(plan, null, 2));
  write(
    path.join(outDir, "report.md"),
    renderReport(plan, {
      linkBase: path.relative(outDir, root).split(path.sep).join("/"),
      generatedAt,
      run,
      citations,
    }),
  );
  return citations;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      target: { type: "string", default: "Node 22 + Postgres on Cloudflare Workers" },
      out: { type: "string", default: "report" },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      model: { type: "string" },
      "max-turns": { type: "string" },
      "max-budget-usd": { type: "string" },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const [command, repoArg] = positionals;
  if (command !== "analyze" && command !== "render") fail(command ? `unknown command "${command}"` : "missing command");
  if (!repoArg) fail("missing <repo-path>");
  const root = path.resolve(repoArg);
  if (!existsSync(root) || !statSync(root).isDirectory()) fail(`${root} is not a directory`);
  const outDir = path.resolve(values.out);
  const snapshot = loadRepo(root);
  const scrubber = makeScrubber(snapshot.files);

  if (command === "render") {
    const planFile = path.join(outDir, "plan.json");
    if (!existsSync(planFile)) fail(`${planFile} not found`);
    const parsed = MigrationPlan.safeParse(scrubber.scrub(JSON.parse(readFileSync(planFile, "utf8"))));
    if (!parsed.success) {
      process.stderr.write(`plan.json does not match the schema:\n${parsed.error.message}\n`);
      return 1;
    }
    const runFile = path.join(outDir, "run.json");
    const run = existsSync(runFile) ? (JSON.parse(readFileSync(runFile, "utf8")) as Record<string, unknown>) : undefined;
    const summary: RunSummary | undefined = run
      ? {
          model: typeof run["model"] === "string" ? run["model"] : undefined,
          numTurns: Number(run["numTurns"] ?? 0),
          durationMs: Number(run["durationMs"] ?? 0),
          totalCostUsd: Number(run["totalCostUsd"] ?? 0),
          deniedToolCalls: Array.isArray(run["denials"]) ? run["denials"].length : 0,
        }
      : undefined;
    const generatedAt = typeof run?.["startedAt"] === "string" ? run["startedAt"].slice(0, 10) : new Date().toISOString().slice(0, 10);
    const citations = writeReport(parsed.data, root, outDir, summary, generatedAt);
    process.stderr.write(`Wrote ${path.join(outDir, "report.md")} (citations verified: ${citations.verified}/${citations.total})\n`);
    return 0;
  }

  const inventory = buildInventory(snapshot);
  if (values["dry-run"]) {
    if (values.json) process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
    else process.stdout.write(`${renderInventory(inventory)}\n`);
    return 0;
  }

  mkdirSync(outDir, { recursive: true });
  write(path.join(outDir, "inventory.json"), JSON.stringify(inventory, null, 2));

  const log = values.quiet ? undefined : (line: string): void => void process.stderr.write(`  ${line}\n`);
  process.stderr.write(`Analyzing ${root}\nTarget: ${values.target}\n`);
  const started = new Date();
  const result = await analyzeWithAgent({
    root,
    targetStack: values.target,
    inventory,
    model: values.model,
    maxTurns: positiveNumber(values["max-turns"], "--max-turns", 60),
    maxBudgetUsd: positiveNumber(values["max-budget-usd"], "--max-budget-usd", 5),
    onProgress: log,
  });

  const plan = result.plan ? MigrationPlan.parse(scrubber.scrub(result.plan)) : undefined;
  const rawOutput = result.rawOutput === undefined ? undefined : scrubber.scrub(result.rawOutput);
  const t = result.telemetry;
  const summary: RunSummary = {
    model: t.model,
    numTurns: t.numTurns,
    durationMs: t.durationMs,
    totalCostUsd: t.totalCostUsd,
    deniedToolCalls: t.denials.length,
  };
  const citations = plan ? writeReport(plan, root, outDir, summary, started.toISOString().slice(0, 10)) : undefined;

  const run = {
    tool: "legacy-migration-agent",
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    target: values.target,
    repo: path.basename(root),
    ok: Boolean(plan),
    ...t,
    citations,
    secretsScrubbed: scrubber.count(),
    validationError: result.validationError,
  };
  write(path.join(outDir, "run.json"), JSON.stringify(run, null, 2));

  if (!plan) {
    if (rawOutput !== undefined) write(path.join(outDir, "plan.invalid.json"), JSON.stringify(rawOutput, null, 2));
    process.stderr.write(
      `\nNo valid plan produced (${t.resultSubtype ?? "no result"}).\n${[...t.errors, result.validationError ?? ""].filter(Boolean).join("\n")}\nDetails in ${path.join(outDir, "run.json")}\n`,
    );
    return 1;
  }

  process.stderr.write(
    `\nDone: ${t.numTurns} turns, ${(t.durationMs / 1000).toFixed(1)} s, estimated $${t.totalCostUsd.toFixed(4)}. ` +
      `Citations verified: ${citations?.verified}/${citations?.total}. Denied tool calls: ${t.denials.length}.\n` +
      `Wrote ${path.join(outDir, "report.md")}\n`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  },
);
