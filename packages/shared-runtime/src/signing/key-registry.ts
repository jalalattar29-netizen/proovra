/**
 * THE EVIDENCE SIGNING-KEY REGISTRY (UC-TRUST-003, 2026-10-01).
 *
 * `signing_keys (key_id, version)` is the identity every record's signature is
 * verified against. It was a convenience lookup: the seed UPSERTED it (a re-run
 * with a different PEM silently replaced the key of every historical record
 * and cleared any revocation), the signer never checked its own signature
 * against it, and no verifier read `revoked_at`.
 *
 * The rules here:
 *   - a (keyId, version) row is INSERT-ONLY. Registering the same public key
 *     again is a no-op (revocation is never cleared); a DIFFERENT key for an
 *     existing (keyId, version) is refused — rotation is a new version.
 *   - the key's identity is the SHA-256 of its DER SubjectPublicKeyInfo (the
 *     same fingerprint the package seal uses), so PEM whitespace never matters.
 *   - every evidence signature is self-verified against the REGISTERED key
 *     before the record may commit, and a revoked key refuses to sign.
 */
import { createHash, createPublicKey, verify } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

export class SigningKeyRegistryError extends Error {
  constructor(
    public readonly code:
      | "SIGNING_KEY_IDENTITY_CONFLICT"
      | "SIGNING_KEY_NOT_REGISTERED"
      | "SIGNING_KEY_REVOKED"
      | "SIGNING_SELF_VERIFICATION_FAILED",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "SigningKeyRegistryError";
  }
}

/** SHA-256 (hex) of the DER SubjectPublicKeyInfo of a PEM public key. */
export function publicKeySpkiSha256(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem.trim()).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex");
}

/** The public key (SPKI PEM) of a PEM private key. */
export function publicKeyPemFromPrivateKeyPem(privateKeyPem: string): string {
  return createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" }).toString().trim();
}

type RegistryClient = Pick<PrismaClient, "signingKey">;

/**
 * Register (keyId, version) -> publicKeyPem, insert-only.
 *   "created"    no row existed; one was inserted
 *   "unchanged"  the same key is already registered (revocation untouched)
 * Throws SIGNING_KEY_IDENTITY_CONFLICT when a different key is registered.
 */
export async function registerSigningKey(
  client: RegistryClient,
  input: { keyId: string; version: number; publicKeyPem: string },
): Promise<{ outcome: "created" | "unchanged"; publicKeySha256: string; revokedAt: Date | null }> {
  const fingerprint = publicKeySpkiSha256(input.publicKeyPem);
  const existing = await client.signingKey.findUnique({
    where: { keyId_version: { keyId: input.keyId, version: input.version } },
    select: { publicKeyPem: true, revokedAt: true },
  });
  if (existing) {
    if (publicKeySpkiSha256(existing.publicKeyPem) !== fingerprint) {
      throw new SigningKeyRegistryError(
        "SIGNING_KEY_IDENTITY_CONFLICT",
        `signing_keys(${input.keyId}, v${input.version}) already holds a DIFFERENT public key. ` +
          "A registered key is never replaced (it would invalidate every signature made with it); " +
          "rotate by registering a new SIGNING_KEY_VERSION.",
      );
    }
    return { outcome: "unchanged", publicKeySha256: fingerprint, revokedAt: existing.revokedAt };
  }
  try {
    await client.signingKey.create({
      data: { keyId: input.keyId, version: input.version, publicKeyPem: input.publicKeyPem.trim() },
    });
  } catch (err) {
    // A concurrent registration of the same (keyId, version): re-check identity.
    const raced = await client.signingKey.findUnique({
      where: { keyId_version: { keyId: input.keyId, version: input.version } },
      select: { publicKeyPem: true, revokedAt: true },
    });
    if (!raced) throw err;
    if (publicKeySpkiSha256(raced.publicKeyPem) !== fingerprint) {
      throw new SigningKeyRegistryError("SIGNING_KEY_IDENTITY_CONFLICT");
    }
    return { outcome: "unchanged", publicKeySha256: fingerprint, revokedAt: raced.revokedAt };
  }
  return { outcome: "created", publicKeySha256: fingerprint, revokedAt: null };
}

/**
 * Self-verify a signature just made, against the REGISTERED key. Fail closed:
 * an unregistered key, a revoked key, or a signature the registered key does
 * not verify is refused, so nothing is committed SIGNED that Verify would then
 * report invalid.
 *
 * `selfPublicKeyPem` (when the signer can derive its own public key) lets a
 * first use register the key insert-only — it is the signer's TRUE public key —
 * and makes a registry row holding a different key a conflict, not a silent
 * mismatch.
 */
export async function assertSignatureVerifiesWithRegisteredKey(
  client: RegistryClient,
  input: {
    keyId: string;
    version: number;
    messageHex: string;
    signatureBase64: string;
    selfPublicKeyPem?: string | null;
  },
): Promise<{ publicKeySha256: string }> {
  let row = await client.signingKey.findUnique({
    where: { keyId_version: { keyId: input.keyId, version: input.version } },
    select: { publicKeyPem: true, revokedAt: true },
  });
  if (!row) {
    if (!input.selfPublicKeyPem) {
      throw new SigningKeyRegistryError(
        "SIGNING_KEY_NOT_REGISTERED",
        `signing_keys(${input.keyId}, v${input.version}) is not registered; run the signing-key seed before signing.`,
      );
    }
    await registerSigningKey(client, {
      keyId: input.keyId,
      version: input.version,
      publicKeyPem: input.selfPublicKeyPem,
    });
    row = await client.signingKey.findUnique({
      where: { keyId_version: { keyId: input.keyId, version: input.version } },
      select: { publicKeyPem: true, revokedAt: true },
    });
    if (!row) throw new SigningKeyRegistryError("SIGNING_KEY_NOT_REGISTERED");
  }
  if (row.revokedAt) {
    throw new SigningKeyRegistryError(
      "SIGNING_KEY_REVOKED",
      `signing_keys(${input.keyId}, v${input.version}) was revoked at ${row.revokedAt.toISOString()}; it may not sign.`,
    );
  }
  if (input.selfPublicKeyPem && publicKeySpkiSha256(input.selfPublicKeyPem) !== publicKeySpkiSha256(row.publicKeyPem)) {
    throw new SigningKeyRegistryError(
      "SIGNING_KEY_IDENTITY_CONFLICT",
      `the configured private key does not belong to signing_keys(${input.keyId}, v${input.version}).`,
    );
  }
  let ok = false;
  try {
    ok = verify(
      null,
      Buffer.from(input.messageHex, "hex"),
      `${row.publicKeyPem.trim()}\n`,
      Buffer.from(input.signatureBase64, "base64"),
    );
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new SigningKeyRegistryError(
      "SIGNING_SELF_VERIFICATION_FAILED",
      `the signature does not verify with the registered public key of (${input.keyId}, v${input.version}).`,
    );
  }
  return { publicKeySha256: publicKeySpkiSha256(row.publicKeyPem) };
}
