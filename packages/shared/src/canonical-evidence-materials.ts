/**
 * PROOVRA Phase 2 — Canonical Evidence Materials.
 *
 * A pure, read-only projection layer that turns existing lifecycle
 * facts (Evidence row, EvidencePart rows, CustodyEvent rows, Report
 * row, VerificationPackage row, trust decision output) into one typed
 * canonical bundle that Report PDF, Verification Package, Public
 * Verify, and internal operational projections all consume.
 *
 * This is NOT a new truth layer. Every material here is a typed
 * projection of facts that already exist in the database or in another
 * shared module. Builders are pure: no DB writes, no ZIP inspection,
 * no network, no side effects.
 *
 * Phase 2 wires real consumers (Verification Package + Public Verify
 * payload) through these builders. Phase 3 will extend the wiring to
 * Report-v2 view-model and internal projections, and start removing
 * the duplicate-derivation offenders that Phase 1 pinned in the
 * ratchet allowlist.
 *
 * Hard invariants (enforced by tests):
 *   - buildCanonicalEvidenceMaterials returns every section.
 *   - Trust decision material is produced by buildEvidenceTrustDecision();
 *     this module never reimplements verdict logic.
 *   - Reviewer evidence type comes from getReviewerEvidenceTypeLabel();
 *     this module never reimplements category logic.
 *   - Workspace scope is derived ONCE here. `teamId` existence is NOT
 *     equivalent to "team_governed" — personal workspaces are stored
 *     as Team rows with `isPersonal=true`, and the canonical scope
 *     correctly resolves those to PERSONAL_ACCOUNT_WORKSPACE.
 *   - Snapshot vs live semantics are encoded per material.
 */

import {
  buildEvidenceTrustDecision,
  type BuildEvidenceTrustDecisionInput,
  type TrustDecision,
} from "./trust-decision.js";
import { getReviewerEvidenceTypeLabel } from "./reviewer-evidence.js";
import { classifyCustodyEventType } from "./custody.js";

// Local alias so the public type names read consistently with the
// material vocabulary used by consumers.
export type EvidenceTrustDecision = TrustDecision;

// -----------------------------------------------------------------------------
// 1. Snapshot/live semantics (per-material flag)
// -----------------------------------------------------------------------------

export const CANONICAL_SNAPSHOT_LIVE_SEMANTICS = [
  "live",
  "live-append-only",
  "live-updating-after-snapshot",
  "report-snapshot-only",
  "package-snapshot-only",
  "internal-metric-only",
] as const;

export type CanonicalSnapshotLiveSemantics =
  (typeof CANONICAL_SNAPSHOT_LIVE_SEMANTICS)[number];

// -----------------------------------------------------------------------------
// 2. Workspace scope (replaces the misleading "team_governed" boolean)
// -----------------------------------------------------------------------------

export const CANONICAL_WORKSPACE_SCOPES = [
  "PERSONAL_ACCOUNT_WORKSPACE",
  "TEAM_ACCOUNT_WORKSPACE",
  "ORGANIZATION_WORKSPACE_RESERVED_OR_DISABLED",
] as const;

export type CanonicalWorkspaceScope =
  (typeof CANONICAL_WORKSPACE_SCOPES)[number];

export type CanonicalWorkspaceScopeInput = {
  /** The Team row attached to the evidence (every record has one). */
  teamId: string | null | undefined;
  /**
   * Whether the attached Team row is a personal-account Team (Team.isPersonal=true).
   * This is the ONLY way to distinguish personal vs team workspaces; a
   * non-null teamId is NOT a signal of enterprise team governance.
   */
  isPersonalTeam: boolean | null | undefined;
  /**
   * Reserved for the future Organization governance tier. If non-null,
   * resolves to ORGANIZATION_WORKSPACE_RESERVED_OR_DISABLED.
   * Currently disabled in product; carried for forward compatibility.
   */
  organizationId?: string | null | undefined;
};

export function deriveCanonicalWorkspaceScope(
  input: CanonicalWorkspaceScopeInput,
): CanonicalWorkspaceScope {
  if (input.organizationId) {
    return "ORGANIZATION_WORKSPACE_RESERVED_OR_DISABLED";
  }
  if (input.teamId && input.isPersonalTeam === false) {
    return "TEAM_ACCOUNT_WORKSPACE";
  }
  // Includes: teamId set + isPersonalTeam=true; teamId set +
  // isPersonalTeam unknown (default to personal — the safer wording);
  // teamId null/undefined (legacy or impossible — defaults to personal).
  return "PERSONAL_ACCOUNT_WORKSPACE";
}

