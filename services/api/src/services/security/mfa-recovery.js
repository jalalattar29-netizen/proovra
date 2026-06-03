/**
 * PHASE R8.1 — Real MFA: backup recovery codes.
 *
 * Pure synchronous module. Implements bounded one-time recovery
 * codes for MFA. Two-layer protection:
 *
 *   1. Deterministic SHA-256 LOOKUP HASH — used to find the row in
 *      O(1) without a table scan. A stolen lookup hash alone is
 *      useless to an attacker because:
 *   2. Per-row scrypt VERIFIER — derived from (code, perRowSalt)
 *      with the standard scrypt parameters used elsewhere in the
 *      codebase. Brute-forcing a stolen verifier requires the
 *      plaintext code AND the salt.
 *
 * Recovery codes are 10 characters from an unambiguous alphabet (no
 * 0/O/1/I/L) split as XXXXX-XXXXX for human transcription. Each
 * batch contains 10 codes; the caller displays them ONCE and
 * persists only the hashed forms.
 *
 * SECURITY:
 *   - Generation uses `crypto.randomBytes` (CSPRNG).
 *   - Verification uses `crypto.timingSafeEqual`.
 *   - The module NEVER logs the plaintext code, the lookup hash,
 *     OR the verifier.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual, } from "node:crypto";
/**
 * Unambiguous character set — excludes 0/O/1/I/L to remove
 * transcription confusion. 32 characters → 5 bits per character →
 * 10 characters = 50 bits of entropy per code. The bounded batch
 * size + one-time-use guarantee makes 50 bits ample.
 */
const RECOVERY_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
/** Bounded number of codes per batch. */
export const RECOVERY_CODE_BATCH_SIZE = 10;
/** Code length INCLUDING the hyphen separator (XXXXX-XXXXX). */
export const RECOVERY_CODE_LENGTH = 11;
/** scrypt parameters — match the codebase's password-hash defaults. */
const SCRYPT_N = 1 << 14; // 16384
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_DK_LEN = 32;
/**
 * Generate a single recovery code formatted as `XXXXX-XXXXX`.
 *
 * Uses CSPRNG with rejection sampling: the alphabet is 31 chars
 * (we excluded 0/1/I/L/O from the base 32-char set), so a raw
 * `byte & 0x1f` can yield 31 which is out of range. We reject any
 * byte whose 5-bit mask equals 31 and refill from a fresh CSPRNG
 * pool when we exhaust the current buffer. This keeps the output
 * unbiased across the 31-char alphabet.
 */
export function generateRecoveryCode() {
    const chars = [];
    while (chars.length < 10) {
        const buf = randomBytes(32);
        for (let i = 0; i < buf.length && chars.length < 10; i += 1) {
            const idx = buf[i] & 0x1f;
            if (idx >= RECOVERY_CODE_ALPHABET.length)
                continue;
            chars.push(RECOVERY_CODE_ALPHABET[idx]);
        }
    }
    return `${chars.slice(0, 5).join("")}-${chars.slice(5).join("")}`;
}
/** Generate a bounded batch of recovery codes (default size 10). */
export function generateRecoveryBatch(size = RECOVERY_CODE_BATCH_SIZE) {
    if (size <= 0 || size > 50) {
        throw new Error("invalid_recovery_batch_size");
    }
    const codes = [];
    for (let i = 0; i < size; i += 1) {
        codes.push(generateRecoveryCode());
    }
    return codes;
}
/**
 * Normalize a user-supplied code for storage / lookup. Strips
 * whitespace, uppercases, and removes the visual hyphen. The
 * normalized form is what we hash + scrypt.
 */
export function normalizeRecoveryCode(input) {
    return (input ?? "")
        .toUpperCase()
        .replace(/\s+/g, "")
        .replace(/-/g, "");
}
/**
 * Deterministic SHA-256 lookup hash. Hex-encoded so it fits a
 * VARCHAR(64) column with a UNIQUE index. Identical input → identical
 * output (intentional, for O(1) lookup).
 */
export function computeLookupHash(rawCode) {
    const normalized = normalizeRecoveryCode(rawCode);
    return createHash("sha256").update(normalized, "utf8").digest("hex");
}
/**
 * Compute the scrypt verifier for a freshly-issued code. The salt
 * is freshly random per code so two identical (never-happening)
 * codes would not collide.
 */
export function buildRecoveryVerifier(rawCode) {
    const salt = randomBytes(16);
    const normalized = normalizeRecoveryCode(rawCode);
    const verifier = scryptSync(normalized, salt, SCRYPT_DK_LEN, {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
    });
    return { salt, verifier };
}
/**
 * Verify a user-supplied code against a stored (salt, verifier) pair.
 * Uses `timingSafeEqual` so partial matches don't leak via timing.
 */
export function verifyRecoveryVerifier(rawCode, stored) {
    const normalized = normalizeRecoveryCode(rawCode);
    if (normalized.length !== 10)
        return false;
    const candidate = scryptSync(normalized, stored.salt, stored.verifier.length, {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
    });
    return (candidate.length === stored.verifier.length &&
        timingSafeEqual(candidate, stored.verifier));
}
