import * as prismaPkg from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { evaluateCustodyChain } from "./custody-events.service.js";
import {
  deriveCanonicalArtifactAvailability,
  isAccessCustodyEventType,
  normalizeOtsStatusValue,
} from "@proovra/shared";
import type {
  EvidenceIntelligence,
  EvidenceOutputState,
  OutputNotApplicableReason,
} from "@proovra/shared";

type EvidenceIntelligenceStorageSummary = {
  immutable: boolean;
  mode: string | null;
  retainUntil: string | null;
  legalHold: string | null;
  region: string | null;
  verified: boolean;
} | null;

type EvidenceIntelligenceAnchorInput = {
  provider: string | null;
  mode: string | null;
  configured: boolean;
  anchorHash: string | null;
  anchoredAtUtc: Date | string | null;
  transactionId: string | null;
} | null;

type EvidenceIntelligenceInput = {
  evidenceId: string;
  evidence: {
    id: string;
    status: prismaPkg.EvidenceStatus;
    verificationStatus: prismaPkg.VerificationStatus | null;
    signedAtUtc: Date | string | null;
    capturedAtUtc: Date | string | null;
    uploadedAtUtc: Date | string | null;
    lastAccessedAtUtc: Date | string | null;
    lastVerifiedAtUtc: Date | string | null;
    recordedIntegrityVerifiedAtUtc: Date | string | null;
    captureMethod: prismaPkg.CaptureMethod | null;
    identityLevelSnapshot: prismaPkg.IdentityLevel | null;
    submittedByEmail: string | null;
    submittedByAuthProvider: prismaPkg.AuthProvider | null;
    uploadedByUserId: string | null;
    createdByUserId: string | null;
    workspaceNameSnapshot: string | null;
    organizationNameSnapshot: string | null;
    organizationVerifiedSnapshot: boolean | null;
    fileSha256: string | null;
    fingerprintHash: string | null;
    signatureBase64: string | null;
    signingKeyId: string | null;
    signingKeyVersion: number | null;
    tsaStatus: string | null;
    otsStatus: string | null;
    reportGeneratedAtUtc: Date | string | null;
    verificationPackageGeneratedAtUtc: Date | string | null;
    latestReportVersion: number | null;
    verificationPackageVersion: number | null;
    createdAt: Date | string | null;
    deviceTimeIso: string | null;
    lat: number | null;
    lng: number | null;
    accuracyMeters: number | null;
    lockedAt: Date | string | null;
    archivedAt: Date | string | null;
    deletedAt: Date | string | null;
    deleteScheduledForUtc: Date | string | null;
    retentionUntilUtc: Date | string | null;
    storageBucket: string | null;
    storageKey: string | null;
    storageRegion: string | null;
    storageObjectLockMode: string | null;
    storageObjectLockRetainUntilUtc: Date | string | null;
    storageObjectLockLegalHoldStatus: string | null;
  };
  anchor: EvidenceIntelligenceAnchorInput;
  storage: EvidenceIntelligenceStorageSummary;
  /**
   * =========================================================================
   * P1-1 CLOSURE (2026-09-10) — THE CANONICAL OUTPUT STATE, HANDED IN.
   * =========================================================================
   * This module used to answer "does this record have its outputs?" from
   * `reportReady` / `packageReady` — artifact-row presence, with no commercial
   * or lifecycle input whatsoever. It was therefore a SECOND output authority,
   * and its answer reached the same page as the canonical one:
   *
   *   Artifacts tab   "Reports are not included for this record"   (canonical)
   *   Overview tab    "Needs review …  Generate the PDF report
   *                    before external review"                     (this file)
   *   Risk signals    two WARNING entries                          (this file)
   *
   * on one record, at one moment, on one screen.
   *
   * It is REQUIRED, not optional. An optional field would let a caller omit it
   * and silently fall back to the defect; making it required turns every call
   * site into a compile error until it supplies the one already-resolved
   * projection, which is what "one decision" means in practice.
   *
   * This module still decides NOTHING commercial. It receives the verdict.
   */
  outputs: EvidenceIntelligenceOutputs;
};

/**
 * The slice of the canonical `EvidenceArtifactStatus.outputs` this module
 * consumes. Deliberately narrow — a state and a bounded reason per output —
 * so nothing here can reach for an axis and start re-deriving.
 */
export type EvidenceIntelligenceOutputs = {
  report: {
    state: EvidenceOutputState;
    notApplicableReason: OutputNotApplicableReason | null;
  };
  verificationPackage: {
    state: EvidenceOutputState;
    notApplicableReason: OutputNotApplicableReason | null;
  };
};