/** Human-safe meaning of a scope. Use in package-mode.json and similar. */
export function describeCanonicalWorkspaceScope(
  scope: CanonicalWorkspaceScope,
): string {
  switch (scope) {
    case "PERSONAL_ACCOUNT_WORKSPACE":
      return "Personal account workspace; no team governance context was applied.";
    case "TEAM_ACCOUNT_WORKSPACE":
      return "Team account workspace; workspace-level governance policies were applied at build time.";
    case "ORGANIZATION_WORKSPACE_RESERVED_OR_DISABLED":
      return "Organization workspace; enterprise organization governance is reserved or disabled in the current product configuration.";
  }
}

// -----------------------------------------------------------------------------
// 3. Material shapes
//
// All shapes carry a `snapshotSemantics` tag so the consumer cannot
// silently treat a snapshot value as live state.
// -----------------------------------------------------------------------------

export type CanonicalEvidenceRecord = {
  snapshotSemantics: CanonicalSnapshotLiveSemantics;
  evidenceId: string;
  status: string | null;
  verificationStatus: string | null;
  reviewerEvidenceTypeLabel: string;
  captureMethod: string | null;
  uploadedAtUtc: string | null;
  signedAtUtc: string | null;
  recordedIntegrityVerifiedAtUtc: string | null;
};

export type CanonicalFingerprintMaterial = {
  snapshotSemantics: CanonicalSnapshotLiveSemantics;
  fileSha256: string | null;
  fingerprintHash: string | null;
  fingerprintCanonicalJsonPresent: boolean;
  hashSemantics: string | null;
  multipartManifestSha256: string | null;
  signatureBase64: string | null;
  signingKeyId: string | null;
  signingKeyVersion: number | null;
};

export type CanonicalPartIndexEntry = {
  partIndex: number;
  sha256: string | null;
  sizeBytes: number | null;
  mimeType: string | null;
};

export type CanonicalPartIndexMaterial = {
  snapshotSemantics: CanonicalSnapshotLiveSemantics;
  itemCount: number;
  structure: "single" | "multipart";
  parts: ReadonlyArray<CanonicalPartIndexEntry>;
};

export type CanonicalCustodySnapshotMaterial = {
  snapshotSemantics: CanonicalSnapshotLiveSemantics;
  forensicEventCount: number;
  accessEventCount: number;
  earliestAtUtc: string | null;
  latestAtUtc: string | null;
};

export type CanonicalIdentitySnapshotMaterial = {
  snapshotSemantics: CanonicalSnapshotLiveSemantics;
  identityLevelSnapshot: string | null;
  workspaceScope: CanonicalWorkspaceScope;
  workspaceLabelAtPackageTime: string | null;
  workspaceNameSnapshot: string | null;
  organizationNameSnapshot: string | null;
  organizationVerifiedSnapshot: boolean | null;
  governanceMeaning: string;
};

export type CanonicalTimestampStateMaterial = {
  snapshotSemantics: CanonicalSnapshotLiveSemantics;
  tsaStatus: string | null;
  tsaSerialNumber: string | null;
  tsaGenTimeUtc: string | null;
  tsaInputDigestHex: string | null;
  tsaInputKind: string | null;
  tokenPresent: boolean;
};

export type CanonicalStorageStateMaterial = {
  snapshotSemantics: CanonicalSnapshotLiveSemantics;
  storageObjectLockMode: string | null;
  storageObjectLockRetainUntilUtc: string | null;
  storageObjectLockLegalHoldStatus: string | null;
  /** True iff mode === COMPLIANCE && retainUntilUtc is set; intentionally strict. */
  isProtected: boolean;
};

export type CanonicalOtsStateMaterial = {
  snapshotSemantics: CanonicalSnapshotLiveSemantics;
  otsStatus: string | null;
  otsHash: string | null;
  otsBitcoinTxid: string | null;
  otsAnchoredAtUtc: string | null;
  otsUpgradedAtUtc: string | null;
  proofPresent: boolean;
  /**
   * Honesty rule (mirrors verification-package.ts:decideOtsPackageArtifact):
   * if otsStatus claims ANCHORED but no Bitcoin txid AND no anchored-at
   * timestamp are present, the canonical state downgrades to PENDING.
   */
  effectiveStatus: string | null;
};

export type CanonicalMediaIntelligenceSnapshotMaterial = {
  snapshotSemantics: CanonicalSnapshotLiveSemantics;
  observationCount: number;
  hasObservations: boolean;
  advisory: string;
};

type CanonicalMediaIntelligenceInput = {
  observationCount?: number | null;
  advisory?: string | null;
  signals?: ReadonlyArray<unknown>;
  mediaSignals?: ReadonlyArray<unknown>;
  derivedThumbnails?: ReadonlyArray<unknown>;
  derivedAssets?: ReadonlyArray<unknown>;
  ocrTranscript?:
    | ReadonlyArray<unknown>
    | {
        ocr?: ReadonlyArray<unknown>;
        transcript?: ReadonlyArray<unknown>;
      }
    | null;
};

