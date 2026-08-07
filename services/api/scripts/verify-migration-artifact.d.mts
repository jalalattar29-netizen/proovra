/**
 * PHASE 12 CORRECTIVE PASS §7 (DB-010) — types for the migration artifact gate.
 *
 * The gate itself is `.mjs` so it can be run directly by an operator with no
 * build step, which is the point of a release-time check. This declaration is
 * what lets the suite that drives its ten negative injections typecheck.
 */

export interface ArtifactFailure {
  /** Bounded reason code. Never a SQL body. */
  code: string;
  detail: string;
}

export interface DestructiveMigration {
  name: string;
  /** Statement KINDS only — DROP_TABLE, DYNAMIC_DROP_COLUMN, and so on. */
  kinds: string[];
}

export interface ArtifactReport {
  artifactDir: string;
  wave: "A" | "B" | "C" | "D";
  migrationCount: number;
  destructiveMigrations: DestructiveMigration[];
  /**
   * Destructive statements in settled history. Reported, never failed on:
   * their bytes are frozen and rewriting them would invalidate a checksum
   * recorded in every database that applied them.
   */
  historicalDestructiveCount: number;
  failures: ArtifactFailure[];
}

export interface VerifyArtifactInput {
  artifactDir: string;
  wave: "A" | "B" | "C" | "D";
  /** name → sha256 of the bytes in HEAD, for the immutability check. */
  headChecksums?: Record<string, string>;
  /** The migration set a WORKER image would apply, when it is given one. */
  workerInventory?: string[];
  /** The tag the compose file resolves to; must be a commit SHA or digest. */
  imageTag?: string;
}

export declare const REPO: string;
export declare function stripComments(sql: string): string;
export declare function stripStringLiterals(sql: string): string;
export declare function classifyMigration(sql: string): string[];
export declare function guardPosition(sql: string): {
  firstDestructive: number;
  firstGuard: number;
  hasRaise: boolean;
};
export declare function readArtifact(
  artifactDir: string,
): Array<{ name: string; sql: string; checksum: string }>;
export declare function verifyArtifact(
  input: VerifyArtifactInput,
): ArtifactReport;