/**
 * IS THE ABSENCE OF THIS OUTPUT SOMETHING A REVIEWER CAN ACT ON?
 *
 * THE one predicate that replaces `!reportReady`. Three states answer "no" and
 * they answer it for three different reasons, all of which are the product
 * working correctly:
 *
 *   READY           it is not absent at all.
 *   NOT_INCLUDED    the plan and this record's funding exclude it. That is a
 *                   commercial decision the customer made, not a gap in the
 *                   evidence — and an advisory panel is not a sales surface.
 *   NOT_APPLICABLE  the record cannot carry the output: it is not finalized,
 *                   or its integrity check failed. Neither is a review gap,
 *                   and the integrity case has its own, louder signal.
 *
 * Everything else — queued, generating, failed, blocked — genuinely is
 * something a reviewer wants to know about, and the canonical state says
 * which.
 */
function outputAbsenceIsReviewGap(state: EvidenceOutputState): boolean {
  switch (state) {
    case "READY":
    case "NOT_INCLUDED":
    case "NOT_APPLICABLE":
      return false;
    case "ELIGIBLE_NOT_GENERATED":
    case "QUEUED":
    case "GENERATING":
    case "RETRYABLE_FAILURE":
    case "TERMINAL_FAILURE":
    case "BLOCKED":
      return true;
  }
}

/**
 * Does this output contribute to the readiness SCORE at all?
 *
 * Distinct from {@link outputAbsenceIsReviewGap} on purpose. A queued output is
 * a review gap worth mentioning AND a legitimate zero in the score — the record
 * is genuinely less ready than one whose artifact exists. But an output the
 * product never produces for this record must leave the denominator entirely:
 * scoring it as zero would mean a Free record could never score above 50%, and
 * the number would be measuring the price plan rather than the evidence.
 */
function outputParticipatesInReadinessScore(
  state: EvidenceOutputState,
): boolean {
  return state !== "NOT_INCLUDED" && state !== "NOT_APPLICABLE";
}

type EventLabelInfo = {
  label: string;
  source: "USER" | "SYSTEM" | "PUBLIC_VERIFY" | "API" | "UNKNOWN";
  tone: "success" | "warning" | "danger" | "neutral";
  description: string;
};

const EVENT_TYPE_LABELS: Record<string, EventLabelInfo> = {
  EVIDENCE_CREATED: {
    label: "Evidence created",
    source: "SYSTEM",
    tone: "success",
    description: "The evidence record was created.",
  },
  UPLOAD_STARTED: {
    label: "Upload started",
    source: "SYSTEM",
    tone: "neutral",
    description: "The evidence upload session started.",
  },
  UPLOAD_COMPLETED: {
    label: "Upload completed",
    source: "SYSTEM",
    tone: "success",
    description: "The evidence file materials were uploaded and recorded.",
  },
  EVIDENCE_COMPLETED: {
    label: "Evidence completed",
    source: "SYSTEM",
    tone: "success",
    description: "The evidence record was completed before report generation.",
  },
  SIGNATURE_APPLIED: {
    label: "Digital signature applied",
    source: "SYSTEM",
    tone: "success",
    description: "A cryptographic signature was applied to the recorded fingerprint.",
  },
  TIMESTAMP_APPLIED: {
    label: "Trusted timestamp recorded",
    source: "SYSTEM",
    tone: "success",
    description: "A trusted timestamp was recorded for the preserved integrity state.",
  },
  TIMESTAMP_FAILED: {
    label: "Trusted timestamp failed",
    source: "SYSTEM",
    tone: "warning",
    description: "A trusted timestamp could not be obtained for this record.",
  },
  OTS_APPLIED: {
    label: "OpenTimestamp proof recorded",
    source: "SYSTEM",
    tone: "warning",
    description: "OpenTimestamp proof material was recorded. Public anchoring may still be pending.",
  },
  OTS_FAILED: {
    label: "OpenTimestamp failed",
    source: "SYSTEM",
    tone: "warning",
    description: "OpenTimestamp proof creation failed or could not be completed.",
  },
  IDENTITY_SNAPSHOT_RECORDED: {
    label: "Identity snapshot recorded",
    source: "SYSTEM",
    tone: "success",
    description: "Submitter and workspace identity context was recorded for reviewer reference.",
  },
  REPORT_GENERATED: {
    label: "Report generated",
    source: "SYSTEM",
    tone: "success",
    description: "A PDF verification report was generated for this evidence record.",
  },
  REVIEW_READY: {
    label: "Review ready",
    source: "SYSTEM",
    tone: "success",
    description: "The evidence record was marked ready for reviewer inspection.",
  },
  VERIFICATION_PACKAGE_GENERATED: {
    label: "Verification package generated",
    source: "SYSTEM",
    tone: "success",
    description: "A verification package was generated for independent technical review.",
  },
  EVIDENCE_LOCKED: {
    label: "Evidence locked",
    source: "SYSTEM",
    tone: "success",
    description: "The evidence record was locked or sealed in the preservation workflow.",
  },

  EVIDENCE_VIEWED: {
    label: "Evidence viewed",
    source: "USER",
    tone: "success",
    description: "The evidence record was viewed by an authorized user.",
  },
  EVIDENCE_DOWNLOADED: {
    label: "Evidence downloaded",
    source: "USER",
    tone: "success",
    description: "An authorized user downloaded the evidence file.",
  },
  REPORT_DOWNLOADED: {
    label: "Report downloaded",
    source: "USER",
    tone: "success",
    description: "A generated report was downloaded for the evidence.",
  },
  VERIFICATION_PACKAGE_DOWNLOADED: {
    label: "Verification package downloaded",
    source: "USER",
    tone: "success",
    description: "The evidence verification package was downloaded.",
  },
  VERIFY_VIEWED: {
    label: "Verification page viewed",
    source: "PUBLIC_VERIFY",
    tone: "neutral",
    description: "An external verification link was accessed.",
  },
  TECHNICAL_VERIFICATION_CHECKED: {
    label: "Verification check performed",
    source: "SYSTEM",
    tone: "success",
    description: "The evidence verification process was executed.",
  },
};