export type CanonicalTrustDecisionMaterial = {
  snapshotSemantics: CanonicalSnapshotLiveSemantics;
  /**
   * The full trust decision object as produced by buildEvidenceTrustDecision().
   * This is the SINGLE canonical source; no consumer should ever
   * recompute the verdict.
   */
  decision: EvidenceTrustDecision;
};

export type CanonicalLegalBoundaryMaterial = {
  /** The same boundary copy is intended for report, package, verify, offline. */
  reportBoundary: string;
  packageBoundary: string;
  publicVerifyBoundary: string;
  offlinePackageReviewBoundary: string;
};

// -----------------------------------------------------------------------------
// 4. Material availability + issues
// -----------------------------------------------------------------------------

export type CanonicalMaterialIssueSeverity = "info" | "warning" | "error";

export type CanonicalMaterialIssue = {
  severity: CanonicalMaterialIssueSeverity;
  code: string;
  message: string;
};

export type CanonicalMaterialAvailability = {
  evidenceRecord: boolean;
  fingerprint: boolean;
  partIndex: boolean;
  custodySnapshot: boolean;
  identitySnapshot: boolean;
  timestampState: boolean;
  storageState: boolean;
  otsState: boolean;
  mediaIntelligenceSnapshot: boolean;
  trustDecision: boolean;
  legalBoundary: boolean;
};

// -----------------------------------------------------------------------------
// 5. Output context
// -----------------------------------------------------------------------------

export const CANONICAL_OUTPUT_TYPES = [
  "REPORT_SNAPSHOT",
  "VERIFICATION_PACKAGE_SNAPSHOT",
  "PUBLIC_VERIFY_LIVE",
  "INTERNAL_OPERATIONAL_PROJECTION",
  "OFFLINE_PACKAGE_REVIEW",
] as const;

export type CanonicalOutputType = (typeof CANONICAL_OUTPUT_TYPES)[number];

export type CanonicalOutputContext = {
  outputType: CanonicalOutputType;
  /** True for snapshot outputs (Report PDF, Verification Package, Offline). */
  isSnapshotOutput: boolean;
  /** True for live outputs (Public Verify, internal projections). */
  isLiveOutput: boolean;
  /** Snapshot generation timestamp the consumer should display next to the output. */
  snapshotGeneratedAtUtc: string | null;
  /** Live observation timestamp; null for snapshot outputs. */
  liveObservedAtUtc: string | null;
  /**
   * Materials whose snapshotSemantics implies they may have advanced
   * since the snapshot was sealed (custody events, access activity, OTS
   * anchoring). Consumers can label these as "live delta".
   */
  liveDeltaMaterials: ReadonlyArray<string>;
  /** Same boundary copy as CanonicalLegalBoundaryMaterial selected for this output. */
  legalBoundary: string;
};

// -----------------------------------------------------------------------------
// 6. The full bundle
// -----------------------------------------------------------------------------

export type CanonicalEvidenceMaterials = {
  evidenceRecord: CanonicalEvidenceRecord;
  fingerprint: CanonicalFingerprintMaterial;
  partIndex: CanonicalPartIndexMaterial;
  custodySnapshot: CanonicalCustodySnapshotMaterial;
  identitySnapshot: CanonicalIdentitySnapshotMaterial;
  timestampState: CanonicalTimestampStateMaterial;
  storageState: CanonicalStorageStateMaterial;
  otsState: CanonicalOtsStateMaterial;
  mediaIntelligenceSnapshot: CanonicalMediaIntelligenceSnapshotMaterial;
  trustDecision: CanonicalTrustDecisionMaterial;
  legalBoundary: CanonicalLegalBoundaryMaterial;
  issues: ReadonlyArray<CanonicalMaterialIssue>;
};

// -----------------------------------------------------------------------------
// 7. Input shape
//
// Builders accept a typed "evidence-like" input that mirrors the
// fields the lifecycle contract already names. Callers are responsible
// for shaping their DB rows into this input; the builders themselves
// do no I/O.
// -----------------------------------------------------------------------------

