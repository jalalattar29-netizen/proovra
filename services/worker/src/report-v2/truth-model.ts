import {
  buildEvidenceTrustDecision,
  buildCanonicalEvidenceMaterials,
  getTrustDecisionConfidenceLabel,
  hasCoreCryptoMaterials as hasSharedCoreCryptoMaterials,
  isExplicitRecordedIntegrityVerified,
  type CanonicalEvidenceMaterials,
} from "@proovra/shared";
import {
  Tone,
  ReportEvidence,
  ReportAnchorSummary,
  ReportCustodyEvent,
  CalloutModel,
  ReportTrustDecision,
  MediaIntelligenceReportInput,
} from "./types.js";
import {
  normalizeTimestampFailureReason,
  safe,
  safeBooleanLabel,
} from "./formatters.js";
import {
  mapOtsStatusPublicLabel,
  mapTimestampStatusPublicLabel,
} from "./normalizers.js";

export function isIntegrityVerified(evidence: ReportEvidence): boolean {
  return isExplicitRecordedIntegrityVerified({
    verificationStatus: evidence.verificationStatus,
    recordedIntegrityVerifiedAtUtc: evidence.recordedIntegrityVerifiedAtUtc,
  });
}

export function hasCoreCryptoMaterials(evidence: ReportEvidence): boolean {
  return hasSharedCoreCryptoMaterials({
    fileSha256: evidence.fileSha256,
    fingerprintHash: evidence.fingerprintHash,
    signatureBase64: evidence.signatureBase64,
    signingKeyId: evidence.signingKeyId,
  });
}

export function normalizeTimestampTone(
  status: string | null | undefined
): Tone {
  const s = safe(status, "").toUpperCase();

  if (["GRANTED", "STAMPED", "VERIFIED", "SUCCEEDED"].includes(s)) {
    return "success";
  }
  if (["PENDING", "UNAVAILABLE"].includes(s)) return "warning";
  if (s) return "danger";
  return "neutral";
}

export function normalizeOtsTone(status: string | null | undefined): Tone {
  const s = safe(status, "").toUpperCase();

  if (s === "ANCHORED") return "success";
  if (s === "PENDING") return "warning";
  if (s === "FAILED") return "danger";
  return "neutral";
}

/**
 * Truthful Bitcoin-anchoring tone: returns "success" only when the OTS proof
 * is ANCHORED AND a valid Bitcoin transaction id is recorded. Without the
 * txid the public-anchoring step is incomplete, so the tone is "warning".
 */
function isValidBitcoinTxid(value: string | null | undefined): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value.trim());
}

export function normalizeBitcoinAnchorTone(params: {
  status: string | null | undefined;
  bitcoinTxid: string | null | undefined;
}): Tone {
  const baseTone = normalizeOtsTone(params.status);
  if (baseTone !== "success") return baseTone;
  return isValidBitcoinTxid(params.bitcoinTxid) ? "success" : "warning";
}

export function normalizeStorageTone(
  immutable: boolean | null | undefined,
  mode: string | null | undefined,
  retainUntil: string | null | undefined
): Tone {
  const normalizedMode = safe(mode, "").toUpperCase();

  if (
    immutable &&
    normalizedMode === "COMPLIANCE" &&
    safe(retainUntil, "") !== ""
  ) {
    return "success";
  }

  if (immutable || normalizedMode === "GOVERNANCE") {
    return "warning";
  }

  if (normalizedMode) {
    return "danger";
  }

  return "neutral";
}

export function buildExecutiveConclusion(
  decision: ReportTrustDecision
): CalloutModel {
  return {
    title:
      decision.presentationState === "VERIFIED_FINALIZED"
        ? "Executive conclusion"
        : "Conditional integrity conclusion",
    body:
      decision.presentationState === "VERIFIED_FINALIZED"
        ? "The preserved evidence record reached a verified recorded-integrity state with finalized supporting publication materials at report generation time. Reviewers can use this report to orient themselves to the package, then proceed to the later technical and legal sections for deeper validation and interpretation."
        : decision.presentationState === "VERIFIED_PENDING_PUBLICATION"
          ? `The preserved evidence record reached a verified recorded-integrity state at report generation time, but independent public anchoring or external publication was not finalized yet. Technical confidence remains ${getTrustDecisionConfidenceLabel(
              decision
            ).toLowerCase()}, and publication recheck is recommended if independent public anchoring is required.`
          : "The preserved evidence record is present and reviewable, but one or more supporting technical confirmation signals were not finalized at report generation time. Reviewers should use this report as an evidence-orientation and technical-review aid.",
    tone:
      decision.presentationState === "VERIFIED_FINALIZED" ? "success" : "warning",
  };
}

