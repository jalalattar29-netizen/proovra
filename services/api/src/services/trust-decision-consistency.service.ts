import type { TrustDecision, TrustSignal } from "@proovra/shared";

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

function getSignal(decision: TrustDecision | null, key: string): TrustSignal | null {
  return decision?.signals.find((signal) => signal.key === key) ?? null;
}

function signalChanged(
  snapshot: TrustDecision | null,
  live: TrustDecision,
  key: string
): boolean {
  const before = getSignal(snapshot, key);
  const after = getSignal(live, key);

  if (!before && !after) return false;
  if (!before || !after) return true;

  return (
    before.status !== after.status ||
    before.summary !== after.summary ||
    before.detail !== after.detail ||
    before.tone !== after.tone
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

  if (
    signalChanged(input.snapshotTrustDecision, input.liveTrustDecision, "bitcoin_anchoring") ||
    input.snapshotTrustDecision.anchoringState !==
      input.liveTrustDecision.anchoringState
  ) {
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

  const integritySignalsChanged = Array.from(INTEGRITY_CRITICAL_SIGNAL_KEYS).some(
    (key) => signalChanged(input.snapshotTrustDecision, input.liveTrustDecision, key)
  );
  if (integritySignalsChanged) {
    pushReason(reasons, {
      code: "CORE_INTEGRITY_SIGNALS_CHANGED",
      label: "Core integrity, signature, timestamp, or storage signals changed",
      detail:
        "The live technical verification state no longer matches the fixed snapshot for one or more integrity-critical signals such as core digest consistency, signature materials, trusted timestamping, or immutable-storage controls.",
      tone: "danger",
      integrityCritical: true,
    });
  }

  const snapshotMatchesLive =
    JSON.stringify(input.snapshotTrustDecision) === JSON.stringify(input.liveTrustDecision);

  if (!snapshotMatchesLive && reasons.length === 0) {
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
  const accessOnly =
    reasons.length > 0 &&
    reasons.every((reason) => reason.code === "ACCESS_ACTIVITY_CHANGED");

  const tone: TrustDecisionConsistencyTone = integrityCritical
    ? "danger"
    : accessOnly
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
