/**
 * Phase C #1 — Object Lock startup verification bootstrap.
 *
 * Decides what to do with the verifyObjectLockConfiguration() result based on
 * the deployment environment. The intent is:
 *
 *   - In production-shaped environments, refuse to start the service when
 *     S3_OBJECT_LOCK_ENABLED=true but the bucket cannot accept retention
 *     writes. Operators get a loud failure rather than silent per-record
 *     downgrades.
 *
 *   - In dev / local / preview, log a clear warning so the developer sees
 *     the gap without blocking iteration.
 *
 *   - When Object Lock was never claimed (env unset/false), this is a no-op.
 *
 * This module is shared between the API and the worker so both surfaces
 * apply the same policy.
 */
import { verifyObjectLockConfiguration, } from "../storage.js";
function isProductionShapedEnv() {
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
        if (typeof raw !== "string")
            continue;
        const value = raw.trim().toLowerCase();
        if (value === "production" || value === "prod")
            return true;
    }
    return false;
}
/**
 * Run the verification and apply the policy. Throws in strict mode when the
 * bucket fails the check. Always returns the verification result.
 */
export async function bootstrapObjectLockVerification(logger, options = {}) {
    const result = await verifyObjectLockConfiguration();
    switch (result.mode) {
        case "disabled":
            logger.info({ phase: "startup.object_lock", mode: "disabled" }, "object_lock.disabled");
            return result;
        case "verified":
            logger.info({
                phase: "startup.object_lock",
                mode: "verified",
                bucket: result.configured.bucket,
                defaultMode: result.configured.defaultMode,
                defaultRetainDays: result.configured.defaultRetainDays,
            }, "object_lock.verified");
            return result;
        case "skipped":
            logger.warn({ phase: "startup.object_lock", mode: "skipped", reason: result.reason }, "object_lock.verification_skipped");
            return result;
        case "claimed-but-unsupported": {
            // This is the dangerous case. Env says enabled, bucket says no.
            const inProd = isProductionShapedEnv();
            const bypassAck = (process.env.OBJECT_LOCK_VERIFICATION_BYPASS ?? "")
                .trim()
                .toLowerCase() === "true";
            const force = options.bypass === true || bypassAck;
            if (inProd && !force) {
                logger.error({
                    phase: "startup.object_lock",
                    mode: "claimed-but-unsupported",
                    bucket: result.bucket,
                    reason: result.reason,
                }, "object_lock.bootstrap_failed");
                throw new Error(`OBJECT_LOCK_BOOTSTRAP_FAILED: S3_OBJECT_LOCK_ENABLED=true but the configured bucket "${result.bucket}" cannot accept Object Lock retention. ${result.reason}. Set OBJECT_LOCK_VERIFICATION_BYPASS=true to start anyway and accept that EVIDENCE_LOCKED claims will be downgraded per-record.`);
            }
            logger.warn({
                phase: "startup.object_lock",
                mode: "claimed-but-unsupported",
                bucket: result.bucket,
                reason: result.reason,
                isProduction: inProd,
                forced: force,
            }, "object_lock.claimed_but_unsupported");
            return result;
        }
    }
}