export type CanonicalMaterialsBuildInput = {
  /** Evidence row fields. */
  evidence: {
    id: string;
    status: string | null;
    verificationStatus: string | null;
    captureMethod: string | null;
    uploadedAtUtc: string | Date | null | undefined;
    signedAtUtc: string | Date | null | undefined;
    recordedIntegrityVerifiedAtUtc: string | Date | null | undefined;
    fileSha256: string | null;
    fingerprintHash: string | null;
    fingerprintCanonicalJsonPresent: boolean;
    hashSemantics: string | null;
    multipartManifestSha256: string | null;
    signatureBase64: string | null;
    signingKeyId: string | null;
    signingKeyVersion: number | null;
    tsaStatus: string | null;
    tsaTokenBase64Present: boolean;
    tsaSerialNumber: string | null;
    tsaGenTimeUtc: string | Date | null | undefined;
    tsaInputDigestHex: string | null;
    tsaInputKind: string | null;
    storageObjectLockMode: string | null;
    storageObjectLockRetainUntilUtc: string | Date | null | undefined;
    storageObjectLockLegalHoldStatus: string | null;
    otsStatus: string | null;
    otsHash: string | null;
    otsBitcoinTxid: string | null;
    otsAnchoredAtUtc: string | Date | null | undefined;
    otsUpgradedAtUtc: string | Date | null | undefined;
    otsProofPresent: boolean;
    identityLevelSnapshot: string | null;
    workspaceNameSnapshot: string | null;
    organizationNameSnapshot: string | null;
    organizationVerifiedSnapshot: boolean | null;
    teamId: string | null;
  };
  /** Team row fields (for workspace-scope derivation). */
  team?: {
    id: string;
    name: string | null;
    legalName?: string | null;
    evidenceWorkspaceLabel?: string | null;
    isPersonal: boolean | null;
    organizationId?: string | null;
  } | null;
  /** Evidence parts (for canonical part index). */
  parts: ReadonlyArray<{
    partIndex: number;
    sha256: string | null;
    sizeBytes: number | null;
    mimeType: string | null;
    /** For reviewer-evidence-type categorization. */
    durationMs?: number | null;
  }>;
  /** Custody events; the builder filters by category internally. */
  custodyEvents: ReadonlyArray<{
    eventType: string;
    atUtc: string | Date;
  }>;
  /**
   * Already-built trust decision. The caller invokes
   * `buildEvidenceTrustDecision()` once and passes the result so the
   * canonical bundle does not duplicate verdict logic and so it can
   * cite the snapshot semantics correctly.
   */
  trustDecision: EvidenceTrustDecision;
  /** Optional advisory media intelligence object from the finalized lifecycle. */
  mediaIntelligence?: CanonicalMediaIntelligenceInput | null;
  /**
   * Context: which output is being built. Affects only the snapshot
   * vs live semantics tags on each material, not the data itself.
   */
  outputType: CanonicalOutputType;
  /**
   * Sealed-at timestamp for snapshot outputs (Report.generatedAtUtc /
   * VerificationPackage.generatedAtUtc). null for live outputs.
   */
  snapshotGeneratedAtUtc?: string | Date | null;
};

// -----------------------------------------------------------------------------
// 8. Internal helpers
// -----------------------------------------------------------------------------

function toIsoOrNull(v: string | Date | null | undefined): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") {
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function nonEmptyOrNull(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = String(v).trim();
  return t.length > 0 ? t : null;
}

function isSnapshotOutput(t: CanonicalOutputType): boolean {
  return (
    t === "REPORT_SNAPSHOT" ||
    t === "VERIFICATION_PACKAGE_SNAPSHOT" ||
    t === "OFFLINE_PACKAGE_REVIEW"
  );
}

/**
 * Per-material snapshot/live semantic depending on the output context.
 * A piece of evidence data is "snapshot" iff the output itself is a
 * sealed snapshot; otherwise it's live (or live-append-only for
 * custody events, live-updating-after-snapshot for OTS).
 */
function semanticForMaterial(
  material:
    | "evidenceRecord"
    | "fingerprint"
    | "partIndex"
    | "custodySnapshot"
    | "identitySnapshot"
    | "timestampState"
    | "storageState"
    | "otsState"
    | "mediaIntelligenceSnapshot"
    | "trustDecision",
  outputType: CanonicalOutputType,
): CanonicalSnapshotLiveSemantics {
  if (isSnapshotOutput(outputType)) {
    if (outputType === "REPORT_SNAPSHOT") return "report-snapshot-only";
    return "package-snapshot-only";
  }
  if (material === "custodySnapshot") return "live-append-only";
  if (material === "otsState") return "live-updating-after-snapshot";
  return "live";
}

// -----------------------------------------------------------------------------
// 9. Builders
// -----------------------------------------------------------------------------

