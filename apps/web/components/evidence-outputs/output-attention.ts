/**
 * EVIDENCE OUTPUT ATTENTION — the ONE answer to "do this record's outputs need
 * me?", derived from the artifact status the page already holds.
 *
 * Evidence Detail opens on Overview, while the report and verification-package
 * truth lives on Artifacts. Four surfaces now say something about outputs — the
 * Overview card, the Artifacts tab indicator, the page-level banner and the
 * Artifacts & Versions tab itself — and they must never disagree. So none of
 * them classifies anything: each renders the value this function returns, from
 * the same `artifactStatus` object in the same render.
 *
 * Nothing here is a new decision. Every input is the server's: the per-output
 * `state` / `action` / `actionUnavailableReason`, the freshness comparison, the
 * durable active request and its projected progress, the matched version pairs
 * and the trust facts. Copy for failures comes from the one typed operation-
 * error authority (`@proovra/shared` output-offer), never from a raw code.
 *
 * PRECEDENCE (first match wins, so a render has exactly one state):
 *
 *   BLOCKED            something the user cannot fix from here, or must not
 *                      ignore (integrity, unrecoverable terminal, pair digest
 *                      mismatch, generation stalled, governance block)
 *   RECOVERY_AVAILABLE the server offers the exact recovery verb
 *   IN_PROGRESS        a durable request is live
 *   UPDATE_AVAILABLE   newer verification facts than the latest report
 *   CURRENT            the latest report reflects the recorded facts
 *   NOT_AVAILABLE      no output is owed yet (plan, finalization, entitlement
 *                      read) — a calm statement, never a warning
 *
 * Every field the API added on 2026-10-06 is optional on the web (the web
 * deploys first), so an absent freshness never reads as "Current"-with-claims
 * and an absent active request falls back to the per-output state.
 */
import {
  NEW_VERSION_ACTION,
  outputOperationError,
  outputOperationErrorForReason,
  outputOperationErrorForTerminal,
  type OutputOperationError,
  type OutputProgressStep,
  type ReportFreshnessChange,
} from "@proovra/shared";

import type { ArtifactOutputsExtras, ArtifactTrust, MatchedHistory } from "./artifact-status-types";

/** Where on the Artifacts tab a surface sends the user. */
export type ArtifactsFocusTarget = "status" | "progress" | "recovery" | "history";

export type OutputAttentionKind = "report" | "verificationPackage";

type OutputSlice = {
  state: string;
  action: string;
  actionUnavailableReason: string | null;
  notApplicableReason?: string | null;
  terminalReasonClass?: string | null;
  terminalReasonCode?: string | null;
  version?: number | null;
};

/** The part of `artifactStatus` (review workspace / `/artifacts/status`) read here. */
export type OutputAttentionStatus = {
  outputs: {
    report: OutputSlice;
    verificationPackage: OutputSlice;
    newVersion?: { action?: string | null; reason?: string | null; currentVersion?: number | null; nextVersion?: number | null } | null;
  } & Omit<ArtifactOutputsExtras, "newVersion">;
  versions?: MatchedHistory | null;
  report?: { version?: number | null; generatedAtUtc?: string | null } | null;
  verificationPackage?: { version?: number | null } | null;
};

export type EvidenceOutputAttention =
  | {
      state: "CURRENT";
      latestReportVersion: number | null;
      latestPackageVersion: number | null;
      tsa: ArtifactTrust["tsa"] | null;
      ots: ArtifactTrust["ots"] | null;
      updatedAt: string | null;
      /** Freshness was compared by the server (absent from an older API). */
      factsCompared: boolean;
    }
  | {
      state: "UPDATE_AVAILABLE";
      currentVersion: number | null;
      targetVersion: number | null;
      materialChanges: ReportFreshnessChange[];
      /** The server offers the updated report to this user now. */
      canGenerate: boolean;
      /** Why not, when it does not (typed). */
      unavailable: OutputOperationError | null;
    }
  | {
      state: "IN_PROGRESS";
      requestId: string | null;
      targetVersion: number | null;
      stage: OutputProgressStep;
      /** Only the verification package is being (re)built. */
      packageOnly: boolean;
    }
  | {
      state: "RECOVERY_AVAILABLE";
      /** The output whose server-offered verb this is, or the updated report. */
      target: OutputAttentionKind | "newVersion";
      /** The server's verb (GENERATE / RETRY / RECOVER), or NEW_VERSION. */
      action: "GENERATE" | "RETRY" | "RECOVER" | "NEW_VERSION";
      reportVersion: number | null;
      packageVersion: number | null;
      error: OutputOperationError;
    }
  | {
      state: "BLOCKED";
      severity: "WARNING" | "CRITICAL";
      /** A bounded code for tests and analytics — never rendered. */
      code: string;
      title: string;
      safeMessage: string;
      focus: ArtifactsFocusTarget;
      /** The record-level integrity banner already states this one. */
      statedByRecordBanner: boolean;
    }
  | {
      state: "NOT_AVAILABLE";
      reason: "NOT_INCLUDED" | "NOT_FINALIZED" | "ENTITLEMENT_UNAVAILABLE";
    };

