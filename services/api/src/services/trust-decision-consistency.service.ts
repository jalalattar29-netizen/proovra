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
  /** AUD-48 — a non-integrity check reads WORSE than at issue; the reason names it. */
  | "VERIFICATION_REGRESSED"
  | "UNKNOWN_DIFFERENCE";

export type TrustDecisionConsistencyTone = "neutral" | "info" | "warning" | "danger";

export type TrustDecisionConsistencyReason = {
  code: TrustDecisionConsistencyReasonCode;
  label: string;
  detail: string;
  tone: Exclude<TrustDecisionConsistencyTone, "neutral">;
  integrityCritical: boolean;
};

/**
 * (2026-10-20, AUD-26) WHICH VERDICT A SURFACE SHOWS. The owner page states
 * the decision fixed when the report (or package) was issued; Public Verify
 * states the record now. Each says which, so the two never read as one claim.
 */
export type TrustDecisionBasis =
  | { kind: "AS_ISSUED"; artifact: "REPORT" | "VERIFICATION_PACKAGE"; version: number | null; issuedAtUtc: string | null }
  | { kind: "LIVE" };

export type TrustDecisionConsistencyResult = {
  source: TrustDecisionConsistencySource;
  basis: TrustDecisionBasis;
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

/** AUD-48 — the reader-facing names of the signals that moved this way. */
function namesOf(live: TrustDecision, snapshot: TrustDecision | null, keys: ReadonlyArray<string>): string {
  const names = keys.map(
    (key) =>
      live.signals.find((signal) => signal.key === key)?.label ??
      snapshot?.signals.find((signal) => signal.key === key)?.label ??
      key,
  );
  return names.length <= 1 ? (names[0] ?? "") : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
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

function basisOf(input: BuildTrustDecisionConsistencyInput): TrustDecisionBasis {
  if (input.source !== "REPORT_SNAPSHOT" && input.source !== "VERIFICATION_PACKAGE_SNAPSHOT") return { kind: "LIVE" };
  const at = toEpoch(input.snapshotGeneratedAtUtc);
  return {
    kind: "AS_ISSUED",
    artifact: input.source === "REPORT_SNAPSHOT" ? "REPORT" : "VERIFICATION_PACKAGE",
    version: input.source === "REPORT_SNAPSHOT" ? (input.latestReportVersion ?? null) : (input.latestVerificationPackageVersion ?? null),
    issuedAtUtc: at === null ? null : new Date(at).toISOString(),
  };
}

export function buildTrustDecisionConsistency(
  input: BuildTrustDecisionConsistencyInput
): TrustDecisionConsistencyResult {
  if (!input.snapshotTrustDecision) {
    return {
      source: input.source,
      basis: basisOf(input),
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
  } else if (anchoringMovement === "REGRESSED" || anchoringMovement === "DECLINED") {
    // AUD-48 (2026-10-20) — stated (and named) with every other regression below.
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

  const coreKeys = Array.from(INTEGRITY_CRITICAL_SIGNAL_KEYS);
  const coreMovements = coreKeys.map((key) =>
    movementOf(input.snapshotTrustDecision, input.liveTrustDecision, key),
  );
  if (coreMovements.includes("REGRESSED")) {
    // AUD-48 (2026-10-20) — the reason names the check(s) that regressed.
    const regressed = namesOf(
      input.liveTrustDecision,
      input.snapshotTrustDecision,
      coreKeys.filter((_, i) => coreMovements[i] === "REGRESSED"),
    );
    pushReason(reasons, {
      code: "CORE_INTEGRITY_SIGNALS_CHANGED",
      label: `Failed since the artifact was issued: ${regressed}`,
      detail:
        `${regressed} did not fail when the artifact was issued and fails now. Review the current verification result before relying on the issued artifact.`,
      tone: "danger",
      integrityCritical: true,
    });
  } else if (coreMovements.includes("DECLINED")) {
    // AUD-48 — worse than at issue without failing: named, never generic.
    const declined = namesOf(
      input.liveTrustDecision,
      input.snapshotTrustDecision,
      coreKeys.filter((_, i) => coreMovements[i] === "DECLINED"),
    );
    pushReason(reasons, {
      code: "CORE_INTEGRITY_SIGNALS_CHANGED",
      label: `Reads worse than when the artifact was issued: ${declined}`,
      detail: `${declined} stated a better result in the issued artifact than the record has now, without failing. Read the current verification result together with the issued artifact.`,
      tone: "warning",
      integrityCritical: false,
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
  const otherKeys = input.liveTrustDecision.signals
    .map((signal) => signal.key as string)
    .filter((key) => key !== "bitcoin_anchoring" && !INTEGRITY_CRITICAL_SIGNAL_KEYS.has(key));
  const otherMovements = otherKeys.map((key) => movementOf(input.snapshotTrustDecision, input.liveTrustDecision, key));
  const otherMoved = otherMovements.some((movement) => movement !== "SAME");
  // AUD-48 (2026-10-20) — a regression of any other check is stated and named,
  // whatever else changed; it is never folded into a generic difference.
  const otherRegressed = [
    ...(anchoringMovement === "REGRESSED" || anchoringMovement === "DECLINED" ? ["bitcoin_anchoring"] : []),
    ...otherKeys.filter((_, i) => otherMovements[i] === "REGRESSED" || otherMovements[i] === "DECLINED"),
  ];
  if (otherRegressed.length > 0) {
    const names = namesOf(input.liveTrustDecision, input.snapshotTrustDecision, otherRegressed);
    pushReason(reasons, {
      code: "VERIFICATION_REGRESSED",
      label: `Reads worse than when the artifact was issued: ${names}`,
      detail: `${names} stated a better result in the issued artifact than the record has now. The issued artifact keeps what was true when it was issued; review the current result.`,
      tone: "warning",
      integrityCritical: false,
    });
  }

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
    basis: basisOf(input),
    consistentWithSnapshot: reasons.length === 0,
    tone,
    accessOnly,
    integrityCritical,
    reasons,
  };
}
