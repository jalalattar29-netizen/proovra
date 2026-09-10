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
  OutputNotApplicableReason,
  OutputTerminalReasonClass,
} from "@proovra/shared";
import { formatValue, OUTPUT_STATE_COPY, type EvidenceDetailCtx } from "./_lib";
// RELIABILITY CLOSURE (2026-09-09) — one operation, one name, across four
// surfaces that each used to spell it differently.
import { GENERATION_ACTION_LABEL } from "../../../../../lib/evidence/generation-labels";
import { formatUserDateTime } from "../../../../../lib/date";
import { ArtifactHistorySection } from "../components/ArtifactHistorySection";
import { formatBytes } from "./_lib";


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

  /*
   * THE CANONICAL LABELS, and the only place they are written for this surface.
   *
   * RELIABILITY CLOSURE (2026-09-09) — "Retry generation" named a different
   * thing from its two siblings, and the Reports page said "Generate report &
   * package" for what this one called "Generate report & verification package".
   * One operation must have one name: a person comparing the two surfaces was
   * being asked to work out whether they did the same thing.
   */
  const label = GENERATION_ACTION_LABEL[action];

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

/**
 * THE ONE PANEL, over the canonical state.
 *
 * Presentation only: every decision it renders was made by the server. It
 * chooses copy and tone from `state`, and it renders whatever `action` says —
 * it never infers an action from the state it is branching on, which is the
 * mistake that made the Reports page a second authority.
 *
 * `READY` renders no alert (a downloadable artifact is not a status message)
 * but DOES render its action, which is how Regenerate became reachable.
 */
