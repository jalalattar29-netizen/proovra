/**
 * Phase C #1 — Object Lock startup bootstrap (worker).
 *
 * Applies the same decision as services/api/src/bootstrap/object-lock-verification.ts
 * (one shared rule): in production-shaped envs, refuse to start unless
 * evidence storage meets the retention contract.
 */
import { decideObjectLockBootstrap } from "@proovra/shared";
import { resolveDeploymentEnvironment } from "@proovra/shared-runtime";

import { logger } from "./logger.js";
import { verifyObjectLockConfiguration } from "./storage.js";

export function isProductionShapedEnv(): boolean {
  const candidates = [
    process.env.PROOVRA_ENV,
    process.env.APP_ENV,
    process.env.DEPLOY_ENV,
    process.env.VERCEL_ENV,
    process.env.NODE_ENV,
  ];
  for (const raw of candidates) {
    if (typeof raw !== "string") continue;
    const value = raw.trim().toLowerCase();
    if (value === "production" || value === "prod") return true;
  }
  const renderFlag = (process.env.RENDER ?? "").trim().toLowerCase();
  if (renderFlag === "true" || renderFlag === "1") return true;
  // F-41 (independent forward audit) — an AMBIGUOUS classification (conflicting
  // or unrecognised declarations) is production-shaped: it fails closed.
  return resolveDeploymentEnvironment().ambiguous;
}

/**
 * The SAME startup decision the API applies (`decideObjectLockBootstrap`,
 * @proovra/shared). In production every shortfall refuses to start — Object
 * Lock disabled, not COMPLIANCE, under 2920 days, unverifiable, unsupported by
 * the bucket, or a weaker bucket default — and there is no bypass (AUD-010).
 */
export async function bootstrapObjectLockVerification(): Promise<void> {
  const result = await verifyObjectLockConfiguration();
  const production = isProductionShapedEnv();
  const decision = decideObjectLockBootstrap(result, { production, env: process.env });
  const detail = {
    phase: "startup.object_lock",
    mode: result.mode,
    isProduction: production,
    ...(result.mode === "verified"
      ? {
          bucket: result.configured.bucket,
          defaultMode: result.configured.defaultMode,
          defaultRetainDays: result.configured.defaultRetainDays,
        }
      : {}),
    ...(result.mode === "claimed-but-unsupported" ? { bucket: result.bucket } : {}),
    ...(result.mode === "skipped" || result.mode === "claimed-but-unsupported"
      ? { reason: result.reason }
      : {}),
  };
  if (decision.action === "refuse") {
    logger.error({ ...detail, refusal: decision.reason }, decision.event);
    throw new Error(
      `OBJECT_LOCK_BOOTSTRAP_FAILED: evidence storage does not meet the retention contract (S3 Object Lock COMPLIANCE, at least 2920 days): ${decision.reason}`,
    );
  }
  if (decision.level === "warn") logger.warn(detail, decision.event);
  else logger.info(detail, decision.event);
}
