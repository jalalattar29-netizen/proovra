/**
 * Phase 2.5D — Ambient TypeScript declaration for the shared DB
 * host policy module (`db-host-policy.mjs`). Lets `prisma.config.ts`
 * import the policy without losing type information.
 */

export type HostClassification = "local" | "remote" | "unknown";

export const SAFE_HOSTS: ReadonlySet<string>;
export const REMOTE_PATTERNS: ReadonlyArray<RegExp>;

export function classifyHost(host: string): HostClassification;

export function parseDatabaseHost(url: string): {
  host: string;
  port: string;
  database: string;
  protocol: string;
};

export function shouldAllowMigration(args: {
  classification: HostClassification;
  allowRemoteFlag: boolean;
  envOverride: boolean;
}): { allow: boolean; reason: string };
