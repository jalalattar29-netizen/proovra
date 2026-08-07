/** PHASE 12 — POINT 8: types for the three source views. */
export interface ViewResult {
  views: { HEAD_ARTIFACT: string[]; SETTLED_WORKTREE: string[]; PROPOSED_RELEASE_ARTIFACT: string[] };
  counts: Record<string, number>;
  additions: { landed: string[]; proposed: string[]; vanished: string[] };
  untrackedOnDisk: string[];
  conservationErrors: string[];
  inventoryFilesystemMismatch: string[];
  metrics: { MigrationInventoryFilesystemMismatch: number; ConservationErrors: number };
}
export declare const REPO: string;
export declare function git(...args: string[]): string;
export declare function digestText(text: string): string;
export declare function digestBytes(buf: Uint8Array): string;
export declare function deriveSourceSets(): {
  tracked: Set<string>;
  modified: Set<string>;
  deleted: Set<string>;
  untracked: Set<string>;
};
export declare function migrationsOnDisk(): string[];
export declare function migrationsInHead(): string[];
export declare function migrationsInInventory(): { names: string[]; entries: Array<Record<string, unknown>> };
export declare function migrationSql(name: string): Buffer;
export declare function buildViews(args?: {
  proposedAdditions?: string[];
  proposedExclusions?: Record<string, string>;
}): ViewResult;

/**
 * PHASE 12 CORRECTIVE PASS 3 §1.1 — the landed/proposed split, DERIVED from
 * HEAD and the worktree rather than hand-maintained.
 */
export declare function partitionAdditions(args: {
  ledger: string[];
  head: string[];
  disk: string[];
}): { landed: string[]; proposed: string[]; vanished: string[] };