export function buildLegalLimitationShort(): CalloutModel {
  return {
    title: "Important legal limitation",
    body:
      "This report verifies the recorded integrity state of the evidence record. It does not independently prove factual truth, authorship, context, intent, or legal admissibility.",
    tone: "warning",
  };
}

export function buildStorageCallout(
  canonicalMaterials: CanonicalEvidenceMaterials
): CalloutModel {
  const tone = normalizeStorageTone(
    canonicalMaterials.storageState.isProtected,
    canonicalMaterials.storageState.storageObjectLockMode,
    canonicalMaterials.storageState.storageObjectLockRetainUntilUtc
  );

  return {
    title:
      tone === "success"
        ? "Immutable storage verified"
        : tone === "warning"
          ? "Storage protection recorded"
          : tone === "danger"
            ? "Storage protection requires review"
            : "Storage protection not reported",
    body:
      tone === "success"
        ? "This report records immutable-style storage protection consistent with Object Lock COMPLIANCE mode and a recorded retention-until timestamp."
        : tone === "warning"
          ? "Some storage-protection indicators are recorded, but the report does not fully confirm COMPLIANCE immutable protection."
          : tone === "danger"
            ? "Storage metadata indicates a protection state that should be reviewed before relying on immutability conclusions."
            : "No verifiable storage-protection information was included in the report payload.",
    tone,
  };
}

export function buildTimestampCallout(
  canonicalMaterials: CanonicalEvidenceMaterials,
  failureReason: string | null | undefined
): CalloutModel {
  const tone = normalizeTimestampTone(
    canonicalMaterials.timestampState.tsaStatus
  );

  return {
    title:
      tone === "success"
        ? "Trusted timestamp recorded"
        : tone === "warning"
          ? "Trusted timestamp not finalized"
          : tone === "danger"
            ? "Trusted timestamp could not be obtained"
            : "Trusted timestamp not reported",
    body:
      tone === "success"
        ? "An RFC 3161 timestamp record is available and may support later review of when the recorded integrity state existed."
        : tone === "warning"
          ? "A trusted timestamp was not finalized in the current report state. The evidence record can still be reviewed using its recorded fingerprint, signature, custody, and storage materials."
          : tone === "danger"
            ? normalizeTimestampFailureReason(failureReason)
            : "No trusted timestamp record was included.",
    tone,
  };
}

export function buildOtsCallout(
  canonicalMaterials: CanonicalEvidenceMaterials,
  failureReason: string | null | undefined
): CalloutModel {
  const effectiveStatus =
    canonicalMaterials.otsState.effectiveStatus ??
    canonicalMaterials.otsState.otsStatus;
  const tone = normalizeBitcoinAnchorTone({
    status: effectiveStatus,
    bitcoinTxid: canonicalMaterials.otsState.otsBitcoinTxid,
  });
  const baseStatusTone = normalizeOtsTone(
    canonicalMaterials.otsState.otsStatus
  );

  return {
    title:
      tone === "success"
        ? "Anchored"
        : tone === "warning"
          ? "Pending"
          : tone === "danger"
            ? "Failed"
            : "Unavailable",
    body:
      tone === "success"
        ? "An OpenTimestamps proof is recorded with a Bitcoin transaction reference. This supports independent public anchoring evidence."
        : tone === "warning"
          ? baseStatusTone === "success"
            ? "An OpenTimestamps proof is recorded, but the Bitcoin transaction reference is not yet attached. Bitcoin anchoring will be confirmed after a separate upgrade pass."
            : "OpenTimestamps proof material is present, but public anchoring has not finalized yet."
          : tone === "danger"
            ? `OpenTimestamps processing reported a failure state.${safe(
                failureReason,
                ""
              )
                ? ` ${safe(failureReason)}`
                : ""}`.trim()
            : "No public anchoring record was included.",
    tone,
  };
}

export function buildReviewSequence(
  primaryLabel: string | null | undefined
): CalloutModel {
  return {
    title: "Review sequence",
    body: `Start with the primary evidence item${
      primaryLabel ? ` (${primaryLabel})` : ""
    }, then review the package structure, then assess the recorded integrity outcome, and only then move into forensic custody, timestamping, storage, anchoring, and the technical appendix when deeper validation is needed.`,
    tone: "neutral",
  };
}

