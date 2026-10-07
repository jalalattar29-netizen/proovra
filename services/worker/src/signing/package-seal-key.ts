/**
 * THE PACKAGE SEAL KEY, BOUND TO PROOVRA'S REGISTRY (2026-10-07).
 *
 * The key registry (signing_keys, insert-only) records the seal key under its
 * own purpose (PACKAGE_SEAL), so PROOVRA's public package record can bind a
 * package to it — and it can never be read as an evidence-signing key. A
 * package whose seal key cannot be registered is not issued: its recipient
 * could not bind it. An identity conflict or an unknown identity is a
 * configuration fault (terminal); an unreachable registry is retried.
 */
export class PackageSealKeyRegistrationError extends Error {
  constructor(
    readonly code: "PACKAGE_SEAL_KEY_IDENTITY_UNKNOWN" | "PACKAGE_SEAL_KEY_IDENTITY_CONFLICT" | "PACKAGE_SEAL_KEY_REGISTRY_UNAVAILABLE",
    readonly retriable: boolean,
  ) {
    super(code);
    this.name = "PackageSealKeyRegistrationError";
  }
}

/** Register the seal key (insert-only) and return its exact registry identity. */
export async function bindPackageSealKey(signature: {
  signingKeyId?: string | null;
  signingKeyVersion?: number | string | null;
  publicKeyPem: string;
}): Promise<{ signingKeyId: string; signingKeyVersion: number }> {
  const version = Number(signature.signingKeyVersion);
  if (!signature.signingKeyId || !Number.isInteger(version)) {
    throw new PackageSealKeyRegistrationError("PACKAGE_SEAL_KEY_IDENTITY_UNKNOWN", false);
  }
  const [{ prisma }, { registerSigningKey, SigningKeyRegistryError }] = await Promise.all([
    import("../db.js"),
    import("@proovra/shared-runtime"),
  ]);
  try {
    await registerSigningKey(prisma, {
      keyId: signature.signingKeyId,
      version,
      purpose: "PACKAGE_SEAL",
      publicKeyPem: signature.publicKeyPem,
    });
  } catch (err) {
    if (err instanceof SigningKeyRegistryError && err.code === "SIGNING_KEY_IDENTITY_CONFLICT") {
      throw new PackageSealKeyRegistrationError("PACKAGE_SEAL_KEY_IDENTITY_CONFLICT", false);
    }
    throw new PackageSealKeyRegistrationError("PACKAGE_SEAL_KEY_REGISTRY_UNAVAILABLE", true);
  }
  return { signingKeyId: signature.signingKeyId, signingKeyVersion: version };
}
