/**
 * IS THE CONFIGURED EVIDENCE SIGNER USABLE (CRYPTO-004, the boot-proof part).
 *
 * A local PEM registers its own public key on the first signature. A KMS signer
 * cannot, because only the seed writes its row, so an identity missing from
 * `signing_keys` started, read ready, and failed every completion with
 * SIGNING_KEY_NOT_REGISTERED. A revoked one refused every signature the same way.
 *
 * (2026-11-04) A registered, unrevoked row is not yet proof: the row names a
 * public key, and KMS_KEY_ID names the key that actually signs. When they are
 * different keys (a KMS key swapped under an unchanged SIGNING_KEY_ID, or the
 * env file read by another loader giving another identity) every signature
 * fails its self-verification. So the KMS public key is read with GetPublicKey
 * and its SPKI SHA-256 compared with the registered one. The public key is
 * cached per KMS key for a bounded time (successes only), so `/readyz` does not
 * call KMS on every probe. This reads; it signs nothing and changes nothing.
 *
 * Which provider the API signs with is the signing owner's question. Both spellings
 * of KMS are read here so that this check does not depend on the answer.
 */
import { parseSignerProvider, publicKeySpkiSha256 } from "@proovra/shared-runtime";
import type { PrismaClient } from "@prisma/client";

export type SignerIdentityIssue =
  | "signer_identity_not_configured"
  | "signer_identity_not_registered"
  | "signer_identity_revoked"
  | "signer_public_key_unavailable"
  | "signer_identity_key_mismatch";

/** Reads the SPKI PEM of a KMS key. Injected in tests; GetPublicKey otherwise. */
export type KmsPublicKeyReader = (kmsKeyId: string, env: NodeJS.ProcessEnv) => Promise<string>;

export const KMS_PUBLIC_KEY_CACHE_TTL_MS = 10 * 60 * 1000;
const kmsPublicKeyCache = new Map<string, { pem: string; readAtMs: number }>();

const readKmsPublicKeyPem: KmsPublicKeyReader = async (kmsKeyId, env) => {
  const { GetPublicKeyCommand, KMSClient } = await import("@aws-sdk/client-kms");
  const region = env.AWS_REGION?.trim() || env.AWS_DEFAULT_REGION?.trim() || "eu-central-1";
  const res = await new KMSClient({ region }).send(new GetPublicKeyCommand({ KeyId: kmsKeyId }));
  if (!res.PublicKey) throw new Error("KMS returned no public key");
  const lines = Buffer.from(res.PublicKey).toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`;
};

async function kmsPublicKeyFingerprint(
  kmsKeyId: string,
  env: NodeJS.ProcessEnv,
  read: KmsPublicKeyReader,
  nowMs: number,
): Promise<string | null> {
  const cached = kmsPublicKeyCache.get(kmsKeyId);
  const fresh = cached && nowMs - cached.readAtMs < KMS_PUBLIC_KEY_CACHE_TTL_MS ? cached.pem : null;
  let pem: string;
  try {
    pem = fresh ?? (await read(kmsKeyId, env));
  } catch {
    return null;
  }
  try {
    const fingerprint = publicKeySpkiSha256(pem);
    if (!fresh) kmsPublicKeyCache.set(kmsKeyId, { pem, readAtMs: nowMs });
    return fingerprint;
  } catch {
    return null;
  }
}

export async function signerIdentityIssue(
  client: PrismaClient,
  env: NodeJS.ProcessEnv = process.env,
  deps: { readKmsPublicKeyPem?: KmsPublicKeyReader; nowMs?: number } = {},
): Promise<SignerIdentityIssue | null> {
  if (parseSignerProvider(env.SIGNER_PROVIDER) !== "aws-kms") return null;
  const keyId = (env.SIGNING_KEY_ID ?? "").trim();
  const version = Number((env.SIGNING_KEY_VERSION ?? "").trim());
  const kmsKeyId = (env.KMS_KEY_ID ?? "").trim();
  if (!keyId || !Number.isInteger(version) || version < 1 || !kmsKeyId) return "signer_identity_not_configured";
  const row = await client.signingKey.findUnique({
    where: { keyId_version_purpose: { keyId, version, purpose: "EVIDENCE_SIGNATURE" } },
    select: { revokedAt: true, publicKeyPem: true, fingerprintSha256: true },
  });
  if (!row) return "signer_identity_not_registered";
  if (row.revokedAt) return "signer_identity_revoked";
  let registered: string;
  try {
    registered = (row.fingerprintSha256 ?? publicKeySpkiSha256(row.publicKeyPem)).toLowerCase();
  } catch {
    // A row whose key cannot be read can verify nothing: not the KMS key.
    return "signer_identity_key_mismatch";
  }
  const live = await kmsPublicKeyFingerprint(kmsKeyId, env, deps.readKmsPublicKeyPem ?? readKmsPublicKeyPem, deps.nowMs ?? Date.now());
  if (!live) return "signer_public_key_unavailable";
  return live === registered ? null : "signer_identity_key_mismatch";
}