function resolveEventLabelInfo(eventType: string | null | undefined): EventLabelInfo {
  const normalized = String(eventType ?? "").trim().toUpperCase();
  return (
    EVENT_TYPE_LABELS[normalized] ?? {
      label: normalized || "Unknown event",
      source: "UNKNOWN",
      tone: "neutral",
      description: "A custody event was recorded.",
    }
  );
}

function buildEvidenceReviewDecision(params: {
  evidence: EvidenceIntelligenceInput["evidence"];
  chainValid: boolean;
  chainMode: string;
  outputs: EvidenceIntelligenceOutputs;
  anchorVerified: boolean;
}): EvidenceIntelligence["reviewerDecision"] {
  const issues: string[] = [];
  const nextActions: string[] = [];
  const statusEvidence = String(params.evidence.status).toUpperCase();
  const reportState = params.outputs.report.state;
  const packageState = params.outputs.verificationPackage.state;
  const reportReady = reportState === "READY";

  if (!params.chainValid) {
    issues.push("Custody chain integrity could not be verified.");
    nextActions.push("Review custody event history and reconcile missing event hashes.");
  }

  /*
   * P1-1 CLOSURE (2026-09-10) — GATED ON THE CANONICAL STATE, NOT ON ABSENCE.
   *
   * This was `if (!params.reportReady)`, which is true of a Free record whose
   * plan will never produce a report and of an unfinalized upload — and it
   * pushed "Generate the PDF report before external review" onto the Overview
   * tab for both. The Artifacts tab, reading the canonical state, was
   * simultaneously saying reports are not included. One page, two answers.
   *
   * The verb also follows the state now: a record whose generation has already
   * been requested does not need to be told to request it.
   */
  if (outputAbsenceIsReviewGap(reportState)) {
    if (reportState === "ELIGIBLE_NOT_GENERATED") {
      issues.push("Evidence report is not yet generated.");
      nextActions.push("Generate the report and verification package before external review.");
    } else if (reportState === "QUEUED" || reportState === "GENERATING") {
      issues.push("Evidence report generation is still in progress.");
    } else {
      issues.push("Evidence report generation did not complete.");
      nextActions.push("Open the record's Artifacts tab for the reason and the available action.");
    }
  }

  /*
   * ANCHORING AND THE PACKAGE ARE ONE SENTENCE ONLY WHERE BOTH ARE REAL GAPS.
   *
   * The old condition was `!anchorVerified && !packageReady`, so a Free record
   * with a pending anchor produced "Public verification and verification
   * package are not fully available" — half of which the customer never bought.
   *
   * The package half is dropped entirely when its absence is not a gap, and
   * with it goes the "generate a package" guidance: there is no standalone
   * package action in this product. Generation is PAIRED — one request produces
   * the report and the package — so the only honest verb is the paired one
   * above, and naming a package-only action here invented a control that does
   * not exist.
   */
  const packageAbsenceIsGap = outputAbsenceIsReviewGap(packageState);
  if (!params.anchorVerified && packageAbsenceIsGap) {
    issues.push("Bitcoin anchoring and the verification package are not yet available.");
  } else if (!params.anchorVerified && !reportReady) {
    issues.push("Bitcoin anchoring has not been confirmed for this record.");
  }

  if (params.evidence.deletedAt) {
    return {
      status: "RESTRICTED",
      label: "Restricted Evidence",
      summary: "This evidence record is currently in a restricted state and may not be suitable for external review.",
      reasons: ["Evidence is in secure trash or marked for deletion."],
      nextActions: ["Restore or resolve the evidence state before review."],
      tone: "danger",
    };
  }

  /*
   * P1-1 CLOSURE — A TERMINAL INTEGRITY FAILURE IS ITS OWN VERDICT.
   *
   * It used to reach the generic "Needs review" tail below and be explained by
   * whichever issues happened to be in the list — which, before this change,
   * included "Evidence report is not yet generated". The record's problem is
   * not a missing report.
   */
  if (params.outputs.report.notApplicableReason === "INTEGRITY_FAILED") {
    return {
      status: "NEEDS_ATTENTION",
      label: "Integrity check failed",
      summary:
        "The fingerprint recomputed from this record's stored bytes did not match the value recorded when it was completed. It is preserved for inspection and no outputs will be produced from it.",
      reasons: [
        "Recomputed fingerprint does not match the value recorded at completion.",
      ],
      nextActions: [
        "Re-upload or re-capture the source material as a new evidence record.",
      ],
      tone: "danger",
    };
  }

  if (issues.length === 0 && params.chainValid && reportReady) {
    return {
      status: "READY_FOR_EXTERNAL_REVIEW",
      label: "Ready for review",
      summary: "The evidence record has a verified custody chain, a generated report, and available verification artifacts.",
      reasons: [
        `Custody chain is ${params.chainMode}.`,
        "Evidence report is generated.",
        params.anchorVerified
          ? "OpenTimestamps Bitcoin anchoring verified."
          : "Verification package is available.",
      ],
      nextActions: [
        "Share the verification link with external reviewers.",
        "Provide the generated report as supporting evidence.",
      ],
      tone: "success",
    };
  }

  /*
   * P1-1 CLOSURE — A RECORD WITHOUT PAID OUTPUTS IS NOT A RECORD THAT NEEDS
   * ATTENTION.
   *
   * Without this branch a finalized Free record fell through to "Needs review"
   * with the filler reason "Some verification or preservation signals are
   * incomplete" — marking it deficient for a commercial decision, which is
   * exactly what §3.2 of the closure forbids. Its custody chain is intact, its
   * integrity material is complete and its public verification works; the only
   * thing it lacks is an artifact the plan does not sell.
   *
   * Deliberately NOT extended to NOT_APPLICABLE: a record that is not
   * finalized has not finished becoming evidence, and saying it is ready for
   * external review would be the opposite error.
   */
  if (
    issues.length === 0 &&
    params.chainValid &&
    reportState === "NOT_INCLUDED" &&
    (statusEvidence === "SIGNED" || statusEvidence === "REPORTED")
  ) {
    return {
      status: "READY_FOR_EXTERNAL_REVIEW",
      label: "Ready for review",
      summary:
        "The evidence record has a verified custody chain and complete integrity material. A PDF report and verification package are not included for this record; its public verification page carries the same integrity evidence.",
      reasons: [
        `Custody chain is ${params.chainMode}.`,
        "Fingerprint, signature and custody materials are recorded.",
        params.anchorVerified
          ? "OpenTimestamps Bitcoin anchoring verified."
          : "Public verification is available for this record.",
      ],
      nextActions: ["Share the verification link with external reviewers."],
      tone: "success",
    };
  }

  if (statusEvidence === "SIGNED" || statusEvidence === "REPORTED") {
    return {
      status: "NEEDS_ATTENTION",
      label: "Needs review",
      summary: "This evidence record has strong preservation signals but still requires additional verification artifacts or custody confirmation.",
      reasons: issues.length > 0 ? issues : ["Some verification or preservation signals are incomplete."],
      nextActions:
        nextActions.length > 0
          ? nextActions
          : ["Confirm proof artifacts, then re-run the evidence verification workflow."],
      tone: "warning",
    };
  }

  return {
    status: "NEEDS_ATTENTION",
    label: "Review recommended",
    summary: "The evidence has not yet achieved a fully review-ready state.",
    reasons: issues.length > 0 ? issues : ["The evidence record lacks review-ready verification signals."],
    nextActions:
      nextActions.length > 0
        ? nextActions
        : ["Complete evidence review readiness tasks and validate preservation state."],
    tone: "neutral",
  };
}

