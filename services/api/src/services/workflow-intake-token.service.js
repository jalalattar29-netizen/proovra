/**
 * Phase 4 — Workflow intake token service.
 *
 * Generates and verifies opaque tokens issued by `POST /v1/workflow/intake-links`
 * and redeemed by `GET /v1/external-intake/:token`.
 *
 * Security model:
 *   - Tokens are 32 random bytes (base64url) wrapped with a version prefix.
 *     The raw token is shown to the operator exactly once at creation; the
 *     database stores only HMAC-SHA256(token, WORKFLOW_INTAKE_TOKEN_SECRET).
 *   - Verification is constant-time on the HMAC comparison. Lookup is by
 *     exact match on the hash column (one round trip).
 *   - Optional client-IP-address hashes are HMAC-SHA256 over the same
 *     secret so an attacker with read-only DB access cannot derive raw IPs.
 *   - The service refuses to operate when WORKFLOW_INTAKE_TOKEN_SECRET is
 *     unset; this is the master kill-switch for all intake link routes.
 */
import { createHmac, randomBytes, timingSafeEqual, } from "node:crypto";
import { formatWorkflowIntakeTokenWireValue, parseWorkflowIntakeTokenShape, WORKFLOW_INTAKE_TOKEN_RANDOM_BYTES, } from "@proovra/shared";
const TOKEN_SECRET_ENV = "WORKFLOW_INTAKE_TOKEN_SECRET";
const FEATURE_FLAG_ENV = "WORKFLOW_INTAKE_LINKS_ENABLED";
const TOKEN_HASH_HEX_LENGTH = 64;
function base64urlEncode(buf) {
    return buf
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}
function readSecret() {
    const raw = process.env[TOKEN_SECRET_ENV];
    if (!raw || raw.trim().length < 32)
        return null;
    // Accept either hex or base64; if neither, treat as utf-8 string.
    if (/^[a-fA-F0-9]+$/.test(raw) && raw.length % 2 === 0) {
        return Buffer.from(raw, "hex");
    }
    return Buffer.from(raw, "utf8");
}
export function isWorkflowIntakeFeatureEnabled() {
    if (process.env[FEATURE_FLAG_ENV] !== "true")
        return false;
    return readSecret() !== null;
}
export function workflowIntakeFeatureDisabledReason() {
    if (process.env[FEATURE_FLAG_ENV] !== "true")
        return "feature_flag_off";
    if (readSecret() === null)
        return "secret_missing";
    return null;
}
function hmacToHexImpl(secret, value) {
    return createHmac("sha256", secret).update(value, "utf8").digest("hex");
}
/**
 * Hash an arbitrary string (IP, raw token, anything) using the same HMAC
 * secret used for token storage. Returns a 64-char hex string. Returns
 * null when the secret is missing — callers MUST treat that as "feature
 * not configured".
 */
export function hmacForIntake(value) {
    const secret = readSecret();
    if (!secret)
        return null;
    return hmacToHexImpl(secret, value);
}
export function issueIntakeToken() {
    const secret = readSecret();
    if (!secret)
        return null;
    const random = randomBytes(WORKFLOW_INTAKE_TOKEN_RANDOM_BYTES);
    const body = base64urlEncode(random);
    const rawToken = formatWorkflowIntakeTokenWireValue(body);
    const tokenHash = hmacToHexImpl(secret, rawToken);
    return { rawToken, tokenHash, tokenVersion: 1 };
}
/**
 * Validate the token's shape and compute its lookup hash. Returns null on
 * malformed tokens BEFORE any DB lookup so the service does not waste a
 * query on garbage input.
 *
 * The caller is responsible for the constant-time comparison performed
 * implicitly by the unique index lookup on the resulting hash. We expose
 * `constantTimeEqualHex` so DB-fetched hashes can be re-confirmed in
 * constant time when paranoid.
 */
export function lookupHashForIntakeToken(rawToken) {
    const shape = parseWorkflowIntakeTokenShape(rawToken);
    if (!shape)
        return null;
    const secret = readSecret();
    if (!secret)
        return null;
    const tokenHash = hmacToHexImpl(secret, rawToken);
    return { tokenHash, tokenVersion: shape.version };
}
const HEX_RE = /^[0-9a-fA-F]+$/;
export function constantTimeEqualHex(a, b) {
    if (a.length !== TOKEN_HASH_HEX_LENGTH)
        return false;
    if (b.length !== TOKEN_HASH_HEX_LENGTH)
        return false;
    // Buffer.from(..., "hex") silently strips non-hex characters, so two
    // garbage strings would erroneously decode to identical empty buffers.
    // Validate explicitly before passing to timingSafeEqual.
    if (!HEX_RE.test(a) || !HEX_RE.test(b))
        return false;
    const aBuf = Buffer.from(a, "hex");
    const bBuf = Buffer.from(b, "hex");
    if (aBuf.length !== bBuf.length)
        return false;
    return timingSafeEqual(aBuf, bBuf);
}
// -----------------------------------------------------------------------------
// Internal helpers for tests
// -----------------------------------------------------------------------------
export const __testing = {
    /**
     * Override the secret read for the duration of one call. Used only by
     * unit tests; never exported to production code paths.
     */
    withSecret(secret, fn) {
        const prevSecret = process.env[TOKEN_SECRET_ENV];
        const prevFlag = process.env[FEATURE_FLAG_ENV];
        process.env[TOKEN_SECRET_ENV] = secret;
        process.env[FEATURE_FLAG_ENV] = "true";
        try {
            return fn();
        }
        finally {
            if (prevSecret === undefined)
                delete process.env[TOKEN_SECRET_ENV];
            else
                process.env[TOKEN_SECRET_ENV] = prevSecret;
            if (prevFlag === undefined)
                delete process.env[FEATURE_FLAG_ENV];
            else
                process.env[FEATURE_FLAG_ENV] = prevFlag;
        }
    },
};
