import { query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Inventory } from "../analysis/types.js";
import { MigrationPlan, migrationPlanJsonSchema } from "../plan/schema.js";
import { createReadOnlyHook, type DenialRecord, MCP_SERVER_NAME, READ_ONLY_TOOLS } from "./guard.js";
import { buildPrompt, SUBAGENTS, SYSTEM_PROMPT } from "./prompts.js";
import { createInventoryServer, DETERMINISTIC_TOOL_NAMES } from "./tools.js";

export interface AnalyzeOptions {
  root: string;
  targetStack: string;
  inventory: Inventory;
  model?: string;
  maxTurns: number;
  maxBudgetUsd: number;
  onProgress?: (line: string) => void;
}

export interface RunTelemetry {
  sessionId?: string;
  claudeCodeVersion?: string;
  model?: string;
  apiKeySource?: string;
  resultSubtype?: string;
  isError: boolean;
  numTurns: number;
  durationMs: number;
  durationApiMs: number;
  totalCostUsd: number;
  usage?: unknown;
  modelUsage?: unknown;
  toolCalls: Record<string, number>;
  subagentCalls: string[];
  denials: DenialRecord[];
  sdkPermissionDenials: unknown[];
  errors: string[];
}

export interface AnalyzeResult {
  plan?: MigrationPlan;
  /** Raw structured output when it failed zod validation, kept for debugging. */
  rawOutput?: unknown;
  validationError?: string;
  telemetry: RunTelemetry;
}

/** Tools the agent never sees. Belt and braces with the hook: a removed tool cannot be attempted. */
const REMOVED_TOOLS = ["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "KillShell", "BashOutput"];

/**
 * Read deny rules for likely secrets files. These also cover Grep and Glob output, which
 * the PreToolUse hook cannot inspect file by file when a search spans a directory.
 */
const SECRET_READ_DENIES = ["Read(**/.env)", "Read(**/.env.*)", "Read(**/*.pem)", "Read(**/*.key)", "Read(**/id_rsa*)"];

function countToolUses(msg: SDKMessage, telemetry: RunTelemetry, progress?: (l: string) => void): void {
  if (msg.type !== "assistant") return;
  const inSubagent = msg.parent_tool_use_id ? "  (subagent) " : "";
  for (const block of msg.message.content) {
    if (block.type !== "tool_use") continue;
    telemetry.toolCalls[block.name] = (telemetry.toolCalls[block.name] ?? 0) + 1;
    const input = block.input as Record<string, unknown>;
    if (block.name === "Agent" || block.name === "Task") {
      const type = typeof input["subagent_type"] === "string" ? input["subagent_type"] : "general-purpose";
      telemetry.subagentCalls.push(type);
      progress?.(`${inSubagent}-> subagent ${type}`);
    } else {
      const arg = input["file_path"] ?? input["pattern"] ?? input["path"] ?? "";
      progress?.(`${inSubagent}${block.name}${arg ? ` ${String(arg)}` : ""}`);
    }
  }
}

/** Run the agent against the target repo and return the validated plan plus telemetry. */
export async function analyzeWithAgent(opts: AnalyzeOptions): Promise<AnalyzeResult> {
  const telemetry: RunTelemetry = {
    isError: false,
    numTurns: 0,
    durationMs: 0,
    durationApiMs: 0,
    totalCostUsd: 0,
    toolCalls: {},
    subagentCalls: [],
    denials: [],
    sdkPermissionDenials: [],
    errors: [],
  };
  const hook = createReadOnlyHook(opts.root, (d) => {
    telemetry.denials.push(d);
    opts.onProgress?.(`DENIED ${d.tool}: ${d.reason}`);
  });

  const q = query({
    prompt: buildPrompt(opts.targetStack),
    options: {
      cwd: opts.root,
      systemPrompt: SYSTEM_PROMPT,
      model: opts.model,
      // Built-in tools available at all. Agent is needed to launch the two subagents.
      tools: [...READ_ONLY_TOOLS, "Agent"],
      allowedTools: [...READ_ONLY_TOOLS, "Agent", `mcp__${MCP_SERVER_NAME}__*`],
      disallowedTools: [...REMOVED_TOOLS, ...SECRET_READ_DENIES],
      // Anything not pre-approved is denied instead of prompting; there is no human in the loop.
      permissionMode: "dontAsk",
      hooks: { PreToolUse: [{ hooks: [hook] }] },
      mcpServers: { [MCP_SERVER_NAME]: createInventoryServer(opts.inventory) },
      agents: SUBAGENTS,
      outputFormat: { type: "json_schema", schema: migrationPlanJsonSchema() },
      // Do not load the user's or the target repo's .claude settings, hooks, or CLAUDE.md.
      settingSources: [],
      // Only our in-process server. Without these, a logged-in user's claude.ai connectors
      // (mail, drive, ...) and any .mcp.json servers would be offered to the agent too.
      strictMcpConfig: true,
      settings: { disableClaudeAiConnectors: true },
      maxTurns: opts.maxTurns,
      maxBudgetUsd: opts.maxBudgetUsd,
      env: {
        ...process.env,
        CLAUDE_AGENT_SDK_CLIENT_APP: "legacy-migration-agent/0.1.0",
        CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1",
        CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "2",
      },
    },
  });

  let result: SDKResultMessage | undefined;
  try {
    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") {
        telemetry.sessionId = msg.session_id;
        telemetry.claudeCodeVersion = msg.claude_code_version;
        telemetry.model = msg.model;
        telemetry.apiKeySource = msg.apiKeySource;
        const missing = DETERMINISTIC_TOOL_NAMES.filter((t) => !msg.tools.includes(t));
        if (missing.length > 0) opts.onProgress?.(`warning: tools not registered: ${missing.join(", ")}`);
        opts.onProgress?.(`session ${msg.session_id} model ${msg.model} (Claude Code ${msg.claude_code_version}, auth: ${msg.apiKeySource})`);
      }
      countToolUses(msg, telemetry, opts.onProgress);
      if (msg.type === "result") result = msg;
    }
  } catch (err) {
    // A single-shot query throws after yielding an error result; keep whatever we captured.
    telemetry.errors.push(err instanceof Error ? err.message : String(err));
  }

  if (!result) {
    telemetry.isError = true;
    return { telemetry };
  }
  telemetry.resultSubtype = result.subtype;
  telemetry.isError = result.is_error || result.subtype !== "success";
  telemetry.numTurns = result.num_turns;
  telemetry.durationMs = result.duration_ms;
  telemetry.durationApiMs = result.duration_api_ms;
  telemetry.totalCostUsd = result.total_cost_usd;
  telemetry.usage = result.usage;
  telemetry.modelUsage = result.modelUsage;
  telemetry.sdkPermissionDenials = result.permission_denials;
  if (result.subtype !== "success") {
    telemetry.errors.push(...result.errors);
    return { telemetry };
  }
  if (result.structured_output === undefined) {
    telemetry.errors.push("Run finished without structured output");
    return { telemetry };
  }
  const parsed = MigrationPlan.safeParse(result.structured_output);
  if (!parsed.success) {
    return { telemetry, rawOutput: result.structured_output, validationError: parsed.error.message };
  }
  return { plan: parsed.data, telemetry };
}