function buildVerificationProof(params: EvidenceIntelligenceInput["evidence"]): EvidenceIntelligence["verificationProof"] {
  const hasHash = Boolean(params.fileSha256 || params.fingerprintHash);
  const signaturePresent = Boolean(params.signatureBase64 || params.signingKeyId || params.signingKeyVersion);
  const tsaStatus = params.tsaStatus ? String(params.tsaStatus).trim().toUpperCase() : "UNKNOWN";
  const otsStatus = normalizeOtsStatusValue(params.otsStatus) ?? "UNKNOWN";

  return {
    hashMatch: hasHash ? "MATCH" : "NOT_CHECKED",
    sha256Recorded: Boolean(params.fileSha256),
    signatureStatus: signaturePresent ? "APPLIED" : "MISSING",
    tsaStatus:
      [
        "RECORDED",
        "SIGNED",
        "COMPLETE",
        "STAMPED",
        "GRANTED",
        "VERIFIED",
        "SUCCEEDED",
      ].includes(tsaStatus)
        ? "RECORDED"
        : tsaStatus === "FAILED" || tsaStatus === "ERROR" || tsaStatus === "UNAVAILABLE"
          ? "FAILED"
          : tsaStatus === "PENDING"
            ? "PENDING"
            : "UNKNOWN",
                otsStatus,
  };
}

