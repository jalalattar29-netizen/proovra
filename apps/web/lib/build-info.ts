/**
 * Build information - auto-generated at build time
 * Shows git commit SHA, build time, and environment
 */

export function getBuildInfo() {
  const buildTime = process.env.BUILD_TIME || "dev";
  const commitSha = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || "dev";
  const environment = process.env.NODE_ENV || "development";
  const vercelEnv = process.env.VERCEL_ENV || "dev";

  return {
    buildTime,
    commitSha: commitSha.substring(0, 8),
    environment,
    vercelEnv,
    buildId: `${environment}-${commitSha.substring(0, 8)}-${buildTime}`.replace(/\s+/g, "_")
  };
}

export function formatBuildInfo(): string {
  const info = getBuildInfo();
  return `Build: ${info.buildId} | Env: ${info.vercelEnv} | Time: ${info.buildTime}`;
}
