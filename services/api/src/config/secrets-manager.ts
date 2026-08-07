/**
 * PHASE 12 CORRECTIVE PASS §4 (SEC-004, 2026-08-06) — RE-EXPORT ONLY.
 *
 * The loader that used to live here now lives at
 * `packages/shared-runtime/src/config/secrets-authority.ts` and is exported
 * from that package's index — deliberately NOT as a `/config` subpath, because
 * a subpath nothing imports is dead surface. It moved because the
 * Worker could not import it: a service cannot reach into another service's
 * private module, so the Worker booted with NO secrets authority at all while
 * the API booted with one, and a deployment that declared its secrets store
 * authoritative was only half authoritative.
 *
 * Nothing in this file implements anything. It exists so the API's existing
 * import sites — `server.ts`, `runtime-secrets.ts`,
 * `runtime-secrets-health.routes.ts` and their tests — keep working without a
 * rename sweep, and so the OLD names (`initSecretsManager`,
 * `__resetSecretsManagerForTests`) continue to resolve to the ONE
 * implementation rather than tempting anyone to keep a second one here.
 *
 * A second implementation in this file is prevented by
 * `phase-12-secrets-authority.test.ts`, which fails if this module contains
 * anything but re-exports.
 */

export {
  assertSecretsAuthorityReady,
  classifySecretsError,
  configuredSecretName,
  configuredSecretsRegion,
  declaredSecretsMode,
  describeLegacyModeMapping,
  getCachedSecret,
  getSecretsHealth,
  initSecretsAuthority,
  refreshSecretsAuthority,
  resetSecretsAuthority,
  setSecretsProvider,
  stopSecretsAuthority,
} from "@proovra/shared-runtime";

export type {
  SecretsAuthorityMode,
  SecretsErrorCode,
  SecretsFallbackMode,
  SecretsHealth,
  SecretsLogShape,
  SecretsProvider,
} from "@proovra/shared-runtime";

// The names the API bootstrap and its existing suites already use, bound to
// the shared implementation. No behaviour is added or changed here.
export {
  initSecretsAuthority as initSecretsManager,
  resetSecretsAuthority as __resetSecretsManagerForTests,
} from "@proovra/shared-runtime";
