import path from "node:path";
import { findDataStores } from "./dataStores.js";
import { dependencyInventory } from "./dependencies.js";
import { findEntryPoints } from "./entryPoints.js";
import { ext, loadRepo, type RepoSnapshot } from "./files.js";
import { collectSecretValues, findHardcodedConfig, scrubSecrets } from "./hardcodedConfig.js";
import { findExternalIntegrations } from "./integrations.js";
import { findScheduledJobs } from "./scheduledJobs.js";
import type { Inventory } from "./types.js";

export { loadRepo } from "./files.js";
export { collectSecretValues, scrubSecrets };
export type * from "./types.js";
export { dependencyInventory, findDataStores, findEntryPoints, findExternalIntegrations, findHardcodedConfig, findScheduledJobs };

function languageCounts(snapshot: RepoSnapshot): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of snapshot.files) {
    const e = ext(f.path) || "(none)";
    counts[e] = (counts[e] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

/** Run every deterministic detector over one snapshot of the repo. No model involved. */
export function buildInventory(snapshot: RepoSnapshot): Inventory {
  const { files } = snapshot;
  return {
    // Directory name only: inventories get committed and shared, absolute paths leak machine details.
    root: path.basename(snapshot.root),
    fileCount: files.length,
    skippedFiles: snapshot.skipped,
    languages: languageCounts(snapshot),
    dependencies: dependencyInventory(files),
    entryPoints: findEntryPoints(files),
    dataStores: findDataStores(files),
    scheduledJobs: findScheduledJobs(files),
    integrations: findExternalIntegrations(files),
    hardcodedConfig: findHardcodedConfig(files),
  };
}

export function inventoryFor(root: string): Inventory {
  return buildInventory(loadRepo(root));
}
