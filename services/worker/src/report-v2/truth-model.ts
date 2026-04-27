import {
  Tone,
  ReportEvidence,
  ReportAnchorSummary,
  CalloutModel,
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
  return (
    safe(evidence.verificationStatus, "").toUpperCase() ===
      "RECORDED_INTEGRITY_VERIFIED" ||
    safe(evidence.recordedIntegrityVerifiedAtUtc, "") !== ""
  );
}

export function hasCoreCryptoMaterials(evidence: ReportEvidence): boolean {
  return Boolean(
    evidence.fileSha256 &&
      evidence.fingerprintHash &&
      evidence.signatureBase64 &&
      evidence.signingKeyId
  );
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
        ? "OpenTimestamps anchored"
        : tone === "warning"
          ? "OpenTimestamps pending"
          : tone === "danger"
            ? "OpenTimestamps failed"
            : "OpenTimestamps not reported",
    body:
      tone === "success"
        ? "An OpenTimestamps proof is recorded in an anchored state and may provide additional independent public anchoring evidence."
        : tone === "warning"
          ? "OpenTimestamps proof data is present but not yet in a final anchored state."
          : tone === "danger"
            ? `OpenTimestamps processing reported a failure state.${safe(
                evidence.otsFailureReason,
                ""
              )
                ? ` ${safe(evidence.otsFailureReason)}`
                : ""}`.trim()
            : "No OpenTimestamps record was included.",
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
    return `Anchor configured but no published record captured`;
  }

  return "No external publication recorded";
}
