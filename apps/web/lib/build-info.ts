/**
 * Build information - auto-generated at build time
 * Shows git commit SHA, build time, and environment
 */

export function getBuildInfo() {
  const buildTime = process.env.BUILD_TIME || "dev";
  const commitSha = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || "dev";
  const environment = process.env.NODE_ENV || "development";
  const vercelEnv = process.env.VERCEL_ENV || "dev";

  const shortSha = commitSha.substring(0, 8);

  return {
    buildTime,
    commitSha: shortSha,
    environment,
    vercelEnv,
    buildId: `${environment}-${shortSha}-${buildTime}`.replace(/\s+/g, "_"),
  };
}

/**
 * Controls whether build info is shown.
 *
 * Default behavior:
 * - production: hidden
 * - development/preview: shown
 *
 * Override with env var:
 * - NEXT_PUBLIC_SHOW_BUILD_INFO="true"  -> always show (even in production)
 * - NEXT_PUBLIC_SHOW_BUILD_INFO="false" -> always hide
 */
function shouldShowBuildInfo(): boolean {
  const flag = (process.env.NEXT_PUBLIC_SHOW_BUILD_INFO || "").toLowerCase();

  if (flag === "true") return true;
  if (flag === "false") return false;

  // default
  return process.env.NODE_ENV !== "production";
}

/**
 * Returns a human-readable build info line.
 * IMPORTANT: returns a string always ("" when hidden) to avoid UI crashes.
 */
export function formatBuildInfo(): string {
  if (!shouldShowBuildInfo()) return "";

  const info = getBuildInfo();
  return `Build: ${info.buildId} | Env: ${info.vercelEnv} | Time: ${info.buildTime}`;
}