function deriveReviewerEvidenceTypeLabel(
  input: CanonicalMaterialsBuildInput,
): string {
  const parts = input.parts;
  let imageCount = 0;
  let videoCount = 0;
  let audioCount = 0;
  let pdfCount = 0;
  let textCount = 0;
  for (const p of parts) {
    const m = (p.mimeType ?? "").toLowerCase();
    if (m.startsWith("image/")) imageCount += 1;
    else if (m.startsWith("video/")) videoCount += 1;
    else if (m.startsWith("audio/")) audioCount += 1;
    else if (m === "application/pdf") pdfCount += 1;
    else if (m.startsWith("text/")) textCount += 1;
  }
  // `ReviewerEvidenceTypeInput` is internal to reviewer-evidence.ts;
  // we build a structurally-compatible literal here.
  return getReviewerEvidenceTypeLabel({
    itemCount: parts.length,
    structure: parts.length > 1 ? "multipart" : "single",
    imageCount,
    videoCount,
    audioCount,
    pdfCount,
    textCount,
    evidenceType: null,
    mimeType: parts.length === 1 ? parts[0]?.mimeType ?? null : null,
  });
}

export function buildCanonicalEvidenceRecord(
  input: CanonicalMaterialsBuildInput,
): CanonicalEvidenceRecord {
  return {
    snapshotSemantics: semanticForMaterial("evidenceRecord", input.outputType),
    evidenceId: input.evidence.id,
    status: nonEmptyOrNull(input.evidence.status),
    verificationStatus: nonEmptyOrNull(input.evidence.verificationStatus),
    reviewerEvidenceTypeLabel: deriveReviewerEvidenceTypeLabel(input),
    captureMethod: nonEmptyOrNull(input.evidence.captureMethod),
    uploadedAtUtc: toIsoOrNull(input.evidence.uploadedAtUtc),
    signedAtUtc: toIsoOrNull(input.evidence.signedAtUtc),
    recordedIntegrityVerifiedAtUtc: toIsoOrNull(
      input.evidence.recordedIntegrityVerifiedAtUtc,
    ),
  };
}

export function buildCanonicalFingerprintMaterial(
  input: CanonicalMaterialsBuildInput,
): CanonicalFingerprintMaterial {
  const e = input.evidence;
  return {
    snapshotSemantics: semanticForMaterial("fingerprint", input.outputType),
    fileSha256: nonEmptyOrNull(e.fileSha256),
    fingerprintHash: nonEmptyOrNull(e.fingerprintHash),
    fingerprintCanonicalJsonPresent: Boolean(e.fingerprintCanonicalJsonPresent),
    hashSemantics: nonEmptyOrNull(e.hashSemantics),
    multipartManifestSha256: nonEmptyOrNull(e.multipartManifestSha256),
    signatureBase64: nonEmptyOrNull(e.signatureBase64),
    signingKeyId: nonEmptyOrNull(e.signingKeyId),
    signingKeyVersion:
      typeof e.signingKeyVersion === "number" ? e.signingKeyVersion : null,
  };
}

export function buildCanonicalPartIndex(
  input: CanonicalMaterialsBuildInput,
): CanonicalPartIndexMaterial {
  const parts = input.parts.map((p) => ({
    partIndex: p.partIndex,
    sha256: nonEmptyOrNull(p.sha256),
    sizeBytes: typeof p.sizeBytes === "number" ? p.sizeBytes : null,
    mimeType: nonEmptyOrNull(p.mimeType),
  }));
  return {
    snapshotSemantics: semanticForMaterial("partIndex", input.outputType),
    itemCount: parts.length,
    structure: parts.length > 1 ? "multipart" : "single",
    parts,
  };
}

export function buildCanonicalCustodySnapshot(
  input: CanonicalMaterialsBuildInput,
): CanonicalCustodySnapshotMaterial {
  let forensic = 0;
  let access = 0;
  let earliest: number | null = null;
  let latest: number | null = null;
  for (const ev of input.custodyEvents) {
    if (classifyCustodyEventType(ev.eventType) === "access") access += 1;
    else forensic += 1;
    const t = ev.atUtc instanceof Date ? ev.atUtc.getTime() : Date.parse(String(ev.atUtc));
    if (!Number.isNaN(t)) {
      if (earliest === null || t < earliest) earliest = t;
      if (latest === null || t > latest) latest = t;
    }
  }
  return {
    snapshotSemantics: semanticForMaterial("custodySnapshot", input.outputType),
    forensicEventCount: forensic,
    accessEventCount: access,
    earliestAtUtc: earliest !== null ? new Date(earliest).toISOString() : null,
    latestAtUtc: latest !== null ? new Date(latest).toISOString() : null,
  };
}

