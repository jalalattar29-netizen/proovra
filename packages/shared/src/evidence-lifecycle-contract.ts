/**
 * PROOVRA — Evidence Lifecycle Contract (Phase 1).
 *
 * This module is the single canonical contract that names every step of
 * the evidence lifecycle, identifies the writer, the timestamp source,
 * the input materials it consumes, the output materials it produces, the
 * custody event it (if any) emits, its retry/failure posture, and the
 * downstream surfaces that consume it.
 *
 * IT IS NOT A NEW TRUTH LAYER. Every "material" referenced here is a
 * pointer to a fact that already exists in the database or in another
 * shared module (Evidence columns, EvidencePart rows, CustodyEvent rows,
 * Report rows, VerificationPackage rows). The contract is metadata about
 * those existing facts; it does not duplicate them.
 *
 * Hard invariants (enforced by tests):
 *   - All 14 lifecycle steps from the Phase 1 spec are present.
 *   - Every step declares writerResponsibility, timestampMeaning,
 *     requiredInputs, producedMaterials, failureCodes, retryPolicy,
 *     snapshotSemantics, and downstreamConsumers.
 *   - Every step maps to a custody event OR sets custodyEventGap=true
 *     with a documented reason.
 *   - ReportSnapshotCreated is snapshot-only.
 *   - VerificationPackageCreated is snapshot-only.
 *   - PublicVerifyPublished is a live publication state.
 *   - OTSAnchoredLater is live-updating and may occur after the report
 *     and package are sealed.
 *
 * Phase 1 scope: read-only contract + helpers. NO behaviour change in
 * any writer. NO download-gate, validator, or wording changes. Later
 * phases will rewire individual writers/readers to consume this
 * contract instead of re-deriving lifecycle truth independently.
 */

// -----------------------------------------------------------------------------
// 1. Lifecycle step ids and event names
// -----------------------------------------------------------------------------

export const EVIDENCE_LIFECYCLE_STEPS = [
  "EvidenceCreated",
  "UploadAuthorized",
  "UploadCompleted",
  "DigestComputed",
  "CanonicalFingerprintCreated",
  "SignatureApplied",
  "TrustedTimestampRecorded",
  "StorageLocked",
  "CustodyChainUpdated",
  "OTSProofCreated",
  "ReportSnapshotCreated",
  "VerificationPackageCreated",
  "PublicVerifyPublished",
  "OTSAnchoredLater",
] as const;

export type EvidenceLifecycleStep = (typeof EVIDENCE_LIFECYCLE_STEPS)[number];

/**
 * Canonical event names emitted by the lifecycle. These mirror but do
 * not replace `CustodyEvent.eventType` — they are the lifecycle-layer
 * names used in instrumentation, logs, and the contract itself.
 */
export const EVIDENCE_LIFECYCLE_EVENT_NAMES = {
  EvidenceCreated: "evidence.created",
  UploadAuthorized: "evidence.upload.authorized",
  UploadCompleted: "evidence.upload.completed",
  DigestComputed: "evidence.digest.computed",
  CanonicalFingerprintCreated: "evidence.fingerprint.created",
  SignatureApplied: "evidence.signature.applied",
  TrustedTimestampRecorded: "evidence.timestamp.recorded",
  StorageLocked: "evidence.storage.locked",
  CustodyChainUpdated: "evidence.custody.updated",
  OTSProofCreated: "evidence.ots.proof.created",
  ReportSnapshotCreated: "evidence.report.snapshot.created",
  VerificationPackageCreated: "evidence.package.created",
  PublicVerifyPublished: "evidence.publicverify.published",
  OTSAnchoredLater: "evidence.ots.anchored",
} as const satisfies Record<EvidenceLifecycleStep, string>;

export type EvidenceLifecycleEventName =
  (typeof EVIDENCE_LIFECYCLE_EVENT_NAMES)[EvidenceLifecycleStep];

// -----------------------------------------------------------------------------
// 2. Lifecycle materials
//
// Every entry is a stable identifier for a piece of existing data on a
// real DB row. The string form is namespaced as `<table>.<column>` so it
// can be cross-referenced from comments, instrumentation, and tests.
// -----------------------------------------------------------------------------

