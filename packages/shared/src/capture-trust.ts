/**
 * PROOVRA Capture Trust — Phase 1B shared contracts.
 *
 * The single source of truth for the Mobile Capture Trust Platform's
 * cross-runtime vocabulary. Shared between api, worker, web, mobile,
 * and downstream tooling so every surface mechanically interprets
 * capture trust state identically.
 *
 * What this is:
 *   * Bounded enums for provenance class, capture mode, trust verdict,
 *     attestation provider/state, signature algorithm, and trust event
 *     codes.
 *   * Canonical-JSON schema for the at-source capture signature.
 *   * Bounded denial reason catalog for ingest, attestation, and
 *     signature verification.
 *
 * What this is NOT:
 *   * NOT a substitute for PROOVRA hash/custody/TSA/OTS integrity.
 *     Capture trust is an additional provenance signal that runs
 *     alongside the existing integrity decision, never instead of it.
 *   * NOT a legal/authenticity assertion. Phase 0 P6 prohibits
 *     PROOVRA from asserting truth — these contracts only describe
 *     the integrity primitives.
 *
 * Hard rules:
 *   1. Every state is a bounded enum.
 *   2. Free-form reason strings are bounded ≤ 240 chars at use sites.
 *   3. Cryptographic material (raw assertions, certificate bytes,
 *      attestation tokens) is NEVER stored inline on these types —
 *      callers store raw artifacts referenced by SHA-256 hash.
 *   4. Provenance class is monotonically declining: A → B → C only.
 *      The server never upgrades a class on its own.
 *   5. Trust event codes are append-only. Renaming a code is a
 *      breaking change.
 */

// =============================================================================
// 1. Provenance class — capture trust tier
// =============================================================================

/**
 * Phase 0 §1.2.2 provenance class enum.
 *
 *   A — Highest. Operator-native or SDK-embedded capture with at-source
 *       device-bound signing + verified hardware attestation (Apple
 *       App Attest / Google Play Integrity STRONG).
 *   B — Medium. Citizen-PWA capture with session-bound key and no
 *       device attestation, or operator-native with downgraded
 *       attestation (TEE-only / Play Integrity BASIC).
 *   C — Lowest. Bulk-imported existing file. PROOVRA cannot speak to
 *       capture-side integrity; only post-ingest custody applies.
 *
 * The class is monotonically declining: a downstream operation can
 * lower the class (e.g., re-encoding via lossy transform demotes A→B)
 * but never raise it.
 */
export const CAPTURE_PROVENANCE_CLASSES = ["A", "B", "C"] as const;
export type CaptureProvenanceClass = (typeof CAPTURE_PROVENANCE_CLASSES)[number];

/**
 * Operator-readable provenance class label used by Verify page and
 * Reports. Bounded to avoid silent drift between surfaces.
 */
export function provenanceClassLabel(
  c: CaptureProvenanceClass,
): "Class A — Verified at source" | "Class B — Browser captured" | "Class C — Imported, origin unverified" {
  switch (c) {
    case "A":
      return "Class A — Verified at source";
    case "B":
      return "Class B — Browser captured";
    case "C":
      return "Class C — Imported, origin unverified";
  }
}

// =============================================================================
// 2. Capture mode — how the asset entered PROOVRA
// =============================================================================

export const CAPTURE_MODES = [
  "OPERATOR_NATIVE", // Operator App, signed in
  "OPERATOR_SDK_EMBED", // Partner app via SDK
  "OPERATOR_WEB_CAPTURE", // Operator browser (capture-v2)
  "PROOVRA_WEB_UPLOAD", // Authenticated workspace browser upload (no capture-side attestation)
  "CITIZEN_PWA", // Public intake browser, no install
  "SECURE_INTAKE_LINK", // Remote contributor upload via a secure intake link
  "BULK_IMPORT", // Operator imports existing files
] as const;
export type CaptureMode = (typeof CAPTURE_MODES)[number];