export function buildCanonicalIdentitySnapshot(
  input: CanonicalMaterialsBuildInput,
): CanonicalIdentitySnapshotMaterial {
  const scope = deriveCanonicalWorkspaceScope({
    teamId: input.evidence.teamId,
    isPersonalTeam: input.team?.isPersonal ?? null,
    organizationId: input.team?.organizationId ?? null,
  });
  const workspaceLabelAtPackageTime =
    nonEmptyOrNull(input.team?.evidenceWorkspaceLabel) ??
    nonEmptyOrNull(input.team?.name) ??
    nonEmptyOrNull(input.evidence.workspaceNameSnapshot);
  return {
    snapshotSemantics: semanticForMaterial("identitySnapshot", input.outputType),
    identityLevelSnapshot: nonEmptyOrNull(input.evidence.identityLevelSnapshot),
    workspaceScope: scope,
    workspaceLabelAtPackageTime,
    workspaceNameSnapshot: nonEmptyOrNull(input.evidence.workspaceNameSnapshot),
    organizationNameSnapshot: nonEmptyOrNull(input.evidence.organizationNameSnapshot),
    organizationVerifiedSnapshot:
      typeof input.evidence.organizationVerifiedSnapshot === "boolean"
        ? input.evidence.organizationVerifiedSnapshot
        : null,
    governanceMeaning: describeCanonicalWorkspaceScope(scope),
  };
}

export function buildCanonicalTimestampState(
  input: CanonicalMaterialsBuildInput,
): CanonicalTimestampStateMaterial {
  const e = input.evidence;
  return {
    snapshotSemantics: semanticForMaterial("timestampState", input.outputType),
    tsaStatus: nonEmptyOrNull(e.tsaStatus),
    tsaSerialNumber: nonEmptyOrNull(e.tsaSerialNumber),
    tsaGenTimeUtc: toIsoOrNull(e.tsaGenTimeUtc),
    tsaInputDigestHex: nonEmptyOrNull(e.tsaInputDigestHex),
    tsaInputKind: nonEmptyOrNull(e.tsaInputKind),
    tokenPresent: Boolean(e.tsaTokenBase64Present),
  };
}

export function buildCanonicalStorageState(
  input: CanonicalMaterialsBuildInput,
): CanonicalStorageStateMaterial {
  const e = input.evidence;
  const mode = nonEmptyOrNull(e.storageObjectLockMode);
  const retainUntil = toIsoOrNull(e.storageObjectLockRetainUntilUtc);
  return {
    snapshotSemantics: semanticForMaterial("storageState", input.outputType),
    storageObjectLockMode: mode,
    storageObjectLockRetainUntilUtc: retainUntil,
    storageObjectLockLegalHoldStatus: nonEmptyOrNull(
      e.storageObjectLockLegalHoldStatus,
    ),
    isProtected: mode === "COMPLIANCE" && retainUntil !== null,
  };
}

const HEX_TXID_RE = /^[0-9a-f]{64}$/i;

export function buildCanonicalOtsState(
  input: CanonicalMaterialsBuildInput,
): CanonicalOtsStateMaterial {
  const e = input.evidence;
  const status = nonEmptyOrNull(e.otsStatus);
  const txid = nonEmptyOrNull(e.otsBitcoinTxid);
  const anchoredAt = toIsoOrNull(e.otsAnchoredAtUtc);
  const hasValidTxid = txid !== null && HEX_TXID_RE.test(txid);
  const effective =
    status === "ANCHORED" && !hasValidTxid && anchoredAt === null
      ? "PENDING"
      : status;
  return {
    snapshotSemantics: semanticForMaterial("otsState", input.outputType),
    otsStatus: status,
    otsHash: nonEmptyOrNull(e.otsHash),
    otsBitcoinTxid: txid,
    otsAnchoredAtUtc: anchoredAt,
    otsUpgradedAtUtc: toIsoOrNull(e.otsUpgradedAtUtc),
    proofPresent: Boolean(e.otsProofPresent),
    effectiveStatus: effective,
  };
}

export function buildCanonicalMediaIntelligenceSnapshot(
  input: CanonicalMaterialsBuildInput,
): CanonicalMediaIntelligenceSnapshotMaterial {
  const count = deriveCanonicalMediaIntelligenceObservationCount(
    input.mediaIntelligence,
  );
  return {
    snapshotSemantics: semanticForMaterial(
      "mediaIntelligenceSnapshot",
      input.outputType,
    ),
    observationCount: count,
    hasObservations: count > 0,
    advisory:
      nonEmptyOrNull(input.mediaIntelligence?.advisory) ??
      "Media intelligence observations are advisory only and do not assert factual truth.",
  };
}

function deriveCanonicalMediaIntelligenceObservationCount(
  input: CanonicalMediaIntelligenceInput | null | undefined,
): number {
  if (!input) return 0;
  if (Array.isArray(input.mediaSignals)) {
    return input.mediaSignals.length;
  }
  if (Array.isArray(input.signals)) {
    return input.signals.length;
  }
  return Math.max(0, Math.trunc(input.observationCount ?? 0));
}