export const EVIDENCE_LIFECYCLE_MATERIALS = [
  // Evidence row truth
  "evidence.row",
  "evidence.status",
  "evidence.verificationStatus",
  "evidence.identityLevelSnapshot",
  "evidence.captureMethod",
  "evidence.uploadedAtUtc",
  "evidence.signedAtUtc",
  "evidence.fileSha256",
  "evidence.hashSemantics",
  "evidence.multipartManifestSha256",
  "evidence.fingerprintCanonicalJson",
  "evidence.fingerprintHash",
  "evidence.signatureBase64",
  "evidence.signingKeyId",
  "evidence.signingKeyVersion",
  "evidence.tsaStatus",
  "evidence.tsaTokenBase64",
  "evidence.tsaSerialNumber",
  "evidence.tsaGenTimeUtc",
  "evidence.tsaInputDigestHex",
  "evidence.tsaInputKind",
  "evidence.storageObjectLockMode",
  "evidence.storageObjectLockRetainUntilUtc",
  "evidence.storageObjectLockLegalHoldStatus",
  "evidence.otsProofBase64",
  "evidence.otsStatus",
  "evidence.otsHash",
  "evidence.otsBitcoinTxid",
  "evidence.otsAnchoredAtUtc",
  "evidence.otsUpgradedAtUtc",
  "evidence.publicVerifyState",
  "evidence.recordedIntegrityVerifiedAtUtc",
  "evidence.verificationPackageVersion",
  "evidence.verificationPackageGeneratedAtUtc",
  "evidence.verificationPackageMetadata",
  "evidence.latestReportVersion",
  "evidence.reportGeneratedAtUtc",
  // EvidencePart row truth
  "evidencePart.row",
  "evidencePart.sha256",
  "evidencePart.storageKey",
  // CustodyEvent row truth (chain)
  "custodyEvent.chain",
  // Report row truth
  "report.row",
  "report.generatedAtUtc",
  "report.pdfSignatureStatus",
  "report.trustDecisionSnapshot",
  "report.verificationStatusSnapshot",
  "report.identityLevelSnapshot",
  "report.recordedIntegrityVerifiedAtUtcSnapshot",
  // VerificationPackage row truth
  "verificationPackage.row",
  "verificationPackage.generatedAtUtc",
  "verificationPackage.trustDecisionSnapshot",
  "verificationPackage.packageMode",
  // External / derived materials
  "upload.session",
  "upload.presignedUrl",
  "trustDecision.derived",
] as const;

export type EvidenceLifecycleMaterial =
  (typeof EVIDENCE_LIFECYCLE_MATERIALS)[number];

// -----------------------------------------------------------------------------
// 3. Failure codes (bounded enum)
// -----------------------------------------------------------------------------

export const EVIDENCE_LIFECYCLE_FAILURE_CODES = [
  "EVIDENCE_CREATE_FAILED",
  "UPLOAD_AUTHORIZATION_FAILED",
  "UPLOAD_COMPLETION_FAILED",
  "DIGEST_MISMATCH",
  "DIGEST_COMPUTE_FAILED",
  "FINGERPRINT_CANONICALIZATION_FAILED",
  "SIGNATURE_KEY_UNAVAILABLE",
  "SIGNATURE_SIGN_FAILED",
  "TSA_PROVIDER_UNAVAILABLE",
  "TSA_REJECTED",
  "TSA_TIMEOUT",
  "STORAGE_PROVIDER_UNAVAILABLE",
  "RETENTION_APPLY_FAILED",
  "CUSTODY_APPEND_FAILED",
  "OTS_PROVIDER_UNAVAILABLE",
  "OTS_PROOF_CREATE_FAILED",
  "OTS_STILL_PENDING",
  "OTS_UPGRADE_BUDGET_EXHAUSTED",
  "OTS_STUCK_AT_ATTEMPT_THRESHOLD",
  "REPORT_PDF_RENDER_FAILED",
  "REPORT_PDF_SIGNATURE_FAILED",
  "PACKAGE_BUILD_FAILED",
  "PACKAGE_SIGNATURE_FAILED",
  "PACKAGE_ELIGIBILITY_DENIED",
  "PUBLIC_VERIFY_GATE_DENIED",
  "PUBLIC_VERIFY_PUBLISH_FAILED",
] as const;

export type EvidenceLifecycleFailureCode =
  (typeof EVIDENCE_LIFECYCLE_FAILURE_CODES)[number];

// -----------------------------------------------------------------------------
// 4. Snapshot semantics
// -----------------------------------------------------------------------------

export const EVIDENCE_LIFECYCLE_SNAPSHOT_SEMANTICS = [
  /** The material is a live, canonical row that updates as state evolves. */
  "live",
  /** The material is sealed into the Report PDF at generation time. */
  "report-snapshot-only",
  /** The material is sealed into the Verification Package ZIP. */
  "package-snapshot-only",
  /** Live state that can advance after a snapshot was sealed (e.g. OTS upgrades). */
  "live-updating-after-snapshot",
  /** A growing append-only chain; queryable at any point in time. */
  "live-append-only",
  /** Surfaced only in internal/operational dashboards. */
  "internal-metric-only",
] as const;

export type EvidenceLifecycleSnapshotSemantic =
  (typeof EVIDENCE_LIFECYCLE_SNAPSHOT_SEMANTICS)[number];

// -----------------------------------------------------------------------------
// 5. Output types that consume lifecycle materials
// -----------------------------------------------------------------------------

export const EVIDENCE_LIFECYCLE_OUTPUT_TYPES = [
  "REPORT_SNAPSHOT",
  "VERIFICATION_PACKAGE",
  "PUBLIC_VERIFY",
  "OFFLINE_VERIFY",
  "INTERNAL_METRICS",
] as const;

