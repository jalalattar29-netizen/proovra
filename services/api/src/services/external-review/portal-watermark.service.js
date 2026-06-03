/**
 * PROOVRA Phase 2B — Watermark service.
 *
 * Server-side builder for the bounded `SignedWatermark` payload that
 * the portal client renders as a translucent CSS overlay on top of
 * the evidence viewer. The HMAC-SHA256 signature lets the portal
 * surface prove its watermark came from PROOVRA without exposing
 * the signing key.
 *
 * Hard rules:
 *   * NEVER includes content bytes; never decisions.
 *   * Bounded fields only: grant id, session id, reviewer email,
 *     display name, organisation, evidence id, issued-at, ttl.
 *   * Signed with a per-deployment secret (env `PORTAL_WATERMARK_HMAC`).
 *   * Bounded TTL — the watermark token is never valid past the
 *     grant's expiry or 4 hours, whichever is sooner.
 */
import { createHmac } from "node:crypto";
import { canonicalJson, } from "@proovra/shared";
const WATERMARK_TTL_S_MAX = 4 * 60 * 60; // 4h
const WATERMARK_SCHEMA = "PROOVRA_WATERMARK_V1";
function secret() {
    const v = process.env.PORTAL_WATERMARK_HMAC;
    if (!v || v.length < 16) {
        // Fail closed if the operator has not provisioned a secret.
        // The portal handler refuses to render watermark UI without one.
        return "";
    }
    return v;
}
export function buildSignedWatermark(input) {
    const k = secret();
    if (!k)
        return null;
    const now = new Date();
    const grantTtlS = Math.floor((input.grantExpiresAtUtc.getTime() - now.getTime()) / 1000);
    if (grantTtlS <= 0)
        return null;
    const ttlSeconds = Math.min(WATERMARK_TTL_S_MAX, grantTtlS);
    const payload = {
        schemaVersion: WATERMARK_SCHEMA,
        grantId: input.grantId,
        sessionId: input.sessionId,
        reviewerEmail: input.reviewerEmail,
        reviewerDisplayName: input.reviewerDisplayName,
        organization: input.organization,
        evidenceId: input.evidenceId,
        issuedAtUtc: now.toISOString(),
        ttlSeconds,
    };
    const canonical = canonicalJson(payload);
    const signatureHex = createHmac("sha256", k).update(canonical).digest("hex");
    return { payload, signatureHex };
}
/**
 * Verify a watermark token. Used by the portal session middleware to
 * confirm a watermark observed in the wild was issued by PROOVRA.
 */
export function verifySignedWatermark(signed) {
    const k = secret();
    if (!k)
        return { valid: false, reason: "PORTAL_WATERMARK_HMAC_MISSING" };
    if (signed.payload.schemaVersion !== WATERMARK_SCHEMA) {
        return { valid: false, reason: "SCHEMA_MISMATCH" };
    }
    try {
        const canonical = canonicalJson(signed.payload);
        const expected = createHmac("sha256", k).update(canonical).digest("hex");
        if (expected !== signed.signatureHex) {
            return { valid: false, reason: "SIGNATURE_INVALID" };
        }
        const issued = new Date(signed.payload.issuedAtUtc).getTime();
        const expires = issued + signed.payload.ttlSeconds * 1000;
        if (Date.now() > expires)
            return { valid: false, reason: "EXPIRED" };
        return { valid: true };
    }
    catch {
        return { valid: false, reason: "PARSE_FAILED" };
    }
}
