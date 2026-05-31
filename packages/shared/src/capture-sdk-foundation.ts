/**
 * Phase 1B — Capture SDK foundation.
 *
 * Architectural preparation for a public Capture SDK. This module
 * declares the bounded TypeScript interfaces (provenance, trust,
 * capture) that any future SDK release MUST conform to.
 *
 * What this is:
 *   * The single source of truth for the bounded contract between
 *     PROOVRA's server-side capture trust platform and any client
 *     that signs an at-source capture (operator mobile app, web
 *     capture-v2, citizen PWA, third-party SDK).
 *
 * What this is NOT:
 *   * NOT a runtime — there is no JavaScript that runs here. The
 *     module is types-only so it can be safely re-exported into the
 *     mobile/Web bundles without pulling in node dependencies.
 *   * NOT a public SDK release. The public SDK will depend on these
 *     interfaces but ship its own runtime + crypto integration.
 *
 * The foundation has three layers:
 *
 *   1. Capture abstraction — `CaptureSource` / `CaptureContext` /
 *      `CaptureResult` describe a generic capture surface. Camera,
 *      video, audio, screen-share, and file-import providers all
 *      conform.
 *
 *   2. Provenance abstraction — `ProvenanceSigner` / `ProvenanceProof`
 *      describe the at-source signature step. Operator native uses a
 *      hardware-backed signer; citizen PWA uses a session-ephemeral
 *      signer; bulk import uses a `null` signer (Class C).
 *
 *   3. Trust abstraction — `TrustEnvelope` describes the full bundle
 *      the client uploads to the ingest endpoint: the signed
 *      payload, the signature, and the optional attestation
 *      assertion.
 *
 * Hard rules:
 *   * Bounded enums only (re-exported from `./capture-trust.ts`).
 *   * Async, side-effect-free type-level descriptions.
 *   * No runtime helpers — see `capture-trust.ts` for those.
 */

import type {
  CaptureMode,
  CaptureProvenanceClass,
  CaptureSignatureAlgorithm,
  CaptureSignaturePayload,
  DeviceAttestationProvider,
} from "./capture-trust.js";

// =============================================================================
// 1. Capture abstraction
// =============================================================================

/**
 * Generic capture context. Conforming clients populate this from
 * their environment (camera + sensors on mobile; getUserMedia on
 * browser; file input on web; piped stream in test harnesses).
 */
export interface CaptureContext {
  /** Bounded mode (see CAPTURE_MODES). */
  readonly mode: CaptureMode;
  /** Asserted provenance class — server clamps to mode ceiling. */
  readonly assertedClass: CaptureProvenanceClass;
  /** Workspace this capture is bound to. */
  readonly teamId: string;
  /** Capture session id. */
  readonly captureSessionId: string;
  /** Device key id (for operator-native + SDK embed). */
  readonly deviceKeyId: string;
  /** Optional case binding. */
  readonly caseId: string | null;
  /** Optional bounded operator-supplied tag. */
  readonly tag: string | null;
}

/**
 * Generic capture result. Output of a CaptureSource — raw bytes plus
 * structured metadata.
 */
export interface CaptureResult {
  readonly rawBytes: Uint8Array;
  readonly mediaType: string;
  readonly assetSha256Hex: string;
  readonly capturedAtUtc: string;
  readonly capturedAtMonotonicNs: string;
  readonly metadata: CaptureSignaturePayload["metadata"];
}

/**
 * A capture source produces a `CaptureResult` from a `CaptureContext`.
 * Implementations:
 *
 *   * `MobileCameraSource`  — Operator app, photo/video
 *   * `WebCameraSource`     — Browser capture-v2, getUserMedia
 *   * `PWACitizenSource`    — Citizen PWA, session-ephemeral key
 *   * `BulkImportSource`    — File-input, Class C
 */
export interface CaptureSource {
  readonly id: "mobile-camera" | "web-camera" | "pwa-citizen" | "bulk-import";
  start(ctx: CaptureContext): Promise<void>;
  capture(): Promise<CaptureResult>;
  stop(): Promise<void>;
}

// =============================================================================
// 2. Provenance abstraction
// =============================================================================

/**
 * A provenance signer produces a `ProvenanceProof` from a payload.
 * Implementations:
 *
 *   * `HardwareEd25519Signer`   — Secure Enclave / StrongBox key
 *   * `SessionEphemeralSigner`  — Citizen PWA in-memory key
 *   * `NullSigner`              — Bulk import (Class C only)
 *
 * The signer MUST NOT modify the payload — it canonicalises +
 * signs the deterministic bytes exactly as the server-side verifier
 * will re-canonicalise + verify.
 */
export interface ProvenanceSigner {
  readonly algorithm: CaptureSignatureAlgorithm | "NONE";
  /** Bounded public key fingerprint (hex SHA-256). For NONE: null. */
  readonly publicKeyFingerprint: string | null;
  sign(payload: CaptureSignaturePayload): Promise<ProvenanceProof | null>;
}

export interface ProvenanceProof {
  /** The serialised, signed payload. */
  readonly payload: CaptureSignaturePayload;
  /** Hex signature over canonical-JSON(payload). */
  readonly signatureHex: string;
}

// =============================================================================
// 3. Trust abstraction
// =============================================================================

/**
 * Bounded device attestation assertion. Optional; absent for citizen
 * PWA + bulk import.
 */
export interface DeviceAttestationAssertion {
  readonly provider: DeviceAttestationProvider;
  /** Base64-encoded raw provider assertion bytes. */
  readonly rawAssertionBase64: string;
  readonly assertedAtUtc: string;
  readonly nonceHex: string;
  readonly expiresAtUtc: string | null;
  readonly providerMetadata: Readonly<Record<string, unknown>>;
}

/**
 * The bundle the client uploads to `/v1/capture/mobile/ingest`.
 */
export interface TrustEnvelope {
  readonly payload: CaptureSignaturePayload;
  readonly signatureHex: string;
  /** Base64-encoded raw asset bytes. */
  readonly assetBase64: string;
  readonly attestation: DeviceAttestationAssertion | null;
}

// =============================================================================
// 4. Conformance assertion (type-only)
//
// A small set of type-only constraints that future SDK implementations
// must satisfy. The compiler enforces these at the implementation
// site — they cost zero at runtime.
// =============================================================================

export type CaptureSdkConformance = {
  /** Source produces a result whose metadata matches the signed payload. */
  sourceMatchesPayload: <S extends CaptureSource>(s: S) => S;
  /** Signer never modifies the payload (input identity preserved). */
  signerPreservesPayload: <P extends ProvenanceSigner>(p: P) => P;
  /** Envelope carries the bounded fields in the bounded shape. */
  envelopeIsBounded: <E extends TrustEnvelope>(e: E) => E;
};
