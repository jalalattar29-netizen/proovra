import {
  OTS_VERIFICATION_WORDS,
  TSA_VALIDATED_QUALIFICATION_STATEMENT,
  isOrganizationVerifiedAtCapture,
  otsVerificationOfSignalState,
  presentOtsAnchoring,
  toVerificationStatus,
  type TrustSignal,
  type TrustSignalState,
  type VerificationStatus,
} from "@proovra/shared";
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

/**
 * THE report tone of a canonical verification status (the matrix vocabulary,
 * packages/shared trust-signal-state). The only tone authority for a
 * verification layer in the report: a tone is never read from a raw status
 * word (GRANTED, VERIFIED, SUCCEEDED, FAILED …).
 */
export const VERIFICATION_STATUS_TONE: Readonly<Record<VerificationStatus, Tone>> = {
  VERIFIED: "success",
  FAILED: "danger",
  NOT_CHECKED: "warning",
  UNAVAILABLE: "neutral",
  NOT_APPLICABLE: "neutral",
};

export function verificationStatusTone(status: VerificationStatus): Tone {
  return VERIFICATION_STATUS_TONE[status];
}

/** The trusted-timestamp signal of a trust decision (resolveTsaTrustState). */
export function timestampSignalOf(
  decision: { signals: ReadonlyArray<TrustSignal> } | null | undefined,
): TrustSignal | null {
  return decision?.signals.find((s) => s.key === "trusted_timestamp") ?? null;
}

/** The canonical state of the trusted timestamp; no signal is UNAVAILABLE. */
export function timestampStateOf(
  decision: { signals: ReadonlyArray<TrustSignal> } | null | undefined,
): TrustSignalState {
  return timestampSignalOf(decision)?.state ?? "UNAVAILABLE";
}

/**
 * THE trusted-timestamp tone: the shared TSA reading (resolveTsaTrustState,
 * carried by the trust decision's signal) projected to its verification
 * status. VERIFIED success, FAILED danger, NOT_CHECKED warning, UNAVAILABLE
 * neutral — a kept token that was never validated is NOT_CHECKED, never danger.
 */
export function timestampToneOf(
  decision: { signals: ReadonlyArray<TrustSignal> } | null | undefined,
): Tone {
  return verificationStatusTone(toVerificationStatus(timestampStateOf(decision)));
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
  const anchoringWord = anchoring ? OTS_VERIFICATION_WORDS[otsVerificationOfSignalState(anchoring.state, anchoring.otsVerification)] : null;
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
  // THE canonical TSA reading (2026-10-18): the trust decision's
  // trusted-timestamp signal, never the raw stored status. Evidence-output
  // incident (2026-10-05): a kept reply that was not validated was received —
  // "could not be obtained" was false — and it is a caution, not a failure.
  const signal = timestampSignalOf(canonicalMaterials.trustDecision?.decision);
  const state = signal?.state ?? "UNAVAILABLE";
  const tone = verificationStatusTone(toVerificationStatus(state));
  const rawStatus = safe(canonicalMaterials.timestampState?.tsaStatus, "").toUpperCase();

  switch (state) {
    case "PASSED":
      return signal?.qualifiers?.includes("VALIDATED_FROM_RETAINED_TOKEN")
        ? {
            title: "Trusted timestamp validated from the token retained at intake",
            body:
              "The RFC 3161 timestamp token received and retained at intake was validated later; the record's timeline keeps the intake outcome. " +
              TSA_VALIDATED_QUALIFICATION_STATEMENT,
            tone,
          }
        : {
            title: "Trusted timestamp validated",
            body:
              "An RFC 3161 timestamp token was validated and may support later review of when the recorded integrity state existed. " +
              TSA_VALIDATED_QUALIFICATION_STATEMENT,
            tone,
          };
    case "PRESENT_NOT_INDEPENDENTLY_VERIFIED":
    case "NOT_CHECKED": {
      const noAnchor = /trust anchor/i.test(String(failureReason ?? ""));
      return {
        title: "Trusted timestamp received but not validated",
        body:
          "A timestamp token was received from the timestamp authority and kept, but it has not been validated, so this report does not rely on it as a trusted timestamp." +
          (noAnchor ? " No timestamp trust anchor was configured to validate it." : ""),
        tone,
      };
    }
    case "FAILED":
      return {
        title: "Trusted timestamp validation failed",
        body:
          "A timestamp token was received from the timestamp authority, and validating it failed. It must not be relied on as a trusted timestamp.",
        tone,
      };
    case "PENDING":
    case "STALE":
      return {
        title: "Trusted timestamp not finalized",
        body:
          "A trusted timestamp was not finalized in the current report state. The evidence record can still be reviewed using its recorded fingerprint, signature, custody, and storage materials.",
        tone,
      };
    default:
      return rawStatus === "FAILED" || rawStatus === "UNAVAILABLE"
        ? {
            title: "Trusted timestamp could not be obtained",
            body: normalizeTimestampFailureReason(failureReason),
            tone,
          }
        : {
            title: "Trusted timestamp not reported",
            body: "No trusted timestamp record was included.",
            tone,
          };
  }
}