export type EvidenceOutputAttentionState = EvidenceOutputAttention["state"];

const offered = (o: OutputSlice): o is OutputSlice & { action: "GENERATE" | "RETRY" | "RECOVER" } =>
  o.action === "GENERATE" || o.action === "RETRY" || o.action === "RECOVER";

const inFlight = (o: OutputSlice) => o.state === "QUEUED" || o.state === "GENERATING";

/** A per-output state that is a problem when no verb is offered for it. */
const needsWork = (o: OutputSlice) =>
  o.state === "ELIGIBLE_NOT_GENERATED" || o.state === "RETRYABLE_FAILURE" || o.state === "TERMINAL_FAILURE";

function errorFor(o: OutputSlice): OutputOperationError {
  if (o.terminalReasonClass === "INTEGRITY") return outputOperationError("INTEGRITY_TERMINAL");
  return (
    outputOperationErrorForReason(o.actionUnavailableReason) ??
    (o.terminalReasonCode
      ? outputOperationErrorForTerminal({ terminalReasonCode: o.terminalReasonCode })
      : outputOperationError(o.state === "TERMINAL_FAILURE" ? "RETRY_BUDGET_EXHAUSTED" : "RECOVERY_REQUIRED"))
  );
}

function blocked(
  error: OutputOperationError,
  input: { code: string; focus: ArtifactsFocusTarget; critical?: boolean; statedByRecordBanner?: boolean },
): EvidenceOutputAttention {
  return {
    state: "BLOCKED",
    severity: (input.critical ?? error.severity === "error") ? "CRITICAL" : "WARNING",
    code: input.code,
    title: error.title,
    // A summary shows no support reference (the Artifacts tab does, beside the
    // request), so it must not point at one "below".
    safeMessage: error.description.replace(/ with the reference below/g, ""),
    focus: input.focus,
    statedByRecordBanner: input.statedByRecordBanner ?? false,
  };
}

/**
 * Derive the attention for ONE record. Returns null when the status belongs to
 * another record than the one on screen (a late response for the previous
 * evidence must never paint this one's warning).
 */