/**
 * Static map: capture mode → maximum provenance class the mode can
 * claim. The ingest pipeline downgrades to this ceiling if the
 * caller asserts a higher class.
 */
export const MAX_PROVENANCE_CLASS_BY_MODE: Readonly<
  Record<CaptureMode, CaptureProvenanceClass>
> = {
  OPERATOR_NATIVE: "A",
  OPERATOR_SDK_EMBED: "A",
  OPERATOR_WEB_CAPTURE: "B",
  // Plain authenticated browser upload has no capture-side device attestation,
  // so it can never claim more than class C — the same ceiling as an import,
  // while remaining honest that the acquisition channel is a PROOVRA web upload
  // (NOT an operator import of pre-existing files).
  PROOVRA_WEB_UPLOAD: "C",
  CITIZEN_PWA: "B",
  SECURE_INTAKE_LINK: "C",
  BULK_IMPORT: "C",
};

// =============================================================================
// 3. Signature algorithm
// =============================================================================

/**
 * Bounded algorithm catalog. Ed25519 is the canonical at-source
 * signature; ECDSA P-256 is supported for older secure-element APIs
 * (Android StrongBox on certain devices). RSA-PSS is the
 * server-side countersignature algorithm used by `kms-signer`.
 */
export const CAPTURE_SIGNATURE_ALGORITHMS = [
  "Ed25519",
  "ECDSA_P256_SHA256",
] as const;
export type CaptureSignatureAlgorithm =
  (typeof CAPTURE_SIGNATURE_ALGORITHMS)[number];

// =============================================================================
// 4. Device attestation provider + verdict
// =============================================================================

/**
 * Attestation providers PROOVRA understands. Each provider has a
 * dedicated verifier service. `NONE` is used for citizen PWA + bulk
 * import paths where attestation is structurally absent (no fraud:
 * the verdict honestly says "no attestation attempted").
 */
export const DEVICE_ATTESTATION_PROVIDERS = [
  "APPLE_APP_ATTEST",
  "GOOGLE_PLAY_INTEGRITY",
  "TEE_ONLY", // Hardware key, no platform-level attestation
  "NONE", // Citizen PWA / bulk import
] as const;
export type DeviceAttestationProvider =
  (typeof DEVICE_ATTESTATION_PROVIDERS)[number];

/**
 * Bounded attestation verdict. Single field that downstream surfaces
 * (verify page, reports, verification package) rely on.
 *
 *   VERIFIED_STRONG    — Apple App Attest valid; or Play Integrity
 *                        verdict with `MEETS_STRONG_INTEGRITY`.
 *   VERIFIED_BASIC     — Play Integrity `MEETS_BASIC_INTEGRITY` or
 *                        `MEETS_DEVICE_INTEGRITY` (no STRONG).
 *   TEE_ONLY           — Hardware secure-element-backed key without a
 *                        platform attestation chain.
 *   NOT_ATTEMPTED      — Citizen PWA / bulk import: no attestation
 *                        path exists for this mode.
 *   UNVERIFIED         — Attestation expected but verifier could not
 *                        evaluate (provider down, tooling missing).
 *   FAILED             — Attestation expected and provider returned
 *                        a failure. Fail-closed: the capture is
 *                        accepted but the provenance class is forced
 *                        down to C.
 *   REVOKED            — Device was revoked after the assertion was
 *                        issued; verifier rejects.
 */
export const DEVICE_ATTESTATION_VERDICTS = [
  "VERIFIED_STRONG",
  "VERIFIED_BASIC",
  "TEE_ONLY",
  "NOT_ATTEMPTED",
  "UNVERIFIED",
  "FAILED",
  "REVOKED",
] as const;
export type DeviceAttestationVerdict =
  (typeof DEVICE_ATTESTATION_VERDICTS)[number];

/**
 * Bounded attestation failure reason catalog. Free-form provider
 * error strings NEVER leak here.
 */
