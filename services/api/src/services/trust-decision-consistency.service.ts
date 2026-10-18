/**
 * SNAPSHOT vs LIVE (2026-10-18). An issued report or package is a snapshot of
 * what was true at issue, in that release's words. The comparison reads both
 * sides through the one legacy snapshot normalizer (signalMovement): it
 * compares CANONICAL STATES, never summaries, details or tones, so improved
 * wording is never a change, a legitimate advance (a kept token validated
 * later, an attestation independently verified) is information, and only a
 * signal that FAILED since issue is an integrity alarm.
 */
import { signalMovement, type SignalMovement, type TrustDecision } from "@proovra/shared";

export type TrustDecisionConsistencySource =
  | "REPORT_SNAPSHOT"
  | "VERIFICATION_PACKAGE_SNAPSHOT"
  | "LIVE_SHARED_FALLBACK";

export type TrustDecisionConsistencyReasonCode =
  | "ACCESS_ACTIVITY_CHANGED"
  | "PUBLICATION_STATUS_CHANGED"
  | "ARTIFACT_VERSION_CHANGED"
  | "FORENSIC_CUSTODY_CHANGED"
  | "CORE_INTEGRITY_SIGNALS_CHANGED"
  /** A legitimate improvement since issue (never an alarm). */
  | "VERIFICATION_ADVANCED"
  | "UNKNOWN_DIFFERENCE";

export type TrustDecisionConsistencyTone = "neutral" | "info" | "warning" | "danger";

export type TrustDecisionConsistencyReason = {
  code: TrustDecisionConsistencyReasonCode;
  label: string;
  detail: string;
  tone: Exclude<TrustDecisionConsistencyTone, "neutral">;
  integrityCritical: boolean;
};

export type TrustDecisionConsistencyResult = {
  source: TrustDecisionConsistencySource;
  consistentWithSnapshot: boolean | null;
  tone: TrustDecisionConsistencyTone;
  accessOnly: boolean;
  integrityCritical: boolean;
  reasons: TrustDecisionConsistencyReason[];
};

type BuildTrustDecisionConsistencyInput = {
  snapshotTrustDecision: TrustDecision | null;
  liveTrustDecision: TrustDecision;
  source: TrustDecisionConsistencySource;
  snapshotGeneratedAtUtc?: Date | string | null;
  latestReportGeneratedAtUtc?: Date | string | null;
  latestReportVersion?: number | null;
  latestVerificationPackageGeneratedAtUtc?: Date | string | null;
  latestVerificationPackageVersion?: number | null;
  /**
   * Forensic-INTEGRITY custody events (isForensicIntegrityCustodyEventType):
   * administrative events — the verification reference, the page's access
   * state, its disclosure policy — are never counted.
   */
  forensicEventsAtSnapshot?: number | null;
  currentForensicEvents?: number | null;
  accessEventsAfterSnapshot?: number | null;
};

const INTEGRITY_CRITICAL_SIGNAL_KEYS = new Set([
  "core_integrity",
  "signature",
  "trusted_timestamp",
  "immutable_storage",
]);

