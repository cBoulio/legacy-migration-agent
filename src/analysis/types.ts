/** A pointer into the target repo. `path` is relative to the repo root, forward slashes. */
export interface Evidence {
  path: string;
  line?: number;
  snippet?: string;
}

/** One deterministic fact found by a detector, with the lines that support it. */
export interface Finding {
  category: string;
  name: string;
  detail?: string;
  evidence: Evidence[];
}

export type DependencyScope = "runtime" | "dev" | "platform" | "frontend-asset";

export interface Dependency {
  ecosystem: string;
  name: string;
  version: string;
  scope: DependencyScope;
  evidence: Evidence[];
}

export interface DependencyInventory {
  manifests: string[];
  lockfiles: string[];
  missingLockfiles: string[];
  dependencies: Dependency[];
}

export interface Inventory {
  root: string;
  fileCount: number;
  skippedFiles: string[];
  languages: Record<string, number>;
  dependencies: DependencyInventory;
  entryPoints: Finding[];
  dataStores: Finding[];
  scheduledJobs: Finding[];
  integrations: Finding[];
  hardcodedConfig: Finding[];
}
