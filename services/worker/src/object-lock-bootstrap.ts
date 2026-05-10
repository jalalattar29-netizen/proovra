/**
 * Phase C #1 — Object Lock startup bootstrap (worker).
 *
 * Mirrors services/api/src/bootstrap/object-lock-verification.ts so the
 * worker applies the same policy: in production-shaped envs, fail to start
 * when S3_OBJECT_LOCK_ENABLED=true but the bucket cannot accept retention
 * writes.
 */
import { logger } from "./logger.js";
import { verifyObjectLockConfiguration } from "./storage.js";

function isProductionShapedEnv(): boolean {
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
  return false;
}

export async function bootstrapObjectLockVerification(): Promise<void> {
  const result = await verifyObjectLockConfiguration();

  switch (result.mode) {
    case "disabled":
      logger.info({ phase: "startup.object_lock", mode: "disabled" }, "object_lock.disabled");
      return;
    case "verified":
      logger.info(
        {
          phase: "startup.object_lock",
          mode: "verified",
          bucket: result.configured.bucket,
          defaultMode: result.configured.defaultMode,
          defaultRetainDays: result.configured.defaultRetainDays,
        },
        "object_lock.verified"
      );
      return;
    case "skipped":
      logger.warn(
        { phase: "startup.object_lock", mode: "skipped", reason: result.reason },
        "object_lock.verification_skipped"
      );
      return;
    case "claimed-but-unsupported": {
      const inProd = isProductionShapedEnv();
      const bypass =
        (process.env.OBJECT_LOCK_VERIFICATION_BYPASS ?? "")
          .trim()
          .toLowerCase() === "true";
      if (inProd && !bypass) {
        logger.error(
          {
            phase: "startup.object_lock",
            mode: "claimed-but-unsupported",
            bucket: result.bucket,
            reason: result.reason,
          },
          "object_lock.bootstrap_failed"
        );
        throw new Error(
          `OBJECT_LOCK_BOOTSTRAP_FAILED: S3_OBJECT_LOCK_ENABLED=true but bucket "${result.bucket}" cannot accept Object Lock retention. ${result.reason}. Set OBJECT_LOCK_VERIFICATION_BYPASS=true to start anyway.`
        );
      }
      logger.warn(
        {
          phase: "startup.object_lock",
          mode: "claimed-but-unsupported",
          bucket: result.bucket,
          reason: result.reason,
          isProduction: inProd,
          forced: bypass,
        },
        "object_lock.claimed_but_unsupported"
      );
      return;
    }
  }
}
