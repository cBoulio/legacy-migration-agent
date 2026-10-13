import { realpathSync } from "node:fs";
import path from "node:path";
import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { isSensitivePath } from "../analysis/files.js";

/** Name of the in-process MCP server that exposes the deterministic tools. */
export const MCP_SERVER_NAME = "legacy";

/** Built-in tools the agent may use. Everything else is denied. */
export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"] as const;

/**
 * Tools that carry no filesystem side effects of their own: the subagent launcher (whose
 * subagents' tool calls pass through this same guard) and the structured-output tool the
 * SDK adds when `outputFormat` is set.
 */
const ORCHESTRATION_TOOLS = new Set(["Agent", "Task", "StructuredOutput"]);

export interface GuardDecision {
  allow: boolean;
  reason?: string;
}

export interface DenialRecord {
  time: string;
  tool: string;
  input: unknown;
  reason: string;
  agentId?: string;
}

const allow: GuardDecision = { allow: true };
const deny = (reason: string): GuardDecision => ({ allow: false, reason });

function realOrResolved(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/** True when `candidate` (absolute or relative to root) resolves to root or something under it. */
export function isInsideRoot(candidate: string, root: string): boolean {
  const absRoot = realOrResolved(path.resolve(root));
  const abs = realOrResolved(path.resolve(absRoot, candidate));
  const fold = (s: string): string => (process.platform === "win32" ? s.toLowerCase() : s);
  const rel = path.relative(fold(absRoot), fold(abs));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function checkPattern(pattern: string | undefined, label: string): GuardDecision {
  if (pattern === undefined) return allow;
  if (path.isAbsolute(pattern) || /^[A-Za-z]:/.test(pattern) || pattern.startsWith("~")) {
    return deny(`${label} must be relative to the target repo`);
  }
  if (pattern.split(/[\\/]/).includes("..")) return deny(`${label} may not climb out of the target repo with ..`);
  return allow;
}

function checkPath(p: string | undefined, root: string, label: string): GuardDecision {
  if (p === undefined) return allow; // the tool defaults to the session cwd, which is the target repo
  if (!isInsideRoot(p, root)) return deny(`${label} ${p} is outside the target repo`);
  if (isSensitivePath(p)) return deny(`${label} ${p} looks like a secrets file; it is never read`);
  return allow;
}

/**
 * The read-only policy, as a pure function so it can be unit tested without a model.
 * Allowed: Read/Grep/Glob inside the target repo, this tool's own MCP tools, and the
 * subagent and structured-output plumbing. Denied: everything else, including any write.
 */
export function evaluateToolCall(toolName: string, rawInput: unknown, root: string): GuardDecision {
  const input = rawInput && typeof rawInput === "object" ? (rawInput as Record<string, unknown>) : {};

  if (toolName.startsWith(`mcp__${MCP_SERVER_NAME}__`)) return allow;
  if (ORCHESTRATION_TOOLS.has(toolName)) return allow;

  switch (toolName) {
    case "Read": {
      const file = str(input, "file_path");
      if (!file) return deny("Read requires file_path");
      return checkPath(file, root, "Read path");
    }
    case "Grep": {
      const r = checkPath(str(input, "path"), root, "Grep path");
      return r.allow ? checkPattern(str(input, "glob"), "Grep glob") : r;
    }
    case "Glob": {
      const r = checkPath(str(input, "path"), root, "Glob path");
      return r.allow ? checkPattern(str(input, "pattern"), "Glob pattern") : r;
    }
    default:
      return deny(`${toolName} is not on the read-only allowlist (Read, Grep, Glob, mcp__${MCP_SERVER_NAME}__*)`);
  }
}

/**
 * PreToolUse hook that enforces evaluateToolCall on every tool call, including calls made
 * by subagents. Hooks run before allow rules and permission modes, so a deny here holds
 * even if someone later loosens `allowedTools` or the permission mode.
 */
export function createReadOnlyHook(root: string, onDeny: (d: DenialRecord) => void): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const pre = input as PreToolUseHookInput;
    const decision = evaluateToolCall(pre.tool_name, pre.tool_input, root);
    if (decision.allow) return {};
    const reason = decision.reason ?? "denied";
    onDeny({ time: new Date().toISOString(), tool: pre.tool_name, input: pre.tool_input, reason, agentId: pre.agent_id });
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Read-only guard: ${reason}`,
      },
    };
  };
}