function toEpoch(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function movementOf(snapshot: TrustDecision | null, live: TrustDecision, key: string): SignalMovement {
  return signalMovement(
    snapshot?.signals.find((signal) => signal.key === key) ?? null,
    live.signals.find((signal) => signal.key === key) ?? null,
  );
}

function pushReason(
  reasons: TrustDecisionConsistencyReason[],
  reason: TrustDecisionConsistencyReason
) {
  if (reasons.some((entry) => entry.code === reason.code)) {
    return;
  }
  reasons.push(reason);
}

export function buildTrustDecisionConsistency(
  input: BuildTrustDecisionConsistencyInput
): TrustDecisionConsistencyResult {
  if (!input.snapshotTrustDecision) {
    return {
      source: input.source,
      consistentWithSnapshot: null,
      tone: "neutral",
      accessOnly: false,
      integrityCritical: false,
      reasons: [],
    };
  }

  const reasons: TrustDecisionConsistencyReason[] = [];

  const accessEventsAfterSnapshot = input.accessEventsAfterSnapshot ?? 0;
  if (accessEventsAfterSnapshot > 0) {
    pushReason(reasons, {
      code: "ACCESS_ACTIVITY_CHANGED",
      label: "Access activity changed after the report snapshot",
      detail:
        "Later viewing, download, or verification activity was recorded after the fixed report or package snapshot. This is an activity difference, not by itself an integrity failure.",
      tone: "info",
      integrityCritical: false,
    });
  }

  const anchoringMovement = movementOf(input.snapshotTrustDecision, input.liveTrustDecision, "bitcoin_anchoring");
  if (anchoringMovement === "ADVANCED") {
    pushReason(reasons, {
      code: "VERIFICATION_ADVANCED",
      label: "Verification advanced after the snapshot",
      detail:
        "A check the issued artifact stated as not yet verified has since been verified. The issued artifact keeps what was true when it was issued.",
      tone: "info",
      integrityCritical: false,
    });
  } else if (anchoringMovement !== "SAME") {
    pushReason(reasons, {
      code: "PUBLICATION_STATUS_CHANGED",
      label: "OpenTimestamps or Bitcoin anchoring status changed after the snapshot",
      detail:
        "The later live state no longer matches the snapshot for OpenTimestamps or Bitcoin anchoring status. This affects anchoring state and reviewer interpretation.",
      tone: "warning",
      integrityCritical: false,
    });
  }

  const snapshotGeneratedAt = toEpoch(input.snapshotGeneratedAtUtc);
  const latestReportGeneratedAt = toEpoch(input.latestReportGeneratedAtUtc);
  const latestPackageGeneratedAt = toEpoch(
    input.latestVerificationPackageGeneratedAtUtc
  );

  const hasLaterArtifact =
    snapshotGeneratedAt != null &&
    ((latestReportGeneratedAt != null &&
      latestReportGeneratedAt > snapshotGeneratedAt) ||
      (latestPackageGeneratedAt != null &&
        latestPackageGeneratedAt > snapshotGeneratedAt));

  if (hasLaterArtifact) {
    pushReason(reasons, {
      code: "ARTIFACT_VERSION_CHANGED",
      label: "Report or verification-package version changed after the snapshot",
      detail:
        "A newer report or verification package was generated after the fixed snapshot that supplied this trust decision. Review the later artifact version before relying on snapshot-era summaries alone.",
      tone: "warning",
      integrityCritical: false,
    });
  } else if (
    input.latestReportVersion != null &&
    input.latestVerificationPackageVersion != null &&
    input.latestVerificationPackageVersion > input.latestReportVersion
  ) {
    pushReason(reasons, {
      code: "ARTIFACT_VERSION_CHANGED",
      label: "Report and verification-package versions are no longer aligned",
      detail:
        "The report snapshot and verification package no longer reflect the same artifact-generation point. Review the current artifact versions together before drawing reviewer conclusions.",
      tone: "warning",
      integrityCritical: false,
    });
  }

  const forensicEventsAtSnapshot = input.forensicEventsAtSnapshot ?? 0;
  const currentForensicEvents = input.currentForensicEvents ?? forensicEventsAtSnapshot;
  if (currentForensicEvents > forensicEventsAtSnapshot) {
    pushReason(reasons, {
      code: "FORENSIC_CUSTODY_CHANGED",
      label: "Forensic custody events changed after the snapshot",
      detail:
        "The current forensic custody chain contains additional integrity-relevant lifecycle events beyond those present at the fixed report or package snapshot.",
      tone: "warning",
      integrityCritical: true,
    });
  }

  const coreMovements = Array.from(INTEGRITY_CRITICAL_SIGNAL_KEYS).map((key) =>
    movementOf(input.snapshotTrustDecision, input.liveTrustDecision, key),
  );
  if (coreMovements.includes("REGRESSED")) {
    pushReason(reasons, {
      code: "CORE_INTEGRITY_SIGNALS_CHANGED",
      label: "An integrity, signature, timestamp, or storage check failed after the snapshot",
      detail:
        "A check that did not fail when the artifact was issued fails now. Review the current verification result before relying on the issued artifact.",
      tone: "danger",
      integrityCritical: true,
    });
  } else if (coreMovements.includes("CHANGED")) {
    pushReason(reasons, {
      code: "CORE_INTEGRITY_SIGNALS_CHANGED",
      label: "An integrity, signature, timestamp, or storage check reads differently than at issue",
      detail:
        "The current state of one of these checks differs from the issued artifact without having failed. Read the current verification result together with the issued artifact.",
      tone: "warning",
      integrityCritical: false,
    });
  } else if (coreMovements.includes("ADVANCED")) {
    pushReason(reasons, {
      code: "VERIFICATION_ADVANCED",
      label: "Verification advanced after the snapshot",
      detail:
        "A check the issued artifact stated as not yet verified has since been verified (for example, a timestamp token validated from the copy kept at intake). The issued artifact keeps what was true when it was issued.",
      tone: "info",
      integrityCritical: false,
    });
  }

  // Any other signal whose canonical state moved (never its words).
  const otherMoved = input.liveTrustDecision.signals.some(
    (signal) =>
      signal.key !== "bitcoin_anchoring" &&
      !INTEGRITY_CRITICAL_SIGNAL_KEYS.has(signal.key) &&
      movementOf(input.snapshotTrustDecision, input.liveTrustDecision, signal.key) !== "SAME",
  );

  if (otherMoved && reasons.length === 0) {
    pushReason(reasons, {
      code: "UNKNOWN_DIFFERENCE",
      label: "A live verification difference was detected",
      detail:
        "The live verification state differs from the fixed snapshot, but the current response did not isolate a narrower reason. Review the current technical materials directly.",
      tone: "warning",
      integrityCritical: false,
    });
  }

  const integrityCritical = reasons.some((reason) => reason.integrityCritical);
  const accessOnly = reasons.length > 0 && reasons.every((reason) => reason.code === "ACCESS_ACTIVITY_CHANGED");
  // Access activity and legitimate advances are both informational.
  const infoOnly = reasons.length > 0 && reasons.every((reason) => reason.tone === "info");

  const tone: TrustDecisionConsistencyTone = integrityCritical
    ? "danger"
    : infoOnly
      ? "info"
      : reasons.length > 0
        ? "warning"
        : "neutral";

  return {
    source: input.source,
    consistentWithSnapshot: reasons.length === 0,
    tone,
    accessOnly,
    integrityCritical,
    reasons,
  };
}