export function buildCanonicalTrustDecisionMaterial(
  input: CanonicalMaterialsBuildInput,
): CanonicalTrustDecisionMaterial {
  // We intentionally accept a pre-built EvidenceTrustDecision and re-export
  // it as the canonical material. The builder for the decision itself is
  // packages/shared/src/trust-decision.ts:buildEvidenceTrustDecision().
  // No verdict logic lives here.
  return {
    snapshotSemantics: semanticForMaterial("trustDecision", input.outputType),
    decision: input.trustDecision,
  };
}

/**
 * Standard legal-boundary copy that every PROOVRA snapshot/live output
 * should consume. Phase 2 exposes it here; Phase 3 will wire actual
 * surfaces through this material and remove their local duplicates.
 */
export function buildCanonicalLegalBoundaryMaterial(): CanonicalLegalBoundaryMaterial {
  const shared =
    "PROOVRA verifies recorded preservation state only. It does not independently prove factual truth, authorship, context, intent, evidentiary weight, or legal admissibility. Reviewers must apply their own legal interpretation layer.";
  return {
    reportBoundary: shared,
    packageBoundary: shared,
    publicVerifyBoundary: shared,
    offlinePackageReviewBoundary:
      shared +
      " Independent verification checks only the materials inside the package; current revocation status, live anchoring confirmations, and post-package custody events cannot be checked offline.",
  };
}

// -----------------------------------------------------------------------------
// 10. Bundle builder + availability + output context
// -----------------------------------------------------------------------------

export function buildCanonicalEvidenceMaterials(
  input: CanonicalMaterialsBuildInput,
): CanonicalEvidenceMaterials {
  const issues: CanonicalMaterialIssue[] = [];

  const evidenceRecord = buildCanonicalEvidenceRecord(input);
  const fingerprint = buildCanonicalFingerprintMaterial(input);
  const partIndex = buildCanonicalPartIndex(input);
  const custodySnapshot = buildCanonicalCustodySnapshot(input);
  const identitySnapshot = buildCanonicalIdentitySnapshot(input);
  const timestampState = buildCanonicalTimestampState(input);
  const storageState = buildCanonicalStorageState(input);
  const otsState = buildCanonicalOtsState(input);
  const mediaIntelligenceSnapshot = buildCanonicalMediaIntelligenceSnapshot(input);
  const trustDecision = buildCanonicalTrustDecisionMaterial(input);
  const legalBoundary = buildCanonicalLegalBoundaryMaterial();

  if (!fingerprint.fileSha256) {
    issues.push({
      severity: "warning",
      code: "FINGERPRINT_FILE_SHA256_MISSING",
      message: "Canonical fileSha256 is not yet available for this evidence record.",
    });
  }
  if (!fingerprint.signatureBase64) {
    issues.push({
      severity: "warning",
      code: "SIGNATURE_MISSING",
      message: "Canonical signature is not yet available for this evidence record.",
    });
  }
  if (otsState.otsStatus === "ANCHORED" && otsState.effectiveStatus === "PENDING") {
    issues.push({
      severity: "info",
      code: "OTS_STATUS_DOWNGRADED_PENDING",
      message:
        "otsStatus claimed ANCHORED but no Bitcoin txid or anchored-at timestamp was present; canonical effectiveStatus downgraded to PENDING per honesty rule.",
    });
  }

  return {
    evidenceRecord,
    fingerprint,
    partIndex,
    custodySnapshot,
    identitySnapshot,
    timestampState,
    storageState,
    otsState,
    mediaIntelligenceSnapshot,
    trustDecision,
    legalBoundary,
    issues,
  };
}

export function deriveCanonicalMaterialAvailability(
  materials: CanonicalEvidenceMaterials,
): CanonicalMaterialAvailability {
  return {
    evidenceRecord: Boolean(materials.evidenceRecord.evidenceId),
    fingerprint: Boolean(
      materials.fingerprint.fileSha256 && materials.fingerprint.fingerprintHash,
    ),
    partIndex: materials.partIndex.itemCount > 0,
    custodySnapshot: materials.custodySnapshot.forensicEventCount > 0,
    identitySnapshot: Boolean(materials.identitySnapshot.identityLevelSnapshot),
    timestampState: Boolean(materials.timestampState.tsaStatus),
    storageState: Boolean(materials.storageState.storageObjectLockMode),
    otsState: Boolean(materials.otsState.otsStatus),
    mediaIntelligenceSnapshot: true,
    trustDecision: Boolean(materials.trustDecision.decision),
    legalBoundary: Boolean(materials.legalBoundary.reportBoundary),
  };
}