export type EvidenceLifecycleOutputType =
  (typeof EVIDENCE_LIFECYCLE_OUTPUT_TYPES)[number];

// -----------------------------------------------------------------------------
// 6. Step definition shape
// -----------------------------------------------------------------------------

export type EvidenceLifecycleStepDefinition = {
  id: EvidenceLifecycleStep;
  eventName: EvidenceLifecycleEventName;
  description: string;
  /**
   * Free-text identification of the single writer responsible for this
   * step. Format: "<file-path>:<entry-symbol>". Phase 1 records this for
   * documentation; later phases will use the contract to assert
   * single-writer invariants in code.
   */
  writerResponsibility: string;
  /** What the timestamp on this step represents. */
  timestampMeaning: string;
  requiredInputs: ReadonlyArray<EvidenceLifecycleMaterial>;
  producedMaterials: ReadonlyArray<EvidenceLifecycleMaterial>;
  /**
   * The CustodyEvent.eventType emitted at this step, or null if the
   * step is intentionally material-only. When null, custodyEventGap
   * must be true and the reason explained.
   */
  custodyEventType: string | null;
  custodyEventGap: boolean;
  custodyEventGapReason?: string;
  failureCodes: ReadonlyArray<EvidenceLifecycleFailureCode>;
  retryPolicy: string;
  snapshotSemantics: EvidenceLifecycleSnapshotSemantic;
  downstreamConsumers: ReadonlyArray<EvidenceLifecycleOutputType>;
};

// -----------------------------------------------------------------------------
// 7. The lifecycle contract — single canonical map
//
// Each entry references existing facts (Evidence columns, custody event
// types from the Prisma enum, Report/VerificationPackage tables). The
// "writerResponsibility" strings are documentation pointers to current
// code paths discovered in the Phase 0 audit; later phases will
// formalize them.
// -----------------------------------------------------------------------------

const STEP_DEFS: Record<
  EvidenceLifecycleStep,
  EvidenceLifecycleStepDefinition
