/** Types for the built-manifest planner (plain ESM, manifest-plan.mjs). */
export const E2E_EXTENSION_PUBLIC_KEY: string;
export const E2E_EXTENSION_ID: string;
export const E2E_OAUTH_REDIRECT: string;
export function originMatchPattern(origin: string): string;
export function parseOriginList(raw: string | null | undefined): string[];
export function planManifest(
  source: Record<string, unknown>,
  opts: { apiOrigin: string; storageOrigins?: string[]; e2e?: boolean },
): Record<string, unknown> & { host_permissions: string[]; key?: string };
export function releaseManifestProblems(
  manifest: Record<string, unknown>,
  opts: { apiOrigin: string; storageOrigins?: string[] },
): string[];
