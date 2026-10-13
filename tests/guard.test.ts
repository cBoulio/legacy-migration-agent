import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { createReadOnlyHook, type DenialRecord, evaluateToolCall, isInsideRoot } from "../src/agent/guard.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../examples/legacy-invoicing/app");
const OUTSIDE = path.resolve(HERE, "../package.json");

describe("evaluateToolCall: allowed", () => {
  it.each([
    ["Read", { file_path: path.join(ROOT, "includes/db.php") }],
    ["Read", { file_path: "includes/db.php" }],
    ["Grep", { pattern: "mysql_", path: "includes" }],
    ["Grep", { pattern: "SoapClient" }],
    ["Glob", { pattern: "**/*.php" }],
    ["Glob", { pattern: "*.sql", path: path.join(ROOT, "sql") }],
    ["mcp__legacy__find_data_stores", {}],
    ["Agent", { subagent_type: "risk-reviewer", prompt: "review" }],
    ["StructuredOutput", { summary: "x" }],
  ])("%s %j", (tool, input) => {
    expect(evaluateToolCall(tool, input, ROOT)).toEqual({ allow: true });
  });
});

describe("evaluateToolCall: denied", () => {
  it.each([
    ["Bash", { command: "ls" }, /not on the read-only allowlist/],
    ["Write", { file_path: path.join(ROOT, "x.txt"), content: "x" }, /not on the read-only allowlist/],
    ["Edit", { file_path: path.join(ROOT, "includes/db.php") }, /not on the read-only allowlist/],
    ["NotebookEdit", {}, /not on the read-only allowlist/],
    ["WebFetch", { url: "https://example.com" }, /not on the read-only allowlist/],
    ["mcp__other__delete_everything", {}, /not on the read-only allowlist/],
    ["Read", { file_path: OUTSIDE }, /outside the target repo/],
    ["Read", { file_path: "../../../package.json" }, /outside the target repo/],
    ["Read", { file_path: path.join(ROOT, ".env") }, /secrets file/],
    ["Read", {}, /requires file_path/],
    ["Grep", { pattern: "x", path: path.dirname(ROOT) }, /outside the target repo/],
    ["Grep", { pattern: "x", glob: "../**/*.php" }, /may not climb/],
    ["Glob", { pattern: "/etc/*" }, /must be relative/],
    ["Glob", { pattern: "C:/Users/**" }, /must be relative/],
    ["Glob", { pattern: "../../**" }, /may not climb/],
  ])("%s %j", (tool, input, reason) => {
    const d = evaluateToolCall(tool, input, ROOT);
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(reason);
  });
});

describe("isInsideRoot", () => {
  it("treats the root itself and children as inside", () => {
    expect(isInsideRoot(ROOT, ROOT)).toBe(true);
    expect(isInsideRoot("public/js", ROOT)).toBe(true);
  });
  it("rejects siblings that share a name prefix", () => {
    expect(isInsideRoot(`${ROOT}-evil/file`, ROOT)).toBe(false);
  });
});

describe("createReadOnlyHook", () => {
  const base = { session_id: "s", transcript_path: "t", cwd: ROOT, tool_use_id: "u" };

  it("returns a deny decision and records it", async () => {
    const denials: DenialRecord[] = [];
    const hook = createReadOnlyHook(ROOT, (d) => denials.push(d));
    const input = { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf ." } } as HookInput;
    const out = await hook(input, "u", { signal: new AbortController().signal });
    expect(out).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } });
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({ tool: "Bash" });
  });

  it("passes allowed calls through without a decision", async () => {
    const denials: DenialRecord[] = [];
    const hook = createReadOnlyHook(ROOT, (d) => denials.push(d));
    const input = { ...base, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "includes/db.php" } } as HookInput;
    expect(await hook(input, "u", { signal: new AbortController().signal })).toEqual({});
    expect(denials).toHaveLength(0);
  });
});
