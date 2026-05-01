import {
  buildEvidenceTrustDecision,
  hasCoreCryptoMaterials as hasSharedCoreCryptoMaterials,
  isExplicitRecordedIntegrityVerified,
} from "@proovra/shared";
import {
  Tone,
  ReportEvidence,
  ReportAnchorSummary,
  ReportCustodyEvent,
  CalloutModel,
  ReportTrustDecision,
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
  evidence: ReportEvidence
): CalloutModel {
  const verified = isIntegrityVerified(evidence);

  return {
    title: verified ? "Executive conclusion" : "Reviewable evidence record",
    body: verified
      ? "The preserved evidence record reached a verified recorded-integrity state at report generation time. Reviewers can use this report to orient themselves to the package, then proceed to the later technical and legal sections for deeper validation and interpretation."
      : "The preserved evidence record is present and reviewable, but one or more technical confirmation signals were not finalized at report generation time. Reviewers should use the report as an evidence-orientation and technical-review aid.",
    tone: verified ? "success" : "warning",
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

export function buildStorageCallout(evidence: ReportEvidence): CalloutModel {
  const tone = normalizeStorageTone(
    evidence.storageImmutable,
    evidence.storageObjectLockMode,
    evidence.storageObjectLockRetainUntilUtc
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

export function buildTimestampCallout(evidence: ReportEvidence): CalloutModel {
  const tone = normalizeTimestampTone(evidence.tsaStatus);

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
            ? normalizeTimestampFailureReason(evidence.tsaFailureReason)
            : "No trusted timestamp record was included.",
    tone,
  };
}

export function buildOtsCallout(evidence: ReportEvidence): CalloutModel {
  const tone = normalizeOtsTone(evidence.otsStatus);

  return {
    title:
      tone === "success"
        ? "Public anchoring verified"
        : tone === "warning"
          ? "OTS proof present, public anchoring pending"
          : tone === "danger"
            ? "Public anchoring failed"
            : "Public anchoring unavailable",
    body:
      tone === "success"
        ? "An OpenTimestamps proof is recorded in an anchored state and may provide additional independent public anchoring evidence."
        : tone === "warning"
          ? "OpenTimestamps proof material is present, but Bitcoin/public anchoring has not finalized yet."
          : tone === "danger"
            ? `OpenTimestamps processing reported a failure state.${safe(
                evidence.otsFailureReason,
                ""
              )
                ? ` ${safe(evidence.otsFailureReason)}`
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
  evidence: ReportEvidence
): string {
  return [
    mapTimestampStatusPublicLabel(evidence.tsaStatus),
    safeBooleanLabel(
      evidence.storageImmutable,
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