export function deriveEvidenceOutputAttention(input: {
  evidenceId: string;
  /** The id the status was loaded for (the workspace's evidence id), when known. */
  statusEvidenceId?: string | null;
  status: OutputAttentionStatus | null | undefined;
  /** The page's own stale-poll stopwatch tripped (generation taking too long). */
  stalled?: boolean;
}): EvidenceOutputAttention | null {
  const { status } = input;
  if (!status) return null;
  if (input.statusEvidenceId != null && input.statusEvidenceId !== input.evidenceId) return null;

  const { outputs } = status;
  const report = outputs.report;
  const pkg = outputs.verificationPackage;
  const nv = outputs.newVersion ?? null;
  const active = outputs.activeRequest ?? null;
  const freshness = outputs.freshness ?? null;
  const latest = status.versions?.versions.find((v) => v.latest) ?? null;

  const reportVersion = latest?.reportVersion ?? report.version ?? status.report?.version ?? null;
  const packageVersion =
    latest?.package?.version ??
    (pkg.state === "READY" ? (pkg.version ?? null) : null) ??
    status.verificationPackage?.version ??
    null;

  const live = Boolean(
    active && (active.progress.outcome === "ACTIVE" || active.progress.outcome === "RETRYING"),
  );
  const recentFailure =
    active && active.recent && (active.progress.outcome === "FAILED" || active.progress.outcome === "BLOCKED")
      ? active
      : null;
  const nvOffered = nv?.action === NEW_VERSION_ACTION;
  const working =
    live ||
    inFlight(report) ||
    (report.state === "READY" && inFlight(pkg)) ||
    nv?.reason === "IN_PROGRESS";

  // ---- BLOCKED -----------------------------------------------------------
  if (report.state === "NOT_APPLICABLE" && report.notApplicableReason === "INTEGRITY_FAILED") {
    return blocked(outputOperationError("INTEGRITY_TERMINAL"), {
      code: "INTEGRITY_FAILED",
      focus: "status",
      critical: true,
      statedByRecordBanner: true,
    });
  }
  if (latest?.digestMismatch) {
    return blocked(outputOperationError("INTEGRITY_TERMINAL"), { code: "PAIR_DIGEST_MISMATCH", focus: "history", critical: true });
  }
  if (report.state === "TERMINAL_FAILURE" && !offered(report)) {
    return blocked(errorFor(report), { code: "REPORT_TERMINAL", focus: "recovery", critical: true });
  }
  if (report.state === "READY" && pkg.state === "TERMINAL_FAILURE" && !offered(pkg)) {
    return blocked(errorFor(pkg), { code: "PACKAGE_TERMINAL", focus: "recovery", critical: true });
  }
  if (report.state === "BLOCKED") {
    return blocked(outputOperationErrorForReason(report.actionUnavailableReason) ?? outputOperationError("POLICY_REFUSED"), {
      code: "GENERATION_BLOCKED",
      focus: "recovery",
      critical: false,
    });
  }
  if (input.stalled && working) {
    return {
      state: "BLOCKED",
      severity: "WARNING",
      code: "GENERATION_STALLED",
      title: "Report generation is taking longer than expected",
      safeMessage:
        "The signed evidence record is preserved. The report and verification package are still pending; review their status on Artifacts.",
      focus: "progress",
      statedByRecordBanner: false,
    };
  }

  // ---- RECOVERY_AVAILABLE -------------------------------------------------
  if (offered(report)) {
    return {
      state: "RECOVERY_AVAILABLE",
      target: "report",
      action: report.action,
      reportVersion,
      packageVersion,
      error: report.action === "GENERATE" ? outputOperationError("RECOVERY_REQUIRED") : errorFor(report),
    };
  }
  if (report.state === "READY" && offered(pkg)) {
    return {
      state: "RECOVERY_AVAILABLE",
      target: "verificationPackage",
      action: pkg.action,
      reportVersion,
      packageVersion,
      error: outputOperationError("RECOVERY_REQUIRED"),
    };
  }
  if (recentFailure && nvOffered && !working) {
    return {
      state: "RECOVERY_AVAILABLE",
      target: "newVersion",
      action: "NEW_VERSION",
      reportVersion,
      packageVersion,
      error: outputOperationErrorForTerminal({
        terminalReasonCode: recentFailure.terminalReasonCode,
        failedStep: recentFailure.progress.currentStep,
      }),
    };
  }
  // A problem the server offers no verb for (permission, escalation, plan).
  const stuck = needsWork(report) ? report : report.state === "READY" && needsWork(pkg) ? pkg : null;
  if (stuck && stuck.actionUnavailableReason !== "IN_PROGRESS" && !working) {
    const error = errorFor(stuck);
    return blocked(error, {
      code: stuck === report ? "REPORT_UNAVAILABLE" : "PACKAGE_UNAVAILABLE",
      focus: "recovery",
      critical: stuck.state === "TERMINAL_FAILURE" || error.severity === "error",
    });
  }
  if (recentFailure && !working) {
    const error = outputOperationErrorForTerminal({
      terminalReasonCode: recentFailure.terminalReasonCode,
      failedStep: recentFailure.progress.currentStep,
    });
    return blocked(error, { code: "REQUEST_FAILED", focus: "progress" });
  }

  // ---- IN_PROGRESS --------------------------------------------------------
  if (working) {
    const packageOnly = active
      ? active.artifactType === "VERIFICATION_PACKAGE"
      : report.state === "READY" && inFlight(pkg);
    const stage: OutputProgressStep =
      live && active
        ? active.progress.currentStep
        : (packageOnly ? pkg.state : report.state) === "QUEUED"
          ? "QUEUED"
          : packageOnly
            ? "BUILDING_PACKAGE"
            : "GENERATING_REPORT";
    return {
      state: "IN_PROGRESS",
      requestId: live && active ? active.requestId : null,
      targetVersion: (live && active ? active.targetVersion : null) ?? nv?.nextVersion ?? (packageOnly ? reportVersion : null),
      stage,
      packageOnly,
    };
  }

  // ---- UPDATE_AVAILABLE ---------------------------------------------------
  if (report.state === "READY" && freshness?.hasNewerFacts) {
    return {
      state: "UPDATE_AVAILABLE",
      currentVersion: nv?.currentVersion ?? freshness.reportVersion ?? reportVersion,
      targetVersion: nv?.nextVersion ?? null,
      materialChanges: freshness.changes,
      canGenerate: nvOffered,
      unavailable: nvOffered ? null : outputOperationErrorForReason(nv?.reason),
    };
  }

  // ---- CURRENT / NOT_AVAILABLE --------------------------------------------
  if (report.state === "READY") {
    return {
      state: "CURRENT",
      latestReportVersion: reportVersion,
      latestPackageVersion: packageVersion,
      tsa: outputs.trust?.tsa ?? null,
      ots: outputs.trust?.ots ?? null,
      updatedAt: latest?.generatedAtUtc ?? status.report?.generatedAtUtc ?? null,
      factsCompared: freshness != null,
    };
  }
  return {
    state: "NOT_AVAILABLE",
    reason:
      report.state === "NOT_INCLUDED"
        ? "NOT_INCLUDED"
        : report.state === "ENTITLEMENT_UNAVAILABLE"
          ? "ENTITLEMENT_UNAVAILABLE"
          : "NOT_FINALIZED",
  };
}

