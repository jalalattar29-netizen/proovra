/**
 * Phase C #1 — Object Lock startup verification bootstrap.
 *
 * Decides what to do with the verifyObjectLockConfiguration() result based on
 * the deployment environment. The intent is:
 *
 *   - In production-shaped environments, refuse to start unless evidence
 *     storage meets the retention contract (AUD-010): Object Lock enabled,
 *     COMPLIANCE, at least 2920 days, verified against the bucket.
 *
 *   - In dev / local / preview, log a clear warning so the developer sees
 *     the gap without blocking iteration.
 *
 * This module is shared between the API and the worker so both surfaces
 * apply the same policy.
 */

import { decideObjectLockBootstrap } from "@proovra/shared";
import { resolveDeploymentEnvironment } from "@proovra/shared-runtime";

import {
  verifyObjectLockConfiguration,
  type ObjectLockVerificationResult,
} from "../storage.js";

export interface ObjectLockBootstrapLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export function isProductionShapedEnv(): boolean {
  // We deliberately do NOT rely on NODE_ENV alone. NODE_ENV can be undefined
  // in production containers; falling back to it would silently skip safety
  // in real deployments. We accept multiple conventional signals so this
  // works on Vercel, Render, Fly, custom Docker, etc.
  const candidates = [
    process.env.PROOVRA_ENV,
    process.env.APP_ENV,
    process.env.DEPLOY_ENV,
    process.env.VERCEL_ENV,
    process.env.RENDER,
    process.env.NODE_ENV,
  ];
  for (const raw of candidates) {
    if (typeof raw !== "string") continue;
    const value = raw.trim().toLowerCase();
    if (value === "production" || value === "prod") return true;
  }
  // F-41 (independent forward audit) — an environment with no usable
  // classification is production-shaped: it fails closed. That covers both the
  // UNDECLARED container (closure re-audit: not assumed to be a laptop) and the
  // AMBIGUOUS one (conflicting or unrecognised declarations carry no kind; the
  // only ambiguous case that does — a development/test claim on a
  // NODE_ENV=production build — is already production-shaped above).
  return resolveDeploymentEnvironment().kind === null;
}

/**
 * Run the verification and apply the ONE startup decision
 * (`decideObjectLockBootstrap`, @proovra/shared — the worker applies the same
 * one). Throws in production on every shortfall: Object Lock disabled, a mode
 * other than COMPLIANCE, a period under 2920 days, a probe that was skipped,
 * a bucket that cannot hold locks, or a bucket default retention weaker than
 * the contract. There is no bypass in production (AUD-010): the old
 * OBJECT_LOCK_VERIFICATION_BYPASS let a production deployment start writing
 * evidence it then had to describe as unprotected record by record.
 */
export async function bootstrapObjectLockVerification(
  logger: ObjectLockBootstrapLogger,
): Promise<ObjectLockVerificationResult> {
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
  return result;
}
