/** PHASE 12 — POINT 8: types for the release-artifact materializer. */
export declare const PROPOSED_ADDITIONS: Record<string, string>;
export declare const PROPOSED_EXCLUSIONS: Record<string, string>;
export declare function materialize(args: { view: "head" | "proposed" | "worktree"; out: string }): {
  view: string;
  gitCommit: string;
  migrationCount: number;
  migrations: string[];
  checksums: Record<string, string>;
  artifactDigest: string;
};
