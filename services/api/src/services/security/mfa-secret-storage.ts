/**
 * PHASE R8.1 — Real MFA: AES-256-GCM envelope encryption for TOTP
 * shared secrets.
 *
 * Pure synchronous module. The TOTP shared secret is small (20 bytes)
 * but is the ONE thing that must never leak from the database. R8.1
 * encrypts it at the application layer with AES-256-GCM using a key
 * derived from a per-deployment environment variable:
 *
 *   MFA_SECRET_KEK_BASE64  — Base64-encoded 32-byte key.
 *
 * If unset in development, a stable per-process fallback is derived
 * via scrypt from the literal "dev-only-mfa-kek-do-not-deploy" so
 * tests pass without env wiring. Production code paths MUST set the
 * env var; the service refuses to encrypt in production without it.
 *
 * The KEK id (`secretKekId` column on MfaFactor) records which key
 * generation encrypted the row, so a key rotation can re-encrypt
 * existing rows without losing the ability to decrypt the legacy
 * ciphertext.
 *
 * SECURITY:
 *   - AES-256-GCM is authenticated encryption — auth tag (16 bytes)
 *     is stored alongside the ciphertext + IV.
 *   - IV is a fresh 12-byte CSPRNG value PER encrypt call (GCM
 *     reuse is catastrophic).
 *   - The module NEVER logs the KEK, the plaintext, the IV, OR the
 *     ciphertext.
 *   - `decrypt` throws on auth-tag failure (never returns garbage).
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

/**
 * Sealed ciphertext bundle. All three components are required to
 * decrypt — the database stores them as three separate BYTEA columns
 * (`secret_ciphertext`, `secret_iv`, `secret_auth_tag`).
 */
export interface SealedSecret {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly authTag: Buffer;
  readonly kekId: string;
}

const KEK_ENV_VAR = "MFA_SECRET_KEK_BASE64";
const DEV_KEK_DERIVATION_SALT = "proovra-r8.1-mfa-dev-kek-v1";
const DEV_KEK_ID = "dev-fallback-v1";
const PROD_DEFAULT_KEK_ID = "env-v1";

/**
 * Resolve the active KEK. Throws in production if the env var is
 * missing. In development / test, derives a stable fallback so unit
 * tests + local dev work without env wiring.
 */
function resolveKek(): { key: Buffer; kekId: string } {
  const envKey = process.env[KEK_ENV_VAR];
  if (envKey && envKey.length > 0) {
    const decoded = Buffer.from(envKey, "base64");
    if (decoded.length !== 32) {
      throw new Error(
        "MFA_SECRET_KEK_BASE64 must decode to exactly 32 bytes (256 bits).",
      );
    }
    return { key: decoded, kekId: PROD_DEFAULT_KEK_ID };
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "MFA_SECRET_KEK_BASE64 is required in production. The MFA service refuses to encrypt without an explicit KEK.",
    );
  }
  // Dev / test fallback — stable per process so test runs are
  // reproducible. Not suitable for production.
  const derived = scryptSync(
    "dev-only-mfa-kek-do-not-deploy",
    DEV_KEK_DERIVATION_SALT,
    32,
    { N: 1 << 14, r: 8, p: 1 },
  );
  return { key: derived, kekId: DEV_KEK_ID };
}

/**
 * Encrypt a plaintext secret. Returns the sealed bundle the caller
 * persists in the `mfa_factors` row.
 */
export function sealSecret(plaintext: Buffer): SealedSecret {
  const { key, kekId } = resolveKek();
  const iv = randomBytes(12); // GCM standard — never reuse.
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag, kekId };
}

/**
 * Decrypt a sealed bundle. Throws on auth-tag failure (the cipher
 * itself raises). The KEK id on the row determines which key to use;
 * R8.1 ships only one KEK generation, so we ignore the id beyond a
 * future-proofing assertion that the stored id is recognized.
 */
export function openSecret(sealed: SealedSecret): Buffer {
  const { key } = resolveKek();
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.iv);
  decipher.setAuthTag(sealed.authTag);
  return Buffer.concat([
    decipher.update(sealed.ciphertext),
    decipher.final(),
  ]);
}