export function buildIntegrityReadinessSummary(
  canonicalMaterials: CanonicalEvidenceMaterials
): string {
  return [
    mapTimestampStatusPublicLabel(canonicalMaterials.timestampState.tsaStatus),
    safeBooleanLabel(
      canonicalMaterials.storageState.isProtected,
      "Immutable",
      "Review storage",
      "Not reported"
    ),
  ].join(" • ");
}

export function buildAnchorPublicationSummary(
  anchor: ReportAnchorSummary | null
): string {
  if (anchor?.published) {
    return `Published via ${safe(anchor.provider, "external anchor")}`;
  }

  if (anchor?.configured) {
    return "Public anchoring pending";
  }

  return "Public anchoring unavailable";
}

/**
 * Phase 2/3 — produce the canonical evidence materials bundle for the
 * Report PDF. This is the single chokepoint through which Report-v2
 * consumes lifecycle truth: reviewer evidence type, OTS effective
 * status (honesty rule), workspace scope, legal boundary copy, etc.
 *
 * Phase 3 sections gradually move from reading raw evidence columns
 * to reading this bundle. The bundle is sealed at report generation
 * time — `snapshotSemantics === "report-snapshot-only"` everywhere
 * by construction (REPORT_SNAPSHOT outputType).
 */
export function buildReportCanonicalMaterials(params: {
  evidence: ReportEvidence;
  custodyEvents: ReportCustodyEvent[];
  trustDecision: ReportTrustDecision;
  snapshotGeneratedAtUtc?: string | Date | null;
  /**
   * Evidence parts for the canonical part index. Pass the real ordered
   * parts at verification-package generation time; omit (or pass null)
   * for report-only snapshots where parts are not materialised.
   */
  parts?: ReadonlyArray<{
    partIndex: number;
    sha256: string | null;
    sizeBytes: number | null;
    mimeType: string | null;
  }> | null;
  /** Full canonical media-intelligence object sealed at snapshot time. */
  mediaIntelligence?:
    | MediaIntelligenceReportInput
    | import("../verification-package-intelligence.js").IntelligencePackageInput
    | null;
  /**
   * Defaults to REPORT_SNAPSHOT (the original use-case). The
   * verification-package builder calls this with
   * VERIFICATION_PACKAGE_SNAPSHOT so the emitted
   * `canonical-record.json` carries package-snapshot semantics on
   * every material.
   */
  outputType?:
    | "REPORT_SNAPSHOT"
    | "VERIFICATION_PACKAGE_SNAPSHOT"
    | "OFFLINE_PACKAGE_REVIEW";
}): CanonicalEvidenceMaterials {
  const ev = params.evidence;
  return buildCanonicalEvidenceMaterials({
    evidence: {
      id: ev.id,
      status: ev.status ?? null,
      verificationStatus: ev.verificationStatus ?? null,
      captureMethod: ev.captureMethod ?? null,
      uploadedAtUtc: ev.uploadedAtUtc ?? null,
      signedAtUtc: ev.signedAtUtc ?? null,
      recordedIntegrityVerifiedAtUtc:
        ev.recordedIntegrityVerifiedAtUtc ?? null,
      fileSha256: ev.fileSha256 ?? null,
      fingerprintHash: ev.fingerprintHash ?? null,
      fingerprintCanonicalJsonPresent: Boolean(ev.fingerprintCanonicalJson),
      hashSemantics:
        (ev as { hashSemantics?: string | null }).hashSemantics ?? null,
      multipartManifestSha256:
        (ev as { multipartManifestSha256?: string | null })
          .multipartManifestSha256 ?? null,
      signatureBase64: ev.signatureBase64 ?? null,
      signingKeyId: ev.signingKeyId ?? null,
      signingKeyVersion:
        typeof ev.signingKeyVersion === "number" ? ev.signingKeyVersion : null,
      tsaStatus: ev.tsaStatus ?? null,
      tsaTokenBase64Present: Boolean(
        (ev as { tsaTokenBase64?: string | null }).tsaTokenBase64,
      ),
      tsaSerialNumber: ev.tsaSerialNumber ?? null,
      tsaGenTimeUtc: ev.tsaGenTimeUtc ?? null,
      tsaInputDigestHex:
        (ev as { tsaInputDigestHex?: string | null }).tsaInputDigestHex ?? null,
      tsaInputKind:
        (ev as { tsaInputKind?: string | null }).tsaInputKind ?? null,
      storageObjectLockMode: ev.storageObjectLockMode ?? null,
      storageObjectLockRetainUntilUtc:
        ev.storageObjectLockRetainUntilUtc ?? null,
      storageObjectLockLegalHoldStatus:
        (ev as { storageObjectLockLegalHoldStatus?: string | null })
          .storageObjectLockLegalHoldStatus ?? null,
      otsStatus: ev.otsStatus ?? null,
      otsHash: ev.otsHash ?? null,
      otsBitcoinTxid: ev.otsBitcoinTxid ?? null,
      otsAnchoredAtUtc: ev.otsAnchoredAtUtc ?? null,
      otsUpgradedAtUtc:
        (ev as { otsUpgradedAtUtc?: string | null }).otsUpgradedAtUtc ?? null,
      otsProofPresent: Boolean(
        (ev as { otsProofBase64?: string | null }).otsProofBase64,
      ),
      identityLevelSnapshot: ev.identityLevelSnapshot ?? null,
      workspaceNameSnapshot:
        (ev as { workspaceNameSnapshot?: string | null })
          .workspaceNameSnapshot ?? null,
      organizationNameSnapshot:
        (ev as { organizationNameSnapshot?: string | null })
          .organizationNameSnapshot ?? null,
      organizationVerifiedSnapshot:
        (ev as { organizationVerifiedSnapshot?: boolean | null })
          .organizationVerifiedSnapshot ?? null,
      teamId: (ev as { teamId?: string | null }).teamId ?? null,
    },
    team: null,
    parts: params.parts ?? [],
    custodyEvents: params.custodyEvents.map((e) => ({
      eventType: e.eventType,
      atUtc: e.atUtc,
    })),
    trustDecision: params.trustDecision,
    mediaIntelligence: params.mediaIntelligence ?? null,
    outputType: params.outputType ?? "REPORT_SNAPSHOT",
    snapshotGeneratedAtUtc: params.snapshotGeneratedAtUtc ?? null,
  });
}

