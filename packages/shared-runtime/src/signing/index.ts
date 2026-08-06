/**
 * Signing-key safety primitives shared by services/api and services/worker.
 *
 * Lives here because BOTH hosts sign — the API signs evidence fingerprints and
 * the worker signs verification packages — and a refusal that only one of them
 * honours is not a refusal. One authority, imported by both.
 */
export {
  assertNotCommittedFixture,
  publicFingerprintOfPem,
  isProductionRuntime,
  FixtureSigningKeyRefused,
  COMMITTED_FIXTURE_PUBLIC_FINGERPRINTS,
} from "./fixture-key-guard.js";
