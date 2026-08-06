/**
 * PHASE 12 — POINT 8: types for the census/preflight module.
 *
 * The module itself is plain `.mjs` so it can run as a pre-everything script
 * with bare `node`, before any TypeScript loader is in play — the same reason
 * the Point-7 isolation canary is not a test. These declarations let the
 * TypeScript suites consume it without loosening `noImplicitAny`.
 */

export type CredentialClassification =
  | "SANDBOX_OR_STAGING_VERIFIED"
  | "PRODUCTION_FORBIDDEN"
  | "LOCAL_FAKE_ONLY"
  | "CONFIGURED_BUT_UNKNOWN"
  | "MISSING";

export type HostCategory =
  | "loopback"
  | "docker-service"
  | "provider-sandbox-endpoint"
  | "staging-named-host"
  | "placeholder-host"
  | "external-host"
  | "no-host";

export interface EnvFileClassification {
  file: string;
  present: boolean;
  keys?: number;
  productionBearing: boolean;
  liveMarkers: string[];
}

export interface CensusItem {
  required: string;
  gates: number[];
  configuredIn: string;
  classification: CredentialClassification;
  evidence: string[];
  observedInFiles: string[];
}

export interface CensusResult {
  files: EnvFileClassification[];
  items: CensusItem[];
  metrics: {
    censusItems: number;
    byClassification: Record<string, number>;
    productionBearingEnvFiles: string[];
    sandboxOrStagingVerified: number;
    unknownCredentialSelections: number;
  };
}

export interface PreflightChecks {
  ProductionDatabaseSelected: boolean;
  ProductionRedisSelected: boolean;
  ProductionStorageSelected: boolean;
  ProductionPaymentModeSelected: boolean;
  ProductionIdentityTenantSelected: boolean;
  ProductionEmailAudienceSelected: boolean;
  ProductionWebhookReceiverSelected: boolean;
  UnknownCredentialSelections: number;
  /**
   * How many required inputs are VERIFIED sandbox/staging. Every other check
   * is a refusal and can only turn green off; this one is the positive
   * requirement that stops an empty environment — where there is nothing to
   * refuse — from being reported as ready.
   */
  SandboxOrStagingVerified: number;
}

export interface PreflightResult {
  checks: PreflightChecks;
  green: boolean;
  allowlistCategories: HostCategory[];
}

export declare const REPO_ROOT: string;
export declare const ENV_FILES: string[];
export declare const PRODUCTION_MARKERS: ReadonlyArray<[string, (v: string) => boolean, string]>;
export declare const CENSUS_ITEMS: ReadonlyArray<unknown>;

export declare function parseEnvFile(path: string): Map<string, string> | null;
export declare function hostOf(value: string): string | null;
export declare function hostCategory(value: string): HostCategory;
export declare function isRemote(value: string): boolean;
export declare function classifyEnvFile(relPath: string): EnvFileClassification;
export declare function rollUp(modes: string[]): CredentialClassification;
export declare function runCensus(): CensusResult;
export declare function isControlledTestMailbox(address: string | undefined): boolean;
export declare function preflight(
  selection: Record<string, string | undefined>,
  censusResult?: CensusResult,
): PreflightResult;