> = {
  EvidenceCreated: {
    id: "EvidenceCreated",
    eventName: EVIDENCE_LIFECYCLE_EVENT_NAMES.EvidenceCreated,
    description:
      "Initial Evidence row is created with workspace/identity snapshot. Status=CREATED.",
    writerResponsibility:
      "services/api/src/services/evidence.service.ts:createEvidence",
    timestampMeaning: "Evidence.createdAt — wall clock at row insert (server UTC).",
    requiredInputs: [],
    producedMaterials: [
      "evidence.row",
      "evidence.status",
      "evidence.identityLevelSnapshot",
      "evidence.captureMethod",
    ],
    custodyEventType: "EVIDENCE_CREATED",
    custodyEventGap: false,
    failureCodes: ["EVIDENCE_CREATE_FAILED"],
    retryPolicy:
      "Client retries on transient errors; no server-side retry. Idempotency via client-supplied request ids where present.",
    snapshotSemantics: "live",
    downstreamConsumers: [
      "REPORT_SNAPSHOT",
      "VERIFICATION_PACKAGE",
      "PUBLIC_VERIFY",
      "OFFLINE_VERIFY",
      "INTERNAL_METRICS",
    ],
  },

  UploadAuthorized: {
    id: "UploadAuthorized",
    eventName: EVIDENCE_LIFECYCLE_EVENT_NAMES.UploadAuthorized,
    description:
      "Upload session and per-part presigned URLs are issued for the evidence row.",
    writerResponsibility:
      "services/api/src/services/uploads/upload-session.service.ts (POST /v1/uploads/sessions and per-part presign)",
    timestampMeaning:
      "UploadSession.createdAt (and per-part presign issuance). Indicates the operator was granted upload capability, not that bytes arrived.",
    requiredInputs: ["evidence.row"],
    producedMaterials: ["upload.session", "upload.presignedUrl"],
    custodyEventType: "UPLOAD_AUTHORIZED",
    custodyEventGap: false,
    failureCodes: ["UPLOAD_AUTHORIZATION_FAILED"],
    retryPolicy: "Client may re-request presigned URLs; server is idempotent per part index.",
    snapshotSemantics: "live",
    downstreamConsumers: ["INTERNAL_METRICS"],
  },

  UploadCompleted: {
    id: "UploadCompleted",
    eventName: EVIDENCE_LIFECYCLE_EVENT_NAMES.UploadCompleted,
    description:
      "All parts uploaded and the evidence is finalized atomically (lock + updateMany guard).",
    writerResponsibility:
      "services/api/src/services/evidence-complete.service.ts:completeEvidence — atomic transaction with advisory lock (status guard CREATED|UPLOADING).",
    timestampMeaning:
      "Evidence.uploadedAtUtc — set at the moment finalize succeeds. Server UTC, not device time.",
    requiredInputs: [
      "evidence.row",
      "evidencePart.row",
      "evidencePart.sha256",
      "evidencePart.storageKey",
    ],
    producedMaterials: ["evidence.status"],
    custodyEventType: "UPLOAD_COMPLETED",
    custodyEventGap: false,
    failureCodes: ["UPLOAD_COMPLETION_FAILED", "DIGEST_MISMATCH"],
    retryPolicy:
      "Exactly-once via advisory lock + updateMany status guard. Concurrent retries no-op.",
    snapshotSemantics: "live",
    downstreamConsumers: [
      "REPORT_SNAPSHOT",
      "VERIFICATION_PACKAGE",
      "PUBLIC_VERIFY",
      "OFFLINE_VERIFY",
      "INTERNAL_METRICS",
    ],
  },

  DigestComputed: {
    id: "DigestComputed",
    eventName: EVIDENCE_LIFECYCLE_EVENT_NAMES.DigestComputed,
    description:
      "SHA-256 of the original bytes (single-file) or composite-of-parts (multipart) is computed and persisted.",
    writerResponsibility:
      "services/api/src/services/evidence-complete.service.ts (sha256HexFromStream + multipart composite) — same atomic transaction as UploadCompleted.",
    timestampMeaning:
      "Implicit at finalize transaction. The digest itself is immutable for the lifetime of the evidence row.",
    requiredInputs: [
      "evidencePart.row",
      "evidencePart.sha256",
      "evidencePart.storageKey",
    ],
    producedMaterials: [
      "evidence.fileSha256",
      "evidence.hashSemantics",
      "evidence.multipartManifestSha256",
    ],
    custodyEventType: null,
    custodyEventGap: true,
    custodyEventGapReason:
      "Folded into the UPLOAD_COMPLETED custody event payload; the digest is part of the same atomic transaction and is included in the SIGNATURE_APPLIED custody payload too. No standalone DIGEST_COMPUTED event is emitted in current Prisma CustodyEventType enum.",
    failureCodes: ["DIGEST_COMPUTE_FAILED", "DIGEST_MISMATCH"],
    retryPolicy: "None — computed once inside the finalize transaction; failure aborts finalize.",
    snapshotSemantics: "live",
    downstreamConsumers: [
      "REPORT_SNAPSHOT",
      "VERIFICATION_PACKAGE",
      "PUBLIC_VERIFY",
      "OFFLINE_VERIFY",
    ],
  },

  CanonicalFingerprintCreated: {
    id: "CanonicalFingerprintCreated",
    eventName:
      EVIDENCE_LIFECYCLE_EVENT_NAMES.CanonicalFingerprintCreated,
    description:
      "Deterministic canonical JSON of evidence identity is built and hashed; this hash is what the signature signs.",
    writerResponsibility:
      "services/api/src/services/evidence-complete.service.ts (canonical JSON builders + SHA-256) — same atomic transaction as DigestComputed.",
    timestampMeaning:
      "Implicit at finalize transaction. fingerprintHash is the canonical identity of the evidence for signing/verification.",
    requiredInputs: [
      "evidence.row",
      "evidence.fileSha256",
      "evidence.hashSemantics",
    ],
    producedMaterials: [
      "evidence.fingerprintCanonicalJson",
      "evidence.fingerprintHash",
    ],
    custodyEventType: null,
    custodyEventGap: true,
    custodyEventGapReason:
      "Folded into SIGNATURE_APPLIED custody payload — `fingerprintHash` is included there. No standalone FINGERPRINT_CREATED enum value exists.",
    failureCodes: [
      "FINGERPRINT_CANONICALIZATION_FAILED",
      "DIGEST_MISMATCH",
    ],
    retryPolicy: "None — computed inside finalize; failure aborts finalize.",
    snapshotSemantics: "live",
    downstreamConsumers: [
      "REPORT_SNAPSHOT",
      "VERIFICATION_PACKAGE",
      "PUBLIC_VERIFY",
      "OFFLINE_VERIFY",
    ],
  },

  SignatureApplied: {
    id: "SignatureApplied",
    eventName: EVIDENCE_LIFECYCLE_EVENT_NAMES.SignatureApplied,
    description:
      "Ed25519 signature over fingerprintHash is produced by the active signer (local PEM or AWS KMS) and persisted.",
    writerResponsibility:
      "services/api/src/services/evidence-complete.service.ts (signer.signFingerprintHex via services/api/src/signing/signer.ts | kms-signer.ts).",
    timestampMeaning:
      "Implicit at finalize transaction. signingKeyId and signingKeyVersion identify the key used; the signature is immutable from this point.",
    requiredInputs: ["evidence.fingerprintHash"],
    producedMaterials: [
      "evidence.signatureBase64",
      "evidence.signingKeyId",
      "evidence.signingKeyVersion",
    ],
    custodyEventType: "SIGNATURE_APPLIED",
    custodyEventGap: false,
    failureCodes: [
      "SIGNATURE_KEY_UNAVAILABLE",
      "SIGNATURE_SIGN_FAILED",
    ],
    retryPolicy:
      "None — signing happens inside finalize. If KMS/local key unavailable, finalize aborts and the operator retries upload.",
    snapshotSemantics: "live",
    downstreamConsumers: [
      "REPORT_SNAPSHOT",
      "VERIFICATION_PACKAGE",
      "PUBLIC_VERIFY",
      "OFFLINE_VERIFY",
    ],
  },

  TrustedTimestampRecorded: {
    id: "TrustedTimestampRecorded",
    eventName: EVIDENCE_LIFECYCLE_EVENT_NAMES.TrustedTimestampRecorded,
    description:
      "RFC 3161 timestamp token is acquired from the configured TSA over the message imprint (fileSha256 or canonical package SHA-256).",
    writerResponsibility:
      "services/api/src/services/timestamp.service.ts:createEvidenceTimestamp — called from evidence-complete.service.ts within the finalize transaction.",
    timestampMeaning:
      "Evidence.tsaGenTimeUtc is the TSA-asserted time-of-issuance. tsaStatus records STAMPED|FAILED.",
    requiredInputs: ["evidence.fileSha256", "evidence.fingerprintHash"],
    producedMaterials: [
      "evidence.tsaStatus",
      "evidence.tsaTokenBase64",
      "evidence.tsaSerialNumber",
      "evidence.tsaGenTimeUtc",
      "evidence.tsaInputDigestHex",
      "evidence.tsaInputKind",
    ],
    custodyEventType: "TIMESTAMP_APPLIED",
    custodyEventGap: false,
    failureCodes: [
      "TSA_PROVIDER_UNAVAILABLE",
      "TSA_REJECTED",
      "TSA_TIMEOUT",
    ],
    retryPolicy:
      "Best-effort at finalize. On failure: tsaStatus=FAILED, finalize still succeeds, custody event TIMESTAMP_FAILED is recorded. No automatic retry.",
    snapshotSemantics: "live",
    downstreamConsumers: [
      "REPORT_SNAPSHOT",
      "VERIFICATION_PACKAGE",
      "PUBLIC_VERIFY",
      "OFFLINE_VERIFY",
    ],
  },

  StorageLocked: {
    id: "StorageLocked",
    eventName: EVIDENCE_LIFECYCLE_EVENT_NAMES.StorageLocked,
    description:
      "S3 / R2 Object Lock retention is applied to the evidence bytes (and parts), making them immutable for the retention window.",
    writerResponsibility:
      "services/api/src/storage.ts:applyDefaultObjectRetention — invoked post-upload; reconciled by governance services.",
    timestampMeaning:
      "Evidence.storageObjectLockRetainUntilUtc — the wall-clock expiry of the retention lock. Mode is GOVERNANCE or COMPLIANCE.",
    requiredInputs: [
      "evidencePart.row",
      "evidencePart.storageKey",
      "evidence.uploadedAtUtc",
    ],
    producedMaterials: [
      "evidence.storageObjectLockMode",
      "evidence.storageObjectLockRetainUntilUtc",
      "evidence.storageObjectLockLegalHoldStatus",
    ],
    custodyEventType: "EVIDENCE_LOCKED",
    custodyEventGap: false,
    failureCodes: [
      "STORAGE_PROVIDER_UNAVAILABLE",
      "RETENTION_APPLY_FAILED",
    ],
    retryPolicy:
      "Reconciled by governance backfill if the initial apply fails. EVIDENCE_LOCKED_FAILED custody event may be recorded on failure.",
    snapshotSemantics: "live",
    downstreamConsumers: [
      "REPORT_SNAPSHOT",
      "VERIFICATION_PACKAGE",
      "PUBLIC_VERIFY",
      "INTERNAL_METRICS",
    ],
  },

  CustodyChainUpdated: {
    id: "CustodyChainUpdated",
    eventName: EVIDENCE_LIFECYCLE_EVENT_NAMES.CustodyChainUpdated,
    description:
      "Meta-step: every other lifecycle step that emits a custody event appends to the per-evidence custody chain via this single writer. Maintains eventHash/prevEventHash linkage.",
    writerResponsibility:
      "services/api/src/services/custody-events.service.ts:appendCustodyEvent (and appendCustodyEventTx).",
    timestampMeaning:
      "CustodyEvent.atUtc is the server wall-clock at append. CustodyEvent.sequence is the per-evidence monotonic ordinal.",
    requiredInputs: ["evidence.row", "custodyEvent.chain"],
    producedMaterials: ["custodyEvent.chain"],
    custodyEventType: null,
    custodyEventGap: true,
    custodyEventGapReason:
      "This is the meta-writer for every custody event; it does not emit its own event type. Every other step that lists a non-null custodyEventType funnels through this writer.",
    failureCodes: ["CUSTODY_APPEND_FAILED"],
    retryPolicy:
      "Inside the calling step's transaction. Append-failure bubbles up to the caller; no asynchronous retry.",
    snapshotSemantics: "live-append-only",
    downstreamConsumers: [
      "REPORT_SNAPSHOT",
      "VERIFICATION_PACKAGE",
      "PUBLIC_VERIFY",
      "OFFLINE_VERIFY",
      "INTERNAL_METRICS",
    ],
  },

  OTSProofCreated: {
    id: "OTSProofCreated",
    eventName: EVIDENCE_LIFECYCLE_EVENT_NAMES.OTSProofCreated,
    description:
      "Initial OpenTimestamps proof is created from the canonical hash. Status starts as PENDING; Bitcoin anchoring is deferred.",
    writerResponsibility:
      "services/worker/src/ots.service.ts:createOpenTimestamp — called during report generation from services/worker/src/processor.ts.",
    timestampMeaning:
      "Implicit at report generation. otsProofBase64 is immutable from this point; only otsStatus + otsBitcoinTxid + otsAnchoredAtUtc advance later.",
    requiredInputs: [
      "evidence.fingerprintHash",
      "evidence.fileSha256",
    ],
    producedMaterials: [
      "evidence.otsProofBase64",
      "evidence.otsHash",
      "evidence.otsStatus",
    ],
    custodyEventType: "OTS_APPLIED",
    custodyEventGap: false,
    failureCodes: [
      "OTS_PROVIDER_UNAVAILABLE",
      "OTS_PROOF_CREATE_FAILED",
    ],
    retryPolicy:
      "On failure the OTS upgrade processor will retry; report generation does not block on OTS.",
    snapshotSemantics: "live",
    downstreamConsumers: [
      "REPORT_SNAPSHOT",
      "VERIFICATION_PACKAGE",
      "PUBLIC_VERIFY",
      "OFFLINE_VERIFY",
    ],
  },

  ReportSnapshotCreated: {
    id: "ReportSnapshotCreated",
    eventName: EVIDENCE_LIFECYCLE_EVENT_NAMES.ReportSnapshotCreated,
    description:
      "A signed PDF Report is produced as an immutable snapshot of the evidence's then-current canonical materials, trust decision, and custody chain.",
    writerResponsibility:
      "services/worker/src/processor.ts:generateReportJobHandler + services/worker/src/report-v2/build-report-pdf.ts:buildReportPdfV2WithSignatureOutcome.",
    timestampMeaning:
      "Report.generatedAtUtc — the moment this snapshot was sealed. Custody and access events are filtered at <= this timestamp for the embedded snapshots.",
    requiredInputs: [
      "evidence.row",
      "evidence.fileSha256",
      "evidence.fingerprintHash",
      "evidence.signatureBase64",
      "evidence.tsaStatus",
      "evidence.otsStatus",
      "evidence.storageObjectLockMode",
      "custodyEvent.chain",
      "trustDecision.derived",
    ],
    producedMaterials: [
      "report.row",
      "report.generatedAtUtc",
      "report.pdfSignatureStatus",
      "report.trustDecisionSnapshot",
      "report.verificationStatusSnapshot",
      "report.identityLevelSnapshot",
      "report.recordedIntegrityVerifiedAtUtcSnapshot",
      "evidence.latestReportVersion",
      "evidence.reportGeneratedAtUtc",
      "evidence.recordedIntegrityVerifiedAtUtc",
    ],
    custodyEventType: "REPORT_GENERATED",
    custodyEventGap: false,
    failureCodes: [
      "REPORT_PDF_RENDER_FAILED",
      "REPORT_PDF_SIGNATURE_FAILED",
    ],
    retryPolicy:
      "Worker may retry generation; explicit regenerate produces a new Report row with version+1. Old versions remain immutable.",
    snapshotSemantics: "report-snapshot-only",
    downstreamConsumers: ["REPORT_SNAPSHOT", "VERIFICATION_PACKAGE", "PUBLIC_VERIFY"],
  },

  VerificationPackageCreated: {
    id: "VerificationPackageCreated",
    eventName: EVIDENCE_LIFECYCLE_EVENT_NAMES.VerificationPackageCreated,
    description:
      "Offline evidence container (ZIP) is generated from the same canonical materials sealed by the report, plus the Report PDF, custody/access snapshots, and an offline verifier.",
    writerResponsibility:
      "services/worker/src/verification-package.ts:createVerificationPackage — invoked from services/worker/src/processor.ts after the report PDF is finalized.",
    timestampMeaning:
      "VerificationPackage.generatedAtUtc — the moment this offline container was sealed. Custody/access snapshots are filtered at <= this timestamp.",
    requiredInputs: [
      "evidence.row",
      "evidencePart.row",
      "evidence.fingerprintCanonicalJson",
      "evidence.fingerprintHash",
      "evidence.signatureBase64",
      "evidence.tsaTokenBase64",
      "evidence.otsProofBase64",
      "evidence.otsStatus",
      "evidence.storageObjectLockMode",
      "custodyEvent.chain",
      "trustDecision.derived",
      "report.row",
    ],
    producedMaterials: [
      "verificationPackage.row",
      "verificationPackage.generatedAtUtc",
      "verificationPackage.trustDecisionSnapshot",
      "verificationPackage.packageMode",
      "evidence.verificationPackageVersion",
      "evidence.verificationPackageGeneratedAtUtc",
      "evidence.verificationPackageMetadata",
    ],
    custodyEventType: "VERIFICATION_PACKAGE_GENERATED",
    custodyEventGap: false,
    failureCodes: [
      "PACKAGE_BUILD_FAILED",
      "PACKAGE_SIGNATURE_FAILED",
      "PACKAGE_ELIGIBILITY_DENIED",
    ],
    retryPolicy:
      "Worker may retry; explicit regenerate produces a new VerificationPackage row with version+1. Old versions remain immutable.",
    snapshotSemantics: "package-snapshot-only",
    downstreamConsumers: ["VERIFICATION_PACKAGE", "OFFLINE_VERIFY"],
  },

  PublicVerifyPublished: {
    id: "PublicVerifyPublished",
    eventName: EVIDENCE_LIFECYCLE_EVENT_NAMES.PublicVerifyPublished,
    description:
      "Evidence is made viewable on the public verify page. publicVerifyState transitions through NOT_CONFIGURED -> CONFIGURED_NOT_PUBLISHED -> PUBLISHED, with SUSPENDED/UNPUBLISHED as terminal-for-publication states.",
    writerResponsibility:
      "services/api/src/routes/evidence.routes.ts (public-verify publish/unpublish handlers). Phase 1: writer not yet formally consolidated — see custodyEventGap.",
    timestampMeaning:
      "Evidence.publicVerifyState transition time (column-update timestamp). Per-view custody is recorded via VERIFY_VIEWED, but the publication state-change itself is currently surfaced via the column update, not a dedicated custody event.",
    requiredInputs: [
      "evidence.row",
      "report.row",
      "verificationPackage.row",
    ],
    producedMaterials: ["evidence.publicVerifyState"],
    custodyEventType: null,
    custodyEventGap: true,
    custodyEventGapReason:
      "No dedicated CustodyEventType value exists for publication state changes. VERIFY_VIEWED is emitted per public view but is not the same as a publish/unpublish event. Phase 2 should add a PUBLIC_VERIFY_STATE_CHANGED custody event type and route the column update through that emitter.",
    failureCodes: [
      "PUBLIC_VERIFY_GATE_DENIED",
      "PUBLIC_VERIFY_PUBLISH_FAILED",
    ],
    retryPolicy: "Operator-driven; no automatic retry.",
    snapshotSemantics: "live",
    downstreamConsumers: ["PUBLIC_VERIFY", "INTERNAL_METRICS"],
  },

  OTSAnchoredLater: {
    id: "OTSAnchoredLater",
    eventName: EVIDENCE_LIFECYCLE_EVENT_NAMES.OTSAnchoredLater,
    description:
      "Previously-PENDING OpenTimestamps proof is upgraded to ANCHORED once Bitcoin confirms. This may occur hours or days after the report/package were sealed.",
    writerResponsibility:
      "services/worker/src/ots-upgrade.processor.ts (writes via services/worker/src/ots-state.ts:buildOtsEvidenceUpdateData).",
    timestampMeaning:
      "Evidence.otsAnchoredAtUtc — the Bitcoin-confirmed anchor time. Evidence.otsUpgradedAtUtc — server wall-clock when the upgrade was applied.",
    requiredInputs: [
      "evidence.otsProofBase64",
      "evidence.otsStatus",
    ],
    producedMaterials: [
      "evidence.otsStatus",
      "evidence.otsBitcoinTxid",
      "evidence.otsAnchoredAtUtc",
      "evidence.otsUpgradedAtUtc",
    ],
    custodyEventType: "ANCHOR_PUBLISHED",
    custodyEventGap: false,
    failureCodes: [
      "OTS_STILL_PENDING",
      "OTS_UPGRADE_BUDGET_EXHAUSTED",
      "OTS_STUCK_AT_ATTEMPT_THRESHOLD",
    ],
    retryPolicy:
      "30-day global budget (OTS_GLOBAL_BUDGET_DAYS_DEFAULT=30). Stuck detection at 10 attempts (OTS_STUCK_ATTEMPT_THRESHOLD_DEFAULT=10). Stable jobId via buildFollowUpJobId.",
    snapshotSemantics: "live-updating-after-snapshot",
    downstreamConsumers: ["PUBLIC_VERIFY", "INTERNAL_METRICS"],
  },
};

