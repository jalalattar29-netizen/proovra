/**
 * @proovra/offline-verifier — public entry point.
 *
 * Browser consumers should import from the package root and supply a
 * `PackageReader` + `CryptoAdapter` (the static `apps/offline-verifier`
 * app does this via JSZip + WebCrypto). Node consumers can use the
 * provided adapter under `@proovra/offline-verifier/node` or invoke
 * the CLI directly via `npx proovra-verify`.
 */

export {
  verifyPackage,
  type CryptoAdapter,
  type PackageReader,
} from "./verifier-core.js";

export * from "./result-schema.js";

export { createMemoryPackageReader, memoryCryptoAdapter } from "./memory-adapter.js";
