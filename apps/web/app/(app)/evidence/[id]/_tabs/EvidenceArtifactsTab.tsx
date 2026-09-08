/**
 * Phase EVIDENCE-IA-ARTIFACTS — Artifacts tab.
 *
 * Generated outputs only: reports, packages, public verification.
 *
 * The "Latest" hero carries only the verification link. The earlier
 * Latest-Report and Latest-Package cards were removed because the
 * ArtifactHistorySection rendered immediately below already lists every
 * version (v1, v2, …) and exposes "Download latest".
 *
 * Phase 1 — Public verification counts (views / report downloads / package
 * downloads / last view) are owned here. Removed from Integrity (no
 * duplication).
 *
 * Phase EVIDENCE-DETAIL-REDESIGN — presentation only, with two truthfulness
 * corrections that the previous build got wrong:
 *
 *   1. DOWNLOAD GATING. "Download latest" used to be enabled whenever the
 *      history array was non-empty. A record can carry prior versions while
 *      the current artifact is pending, failed, unavailable or excluded by
 *      plan — so the control could offer a download that could not succeed.
 *      It now derives from `artifactStatus`, and carries the reason.
 *
 *   2. ZERO vs UNAVAILABLE. Public-verification counters were stringified
 *      unconditionally, so a workspace with no analytics read as "0 views".
 *      They now honour `analyticsAvailable`: a real zero shows "0", and
 *      absent analytics say so instead of claiming no activity.
 */

"use client";

import { useState } from "react";
import { ChevronRight, Globe, ShieldCheck } from "lucide-react";
import type {
  EvidenceOutputState,
  OutputAction,
  OutputTerminalReasonClass,
} from "@proovra/shared";
import { formatValue, type EvidenceDetailCtx } from "./_lib";
import { formatUserDateTime } from "../../../../../lib/date";
import { ArtifactHistorySection } from "../components/ArtifactHistorySection";
import { formatBytes } from "./_lib";

/**
 * THE ONE COPY TABLE for a disabled download control, keyed by the server's
 * canonical state.
 *
 * Total over `EvidenceOutputState` so a new state is a compile error here
 * rather than a card that silently says nothing.
 */
const OUTPUT_STATE_COPY: Record<
  EvidenceOutputState,
  { reason: (noun: string) => string }
> = {
  READY: { reason: () => "" },
  NOT_INCLUDED: {
    reason: (noun) => `A ${noun} is not included for this evidence record.`,
  },
  ELIGIBLE_NOT_GENERATED: {
    reason: (noun) =>
      `No ${noun} has been generated for this record yet. Generate one to download it.`,
  },
  QUEUED: {
    reason: (noun) => `The ${noun} is queued for generation. Re-check shortly.`,
  },
  GENERATING: {
    reason: (noun) =>
      `The ${noun} is being generated. Re-check status once it completes.`,
  },
  RETRYABLE_FAILURE: {
    reason: (noun) => `The last attempt to build the ${noun} failed.`,
  },
  TERMINAL_FAILURE: {
    reason: (noun) => `The ${noun} could not be produced for this record.`,
  },
  BLOCKED: {
    reason: (noun) => `${noun} generation is blocked by a policy decision.`,
  },
};

/**
 * What a terminal failure MEANS, per class — never the raw reason code.
 *
 * The code is a worker branch name; the class is the part a person can act on,
 * and it is what decides whether an action is offered at all.
 */
function terminalFailureCopy(
  reasonClass: OutputTerminalReasonClass | null,
): string {
  switch (reasonClass) {
    case "COMMERCIAL":
      return "The attempt ran while this record was not entitled to the output. Your current plan includes it, so it can be generated now.";
    case "INTEGRITY":
      return "This record cannot produce a truthful artifact — its recorded integrity state does not permit it. The record itself is preserved; re-capture the source material as a new record if a fixed artifact is required.";
    case "POLICY":
      return "A governance policy refused the generation. It becomes possible again when that policy decision changes.";
    case "TECHNICAL":
    default:
      return "The pipeline could not produce it and has stopped retrying. Support can investigate; the evidence record and its integrity state are unaffected.";
  }
}