// -----------------------------------------------------------------------------
// 8. Read-only accessors
// -----------------------------------------------------------------------------

export function getLifecycleStepDefinition(
  step: EvidenceLifecycleStep,
): EvidenceLifecycleStepDefinition {
  return STEP_DEFS[step];
}

export function listEvidenceLifecycleSteps(): ReadonlyArray<EvidenceLifecycleStepDefinition> {
  return EVIDENCE_LIFECYCLE_STEPS.map((id) => STEP_DEFS[id]);
}

// -----------------------------------------------------------------------------
// 9. Validation helpers
//
// These take a generic "evidence-like" input — a plain object keyed by
// the material identifiers above. They never call the database and
// never mutate state. They are intended for tests, instrumentation, and
// future read-only checks at material-availability boundaries.
// -----------------------------------------------------------------------------

export type LifecycleMaterialPresenceMap = Partial<
  Record<EvidenceLifecycleMaterial, boolean>
>;

function isMaterialPresent(
  input: LifecycleMaterialPresenceMap | Record<string, unknown>,
  material: EvidenceLifecycleMaterial,
): boolean {
  const v = (input as Record<string, unknown>)[material];
  if (v === undefined || v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.trim().length > 0;
  return true;
}

export type LifecycleStepInputValidation = {
  step: EvidenceLifecycleStep;
  ok: boolean;
  missing: ReadonlyArray<EvidenceLifecycleMaterial>;
};

export function validateLifecycleStepInputs(
  step: EvidenceLifecycleStep,
  input: LifecycleMaterialPresenceMap | Record<string, unknown>,
): LifecycleStepInputValidation {
  const def = STEP_DEFS[step];
  const missing = def.requiredInputs.filter(
    (m) => !isMaterialPresent(input, m),
  );
  return { step, ok: missing.length === 0, missing };
}

export function deriveLifecycleMaterialAvailability(
  input: LifecycleMaterialPresenceMap | Record<string, unknown>,
): Record<EvidenceLifecycleMaterial, boolean> {
  const out: Partial<Record<EvidenceLifecycleMaterial, boolean>> = {};
  for (const m of EVIDENCE_LIFECYCLE_MATERIALS) {
    out[m] = isMaterialPresent(input, m);
  }
  return out as Record<EvidenceLifecycleMaterial, boolean>;
}

// -----------------------------------------------------------------------------
// 10. Output readiness derivation
//
// For each downstream output, derive which lifecycle steps are
// considered satisfied and which materials are still missing. This is
// metadata only; it does not gate any download or change any UI.
// -----------------------------------------------------------------------------

const OUTPUT_REQUIREMENTS: Record<
  EvidenceLifecycleOutputType,
  ReadonlyArray<EvidenceLifecycleStep>
> = {
  REPORT_SNAPSHOT: [
    "EvidenceCreated",
    "UploadCompleted",
    "DigestComputed",
    "CanonicalFingerprintCreated",
    "SignatureApplied",
    "TrustedTimestampRecorded",
    "StorageLocked",
    "CustodyChainUpdated",
    "OTSProofCreated",
    "ReportSnapshotCreated",
  ],
  VERIFICATION_PACKAGE: [
    "EvidenceCreated",
    "UploadCompleted",
    "DigestComputed",
    "CanonicalFingerprintCreated",
    "SignatureApplied",
    "TrustedTimestampRecorded",
    "StorageLocked",
    "CustodyChainUpdated",
    "OTSProofCreated",
    "ReportSnapshotCreated",
    "VerificationPackageCreated",
  ],
  PUBLIC_VERIFY: [
    "EvidenceCreated",
    "UploadCompleted",
    "DigestComputed",
    "CanonicalFingerprintCreated",
    "SignatureApplied",
    "TrustedTimestampRecorded",
    "StorageLocked",
    "CustodyChainUpdated",
    "ReportSnapshotCreated",
    "PublicVerifyPublished",
  ],
  OFFLINE_VERIFY: [
    "EvidenceCreated",
    "UploadCompleted",
    "DigestComputed",
    "CanonicalFingerprintCreated",
    "SignatureApplied",
    "TrustedTimestampRecorded",
    "CustodyChainUpdated",
    "VerificationPackageCreated",
  ],
  INTERNAL_METRICS: [
    "EvidenceCreated",
    "UploadAuthorized",
    "UploadCompleted",
    "CustodyChainUpdated",
  ],
};

export type LifecycleOutputReadiness = {
  outputType: EvidenceLifecycleOutputType;
  ready: boolean;
  satisfiedSteps: ReadonlyArray<EvidenceLifecycleStep>;
  unsatisfiedSteps: ReadonlyArray<LifecycleStepInputValidation>;
};

export function deriveLifecycleReadinessForOutput(
  outputType: EvidenceLifecycleOutputType,
  input: LifecycleMaterialPresenceMap | Record<string, unknown>,
): LifecycleOutputReadiness {
  const required = OUTPUT_REQUIREMENTS[outputType];
  const checks = required.map((step) =>
    validateLifecycleStepInputs(step, input),
  );
  const satisfied = checks.filter((c) => c.ok).map((c) => c.step);
  const unsatisfied = checks.filter((c) => !c.ok);
  return {
    outputType,
    ready: unsatisfied.length === 0,
    satisfiedSteps: satisfied,
    unsatisfiedSteps: unsatisfied,
  };
}

export function getOutputRequirements(
  outputType: EvidenceLifecycleOutputType,
): ReadonlyArray<EvidenceLifecycleStep> {
  return OUTPUT_REQUIREMENTS[outputType];
}