export type CanonicalArtifactAvailabilityInput = {
  latestReportVersion?: number | null;
  reportGeneratedAtUtc?: string | Date | null;
  verificationPackageVersion?: number | null;
  verificationPackageGeneratedAtUtc?: string | Date | null;
  reportAvailable?: boolean;
  verificationPackageAvailable?: boolean;
};

export type CanonicalArtifactAvailability = {
  reportReady: boolean;
  packageReady: boolean;
  report: {
    available: boolean;
    version: number | null;
    generatedAtUtc: string | null;
  };
  verificationPackage: {
    available: boolean;
    version: number | null;
    generatedAtUtc: string | null;
  };
};

export function deriveCanonicalArtifactAvailability(
  input: CanonicalArtifactAvailabilityInput,
): CanonicalArtifactAvailability {
  const reportVersion =
    typeof input.latestReportVersion === "number"
      ? input.latestReportVersion
      : null;
  const reportGeneratedAtUtc = toIsoOrNull(input.reportGeneratedAtUtc);
  const verificationPackageVersion =
    typeof input.verificationPackageVersion === "number"
      ? input.verificationPackageVersion
      : null;
  const verificationPackageGeneratedAtUtc =
    toIsoOrNull(input.verificationPackageGeneratedAtUtc);

  const reportAvailable =
    typeof input.reportAvailable === "boolean"
      ? input.reportAvailable
      : reportVersion !== null || reportGeneratedAtUtc !== null;
  const packageAvailable =
    typeof input.verificationPackageAvailable === "boolean"
      ? input.verificationPackageAvailable
      : verificationPackageVersion !== null ||
        verificationPackageGeneratedAtUtc !== null;

  return {
    reportReady: reportAvailable,
    packageReady: packageAvailable,
    report: {
      available: reportAvailable,
      version: reportVersion,
      generatedAtUtc: reportGeneratedAtUtc,
    },
    verificationPackage: {
      available: packageAvailable,
      version: verificationPackageVersion,
      generatedAtUtc: verificationPackageGeneratedAtUtc,
    },
  };
}

export function deriveCanonicalOutputContext(
  materials: CanonicalEvidenceMaterials,
  outputType: CanonicalOutputType,
  options?: {
    snapshotGeneratedAtUtc?: string | Date | null;
    liveObservedAtUtc?: string | Date | null;
  },
): CanonicalOutputContext {
  const isSnap = isSnapshotOutput(outputType);
  const snapshotGen = toIsoOrNull(options?.snapshotGeneratedAtUtc ?? null);
  const liveObs = isSnap ? null : toIsoOrNull(options?.liveObservedAtUtc ?? null);

  // Live-delta materials are those whose snapshot semantic indicates they
  // may have advanced since a snapshot was sealed. For snapshot outputs
  // this is empty (the snapshot is sealed); for live outputs it lists the
  // material categories the consumer should label as "live delta".
  const liveDeltaMaterials = isSnap
    ? []
    : [
        materials.custodySnapshot.snapshotSemantics === "live-append-only"
          ? "custodyChain"
          : null,
        materials.otsState.snapshotSemantics === "live-updating-after-snapshot"
          ? "otsAnchoring"
          : null,
      ].filter((x): x is string => x !== null);

  const legalBoundary =
    outputType === "REPORT_SNAPSHOT"
      ? materials.legalBoundary.reportBoundary
      : outputType === "VERIFICATION_PACKAGE_SNAPSHOT"
        ? materials.legalBoundary.packageBoundary
        : outputType === "OFFLINE_PACKAGE_REVIEW"
          ? materials.legalBoundary.offlinePackageReviewBoundary
          : materials.legalBoundary.publicVerifyBoundary;

  return {
    outputType,
    isSnapshotOutput: isSnap,
    isLiveOutput: !isSnap,
    snapshotGeneratedAtUtc: snapshotGen,
    liveObservedAtUtc: liveObs,
    liveDeltaMaterials,
    legalBoundary,
  };
}

// -----------------------------------------------------------------------------
// 11. Convenience: full bundle build that also computes trust decision
//
// Some callers already have a `BuildEvidenceTrustDecisionInput` and
// don't want to invoke buildEvidenceTrustDecision themselves. They can
// pass it via `trustDecisionInput` and the bundle builder will call
// the canonical function once.
// -----------------------------------------------------------------------------

export function buildCanonicalEvidenceMaterialsWithTrustInput(
  input: Omit<CanonicalMaterialsBuildInput, "trustDecision"> & {
    trustDecisionInput: BuildEvidenceTrustDecisionInput;
  },
): CanonicalEvidenceMaterials {
  const decision = buildEvidenceTrustDecision(input.trustDecisionInput);
  return buildCanonicalEvidenceMaterials({
    ...input,
    trustDecision: decision,
  });
}