function buildArtifactSummaries(params: {
  evidence: EvidenceIntelligenceInput["evidence"];
}): EvidenceIntelligence["artifacts"] {
  const artifactAvailability = deriveCanonicalArtifactAvailability({
    latestReportVersion: params.evidence.latestReportVersion,
    reportGeneratedAtUtc: params.evidence.reportGeneratedAtUtc,
    verificationPackageVersion: params.evidence.verificationPackageVersion,
    verificationPackageGeneratedAtUtc:
      params.evidence.verificationPackageGeneratedAtUtc,
  });

  return {
    report: {
      available: artifactAvailability.report.available,
      label: "PDF report",
      version: artifactAvailability.report.version
        ? String(artifactAvailability.report.version)
        : null,
      generatedAtUtc: artifactAvailability.report.generatedAtUtc,
      generatedByLabel: "Automated report engine",
      downloadCount: null,
      lastDownloadedAtUtc: null,
      offlineVerificationIncluded: true,
    },
    verificationPackage: {
      available: artifactAvailability.verificationPackage.available,
      label: "Verification package",
      version: artifactAvailability.verificationPackage.version
        ? String(artifactAvailability.verificationPackage.version)
        : null,
      generatedAtUtc: artifactAvailability.verificationPackage.generatedAtUtc,
      generatedByLabel: "Automated package generator",
      downloadCount: null,
      lastDownloadedAtUtc: null,
      offlineVerificationIncluded: true,
    },
    verificationProofArtifacts: {
      available: Boolean(params.evidence.otsStatus || params.evidence.tsaStatus || params.evidence.signatureBase64),
      label: "Verification proof artifacts",
      version: null,
      generatedAtUtc: null,
      generatedByLabel: "Capture system",
      downloadCount: null,
      lastDownloadedAtUtc: null,
      offlineVerificationIncluded: Boolean(params.evidence.otsStatus || params.evidence.tsaStatus),
    },
  };
}