export const DEVICE_ATTESTATION_FAILURE_REASONS = [
  "PROVIDER_DISABLED",
  "ASSERTION_MALFORMED",
  "ASSERTION_EXPIRED",
  "ASSERTION_REPLAYED",
  "TEAM_ID_MISMATCH",
  "BUNDLE_ID_MISMATCH",
  "RECEIPT_INVALID",
  "PUBKEY_MISMATCH",
  "PROVIDER_TIMEOUT",
  "PROVIDER_UNAVAILABLE",
  "DEVICE_REVOKED",
  "DEVICE_UNKNOWN",
  "INTEGRITY_NOT_MET",
  "NONCE_MISMATCH",
  "UNKNOWN",
] as const;
export type DeviceAttestationFailureReason =
  (typeof DEVICE_ATTESTATION_FAILURE_REASONS)[number];

// =============================================================================
// 5. Capture-side signature verdict
// =============================================================================

export const CAPTURE_SIGNATURE_VERDICTS = [
  "VALID", // Sig verifies + hash matches + canonical-JSON round-trip ok
  "INVALID_SIGNATURE", // sig does not verify against device pubkey
  "INVALID_HASH", // re-hashed bytes do not match the asserted asset hash
  "INVALID_CANONICAL_JSON", // metadata fails canonical-JSON round-trip
  "UNKNOWN_DEVICE", // device id not registered or revoked
  "MISSING", // no capture signature supplied (BULK_IMPORT etc.)
  "ALGORITHM_UNSUPPORTED",
] as const;
export type CaptureSignatureVerdict =
  (typeof CAPTURE_SIGNATURE_VERDICTS)[number];

// =============================================================================
// 6. Trust event codes — append-only, bounded
//
// These integrate with `CustodyEvent` via the `CAPTURE_TRUST_*`
// custody event type. Each emitted event additionally writes a row
// to `capture_trust_events` for the per-session timeline.
// =============================================================================

export const CAPTURE_TRUST_EVENT_CODES = [
  // Capture lifecycle
  "CAPTURE_SESSION_STARTED",
  "CAPTURE_SESSION_ENDED",
  "CAPTURE_ARTIFACT_RECEIVED",
  "CAPTURE_ARTIFACT_SIGNED_AT_SOURCE",
  "CAPTURE_ARTIFACT_COUNTERSIGNED",
  "CAPTURE_ARTIFACT_ANCHORED",
  "CAPTURE_ARTIFACT_VERIFICATION_FAILED",
  "CAPTURE_ARTIFACT_IMPORTED",
  "CAPTURE_DERIVATION_CREATED",

  // Device lifecycle
  "CAPTURE_DEVICE_REGISTERED",
  "CAPTURE_DEVICE_REVOKED",
  "CAPTURE_DEVICE_KEY_ROTATED",

  // Attestation lifecycle
  "ATTESTATION_VERIFIED",
  "ATTESTATION_FAILED",
  "ATTESTATION_REPLAY_DETECTED",

  // Offline handling
  "OFFLINE_CAPTURE_QUEUED",
  "OFFLINE_CAPTURE_SYNCHRONIZED",
  "OFFLINE_QUEUE_OVERAGE",

  // Provenance derivation
  "PROVENANCE_PROJECTION_GENERATED",
  "PROVENANCE_PROJECTION_VERIFIED",

  // Policy
  "CAPTURE_POLICY_LOCATION_CHANGED",
  "CAPTURE_POLICY_DEGRADED",
] as const;
export type CaptureTrustEventCode = (typeof CAPTURE_TRUST_EVENT_CODES)[number];

// =============================================================================
// 7. Canonical capture-signature schema (at-source)
//
// This is the JSON the mobile/SDK side serializes deterministically
// and signs with the device-bound private key. Server-side, the
// signature verifier:
//   (a) re-hashes the raw bytes and asserts equality with `assetHash`
//   (b) canonicalizes this JSON deterministically and asserts the sig
//   (c) verifies the device public key matches the registered device
//
// Canonical-JSON rules:
//   * Object keys sorted lexicographically
//   * No trailing whitespace
//   * Numbers in shortest valid form (no exponent, no leading zeros)
//   * Strings UTF-8 with bounded escapes (\\, \", \n, \r, \t, \uXXXX)
//   * No `undefined`, no `NaN`, no `Infinity`
//
// The mobile SDK and the server share a canonicalizer implementation
// to keep the round-trip deterministic.
// =============================================================================

