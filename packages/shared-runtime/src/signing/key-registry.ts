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
 *   - (2026-10-07) every row states its PURPOSE and every lookup names one. The
 *     same key material may be published for the evidence signature and for
 *     the verification-package seal — as two rows — and a PACKAGE_SEAL row is
 *     never accepted where an EVIDENCE_SIGNATURE key is required.
 */
import { createHash, createPublicKey, verify } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

/** What a registered key may verify. Closed vocabulary (DB CHECK). */
export const SIGNING_KEY_PURPOSES = ["EVIDENCE_SIGNATURE", "PACKAGE_SEAL"] as const;
export type SigningKeyPurpose = (typeof SIGNING_KEY_PURPOSES)[number];

/** The only algorithm the registry verifies (DB CHECK). */
export const SIGNING_KEY_ALGORITHM = "Ed25519" as const;

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

const identityWhere = (keyId: string, version: number, purpose: SigningKeyPurpose) => ({
  keyId_version_purpose: { keyId, version, purpose },
});

/**
 * Register (keyId, version, purpose) -> publicKeyPem, insert-only.
 *   "created"    no row existed; one was inserted
 *   "unchanged"  the same key is already registered (revocation untouched)
 * Throws SIGNING_KEY_IDENTITY_CONFLICT when a different key is registered.
 */
export async function registerSigningKey(
  client: RegistryClient,
  input: { keyId: string; version: number; publicKeyPem: string; purpose: SigningKeyPurpose },
): Promise<{ outcome: "created" | "unchanged"; publicKeySha256: string; revokedAt: Date | null }> {
  const fingerprint = publicKeySpkiSha256(input.publicKeyPem);
  const existing = await client.signingKey.findUnique({
    where: identityWhere(input.keyId, input.version, input.purpose),
    select: { publicKeyPem: true, revokedAt: true },
  });
  if (existing) {
    if (publicKeySpkiSha256(existing.publicKeyPem) !== fingerprint) {
      throw new SigningKeyRegistryError(
        "SIGNING_KEY_IDENTITY_CONFLICT",
        `signing_keys(${input.keyId}, v${input.version}, ${input.purpose}) already holds a DIFFERENT public key. ` +
          "A registered key is never replaced (it would invalidate every signature made with it); " +
          "rotate by registering a new SIGNING_KEY_VERSION.",
      );
    }
    return { outcome: "unchanged", publicKeySha256: fingerprint, revokedAt: existing.revokedAt };
  }
  try {
    await client.signingKey.create({
      data: {
        keyId: input.keyId,
        version: input.version,
        purpose: input.purpose,
        algorithm: SIGNING_KEY_ALGORITHM,
        fingerprintSha256: fingerprint,
        publicKeyPem: input.publicKeyPem.trim(),
      },
    });
  } catch (err) {
    // A concurrent registration of the same identity: re-check the key.
    const raced = await client.signingKey.findUnique({
      where: identityWhere(input.keyId, input.version, input.purpose),
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
    purpose: SigningKeyPurpose;
  },
): Promise<{ publicKeySha256: string }> {
  let row = await client.signingKey.findUnique({
    where: identityWhere(input.keyId, input.version, input.purpose),
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
      purpose: input.purpose,
      publicKeyPem: input.selfPublicKeyPem,
    });
    row = await client.signingKey.findUnique({
      where: identityWhere(input.keyId, input.version, input.purpose),
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

/**
 * THE registered key for one exact identity and purpose — the only way a
 * verifier finds a key. A key registered for another purpose is invisible here.
 */
export async function findRegisteredSigningKey(
  client: RegistryClient,
  input: { keyId: string; version: number; purpose: SigningKeyPurpose },
): Promise<{ publicKeyPem: string; revokedAt: Date | null; createdAt: Date; fingerprintSha256: string } | null> {
  const row = await client.signingKey.findUnique({
    where: identityWhere(input.keyId, input.version, input.purpose),
    select: { publicKeyPem: true, revokedAt: true, createdAt: true, fingerprintSha256: true },
  });
  if (!row) return null;
  return {
    publicKeyPem: row.publicKeyPem,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    fingerprintSha256: row.fingerprintSha256 ?? publicKeySpkiSha256(row.publicKeyPem),
  };
}

export type PublicKeyBindingStatus = "ACTIVE" | "SUPERSEDED" | "REVOKED";

/** What PROOVRA publishes about one registered key — public material only. */
export type PublicSigningKeyRecord = {
  purpose: SigningKeyPurpose;
  algorithm: typeof SIGNING_KEY_ALGORITHM;
  keyId: string;
  version: number;
  fingerprintSha256: string;
  status: PublicKeyBindingStatus;
  validFromUtc: string;
  /** When a later version of the same key id and purpose took over, or the revocation. */
  validUntilUtc: string | null;
  revokedAtUtc: string | null;
  /** The version that superseded it (rotation), when one exists. */
  supersededByVersion: number | null;
};

/**
 * The public binding of ONE exact key identity: its registry row plus the
 * rotation facts (a later version of the same key id and purpose). Bounded:
 * reads that identity and the next version only — never the inventory.
 */
export async function describePublicSigningKey(
  client: RegistryClient,
  input: { keyId: string; version: number; purpose: SigningKeyPurpose },
): Promise<PublicSigningKeyRecord | null> {
  const row = await client.signingKey.findUnique({
    where: identityWhere(input.keyId, input.version, input.purpose),
    select: { publicKeyPem: true, revokedAt: true, createdAt: true, fingerprintSha256: true, algorithm: true },
  });
  if (!row) return null;
  let fingerprint: string;
  try {
    fingerprint = row.fingerprintSha256 ?? publicKeySpkiSha256(row.publicKeyPem);
  } catch {
    return null;
  }
  const next = await client.signingKey.findFirst({
    where: { keyId: input.keyId, purpose: input.purpose, version: { gt: input.version } },
    orderBy: { version: "asc" },
    select: { version: true, createdAt: true },
  });
  const status: PublicKeyBindingStatus = row.revokedAt ? "REVOKED" : next ? "SUPERSEDED" : "ACTIVE";
  const until = row.revokedAt ?? next?.createdAt ?? null;
  return {
    purpose: input.purpose,
    algorithm: SIGNING_KEY_ALGORITHM,
    keyId: input.keyId,
    version: input.version,
    fingerprintSha256: fingerprint,
    status,
    validFromUtc: row.createdAt.toISOString(),
    validUntilUtc: until ? until.toISOString() : null,
    revokedAtUtc: row.revokedAt ? row.revokedAt.toISOString() : null,
    supersededByVersion: next?.version ?? null,
  };
}