/**
 * The generate / retry control.
 *
 * ONE button for both artifacts, because the report and the verification
 * package are produced by ONE job — offering two would be two controls for one
 * pipeline, and one of them would describe work it does not start.
 *
 * The VERB comes from the server's `action`, never from the presence of a
 * version: inferring it locally is how a first generation came to be called a
 * regeneration.
 */
function GenerateOutputsButton({
  ctx,
  action,
}: {
  ctx: EvidenceDetailCtx;
  action: OutputAction;
}) {
  const [confirming, setConfirming] = useState(false);
  if (action === "NONE") return null;

  const label =
    action === "GENERATE"
      ? "Generate report & verification package"
      : action === "RETRY"
        ? "Retry generation"
        : "Regenerate report & verification package";

  /*
   * Only a REGENERATION needs confirming. It creates a new immutable version
   * beside one that already exists and consumes storage that cannot be
   * reclaimed; a first generation and a retry produce the artifact the customer
   * is already owed, and putting a dialog in front of those is friction with
   * nothing to decide.
   */
  if (action !== "REGENERATE") {
    return (
      <button
        type="button"
        className="app-secondary-action"
        onClick={() => void ctx.generateOutputs()}
        disabled={ctx.generateOutputsBusy}
        data-evidence-action="generate-outputs"
        data-evidence-generate-verb={action}
      >
        {ctx.generateOutputsBusy ? "Requesting…" : label}
      </button>
    );
  }

  if (!confirming) {
    return (
      <button
        type="button"
        className="app-secondary-action"
        onClick={() => setConfirming(true)}
        disabled={ctx.generateOutputsBusy}
        data-evidence-action="generate-outputs"
        data-evidence-generate-verb={action}
      >
        {label}
      </button>
    );
  }

  return (
    <div
      className="app-inner-surface app-panel__body"
      role="dialog"
      aria-modal="true"
      aria-label="Confirm regeneration"
      data-evidence-section="regenerate-confirm"
    >
      <p>
        This creates a <strong>new immutable version</strong>. Previous versions
        are retained and remain downloadable, and the new one uses additional
        workspace storage. No evidence credit is charged.
      </p>
      <div className="app-page-header__actions">
        <button
          type="button"
          className="app-secondary-action app-secondary-action--filled"
          onClick={() => {
            setConfirming(false);
            void ctx.generateOutputs();
          }}
          disabled={ctx.generateOutputsBusy}
          data-evidence-action="generate-outputs-confirm"
        >
          {ctx.generateOutputsBusy ? "Requesting…" : "Create a new version"}
        </button>
        <button
          type="button"
          className="app-secondary-action"
          onClick={() => setConfirming(false)}
          data-evidence-action="generate-outputs-cancel"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function EvidenceArtifactsTab({ ctx }: { ctx: EvidenceDetailCtx }) {
  const {
    workspace,
    evidenceId,
    publicVerificationState,
    shareUrl,
    stalePending,
    setStalePending,
    setPollStartedAt,
    loadWorkspace,
    downloadReport,
    downloadVerificationPackage,
  } = ctx;

  const summary = workspace.publicVerificationSummary;
  const reportStatus = workspace.artifactStatus.report;
  const packageStatus = workspace.artifactStatus.verificationPackage;

  /**
   * COMMERCIAL + OUTPUT LIFECYCLE CLOSURE (2026-09-08) — ONE state, ONE
   * sentence, per output.
   *
   * The chain that stood here asked `pending` FIRST and the plan flag second,
   * and `pending` meant "no artifact row exists". So a record on a plan without
   * reports rendered the banner "Reports are not included in this plan"
   * directly above a control whose reason read "The report is still being
   * generated" — two contradictory statements on one card, both produced from
   * the same absence.
   *
   * The server now sends the canonical state and the action, and this file
   * renders them. No plan name, no absence, no precedence puzzle.
   */
  const reportOutput = workspace.artifactStatus.outputs.report;
  const packageOutput = workspace.artifactStatus.outputs.verificationPackage;

  const reportDownloadable = reportStatus.available === true;
  const reportDisabledReason = reportDownloadable
    ? null
    : OUTPUT_STATE_COPY[reportOutput.state].reason("report");

  const packageDownloadable = packageStatus.available === true;
  const packageDisabledReason = packageDownloadable
    ? null
    : packageStatus.blocked
      ? (packageStatus.blockedReason ??
        "Verification package export is blocked by an export-governance gate.")
      : OUTPUT_STATE_COPY[packageOutput.state].reason("verification package");

  // A counter is a real number only when analytics are actually available.
  // Otherwise the honest answer is that we do not know — never "0".
  const counter = (value: number): string =>
    summary.analyticsAvailable ? String(value) : "Not available";

  return (
    <>
      {stalePending ? (
        <div
          className="app-alert app-alert--warn"
          role="status"
          data-evidence-section="artifact-stale-pending"
        >
          <strong>Report generation is taking longer than expected</strong>
          <p>
            The signed evidence record is preserved — the chain-of-custody and
            integrity columns are intact. The downstream report and verification
            package are still pending. Re-check status below, or contact support
            if this persists.
          </p>
          <button
            type="button"
            className="app-secondary-action"
            onClick={() => {
              setStalePending(false);
              setPollStartedAt(null);
              void loadWorkspace();
            }}
            data-evidence-action="artifact-stale-refresh"
          >
            Re-check status
          </button>
        </div>
      ) : null}

      {/* THE ONE COMMERCIAL / LIFECYCLE STATEMENT, from the server's state.
          Suppressed once an artifact exists: a downloadable report is not a
          conversation about entitlement, and a downgrade never takes one away. */}
      {reportOutput.state === "NOT_INCLUDED" ? (
        <div
          className="app-alert app-alert--warn"
          role="status"
          data-evidence-section="reports-plan-gated"
          data-evidence-output-state={reportOutput.state}
        >
          <strong>Reports are not included for this record</strong>
          <p>
            Report PDFs and verification packages are included with
            Pay-per-evidence credits and with the Pro, Team and Enterprise
            plans. Your evidence record itself is signed and preserved — the
            chain of custody is intact, and public verification still works —
            but no downloadable report artifact is produced for it.
          </p>
        </div>
      ) : reportOutput.state === "ELIGIBLE_NOT_GENERATED" ? (
        <div
          className="app-alert"
          role="status"
          data-evidence-section="reports-eligible-not-generated"
          data-evidence-output-state={reportOutput.state}
        >
          <strong>
            Your current plan includes a report and verification package for
            this record
          </strong>
          <p>
            Nothing has been generated for it yet — records captured before this
            entitlement applied are not produced automatically. Generating uses
            no evidence credit; it does use workspace storage.
          </p>
          <GenerateOutputsButton ctx={ctx} action={reportOutput.action} />
        </div>
      ) : reportOutput.state === "RETRYABLE_FAILURE" ? (
        <div
          className="app-alert app-alert--warn"
          role="status"
          data-evidence-section="reports-retryable-failure"
          data-evidence-output-state={reportOutput.state}
        >
          <strong>Report generation failed</strong>
          <p>
            The last attempt did not complete
            {reportOutput.attemptCount
              ? ` (attempt ${reportOutput.attemptCount})`
              : ""}
            . The evidence record and its integrity state are unaffected.
          </p>
          <GenerateOutputsButton ctx={ctx} action={reportOutput.action} />
        </div>
      ) : reportOutput.state === "TERMINAL_FAILURE" ? (
        <div
          className="app-alert app-alert--warn"
          role="status"
          data-evidence-section="reports-terminal-failure"
          data-evidence-output-state={reportOutput.state}
          data-evidence-terminal-class={reportOutput.terminalReasonClass ?? ""}
        >
          <strong>Report generation stopped</strong>
          <p>{terminalFailureCopy(reportOutput.terminalReasonClass)}</p>
          <GenerateOutputsButton ctx={ctx} action={reportOutput.action} />
        </div>
      ) : null}

      {/* Latest verification link. `shareUrl` is derived from the SAME
          publicVerificationSummary the rail reads, so the tab and the rail can
          never disagree about publication state. The link is never
          synthesised: without a real share path the card shows the state
          label and its reason instead of an action. */}
      <section
        className="evidence-detail-verify-card"
        data-evidence-section="latest-artifacts"
      >
        <span className="evidence-detail-verify-card__icon" aria-hidden="true">
          <ShieldCheck size={20} strokeWidth={2} />
        </span>
        <h2 className="evidence-detail-verify-card__title">
          Latest verification link
        </h2>
        <div className="evidence-detail-verify-card__action" data-latest-artifact="verify">
          {shareUrl ? (
            <a
              href={shareUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="evidence-detail-inline-link evidence-detail-verify-link"
              data-evidence-verify-link
            >
              Open verification surface
              <ChevronRight size={16} strokeWidth={2.5} aria-hidden="true" />
            </a>
          ) : (
            <span
              className="evidence-detail-verify-card__unavailable"
              data-evidence-verify-unavailable
            >
              {publicVerificationState?.label ?? "Not available"}
            </span>
          )}
        </div>
        {!shareUrl && publicVerificationState?.detail ? (
          <p className="evidence-detail-verify-card__reason">
            {publicVerificationState.detail}
          </p>
        ) : null}
      </section>

      <ArtifactHistorySection
        history={workspace.artifactVersions.history}
        onDownloadReport={() => void downloadReport()}
        onDownloadVerificationPackage={() => void downloadVerificationPackage()}
        formatDateTime={formatUserDateTime}
        formatBytes={formatBytes}
        evidenceId={evidenceId}
        teamId={workspace.evidence.teamId}
        reportDownloadable={reportDownloadable}
        reportDisabledReason={reportDisabledReason}
        packageDownloadable={packageDownloadable}
        packageDisabledReason={packageDisabledReason}
      />

      <section
        className="evidence-detail-sharing"
        data-evidence-section="public-verification-sharing"
      >
        <div className="evidence-detail-sharing__head">
          <span className="evidence-detail-sharing__icon" aria-hidden="true">
            <Globe size={20} strokeWidth={2} />
          </span>
          <div className="evidence-detail-sharing__copy">
            <h2 className="evidence-detail-sharing__title">
              Public verification &amp; sharing
            </h2>
            <p className="evidence-detail-sharing__description">
              External verification and export activity
            </p>
          </div>
        </div>

        {/* One bare row of label/value pairs inside the card, not a grid of
            sub-cards: these are columns of one activity summary. */}
        <div className="evidence-detail-sharing-grid" data-evidence-facts-grid>
          {[
            {
              label: "Verification status",
              value: publicVerificationState?.label ?? "State unavailable",
            },
            {
              label: "Verification link",
              value: shareUrl ? "Available" : "Not available",
            },
            {
              label: "Publication detail",
              value:
                publicVerificationState?.detail ?? "No publication detail available",
              wide: true,
            },
            { label: "Public views", value: counter(summary.publicViewCount) },
            {
              label: "Report downloads",
              value: counter(summary.reportDownloadCount),
            },
            {
              label: "Package downloads",
              value: counter(summary.verificationPackageDownloadCount),
            },
            {
              label: "Last public view",
              value: formatValue(formatUserDateTime(summary.lastPublicViewAt)),
            },
          ].map((item) => (
            <div
              key={item.label}
              className="evidence-detail-sharing-fact"
              data-wide={item.wide ? "true" : undefined}
            >
              <span className="evidence-detail-sharing-fact__label">{item.label}</span>
              <span className="evidence-detail-sharing-fact__value">{item.value}</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
