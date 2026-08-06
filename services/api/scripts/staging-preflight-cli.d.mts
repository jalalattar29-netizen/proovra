/** PHASE 12 — POINT 8: types for the Staging credential preflight command. */
import type { PreflightChecks } from "../test/point8/staging-census.mjs";
export declare const REQUIRED_STAGING_INPUTS: string[];
export declare function selectionFromEnv(env?: Record<string, string | undefined>): Record<string, string>;
export declare function runPreflight(env?: Record<string, string | undefined>): {
  missing: string[];
  checks: PreflightChecks;
  green: boolean;
};
