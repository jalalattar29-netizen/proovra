/**
 * B8-F-303 / B8-F-305 (free-audit 0ea0) — per-queue consumer concurrency that
 * an operator can raise without a code change. The literals these replace
 * (report 2, ots-upgrade 1) stay the defaults, so an unset environment runs
 * exactly as before. A value must be a whole number from 1 to 32; anything
 * else stops the process rather than guessing (the DATABASE_POOL_MAX rule).
 *
 * Raising a value multiplies Chromium memory (report) or calendar calls
 * (ots-upgrade) per worker, and needs DATABASE_POOL_MAX headroom
 * (`databasePoolHeadroomWarning`, db.ts). The right numbers are a staging
 * measurement (T_report, OTS call time) — see the free-audit register.
 */
export const WORKER_CONCURRENCY_SETTINGS = {
  report: { env: "WORKER_REPORT_CONCURRENCY", defaultValue: 2 },
  otsUpgrade: { env: "WORKER_OTS_UPGRADE_CONCURRENCY", defaultValue: 1 },
} as const;

export function workerQueueConcurrency(
  setting: { env: string; defaultValue: number },
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[setting.env];
  if (raw === undefined || raw.trim() === "") return setting.defaultValue;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1 || n > 32) {
    throw new Error(`${setting.env} must be a whole number from 1 to 32`);
  }
  return n;
}