export type CaptureSignaturePayload = {
  /** Schema version. Bump on incompatible change. */
  schemaVersion: "PROOVRA_CAPTURE_SIG_V1";

  /** SHA-256 hex of the raw captured bytes. Lowercase, 64 chars. */
  assetHash: string;

  /** Capture mode (drives provenance class). */
  captureMode: CaptureMode;

  /** Provenance class the capturer asserts (server caps to mode max). */
  provenanceClass: CaptureProvenanceClass;

  /** Device identity that signed this capture. */
  deviceKeyId: string;

  /** Algorithm used to produce the signature over this payload. */
  algorithm: CaptureSignatureAlgorithm;

  /** Capture session id the artifact belongs to. */
  captureSessionId: string;

  /** Wall-clock UTC ISO at signing time. */
  signedAtUtc: string;

  /** Device monotonic timestamp (ns since boot or equivalent). */
  signedAtMonotonicNs: string;

  /** 32-byte hex random nonce — re-feed defense. */
  nonceHex: string;

  /** Capture metadata block. Required fields below. */
  metadata: {
    /** Device model bounded label (e.g. "iPhone 15 Pro"). */
    deviceModel: string;
    /** OS family + version (e.g. "iOS 17.5.1"). */
    osVersion: string;
    /** App / SDK version + build hash. */
    appVersion: string;
    /** Network state at capture time. */
    networkState: "ONLINE" | "OFFLINE" | "UNKNOWN";
    /** Geolocation policy at time of capture. */
    locationPolicy: "OFF" | "COARSE" | "PRECISE";
    /** Optional coarse location (lat, lon, radius_m) — present only if policy allowed. */
    location: {
      latitude: number;
      longitude: number;
      accuracyMeters: number;
      method: "GPS" | "NETWORK" | "MANUAL";
    } | null;
    /** Camera + sensor flags. */
    camera: {
      facing: "FRONT" | "BACK" | "EXTERNAL" | "UNKNOWN";
      flashOn: boolean;
      focalLengthMm: number | null;
      iso: number | null;
    } | null;
    /** Battery + sensor context (forensic value). */
    sensor: {
      batteryPct: number | null;
      orientationDegrees: number | null;
      gravityVector: ReadonlyArray<number> | null;
    } | null;
    /** Optional operator-supplied bounded context. */
    operatorContext: {
      caseId: string | null;
      tag: string | null;
    } | null;
  };
};

// =============================================================================
// 8. Ingest receipt (returned by /v1/capture/mobile/ingest)
// =============================================================================

export type CaptureIngestReceipt = {
  /** Final evidence id (existing PROOVRA evidence row). */
  evidenceId: string;

  /** Final provenance class after ingest-side caps + verdicts applied. */
  provenanceClass: CaptureProvenanceClass;

  /** Bounded capture-signature verdict. */
  signatureVerdict: CaptureSignatureVerdict;

  /** Bounded attestation verdict (or NOT_ATTEMPTED for citizen / bulk). */
  attestationVerdict: DeviceAttestationVerdict;

  /** Whether the server countersigned the artifact via KMS. */
  countersigned: boolean;

  /** Whether RFC 3161 trusted timestamp was acquired. */
  rfc3161Applied: boolean;

  /** Whether OpenTimestamps anchoring has been queued. */
  otsQueued: boolean;

  /**
   * Bounded list of warnings — never failures. E.g. `CAPTURE_PROVENANCE_DOWNGRADED`,
   * `OFFLINE_CAPTURE_LATE_SYNC`.
   */
  warnings: ReadonlyArray<CaptureIngestWarning>;

  /** Optional bounded denial reason — present iff ingest refused. */
  denialReason: CaptureIngestDenialReason | null;
};