// ===========================================================================
// PRESENTATION — the badge, the tab indicator and the banner, from the value.
// ===========================================================================

export type OutputAttentionTone = "ok" | "info" | "progress" | "warn" | "bad" | "neutral";

export type OutputAttentionPresentation = {
  /** Visible status badge text on the Overview card. */
  badge: string;
  tone: OutputAttentionTone;
  /** The Artifacts tab indicator; null renders nothing on the tab. */
  tab: { suffix: string; tone: OutputAttentionTone } | null;
  /** The page-level banner (critical / action required only); null renders none. */
  banner: { title: string; body: string; focus: ArtifactsFocusTarget } | null;
  /** Where "Review artifacts" lands. */
  focus: ArtifactsFocusTarget;
};

export function presentOutputAttention(a: EvidenceOutputAttention): OutputAttentionPresentation {
  switch (a.state) {
    case "CURRENT":
      return { badge: "Current", tone: "ok", tab: null, banner: null, focus: "status" };
    case "NOT_AVAILABLE":
      return { badge: "Not generated", tone: "neutral", tab: null, banner: null, focus: "status" };
    case "UPDATE_AVAILABLE":
      return {
        badge: "Update available",
        tone: "info",
        tab: { suffix: "update available", tone: "info" },
        // An optional updated report is never a page-level alarm.
        banner: null,
        focus: "status",
      };
    case "IN_PROGRESS":
      return {
        badge: "In progress",
        tone: "progress",
        tab: { suffix: "generation in progress", tone: "progress" },
        banner: null,
        focus: "progress",
      };
    case "RECOVERY_AVAILABLE":
      return {
        badge: "Action required",
        tone: "warn",
        tab: { suffix: "action required", tone: "warn" },
        // Generating a never-generated output is an offer, not an incident.
        banner:
          a.action === "GENERATE"
            ? null
            : {
                title: "Output action required",
                body: recoverySentence(a),
                focus: "recovery",
              },
        focus: "recovery",
      };
    case "BLOCKED": {
      const critical = a.severity === "CRITICAL";
      const showBanner = (critical || a.code === "GENERATION_STALLED") && !a.statedByRecordBanner;
      return {
        badge: critical ? "Action required" : "Needs attention",
        tone: critical ? "bad" : "warn",
        tab: { suffix: critical ? "action required" : "needs attention", tone: critical ? "bad" : "warn" },
        banner: showBanner ? { title: "Evidence output needs attention", body: a.title, focus: a.focus } : null,
        focus: a.focus,
      };
    }
  }
}

/** One sentence naming what is incomplete, for the card and the banner. */
export function recoverySentence(a: Extract<EvidenceOutputAttention, { state: "RECOVERY_AVAILABLE" }>): string {
  if (a.target === "verificationPackage") {
    return a.packageVersion != null || a.reportVersion != null
      ? `Verification package${a.reportVersion != null ? ` v${a.reportVersion}` : ""} could not be completed.`
      : "The verification package is incomplete.";
  }
  if (a.target === "newVersion") return "The updated report could not be completed.";
  if (a.action === "GENERATE") return "No report or verification package has been generated for this record yet.";
  if (a.action === "RECOVER") return "The report is missing and can be recovered.";
  // A RETRY with no report: the FIRST issuance failed, so nothing is downloadable.
  return a.reportVersion == null
    ? "Report v1 could not be generated, so no report exists for this record yet."
    : "Report generation did not complete.";
}

/**
 * What stays true while the output is missing — said beside the action so
 * nobody reads a failed output as a damaged record.
 */
export function recoveryStandingSentence(a: Extract<EvidenceOutputAttention, { state: "RECOVERY_AVAILABLE" }>): string {
  if (a.target === "report" && a.reportVersion == null) {
    return "The signed evidence record is preserved and unaffected.";
  }
  return a.reportVersion != null
    ? `Report v${a.reportVersion} remains valid and downloadable.`
    : "The signed evidence record is preserved and unaffected.";
}

/** The busy text of a recovery control: a RETRY says it is retrying. */
export function recoveryBusyLabel(action: string): string {
  return action === "RETRY" ? "Retrying…" : "Requesting…";
}
