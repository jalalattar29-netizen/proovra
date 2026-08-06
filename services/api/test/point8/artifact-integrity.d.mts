/** PHASE 12 — POINT 8: types for the artifact-integrity scanner. */
export interface MigrationScan {
  name: string;
  destructive: Array<{ statement: string; count: number }>;
  destructiveCount: number;
  raises: number;
  hasCondition: boolean;
  namesMigrations: string[];
  rawText: string;
}
export interface ArtifactFailure {
  code: "MISSING_SQL" | "GUARD_EXCLUDED_FROM_ARTIFACT" | "UNGUARDED_DESTRUCTIVE" | "GUARD_ORDER" | "GUARD_UNCONDITIONAL";
  migration: string;
  reason: string;
}
export interface ArtifactIntegrityResult {
  ok: boolean;
  failures: ArtifactFailure[];
  metrics: {
    migrationsInView: number;
    pendingDestructiveMigrations: number;
    TrackedDropWithoutGuard: number;
    MigrationOrderConflicts: number;
    CleanArtifactMissingMigrations: number;
  };
}
export declare function stripSqlComments(sql: string): string;
export declare function scanMigration(name: string): MigrationScan | null;
export declare function evaluateArtifactIntegrity(args: {
  view: string[];
  waves: Record<string, string>;
}): ArtifactIntegrityResult;
export declare function crossCheckInventory(args: {
  inventoryEntries: Array<Record<string, unknown>>;
}): Array<{ migration: string; reason: string }>;