function buildAccessActivitySummary(params: {
  records: Array<{
    sequence: number;
    eventType: string;
    atUtc: Date;
    payload: Prisma.JsonValue | null;
    prevEventHash: string | null;
    eventHash: string | null;
  }>;
}): EvidenceIntelligence["accessActivity"] {
  const accessRecords = params.records.filter((event) =>
    isAccessCustodyEventType(event.eventType)
  );

  const recentEvents = accessRecords
    .slice(-6)
    .reverse()
    .map((event) => {
      const info = resolveEventLabelInfo(event.eventType);
      return {
        eventType: event.eventType,
        label: info.label,
        timestampUtc: event.atUtc.toISOString(),
        actorLabel:
          info.source === "PUBLIC_VERIFY"
            ? "External reviewer"
            : info.source === "SYSTEM"
              ? "System process"
              : "Authorized user",
        source: info.source,
        tone: info.tone,
        description: info.description,
      };
    });

  const publicVerifyViews = accessRecords.filter(
    (event) => String(event.eventType).toUpperCase() === "VERIFY_VIEWED"
  ).length;

  const reportDownloads = accessRecords.filter(
    (event) => String(event.eventType).toUpperCase() === "REPORT_DOWNLOADED"
  ).length;

  const verificationPackageDownloads = accessRecords.filter(
    (event) =>
      String(event.eventType).toUpperCase() ===
      "VERIFICATION_PACKAGE_DOWNLOADED"
  ).length;

  const lastViewedAtUtc =
    accessRecords.map((event) => event.atUtc.toISOString()).sort().pop() ?? null;

  const lastDownloadedAtUtc =
    accessRecords
      .filter((event) =>
        [
          "EVIDENCE_DOWNLOADED",
          "REPORT_DOWNLOADED",
          "VERIFICATION_PACKAGE_DOWNLOADED",
        ].includes(String(event.eventType).toUpperCase())
      )
      .map((event) => event.atUtc.toISOString())
      .sort()
      .pop() ?? null;

  return {
    publicVerifyViews: publicVerifyViews || null,
    reportDownloads: reportDownloads || null,
    verificationPackageDownloads: verificationPackageDownloads || null,
    originalDownloads: null,
    lastViewedAtUtc,
    lastDownloadedAtUtc,
    recentEvents,
  };
}

function buildReviewerAlerts(params: {
  evidence: EvidenceIntelligenceInput["evidence"];
  anchor: EvidenceIntelligenceAnchorInput;
  storage: EvidenceIntelligenceStorageSummary;
  chainValid: boolean;
  outputs: EvidenceIntelligenceOutputs;
}): EvidenceIntelligence["reviewerAlerts"] {
  const alerts: EvidenceIntelligence["reviewerAlerts"] = [];

  if (params.evidence.deletedAt) {
    alerts.push({
      severity: "danger",
      label: "Trash retention active",
      detail: "This evidence is currently deleted and retained in secure trash.",
    });
  }

  if (params.evidence.lockedAt) {
    alerts.push({
      severity: "info",
      label: "Record sealed",
      detail: "Evidence has been permanently locked to preserve chain-of-custody.",
    });
  }

  if (!params.chainValid) {
    alerts.push({
      severity: "danger",
      label: "Custody chain issue",
      detail: "One or more custody events did not match expected chain integrity.",
    });
  }

  /*
   * =======================================================================
   * P1-1 CLOSURE (2026-09-10) — THESE TWO ARE GONE FROM THIS MODULE.
   * =======================================================================
   * They fired on `!reportReady` / `!packageReady` — pure artifact-row
   * absence — and the route merges this array with the CANONICAL alert block
   * it builds from `outputs.*.state`. That canonical block deliberately emits
   * nothing for NOT_INCLUDED, so on every Free record the page showed the two
   * WARNING signals below and the canonical silence at the same time: the old
   * authority overruling the new one on the same screen.
   *
   * The canonical block already covers every state where an output's absence
   * IS worth a reviewer's attention (queued, generating, failed, blocked,
   * eligible-but-ungenerated), with copy keyed to the state. Emitting a second
   * alert from here could only duplicate it or contradict it.
   *
   * What remains here is the INTEGRITY case, which the canonical output block
   * does not cover because it is not an output condition at all — it is a fact
   * about the record, and it is the loudest thing on this panel.
   */
  if (params.outputs.report.notApplicableReason === "INTEGRITY_FAILED") {
    alerts.push({
      severity: "danger",
      label: "Integrity check failed",
      detail:
        "The fingerprint recomputed from the stored bytes does not match the value recorded at completion. No outputs will be produced for this record.",
    });
  }

  const anchorVerified = Boolean(
    params.anchor?.transactionId || params.anchor?.anchoredAtUtc
  );
  if (!anchorVerified && !params.anchor?.configured) {
    alerts.push({
      severity: "warning",
      label: "Public verification not configured",
      detail: "Public verification is not enabled for this evidence record.",
    });
  }

  if (!params.storage?.verified) {
    alerts.push({
      severity: "warning",
      label: "Storage protection incomplete",
      detail: "Storage object lock or legal hold settings are not fully configured.",
    });
  }

  if (alerts.length === 0) {
    alerts.push({
      severity: "info",
      label: "Review ready",
      detail: "This record has no flagged issues in the current intelligence summary.",
    });
  }

  return alerts;
}

