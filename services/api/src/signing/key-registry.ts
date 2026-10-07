/**
 * THE EVIDENCE AND PACKAGE SIGNING-KEY REGISTRY lives in
 * @proovra/shared-runtime (signing/key-registry.ts) since 2026-10-07: the
 * worker registers the package seal key there too, and one insert-only
 * registry must serve both hosts. This module keeps the API's import path.
 */
export {
  SigningKeyRegistryError,
  assertSignatureVerifiesWithRegisteredKey,
  publicKeyPemFromPrivateKeyPem,
  publicKeySpkiSha256,
  registerSigningKey,
} from "@proovra/shared-runtime";