export const CAPTURE_INGEST_WARNINGS = [
  "CAPTURE_PROVENANCE_DOWNGRADED",
  "CAPTURE_LOCATION_WITHHELD",
  "OFFLINE_CAPTURE_LATE_SYNC",
  "ATTESTATION_PROVIDER_DEGRADED",
  "ANCHOR_LATENCY_HIGH",
  "DEVICE_FIRST_USE",
] as const;
export type CaptureIngestWarning = (typeof CAPTURE_INGEST_WARNINGS)[number];

export const CAPTURE_INGEST_DENIAL_REASONS = [
  "WORKSPACE_NOT_FOUND",
  "DEVICE_NOT_REGISTERED",
  "DEVICE_REVOKED",
  "DEVICE_NOT_OWNED_BY_WORKSPACE",
  "SESSION_NOT_FOUND",
  "SESSION_NOT_ACTIVE",
  "SIGNATURE_INVALID",
  "ATTESTATION_FAILED_HARD",
  "BYTES_HASH_MISMATCH",
  "REPLAY_NONCE_REUSED",
  "PROVENANCE_CLASS_DECLINED",
  "RATE_LIMITED",
  "POLICY_REJECTED",
] as const;
export type CaptureIngestDenialReason =
  (typeof CAPTURE_INGEST_DENIAL_REASONS)[number];

// =============================================================================
// 9. Provenance chain projection
//
// The bounded shape returned by the server-side provenance projection
// service. Consumed by the Verify page, Reports, and the Verification
// Package builder. The Trust pillar surfaces individual fields.
// =============================================================================

export const PROVENANCE_CHAIN_SCHEMA_VERSION =
  "PROOVRA_PROVENANCE_CHAIN_V1" as const;

export type ProvenanceChain = {
  schemaVersion: typeof PROVENANCE_CHAIN_SCHEMA_VERSION;
  /** UTC ISO when the projection was assembled. */
  generatedAtUtc: string;
  /** Evidence id this projection is for. */
  evidenceId: string;

  /** Capture-side primitives (Class A/B only — Class C surfaces NOT_ATTEMPTED). */
  capture: {
    mode: CaptureMode;
    provenanceClass: CaptureProvenanceClass;
    /** Capture session id (may be null for Class C bulk imports). */
    sessionId: string | null;
    /** Device id (may be null for citizen PWA / bulk imports). */
    deviceId: string | null;
    /**
     * Bounded CAPTURE-SIDE / device signature verdict. This describes only
     * whether the contributor's capture device signed the artifact at source
     * — it is NOT the PROOVRA preservation signature (which is recorded
     * separately in signature.txt / the package manifest signature). A
     * "MISSING" value here means the source device did not provide a
     * signature (e.g. bulk import or secure intake upload), not that
     * PROOVRA's cryptographic signature is absent.
     */
    deviceSignatureVerdict: CaptureSignatureVerdict;
    /** Human-readable clarification of the device-signature verdict. */
    deviceSignatureNote: string;
    /** Bounded attestation verdict. */
    attestationVerdict: DeviceAttestationVerdict;
    /** Bounded attestation provider. */
    attestationProvider: DeviceAttestationProvider;
    /** UTC ISO of the device-side signing event. */
    signedAtUtc: string | null;
  };

  /** Server-side primitives (always present). */
  server: {
    /** Did PROOVRA countersign via KMS? */
    countersigned: boolean;
    /** Signing key id used for the countersignature. */
    countersignKeyId: string | null;
    /** UTC ISO of the countersignature. */
    countersignedAtUtc: string | null;
  };

  /** Time anchoring. */
  time: {
    rfc3161: {
      applied: boolean;
      tsaUrl: string | null;
      appliedAtUtc: string | null;
    };
    ots: {
      applied: boolean;
      anchorTxId: string | null;
      appliedAtUtc: string | null;
      confirmations: number | null;
    };
  };

  /** Derivation lineage (parent → derived edges). */
  derivations: ReadonlyArray<{
    derivedEvidenceId: string;
    transformLabel: string;
    derivedAtUtc: string;
  }>;

  /** Trust event count summary for the session that captured this artifact. */
  trustEventSummary: {
    total: number;
    failures: number;
    lastEventAtUtc: string | null;
  };

  /** Standing limitations — surfaced on every projection. */
  limitations: ReadonlyArray<ProvenanceLimitationCode>;
};

