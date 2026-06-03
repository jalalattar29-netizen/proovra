/**
 * PHASE R8.1 — Real MFA: RFC 6238 TOTP implementation.
 *
 * Pure synchronous module. Implements TOTP using Node's built-in
 * `crypto` primitives — no external dependency, no `otplib`, no
 * `speakeasy`. The algorithm is well-known and small enough that a
 * minimal in-house implementation is easier to audit than a third-
 * party library.
 *
 * Pinned parameters (matching every mainstream authenticator app):
 *   - Algorithm: HMAC-SHA1
 *   - Digits:    6
 *   - Period:    30 seconds
 *   - Time step: floor(unixTimeSeconds / period)
 *
 * Verification window: ±1 step (i.e. up to 30 seconds clock skew on
 * either side). This is the standard tradeoff between user
 * experience (typing latency) and replay-window size.
 *
 * Secrets are emitted as Base32 (RFC 4648) so users can type them
 * manually into authenticator apps that don't scan QR codes.
 *
 * SECURITY CONTRACT:
 *   - Secret generation uses `crypto.randomBytes` (CSPRNG).
 *   - Code verification uses `crypto.timingSafeEqual` to prevent
 *     timing-attack disclosure of partial matches.
 *   - The module NEVER logs the secret OR the user code.
 *   - The module NEVER returns the secret as a side-channel; the
 *     caller stores it via the canonical encrypted-storage helper.
 */
import { createHmac, randomBytes, timingSafeEqual, } from "node:crypto";
const RFC4648_BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** Pinned TOTP parameters. */
export const TOTP_ALGORITHM = "SHA1";
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
/**
 * ±1 step verification window. 30 s clock skew either side is the
 * universal default; widening it weakens replay protection.
 */
export const TOTP_DEFAULT_WINDOW = 1;
/**
 * Generate a fresh TOTP shared secret. Returns 20 bytes (160 bits) —
 * the RFC 6238 reference length for SHA-1 HOTP/TOTP. The caller MUST
 * encrypt this before persistence and MUST NOT log it.
 */
export function generateTotpSecretBytes() {
    return randomBytes(20);
}
/**
 * Encode raw bytes as RFC 4648 Base32 (uppercase, no padding). This
 * is the format every authenticator app accepts as manual-entry text
 * AND as the `secret=` parameter of the `otpauth://` URI.
 */
export function encodeBase32(buf) {
    let bits = 0;
    let value = 0;
    let out = "";
    for (let i = 0; i < buf.length; i += 1) {
        value = (value << 8) | buf[i];
        bits += 8;
        while (bits >= 5) {
            out += RFC4648_BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
            bits -= 5;
        }
    }
    if (bits > 0) {
        out += RFC4648_BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
    }
    return out;
}
/**
 * Decode an RFC 4648 Base32 string (case-insensitive; pads tolerated)
 * back to bytes. Used by the verification path so the caller can
 * round-trip secret values through user-visible representations.
 */
export function decodeBase32(input) {
    const cleaned = input
        .toUpperCase()
        .replace(/=+$/g, "")
        .replace(/\s+/g, "");
    let bits = 0;
    let value = 0;
    const out = [];
    for (let i = 0; i < cleaned.length; i += 1) {
        const idx = RFC4648_BASE32_ALPHABET.indexOf(cleaned[i]);
        if (idx < 0) {
            throw new Error("invalid_base32_character");
        }
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}
/**
 * Compute the RFC 6238 TOTP code for a given secret + time step.
 * Returns a zero-padded `digits`-length string.
 */
export function computeTotpCode(secret, step, digits = TOTP_DIGITS) {
    // RFC 4226 — HOTP counter is a 64-bit big-endian integer. Node
    // doesn't have a built-in u64; we write a 0-32 high half and a
    // step low half. step is a JS number, safe up to 2^53.
    const counter = Buffer.alloc(8);
    // Step values stay well within 32-bit range for the next several
    // thousand years (2^32 * 30 seconds ≈ 4000 years), so the high
    // word stays zero in practice. Encode safely either way.
    const high = Math.floor(step / 0x1_0000_0000);
    const low = step >>> 0;
    counter.writeUInt32BE(high, 0);
    counter.writeUInt32BE(low, 4);
    const hmac = createHmac("sha1", secret).update(counter).digest();
    // RFC 4226 dynamic truncation: last nibble of the HMAC selects a
    // 4-byte window; the high bit of the window is masked off.
    const offset = hmac[hmac.length - 1] & 0x0f;
    const binary = ((hmac[offset] & 0x7f) << 24) |
        ((hmac[offset + 1] & 0xff) << 16) |
        ((hmac[offset + 2] & 0xff) << 8) |
        (hmac[offset + 3] & 0xff);
    const code = binary % 10 ** digits;
    return code.toString().padStart(digits, "0");
}
/** Time step for a unix-seconds timestamp under the pinned period. */
export function timeStep(unixSeconds, period = TOTP_PERIOD_SECONDS) {
    return Math.floor(unixSeconds / period);
}
/**
 * Verify a user-supplied TOTP code against a secret, allowing the
 * pinned ±`window` step tolerance. Uses `timingSafeEqual` so partial
 * matches don't leak via timing.
 *
 * Returns `true` on match, `false` otherwise. Never throws on a
 * malformed code (returns false instead).
 *
 * SECURITY: callers MUST emit a `mfa_verification_failed` event on
 * `false` and a `mfa_verification_succeeded` event on `true`, but
 * MUST NOT include the code itself in the audit payload.
 */
export function verifyTotpCode(secret, userCode, options = {}) {
    const cleaned = (userCode ?? "").replace(/\s+/g, "");
    const digits = options.digits ?? TOTP_DIGITS;
    if (!/^\d+$/.test(cleaned))
        return false;
    if (cleaned.length !== digits)
        return false;
    const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    const window = options.window ?? TOTP_DEFAULT_WINDOW;
    const period = options.period ?? TOTP_PERIOD_SECONDS;
    const currentStep = timeStep(nowSeconds, period);
    const userBuf = Buffer.from(cleaned, "utf8");
    for (let delta = -window; delta <= window; delta += 1) {
        const candidate = computeTotpCode(secret, currentStep + delta, digits);
        const candidateBuf = Buffer.from(candidate, "utf8");
        if (candidateBuf.length === userBuf.length &&
            timingSafeEqual(candidateBuf, userBuf)) {
            return true;
        }
    }
    return false;
}
/**
 * Build the canonical `otpauth://totp/...` URI that authenticator
 * apps consume (either by scanning a QR or by manual entry).
 *
 * Per the de-facto Key Uri Format (Google Authenticator wiki):
 *   otpauth://totp/{label}?secret={Base32}&issuer={issuer}
 *     &algorithm=SHA1&digits=6&period=30
 *
 * The `label` is URL-encoded; the issuer is repeated in both the
 * label prefix and the `issuer=` query parameter for compatibility
 * with apps that read one but not the other.
 *
 * Callers MUST treat the returned URI as a secret — it contains the
 * shared secret. Render it ONCE inside an authenticated session and
 * never store or log it.
 */
export function buildOtpauthUri(input) {
    const secretBase32 = encodeBase32(input.secret);
    const label = `${input.issuer}:${input.accountName}`;
    const params = new URLSearchParams({
        secret: secretBase32,
        issuer: input.issuer,
        algorithm: TOTP_ALGORITHM,
        digits: String(TOTP_DIGITS),
        period: String(TOTP_PERIOD_SECONDS),
    });
    return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}
