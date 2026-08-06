/** PHASE 12 — POINT 8: types for the wave-aware migration deployer. */
export declare const WAVES: Record<string, string[]>;
export declare function loadWaves(): Record<string, string>;
export declare function selectForWave(args: {
  artifactMigrations: string[];
  wave: string;
  waves: Record<string, string>;
}): { selected: string[]; deferred: string[]; unclassified: string[] };
export declare function deployWave(args: {
  artifactDir: string;
  wave: string;
  dryRun?: boolean;
  databaseUrl?: string;
  out?: string;
}): Promise<{
  wave: string;
  selected: string[];
  deferred: string[];
  stage: string;
  applied: boolean;
  appliedCount?: number;
  output?: string;
}>;