function buildCustodyTimeline(params: {
  records: Array<{
    sequence: number;
    eventType: string;
    atUtc: Date;
    payload: Prisma.JsonValue | null;
    prevEventHash: string | null;
    eventHash: string | null;
  }>;
}): EvidenceIntelligence["custodyTimeline"] {
  const forensicRecords = params.records.filter(
    (record) => !isAccessCustodyEventType(record.eventType)
  );

  return forensicRecords
    .slice(-10)
    .reverse()
    .map((record) => {
      const info = resolveEventLabelInfo(record.eventType);
      return {
        eventType: record.eventType,
        label: info.label,
        timestampUtc: record.atUtc.toISOString(),
        actorLabel:
          info.source === "SYSTEM"
            ? "System"
            : info.source === "PUBLIC_VERIFY"
              ? "Public verification"
              : "User",
        source: info.source,
        tone: info.tone,
        description: info.description,
      };
    });
}

/**
 * The readiness score.
 *
 * ---------------------------------------------------------------------------
 * P1-1 CLOSURE (2026-09-10) — AN OUTPUT THE PRODUCT WILL NEVER MAKE LEAVES THE
 * DENOMINATOR, RATHER THAN SCORING ZERO.
 * ---------------------------------------------------------------------------
 * The score was a fixed four-signal average with `reportReady` and
 * `packageReady` as two of the four. On a Free record both are permanently
 * false, so the ceiling was 50% no matter how complete the evidence was — the
 * number was measuring the price plan. The same was true of a record still
 * uploading, and of one whose integrity check failed.
 *
 * Excluding the signal is the correct fix and zeroing it is not: a record that
 * is not entitled to an artifact is not LESS PREPARED for review than one that
 * is; the artifact simply is not part of what preparation means for it. A
 * QUEUED or FAILED output, by contrast, stays in the denominator and scores
 * zero, because there the absence really is an incomplete step.
 */
function buildLibrarySummary(params: {
  evidence: EvidenceIntelligenceInput["evidence"];
  chainValid: boolean;
  outputs: EvidenceIntelligenceOutputs;
  anchorVerified: boolean;
}): EvidenceIntelligence["librarySummary"] {
  const signals: number[] = [
    params.chainValid ? 1 : 0,
    params.anchorVerified ? 1 : 0,
  ];
  if (outputParticipatesInReadinessScore(params.outputs.report.state)) {
    signals.push(params.outputs.report.state === "READY" ? 1 : 0);
  }
  if (
    outputParticipatesInReadinessScore(
      params.outputs.verificationPackage.state,
    )
  ) {
    signals.push(
      params.outputs.verificationPackage.state === "READY" ? 1 : 0,
    );
  }
  const score = Math.round((signals.reduce((sum, value) => sum + value, 0) / signals.length) * 100);

  return {
    label: "Evidence readiness score",
    score: score === 0 ? null : score,
    description: `Scored from custody integrity, artifact availability, and verification readiness. ${score >= 80 ? "Well prepared for review." : score >= 50 ? "Most required review context is available; some gaps remain." : "Additional preparation is recommended."}`,
    // Phase A6 — mandatory completeness-only boundary. This is a preparation
    // signal, never a truth/authenticity/admissibility judgement.
    boundary:
      "This score measures review-preparation completeness only. It does not assess truth, authenticity, reliability, evidential strength, or legal admissibility.",
  };
}

