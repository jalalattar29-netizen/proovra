import { OTS_STATE_WORDS, otsStateFromTrustState, presentOtsAnchoring } from "@proovra/shared";
import {
  buildEvidenceTrustDecision,
  buildCanonicalEvidenceMaterials,
  hasCoreCryptoMaterials as hasSharedCoreCryptoMaterials,
  isExplicitRecordedIntegrityVerified,
  type CanonicalEvidenceMaterials,
} from "@proovra/shared";
import { captureMethodDisplayLabel } from "@proovra/shared-runtime/technical-metadata";
import {
  Tone,
  ReportEvidence,
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

  // The presented status: STAMPED is a VALIDATED token and the only success.
  if (s === "STAMPED") return "success";
  // ET-TSA-01: a kept, never-validated token is a caution, not a failure;
  // legacy positive strings never carried a validation either.
  if (["PENDING", "UNAVAILABLE", "RECORDED_NOT_VALIDATED", "GRANTED", "VERIFIED", "SUCCEEDED"].includes(s)) return "warning";
  if (s) return "danger";
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

export function buildExecutiveConclusion(decision: ReportTrustDecision): CalloutModel {
  // (2026-10-13) The evidence record's verification layers in one or two
  // sentences: which verified, which did not — never a verdict, confidence or
  // score, and no product boundary (the Report Boundary states that once).
  // Bitcoin anchoring is an additional public layer stated in its own words
  // (Anchored / Pending / …), never as "verified" and never as a reason not to
  // rely on the preserved bytes (2026-10-13).
  const layers = decision.signals.filter(
    (s) => s.key !== "identity" && s.key !== "verification_package" && s.key !== "bitcoin_anchoring",
  );
  const anchoring = decision.signals.find((s) => s.key === "bitcoin_anchoring");
  const anchoringWord = anchoring ? OTS_STATE_WORDS[otsStateFromTrustState(anchoring.state)] : null;
  const list = (items: string[]) =>
    items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  const lower = (s: { label: string }) => s.label.replace(/^[A-Z](?!itcoin)/, (c) => c.toLowerCase());
  const passed = layers.filter((s) => s.state === "PASSED").map(lower);
  const failed = layers.filter((s) => s.state === "FAILED").map(lower);
  const other = layers.filter((s) => s.state !== "PASSED" && s.state !== "FAILED").map(lower);
  const parts = [
    passed.length ? `Verified for this evidence record: ${list(passed)}.` : "No verification layer passed for this evidence record.",
    failed.length ? `Failed: ${list(failed)} — review before relying on the record.` : "",
    other.length ? `Not verified: ${list(other)}; Trust Signal Analysis states each.` : "",
    anchoringWord ? `Bitcoin anchoring: ${anchoringWord}.` : "",
  ].filter(Boolean);
  return {
    title: "Executive conclusion",
    body: parts.join(" "),
    tone: failed.length ? "danger" : other.length ? "warning" : "success",
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

  // Evidence-output incident (2026-10-05): a FAILED status with a KEPT reply
  // means the authority answered and PROOVRA could not validate the answer
  // (Production: no trust anchor configured). "Could not be obtained" was
  // false. Still a failure tone, and still never presented as a timestamp.
  if (tone === "danger" && canonicalMaterials.timestampState.tokenPresent) {
    const noAnchor = /trust anchor/i.test(String(failureReason ?? ""));
    return {
      title: "Trusted timestamp received but not validated",
      body:
        "A timestamp token was received from the timestamp authority, but it could not be validated, so this report does not rely on it as a trusted timestamp." +
        (noAnchor ? " No timestamp trust anchor was configured to validate it." : ""),
      tone,
    };
  }

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

/**
 * THE OTS CALLOUT (2026-10-13): the "Bitcoin anchoring" card — the canonical
 * state's status word and its one sentence. ANCHORED is a success.
 */
export function buildOtsCallout(canonicalMaterials: CanonicalEvidenceMaterials): CalloutModel {
  const card = presentOtsAnchoring({ state: canonicalMaterials.otsState.state });
  return {
    title: card.status,
    body: card.sentence,
    tone: card.tone === "success" ? "success" : card.tone === "danger" ? "danger" : "neutral",
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
  /**
   * Reliable intake signal from the acquisition context. Required because
   * `completeEvidence` overwrites `evidence.capture_method` to the structure
   * enum MULTIPART_PACKAGE, so the persisted method cannot identify intake.
   * When true, the canonical capture-method reads "Secure Intake Link".
   */
  isIntake?: boolean;
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
      // UC-0 — the acquisition label from the record's acquisition snapshot
      // (never the `captureMethod` structure enum).
      captureMethod: captureMethodDisplayLabel({
        acquisitionMode: ev.acquisitionMode ?? null,
        isIntake: params.isIntake === true,
      }),
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
      otsAnchoredAtUtc: ev.otsAnchoredAtUtc ?? null,
      otsUpgradedAtUtc: ev.otsUpgradedAtUtc ?? null,
      otsFailureReason: ev.otsFailureReason ?? null,
      // The proof bytes: the canonical OTS state is resolved from them.
      otsProofBase64: ev.otsProofBase64 ?? null,
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
  /** True ONLY for Secure Intake evidence — drives role-accurate identity
   *  wording in the trust decision (link creator vs authenticated user). */
  isIntake?: boolean;
}): ReportTrustDecision {
  return buildEvidenceTrustDecision({
    isIntake: params.isIntake === true,
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
      tsaFailureCode: params.evidence.tsaFailureCode ?? null,
      tsaTokenPresent: Boolean(params.evidence.tsaTokenBase64),
      tsaValidatedAtUtc: params.evidence.tsaValidatedAtUtc ?? null,
      otsStatus: params.evidence.otsStatus,
      otsHash: params.evidence.otsHash,
      otsAnchoredAtUtc: params.evidence.otsAnchoredAtUtc,
      otsUpgradedAtUtc: params.evidence.otsUpgradedAtUtc ?? null,
      otsCalendar: params.evidence.otsCalendar,
      otsFailureReason: params.evidence.otsFailureReason,
      // The proof's own bytes: the anchoring signal is the canonical state
      // resolved from them against the fingerprint digest.
      otsProofBase64: params.evidence.otsProofBase64 ?? null,
      signatureVerified: params.evidence.signatureVerified ?? null,
      custodyChainValid: params.evidence.custodyChainValid ?? null,
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
            provider: params.evidence.anchor.provider,
            anchoredAtUtc: params.evidence.anchor.anchoredAtUtc,
            transactionId: params.evidence.anchor.transactionId,
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
