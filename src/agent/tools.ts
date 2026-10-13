import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { Inventory } from "../analysis/types.js";
import { MCP_SERVER_NAME } from "./guard.js";

const readOnly = { annotations: { readOnlyHint: true, openWorldHint: false } };

function json(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 1) }] };
}

/** Tool names as the agent sees them: mcp__<server>__<tool>. */
export const DETERMINISTIC_TOOL_NAMES = [
  "dependency_inventory",
  "find_entry_points",
  "find_data_stores",
  "find_scheduled_jobs",
  "find_external_integrations",
  "find_hardcoded_config",
].map((t) => `mcp__${MCP_SERVER_NAME}__${t}`);

/**
 * Expose the static-analysis results as MCP tools. The inventory is computed once before
 * the agent starts; the tools take no arguments, so the model cannot point them at a
 * different directory.
 */
export function createInventoryServer(inv: Inventory) {
  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: "0.1.0",
    instructions:
      "Deterministic static analysis of the target repo. Results are facts with file:line evidence. Prefer them over guessing.",
    tools: [
      tool(
        "dependency_inventory",
        "Dependencies parsed from manifests (package.json, composer.json, requirements.txt, pom.xml) and <script> tags, plus which lockfiles exist or are missing.",
        {},
        async () => json({ fileCount: inv.fileCount, languages: inv.languages, ...inv.dependencies }),
        readOnly,
      ),
      tool(
        "find_entry_points",
        "Ways requests or processes enter the app: directly served pages and endpoints, routes, rewrite rules, CLI scripts, server start-up, container commands.",
        {},
        async () => json(inv.entryPoints),
        readOnly,
      ),
      tool(
        "find_data_stores",
        "Database drivers and ORMs, connection settings, tables from SQL files, which tables code reads and writes, and local file storage.",
        {},
        async () => json(inv.dataStores),
        readOnly,
      ),
      tool(
        "find_scheduled_jobs",
        "Cron entries (with a plain-English schedule), in-process schedulers, and infrastructure timers.",
        {},
        async () => json(inv.scheduledJobs),
        readOnly,
      ),
      tool(
        "find_external_integrations",
        "Outbound HTTP/SOAP clients, third-party services (email, payments, cloud SDKs), URL hosts, browser calls into the app, network allowlists, and comments that name callers.",
        {},
        async () => json(inv.integrations),
        readOnly,
      ),
      tool(
        "find_hardcoded_config",
        "Credentials and host-specific values written into source. Secret values are redacted; only key names and locations are returned.",
        {},
        async () => json(inv.hardcodedConfig),
        readOnly,
      ),
    ],
  });
}