function ArtifactLifecyclePanel({
  ctx,
  output,
}: {
  ctx: EvidenceDetailCtx;
  output: {
    state: EvidenceOutputState;
    action: OutputAction;
    terminalReasonClass: OutputTerminalReasonClass | null;
    /** P1-3 — bounded, present only for NOT_APPLICABLE. */
    notApplicableReason: OutputNotApplicableReason | null;
    /** P2-1 — why the verb was withdrawn on a state that would carry one. */
    actionUnavailableReason: "WORKSPACE_UNRESOLVED" | null;
    attemptCount: number | null;
  };
}) {
  /*
   * P2-1 (2026-09-10) — when the server withdrew the verb, say why.
   *
   * `action` is already NONE here, so `GenerateOutputsButton` renders nothing.
   * Rendering nothing was the old behaviour and it left a legacy record with an
   * invitation-shaped silence; the sentence replaces it. Placed alongside the
   * action so every state's arm gets it without repeating the branch.
   */
  const action =
    output.actionUnavailableReason === "WORKSPACE_UNRESOLVED" ? (
      <p
        className="evidence-detail-artifact-note"
        data-evidence-action-unavailable={output.actionUnavailableReason}
      >
        This older record needs a workspace association before a new report or
        verification package can be requested. Everything already generated for
        it stays available.
      </p>
    ) : (
      <GenerateOutputsButton ctx={ctx} action={output.action} />
    );

  switch (output.state) {
    case "NOT_APPLICABLE":
      /*
       * P1-3 CLOSURE (2026-09-10) — A RECORD CONDITION, STATED AS ONE.
       *
       * Both of these used to render the NOT_INCLUDED arm below, which names
       * plans. So a Pro customer watching their own upload was told reports
       * were not included in their plan, and a record whose recomputed SHA-256
       * disagreed with the value stored at completion was told the same — a
       * billing sentence for an integrity failure, on a forensic surface.
       *
       * The two reasons are rendered separately because they end differently:
       * finalization is coming, and an integrity failure is not.
       */
      return output.notApplicableReason === "INTEGRITY_FAILED" ? (
        <div
          className="app-alert app-alert--warn"
          role="status"
          data-evidence-section="reports-integrity-failed"
          data-evidence-output-state={output.state}
          data-evidence-not-applicable-reason={output.notApplicableReason}
        >
          <strong>
            Outputs cannot be produced for this record
          </strong>
          <p>
            This record did not pass its integrity check: the fingerprint
            recomputed from the stored bytes did not match the value recorded
            when it was completed. A report and verification package can only
            be produced from a record whose integrity is intact, so none will
            be generated for this one. The record itself is preserved exactly
            as received, for inspection. To capture this material as evidence,
            re-upload or re-capture it as a new record.
          </p>
        </div>
      ) : (
        <div
          className="app-alert"
          role="status"
          data-evidence-section="reports-not-applicable"
          data-evidence-output-state={output.state}
          data-evidence-not-applicable-reason={
            output.notApplicableReason ?? "NOT_FINALIZED"
          }
        >
          <strong>
            Outputs become available once this record is finalized
          </strong>
          <p>
            A report and verification package are produced from a finalized
            record — its fingerprint, signature and chain of custody. This
            record has not reached that point yet, so there is nothing to
            generate from and no action to take.
          </p>
        </div>
      );

    case "NOT_INCLUDED":
      return (
        <div
          className="app-alert app-alert--warn"
          role="status"
          data-evidence-section="reports-plan-gated"
          data-evidence-output-state={output.state}
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
      );

    case "ELIGIBLE_NOT_GENERATED":
      return (
        <div
          className="app-alert"
          role="status"
          data-evidence-section="reports-eligible-not-generated"
          data-evidence-output-state={output.state}
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
          {action}
        </div>
      );

    case "QUEUED":
      return (
        <div
          className="app-alert"
          role="status"
          aria-live="polite"
          data-evidence-section="reports-queued"
          data-evidence-output-state={output.state}
        >
          <strong>
            Report and verification package are queued for generation
          </strong>
          <p>
            Work has been accepted and is waiting for a worker. This page checks
            for completion on its own; nothing further is needed from you.
          </p>
        </div>
      );

    case "GENERATING":
      return (
        <div
          className="app-alert"
          role="status"
          aria-live="polite"
          data-evidence-section="reports-generating"
          data-evidence-output-state={output.state}
        >
          <strong>Generating report and verification package…</strong>
          <p>
            Both artifacts are produced by one job. They will appear below when
            it completes.
          </p>
        </div>
      );

    case "RETRYABLE_FAILURE":
      return (
        <div
          className="app-alert app-alert--warn"
          role="status"
          data-evidence-section="reports-retryable-failure"
          data-evidence-output-state={output.state}
        >
          <strong>Report generation failed</strong>
          <p>
            The last attempt did not complete
            {output.attemptCount ? ` (attempt ${output.attemptCount})` : ""}. The
            evidence record and its integrity state are unaffected.
          </p>
          {action}
        </div>
      );

    case "TERMINAL_FAILURE":
      return (
        <div
          className="app-alert app-alert--warn"
          role="status"
          data-evidence-section="reports-terminal-failure"
          data-evidence-output-state={output.state}
          data-evidence-terminal-class={output.terminalReasonClass ?? ""}
        >
          <strong>Report generation stopped</strong>
          <p>{terminalFailureCopy(output.terminalReasonClass)}</p>
          {action}
        </div>
      );

    case "BLOCKED":
      /*
       * NO LONGER SILENT. A blocked record rendered nothing at all, so the one
       * state whose entire content is an explanation had none — the reason
       * survived only as the title attribute of a disabled download button.
       *
       * The action still comes from the server, and for a standing block the
       * server returns NONE. It becomes an action again when the request
       * authority re-reads the blocker and finds it gone.
       */
      return (
        <div
          className="app-alert app-alert--warn"
          role="status"
          data-evidence-section="reports-blocked"
          data-evidence-output-state={output.state}
        >
          <strong>Report generation is blocked</strong>
          <p>
            A governance or lifecycle decision is currently preventing
            generation for this record. It becomes possible again when that
            decision changes; the evidence record and its integrity state are
            unaffected.
          </p>
          {action}
        </div>
      );

    case "READY":
      /*
       * A downloadable artifact is not a status message, so there is no alert
       * here — the version cards below say everything. But the ACTION still
       * renders, and that is the fix: READY is the only state whose canonical
       * action is REGENERATE, and rendering nothing for it made the entire
       * regeneration path in `GenerateOutputsButton` — confirmation dialog and
       * all — unreachable code.
       *
       * After a downgrade the server returns NONE here, so the control
       * disappears while the downloads stay. Neither decision is made locally.
       */
      /*
       * P2-1 — the withdrawn-verb note renders here too. A legacy record with
       * an existing artifact is READY, downloadable, and cannot be
       * regenerated; the downloads above say the first two and this says the
       * third.
       */
      return output.action === "NONE" &&
        output.actionUnavailableReason === null ? null : (
        <div
          className="evidence-detail-artifact-actions"
          data-evidence-section="reports-ready-actions"
          data-evidence-output-state={output.state}
        >
          {action}
        </div>
      );
  }
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

      {/* ==================================================================
          THE OUTPUT LIFECYCLE PANEL — TOTAL OVER THE CANONICAL STATE.
          ==================================================================
          RELIABILITY CLOSURE (2026-09-09). The chain that stood here handled
          four of the eight states and fell through to `null` for the rest,
          which produced two defects:

            * READY is the ONLY state whose canonical action is REGENERATE, and
              READY rendered nothing — so the regeneration path in
              `GenerateOutputsButton`, confirmation dialog included, was
              unreachable code. A customer could not create a new version from
              the surface that owns versions.
            * QUEUED and GENERATING rendered nothing, so the moment a person
              clicked Generate the panel they were looking at went blank. The
              only trace of their click was the reason text on a disabled
              download button.

          It is a switch over `EvidenceOutputState` now, so a new state is a
          compile error rather than a silent empty panel. */}
      <ArtifactLifecyclePanel ctx={ctx} output={reportOutput} />

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
        onDownloadReportVersion={(v) => void ctx.downloadReportVersion(v)}
        onDownloadVerificationPackageVersion={(v) =>
          void ctx.downloadVerificationPackageVersion(v)
        }
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
