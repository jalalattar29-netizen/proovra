/**
 * Phase 1B — Mobile Capture Trust integration scaffolding.
 *
 * This module declares the bounded contract that the mobile capture
 * screen (`app/(stack)/capture.tsx`) MUST conform to when the device
 * trust path lights up. It is the mobile-side companion to the
 * server-side Capture Trust Platform.
 *
 * Current state (Phase 1B exit):
 *
 *   * The mobile capture flow CAPTURES + UPLOADS as it does today.
 *   * The trust hook below is wired but disabled by default
 *     (`captureTrustMode === "DISABLED"`). When enabled, the capture
 *     pipeline routes through `prepareTrustEnvelope` to produce a
 *     signed `TrustEnvelope` and uploads via the new
 *     `/v1/capture/mobile/ingest` endpoint instead of the legacy
 *     evidence presign path.
 *   * The actual hardware-key generation + Apple App Attest / Google
 *     Play Integrity integration is a follow-on (Phase 1B.1) — this
 *     module declares the contract so the follow-on can ship without
 *     rewriting the capture screen.
 *
 * Hard rules:
 *
 *   * NEVER inline raw assertion bytes. The mobile pipeline forwards
 *     base64-encoded provider assertion bytes once; they are not
 *     persisted on-device.
 *   * Device key generation MUST use the secure element (Secure
 *     Enclave on iOS, StrongBox/Keystore on Android). The Phase 1B.1
 *     implementation MUST refuse to fall back to software keys without
 *     an explicit operator-acknowledged downgrade.
 *   * The session-ephemeral key in citizen PWA paths is OUT OF SCOPE
 *     for this file — citizen PWA captures route through the web
 *     bundle, not the mobile bundle.
 */

import type {
  CaptureContext,
  CaptureMode,
  CaptureProvenanceClass,
  CaptureResult,
  DeviceAttestationAssertion,
  ProvenanceSigner,
  TrustEnvelope,
} from "@proovra/shared";

// -----------------------------------------------------------------------------
// 1. Capture trust mode (env-gated)
// -----------------------------------------------------------------------------

export type CaptureTrustMode = "DISABLED" | "ENABLED_SHADOW" | "ENABLED";

/**
 * Read the current mode from the app config / runtime flag. Defaults
 * to DISABLED so existing captures continue to flow through the
 * legacy presign path. ENABLED_SHADOW double-writes: the legacy
 * upload + a shadow trust envelope (telemetry-only). ENABLED routes
 * through the trust path exclusively.
 */
export function captureTrustMode(): CaptureTrustMode {
  // Mobile env reads via process.env (Expo) or a build-time flag —
  // the mobile config layer is intentionally NOT touched in Phase 1B.
  // The follow-on phase wires this to a real config source.
  return "DISABLED";
}

// -----------------------------------------------------------------------------
// 2. Trust envelope preparation
// -----------------------------------------------------------------------------

export type PrepareTrustEnvelopeInput = {
  ctx: CaptureContext;
  capture: CaptureResult;
  signer: ProvenanceSigner;
  attestation?: DeviceAttestationAssertion;
};

/**
 * Bounded function — assembles the `TrustEnvelope` for upload.
 *
 * Implementation outline (Phase 1B.1):
 *
 *   1. Build the `CaptureSignaturePayload` from `ctx` + `capture`,
 *      including the asserted `provenanceClass`, the device key id,
 *      the canonical metadata, and a fresh nonce.
 *   2. Call `signer.sign(payload)` to obtain a `ProvenanceProof`.
 *   3. Base64-encode the capture bytes (`assetBase64`).
 *   4. Assemble the `TrustEnvelope`.
 *
 * The function deliberately does NOT throw — when the signer returns
 * `null` (NullSigner / Class C path) the envelope still ships, with
 * `signatureHex: ""` + provenanceClass clamped to C. The server's
 * verifier returns `MISSING` for the signature in that path.
 */
export async function prepareTrustEnvelope(
  input: PrepareTrustEnvelopeInput,
): Promise<TrustEnvelope> {
  void input;
  throw new Error(
    "prepareTrustEnvelope: Phase 1B.1 wiring pending — see apps/mobile/src/capture-trust.ts",
  );
}

// -----------------------------------------------------------------------------
// 3. Bounded mode → provenance class
// -----------------------------------------------------------------------------

/**
 * Bounded mapping from mobile capture mode → maximum claimable
 * provenance class. Mirrors the server-side `MAX_PROVENANCE_CLASS_BY_MODE`
 * map so the client and server agree on the ceiling without crossing
 * the network. The server still enforces this; this is a UX defence
 * (the mobile UI never shows a class chip the server would reject).
 */
export function maxProvenanceClassForMobileMode(
  mode: Extract<CaptureMode, "OPERATOR_NATIVE" | "OPERATOR_SDK_EMBED">,
): CaptureProvenanceClass {
  void mode;
  return "A";
}

// -----------------------------------------------------------------------------
// Mobile PWA + Capture Audit — see PHASE_1B_MOBILE_GAP_REPORT.md
//
// Summary (from the Phase 1B audit):
//
//   * apps/mobile/app/(stack)/capture.tsx              ✅ exists (1,066 LoC)
//   * apps/mobile/src/upload-queue.ts                  ✅ resumable queue
//   * apps/mobile/src/upload-utils.ts                  ✅ helpers
//   * On-device SHA-256 hashing                         ❌ missing
//   * Secure-element key generation                     ❌ missing
//   * App Attest assertion request                      ❌ missing
//   * Play Integrity token request                      ❌ missing
//   * Canonical-JSON serialiser                         ❌ missing
//   * Ed25519 signing primitive                         ❌ missing (native module needed)
//   * Trust envelope assembly                           ⚠️ stub (this file)
//   * Trust ingest endpoint integration                 ⚠️ stub
//   * Offline queue with crypto                         ⚠️ existing queue covers
//                                                          bytes only; envelope queueing
//                                                          MUST land in Phase 1B.1
//
// The hooks above keep the mobile capture screen unchanged in Phase 1B
// while reserving the integration points. Phase 1B.1 lights up:
//   - react-native-quick-crypto for SHA-256 + Ed25519
//   - react-native-keychain (secure element wrapper)
//   - react-native-app-attest (iOS) + react-native-play-integrity (Android)
//   - this module's prepareTrustEnvelope() body
//   - upload-queue.ts persists TrustEnvelope alongside raw bytes
//   - capture.tsx pipes via captureTrustMode() === "ENABLED"
// -----------------------------------------------------------------------------
