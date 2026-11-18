/**
 * PRO-G1-02 — THE at-rest wrap for webhook SIGNING secrets.
 *
 * Three channels sign outbound webhooks with a per-endpoint secret the platform
 * must be able to read back at send time:
 *   - integration webhooks (API, `webhook_endpoints_v1`) — already AES-256-GCM
 *     with a random IV;
 *   - automation destinations (API) — were XOR-ed with ONE keystream shared by
 *     every tenant (`e3.2:`), so one known plaintext recovered every tenant's
 *     secret, and decryption never failed (a key change silently corrupted
 *     every stored secret);
 *   - lifecycle endpoints (API writes, Worker signs) — were stored in clear.
 *
 * This module is the one authenticated-encryption primitive all three use:
 * AES-256-GCM, a fresh 96-bit nonce per seal, a 128-bit tag, and an AAD naming
 * the channel so an envelope cannot be replayed into another channel's column.
 * Opening FAILS CLOSED (null) on any malformation or tag mismatch.
 *
 * Envelope `e3.3:<base64(iv | ciphertext | tag)>` (automation + lifecycle).
 * The integration channel keeps its historical un-prefixed base64 layout,
 * which is byte-identical to `sealAesGcm` without AAD.
 *
 * Pure node:crypto — no I/O and no environment reads: callers pass the key
 * material, so the API and the Worker derive the same key from the same secret.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

export const WEBHOOK_SECRET_ENVELOPE_PREFIX = "e3.3:" as const;

export type WebhookSecretChannel = "automation-webhook" | "lifecycle-webhook";

/** A 32-byte AES key for the e3.3 envelope, derived from shared key material. */
export function deriveWebhookSecretWrapKey(keyMaterial: string | Buffer): Buffer {
  return createHash("sha256")
    .update("proovra-webhook-signing-secret-wrap-v3|", "utf8")
    .update(keyMaterial)
    .digest();
}

/** AES-256-GCM seal: returns iv | ciphertext | tag. A fresh nonce per call. */
export function sealAesGcm(key: Buffer, plaintext: string, aad?: string): Buffer {
  if (key.length !== 32) throw new Error("webhook_secret_wrap_key_invalid");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]);
}

/** AES-256-GCM open of iv | ciphertext | tag. Null on ANY failure. */
export function openAesGcm(key: Buffer, sealed: Buffer, aad?: string): string | null {
  if (key.length !== 32 || sealed.length < IV_BYTES + TAG_BYTES + 1) return null;
  const iv = sealed.subarray(0, IV_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const ct = sealed.subarray(IV_BYTES, sealed.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Wrap a signing secret into a versioned `e3.3:` envelope bound to its channel. */
export function wrapWebhookSigningSecret(
  plaintext: string,
  keyMaterial: string | Buffer,
  channel: WebhookSecretChannel,
): string {
  const sealed = sealAesGcm(deriveWebhookSecretWrapKey(keyMaterial), plaintext, channel);
  return `${WEBHOOK_SECRET_ENVELOPE_PREFIX}${sealed.toString("base64")}`;
}

export function isWrappedWebhookSigningSecret(stored: string): boolean {
  return stored.startsWith(WEBHOOK_SECRET_ENVELOPE_PREFIX);
}

/**
 * Open an `e3.3:` envelope. Tries each key material in order (current first,
 * then any previous one an operator keeps during a key rotation). Null when the
 * envelope is not e3.3, is malformed, or no key opens it — callers fail closed.
 */
export function unwrapWebhookSigningSecret(
  stored: string,
  keyMaterials: ReadonlyArray<string | Buffer>,
  channel: WebhookSecretChannel,
): string | null {
  if (!isWrappedWebhookSigningSecret(stored)) return null;
  let sealed: Buffer;
  try {
    sealed = Buffer.from(stored.slice(WEBHOOK_SECRET_ENVELOPE_PREFIX.length), "base64");
  } catch {
    return null;
  }
  for (const material of keyMaterials) {
    const opened = openAesGcm(deriveWebhookSecretWrapKey(material), sealed, channel);
    if (opened !== null) return opened;
  }
  return null;
}