export function buildTrustDecision(params: {
  evidence: ReportEvidence;
  custodyEvents: ReportCustodyEvent[];
}): ReportTrustDecision {
  return buildEvidenceTrustDecision({
    evidence: {
      verificationStatus: params.evidence.verificationStatus,
      recordedIntegrityVerifiedAtUtc:
        params.evidence.recordedIntegrityVerifiedAtUtc,
      fileSha256: params.evidence.fileSha256,
      fingerprintHash: params.evidence.fingerprintHash,
      signatureBase64: params.evidence.signatureBase64,
      signingKeyId: params.evidence.signingKeyId,
      publicKeyPem: params.evidence.publicKeyPem,
      tsaStatus: params.evidence.tsaStatus,
      tsaFailureReason: params.evidence.tsaFailureReason,
      otsStatus: params.evidence.otsStatus,
      otsHash: params.evidence.otsHash,
      otsBitcoinTxid: params.evidence.otsBitcoinTxid,
      otsAnchoredAtUtc: params.evidence.otsAnchoredAtUtc,
      otsCalendar: params.evidence.otsCalendar,
      otsFailureReason: params.evidence.otsFailureReason,
      storageImmutable: params.evidence.storageImmutable,
      storageObjectLockMode: params.evidence.storageObjectLockMode,
      storageObjectLockRetainUntilUtc:
        params.evidence.storageObjectLockRetainUntilUtc,
      identityLevelSnapshot: params.evidence.identityLevelSnapshot,
      submittedByEmail: params.evidence.submittedByEmail,
      submittedByAuthProvider: params.evidence.submittedByAuthProvider,
      verificationPackageVersion: params.evidence.verificationPackageVersion,
      verificationPackageGeneratedAtUtc:
        params.evidence.verificationPackageGeneratedAtUtc,
      anchor: params.evidence.anchor
        ? {
            configured: params.evidence.anchor.configured,
            published: params.evidence.anchor.published,
            provider: params.evidence.anchor.provider,
            publicUrl: params.evidence.anchor.publicUrl,
            anchoredAtUtc: params.evidence.anchor.anchoredAtUtc,
            transactionId: params.evidence.anchor.transactionId,
            receiptId: params.evidence.anchor.receiptId,
          }
        : null,
    },
    custodyEvents: params.custodyEvents.map((event) => ({
      eventType: event.eventType,
      category: event.category ?? null,
      eventHash: event.eventHash ?? null,
      prevEventHash: event.prevEventHash ?? null,
    })),
  });
}