function formatNullableDate(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = typeof value === "string" ? new Date(value) : value;
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export async function buildEvidenceIntelligence(
  params: EvidenceIntelligenceInput
): Promise<EvidenceIntelligence> {
  const custodyRecords = await prisma.custodyEvent.findMany({
    where: { evidenceId: params.evidenceId },
    orderBy: { sequence: "asc" },
    select: {
      sequence: true,
      eventType: true,
      atUtc: true,
      payload: true,
      prevEventHash: true,
      eventHash: true,
    },
  });

  const chain = evaluateCustodyChain({
    evidenceId: params.evidenceId,
    records: custodyRecords.map((record) => ({
      sequence: record.sequence,
      eventType: record.eventType,
      atUtc: record.atUtc,
      payload: record.payload,
      prevEventHash: record.prevEventHash,
      eventHash: record.eventHash,
    })),
  });

  const accessEventCount = custodyRecords.filter((record) =>
    isAccessCustodyEventType(record.eventType)
  ).length;
  const forensicEventCount = custodyRecords.length - accessEventCount;

  const { reportReady, packageReady: verificationPackageReady } = deriveCanonicalArtifactAvailability({
    latestReportVersion: params.evidence.latestReportVersion,
    reportGeneratedAtUtc: params.evidence.reportGeneratedAtUtc,
    verificationPackageVersion: params.evidence.verificationPackageVersion,
    verificationPackageGeneratedAtUtc: params.evidence.verificationPackageGeneratedAtUtc,
  });

  return {
    recordId: params.evidenceId,
    status: {
      evidence: String(params.evidence.status),
      verificationStatus: params.evidence.verificationStatus ?? null,
      signedAtUtc: formatNullableDate(params.evidence.signedAtUtc),
      reportReady,
      verificationPackageReady,
    },
    preservation: {
      locked: Boolean(params.evidence.lockedAt),
      archived: Boolean(params.evidence.archivedAt),
      deleted: Boolean(params.evidence.deletedAt),
      deleteScheduledForUtc: formatNullableDate(params.evidence.deleteScheduledForUtc),
      retentionUntilUtc: formatNullableDate(params.evidence.retentionUntilUtc),
      storageProtection: params.storage,
      publicVerificationEnabled: Boolean(params.anchor?.configured),
      publicVerificationActive: Boolean(
        params.anchor?.transactionId || params.anchor?.anchoredAtUtc
      ),
    },
    provenance: {
      captureMethod: params.evidence.captureMethod ?? null,
      identityLevelSnapshot: params.evidence.identityLevelSnapshot ?? null,
      submittedByEmail: params.evidence.submittedByEmail ?? null,
      submittedByAuthProvider: params.evidence.submittedByAuthProvider ?? null,
      createdByUserId: params.evidence.createdByUserId ?? null,
      uploadedByUserId: params.evidence.uploadedByUserId ?? null,
      workspaceName: params.evidence.workspaceNameSnapshot ?? null,
      organizationName: params.evidence.organizationNameSnapshot ?? null,
      organizationVerified: params.evidence.organizationVerifiedSnapshot ?? null,
    },
    custody: {
      createdAt:
        formatNullableDate(params.evidence.createdAt) ??
        new Date().toISOString(),
      uploadedAtUtc: formatNullableDate(params.evidence.uploadedAtUtc),
      lastAccessedAtUtc: formatNullableDate(params.evidence.lastAccessedAtUtc),
      lastVerifiedAtUtc: formatNullableDate(params.evidence.lastVerifiedAtUtc),
      recordedIntegrityVerifiedAtUtc: formatNullableDate(
        params.evidence.recordedIntegrityVerifiedAtUtc
      ),
      firstEventAtUtc:
        custodyRecords.length > 0
          ? formatNullableDate(custodyRecords[0].atUtc)
          : null,
      latestEventAtUtc:
        custodyRecords.length > 0
          ? formatNullableDate(custodyRecords[custodyRecords.length - 1].atUtc)
          : null,
    },
    events: {
      total: custodyRecords.length,
      access: accessEventCount,
      forensic: forensicEventCount,
      chainIntegrity: {
        valid: chain.valid,
        mode: chain.mode,
        reason: chain.reason,
      },
    },
    anchor: {
      provider: params.anchor?.provider ?? null,
      mode: params.anchor?.mode ?? "off",
      configured: Boolean(params.anchor?.configured),
      anchorHash: params.anchor?.anchorHash ?? null,
      anchoredAtUtc: formatNullableDate(params.anchor?.anchoredAtUtc),
    },
    reviewerDecision: buildEvidenceReviewDecision({
      evidence: params.evidence,
      chainValid: chain.valid,
      chainMode: chain.mode,
      outputs: params.outputs,
      anchorVerified: Boolean(
        params.anchor?.transactionId || params.anchor?.anchoredAtUtc
      ),
    }),
    verificationProof: buildVerificationProof(params.evidence),
    artifacts: buildArtifactSummaries({ evidence: params.evidence }),
    accessActivity: buildAccessActivitySummary({ records: custodyRecords }),
    reviewerAlerts: buildReviewerAlerts({
      evidence: params.evidence,
      anchor: params.anchor,
      storage: params.storage,
      chainValid: chain.valid,
      outputs: params.outputs,
    }),
    custodyTimeline: buildCustodyTimeline({ records: custodyRecords }),
    librarySummary: buildLibrarySummary({
      evidence: params.evidence,
      chainValid: chain.valid,
      outputs: params.outputs,
      anchorVerified: Boolean(
        params.anchor?.transactionId || params.anchor?.anchoredAtUtc
      ),
    }),
  };
}