/**
 * THE OTS CALLOUT: the "Bitcoin anchoring" card — the canonical
 * verification's word and its one sentence. Only CHAIN_VERIFIED is a success.
 */
export function buildOtsCallout(canonicalMaterials: CanonicalEvidenceMaterials): CalloutModel {
  const card = presentOtsAnchoring(canonicalMaterials.otsState);
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
      // The independent Bitcoin-chain check of the stored proof: without it
      // every surface built here would read a CHAIN_VERIFIED record as unchecked.
      otsChainVerificationStatus: ev.otsChainVerificationStatus ?? null,
      otsChainCheckedAtUtc: ev.otsChainCheckedAtUtc ?? null,
      otsChainVerifiedAtUtc: ev.otsChainVerifiedAtUtc ?? null,
      otsChainBlockHeight: ev.otsChainBlockHeight ?? null,
      otsChainBlockHash: ev.otsChainBlockHash ?? null,
      otsChainBlockTimeUtc: ev.otsChainBlockTimeUtc ?? null,
      otsChainConfirmations: ev.otsChainConfirmations ?? null,
      otsChainVerifier: ev.otsChainVerifier ?? null,
      otsChainFailureCode: ev.otsChainFailureCode ?? null,
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
      // (2026-10-18) The same custody marker the API passes: a NEW report issued
      // after the retained-token repair states how the timestamp was validated.
      tsaValidatedFromRetainedToken: params.evidence.tsaValidatedFromRetainedToken === true,
      otsStatus: params.evidence.otsStatus,
      otsHash: params.evidence.otsHash,
      otsAnchoredAtUtc: params.evidence.otsAnchoredAtUtc,
      otsUpgradedAtUtc: params.evidence.otsUpgradedAtUtc ?? null,
      otsCalendar: params.evidence.otsCalendar,
      otsFailureReason: params.evidence.otsFailureReason,
      // The proof's own bytes: the anchoring signal is the canonical state
      // resolved from them against the fingerprint digest.
      otsProofBase64: params.evidence.otsProofBase64 ?? null,
      // The independent Bitcoin-chain check of the stored proof: without it
      // every surface built here would read a CHAIN_VERIFIED record as unchecked.
      otsChainVerificationStatus: params.evidence.otsChainVerificationStatus ?? null,
      otsChainCheckedAtUtc: params.evidence.otsChainCheckedAtUtc ?? null,
      otsChainVerifiedAtUtc: params.evidence.otsChainVerifiedAtUtc ?? null,
      otsChainBlockHeight: params.evidence.otsChainBlockHeight ?? null,
      otsChainBlockHash: params.evidence.otsChainBlockHash ?? null,
      otsChainBlockTimeUtc: params.evidence.otsChainBlockTimeUtc ?? null,
      otsChainConfirmations: params.evidence.otsChainConfirmations ?? null,
      otsChainVerifier: params.evidence.otsChainVerifier ?? null,
      otsChainFailureCode: params.evidence.otsChainFailureCode ?? null,
      signatureVerified: params.evidence.signatureVerified ?? null,
      signatureValidity: params.evidence.signatureValidity ?? null,
      custodyChainValid: params.evidence.custodyChainValid ?? null,
      storageImmutable: params.evidence.storageImmutable,
      storageObjectLockMode: params.evidence.storageObjectLockMode,
      storageObjectLockRetainUntilUtc:
        params.evidence.storageObjectLockRetainUntilUtc,
      storageProtectionVerification: params.evidence.storageProtectionVerification ?? null,
      identityLevelSnapshot: params.evidence.identityLevelSnapshot,
      // AUD-016 — the capture-time organization-verification fact.
      organizationVerifiedAtCapture: isOrganizationVerifiedAtCapture(params.evidence.acquisitionIdentity ?? null),
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
