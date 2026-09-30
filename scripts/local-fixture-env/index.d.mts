/** Types for the local fixture environment builder (plain ESM, index.mjs). */
export type LocalFixtureEnvOptions = {
  webPort?: string;
  apiPort?: string;
  databaseUrl?: string;
  redisUrl?: string;
  extra?: Record<string, string>;
  allow?: string[];
  /** Typed, shape-checked redirect allow-lists (never endpoints). */
  redirectAllowLists?: Record<string, string[]>;
};
export function buildLocalFixtureEnv(options?: LocalFixtureEnvOptions): Record<string, string>;
export function describeLocalFixtureEnv(env: Record<string, string>): string;
export function findEnvironmentLeaks(
  env: Record<string, unknown>,
  opts?: { allow?: string[]; redirectAllowListNames?: string[] },
): string[];
export function findCredentialShapes(env: Record<string, unknown>, opts?: { allow?: string[] }): string[];
export function redirectAllowListProblems(name: string, entries: unknown): string[];
export class UnsafeFixtureEnvironmentError extends Error {
  leaks: string[];
  constructor(leaks: string[]);
}
export const LOCAL_FIXTURE_DEFAULTS: Readonly<Record<string, string>>;
export const LOCAL_FIXTURE_OS_BASELINE: ReadonlyArray<string>;
export const LOCAL_FIXTURE_FORBIDDEN: ReadonlyArray<string>;