/**
 * Standing limitations injected on every provenance chain projection.
 * These exist so the distinction between PROOVRA's integrity primitives
 * and any legal/authenticity assertion is impossible to lose.
 */
export const PROVENANCE_LIMITATION_CODES = [
  "PROVENANCE_DOES_NOT_PROVE_CONTENT_TRUTH",
  "PROVENANCE_DOES_NOT_PROVE_LEGAL_ADMISSIBILITY",
  "PROVENANCE_CLASS_C_HAS_NO_CAPTURE_SIDE_INTEGRITY",
  "ATTESTATION_REVOCATION_IS_RETROACTIVE",
  "OFFLINE_CAPTURES_ARE_TIME-BOUNDED_BY_LOCAL_CLOCK",
] as const;
export type ProvenanceLimitationCode =
  (typeof PROVENANCE_LIMITATION_CODES)[number];

export const STANDING_PROVENANCE_LIMITATIONS: ReadonlyArray<ProvenanceLimitationCode> =
  PROVENANCE_LIMITATION_CODES;

// =============================================================================
// 10. Helpers
// =============================================================================

/**
 * Clamp the asserted provenance class to the maximum the capture mode
 * permits. Used by the ingest pipeline before any verifier runs.
 */
export function clampProvenanceClass(
  asserted: CaptureProvenanceClass,
  mode: CaptureMode,
): CaptureProvenanceClass {
  const ceiling = MAX_PROVENANCE_CLASS_BY_MODE[mode];
  // Class order: A > B > C. Clamp to ceiling.
  const order: Record<CaptureProvenanceClass, number> = { A: 3, B: 2, C: 1 };
  return order[asserted] > order[ceiling] ? ceiling : asserted;
}

/**
 * Force the provenance class down to C when a fatal-but-recoverable
 * verifier outcome occurs. Used when the ingest accepts the bytes
 * but the trust chain cannot be relied on.
 */
export function demoteToClassC(
  current: CaptureProvenanceClass,
): "C" {
  // Always lands at C; declared as a function so callers see the
  // intent at the call site rather than a magic literal.
  void current;
  return "C";
}

/**
 * Whether the verdict permits the capture to retain Class A. Used by
 * the ingest pipeline to decide if the asserted class survives.
 */
export function attestationVerdictKeepsClassA(
  v: DeviceAttestationVerdict,
): boolean {
  return v === "VERIFIED_STRONG";
}

/**
 * Whether the signature verdict is "fatal" — i.e. the ingest must
 * refuse rather than accept-with-downgrade.
 */
export function signatureVerdictIsFatal(
  v: CaptureSignatureVerdict,
): boolean {
  return (
    v === "INVALID_SIGNATURE" ||
    v === "INVALID_HASH" ||
    v === "INVALID_CANONICAL_JSON" ||
    v === "UNKNOWN_DEVICE"
  );
}

/**
 * Human-readable clarification for the capture-side / device signature
 * verdict in a ProvenanceChain. Makes explicit that this describes only the
 * SOURCE-DEVICE signature and never the PROOVRA preservation signature, so a
 * "MISSING" verdict is not misread as an absent PROOVRA signature.
 */
export function describeDeviceSignatureVerdict(
  v: CaptureSignatureVerdict,
): string {
  if (v === "MISSING") {
    return "Device/source signature not provided by contributor device. PROOVRA preservation signature is recorded separately.";
  }
  return `Capture-side device signature verdict: ${v}. This describes the source-device signature only; the PROOVRA preservation signature is recorded separately.`;
}
