/**
 * IS THE CONFIGURED EVIDENCE SIGNER USABLE (CRYPTO-004, the boot-proof part).
 *
 * A local PEM registers its own public key on the first signature. A KMS signer
 * cannot, because only the seed writes its row, so an identity missing from
 * `signing_keys` started, read ready, and failed every completion with
 * SIGNING_KEY_NOT_REGISTERED. A revoked one refused every signature the same way.
 * This reads the row `/readyz` needs; it signs nothing and changes nothing.
 *
 * Which provider the API signs with is the signing owner's question. Both spellings
 * of KMS are read here so that this check does not depend on the answer.
 */
import { parseSignerProvider } from "@proovra/shared-runtime";
import type { PrismaClient } from "@prisma/client";

export type SignerIdentityIssue =
  | "signer_identity_not_configured"
  | "signer_identity_not_registered"
  | "signer_identity_revoked";

export async function signerIdentityIssue(
  client: PrismaClient,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SignerIdentityIssue | null> {
  if (parseSignerProvider(env.SIGNER_PROVIDER) !== "aws-kms") return null;
  const keyId = (env.SIGNING_KEY_ID ?? "").trim();
  const version = Number((env.SIGNING_KEY_VERSION ?? "").trim());
  if (!keyId || !Number.isInteger(version) || version < 1) return "signer_identity_not_configured";
  const row = await client.signingKey.findUnique({
    where: { keyId_version_purpose: { keyId, version, purpose: "EVIDENCE_SIGNATURE" } },
    select: { revokedAt: true },
  });
  if (!row) return "signer_identity_not_registered";
  return row.revokedAt ? "signer_identity_revoked" : null;
}
