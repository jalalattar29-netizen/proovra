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

import { ChevronRight, Globe, ShieldCheck } from "lucide-react";
import {
  NEW_VERSION_ACTION,
  outputActionLabel,
  outputUnavailableReasonCopy,
  type OutputTerminalReasonClass,
} from "@proovra/shared";
import { formatValue, OUTPUT_STATE_COPY, type EvidenceDetailCtx } from "./_lib";
import type { EvidenceOutputProjection } from "../review-workspace-types";
import { NewVersionMenu } from "../../../../../components/evidence-outputs/NewVersionMenu";
import { formatUserDateTime } from "../../../../../lib/date";
import { ArtifactHistorySection } from "../components/ArtifactHistorySection";
import { RuntimeStatusBanner } from "../../../../../components/operational";
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

type OutputKind = "report" | "verificationPackage";

/**
 * ONE OUTPUT'S ACTION — the verb the server chose, named by the shared table.
 *
 * 2026-09-26 — the verb is per output now. A report whose package is missing
 * offers "Recover verification package" on the PACKAGE, and that request
 * rebuilds only the package, from the stored report bytes. The old single
 * control called this "Regenerate report & verification package", which is
 * a different operation with a different result.
 *
 * Nothing here decides whether to render: `action` does. REGENERATE is
 * retired (a new version is its own confirmed action below) and never renders.
 */
function OutputActionButton({
  ctx,
  kind,
  output,
}: {
  ctx: EvidenceDetailCtx;
  kind: OutputKind;
  output: EvidenceOutputProjection;
}) {
  const action = output.action;
  if (action === "NONE" || action === "REGENERATE") return null;
  return (
    <button
      type="button"
      className="app-secondary-action"
      onClick={() => void ctx.generateOutputs(action)}
      disabled={ctx.generateOutputsBusy}
      data-evidence-action="generate-outputs"
      data-evidence-output={kind}
      data-evidence-generate-verb={action}
      data-evidence-operation={output.operation ?? ""}
    >
      {ctx.generateOutputsBusy ? "Requesting…" : outputActionLabel(kind, action)}
    </button>
  );
}

/** Why no action is offered, when a person should read it. */
function OutputUnavailableNote({
  kind,
  output,
}: {
  kind: OutputKind;
  output: EvidenceOutputProjection;
}) {
  const copy = outputUnavailableReasonCopy(output.actionUnavailableReason);
  if (!copy) return null;
  return (
    <p
      className="evidence-detail-artifact-note"
      data-evidence-output={kind}
      data-evidence-action-unavailable={output.actionUnavailableReason ?? ""}
    >
      {copy}
    </p>
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
 * but DOES render a failed attempt beyond it, a new version in flight, and the
 * optional new-version menu.
 */
function ArtifactLifecyclePanel({
  ctx,
  output,
}: {
  ctx: EvidenceDetailCtx;
  output: EvidenceOutputProjection;
}) {
  const reasonCopy = outputUnavailableReasonCopy(output.actionUnavailableReason);
  const action = (
    <>
      {/* A confirmed generation incident is said HERE, beside the control
          it affects — not as a banner over the record. */}
      {output.action !== "NONE" ? (
        <RuntimeStatusBanner requires={["artifactGeneration"]} />
      ) : null}
      <OutputActionButton ctx={ctx} kind="report" output={output} />
      <OutputUnavailableNote kind="report" output={output} />
    </>
  );
  const newVersion = ctx.workspace.artifactStatus.outputs.newVersion;
  const newVersionInFlight =
    output.state === "READY" && newVersion?.reason === "IN_PROGRESS";

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
          <RuntimeStatusBanner requires={["artifactGeneration"]} />
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
          <RuntimeStatusBanner requires={["artifactGeneration"]} />
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
          {/* The server's reason (escalated to operators, integrity review,
              ...) is the more specific sentence; the class copy is the
              fallback when there is none. */}
          {reasonCopy ? null : <p>{terminalFailureCopy(output.terminalReasonClass)}</p>}
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
          {reasonCopy ? null : (
            <p>
              A governance or lifecycle decision is currently preventing
              generation for this record. It becomes possible again when that
              decision changes; the evidence record and its integrity state
              are unaffected.
            </p>
          )}
          {action}
        </div>
      );

    case "READY":
      /*
       * A downloadable artifact is not a status message, so there is no alert
       * for READY itself. What does render: a new version in flight (the
       * downloads below stay the current version until it lands), a failed
       * attempt beyond the current version and what can be done about it, and
       * the optional new-version menu. After a downgrade the server offers
       * nothing here and only the downloads remain. None of it is decided
       * locally.
       */
      if (newVersionInFlight) {
        return (
          <div
            className="app-alert"
            role="status"
            aria-live="polite"
            data-evidence-section="reports-new-version-in-flight"
            data-evidence-output-state={output.state}
          >
            <strong>
              {newVersion.nextVersion != null
                ? `Creating version ${newVersion.nextVersion}…`
                : "Creating a new version…"}
            </strong>
            <p>
              The current version stays available below until the new report
              and verification package are ready. This page checks on its own.
            </p>
          </div>
        );
      }
      return output.action === "NONE" &&
        reasonCopy === null &&
        newVersion?.action !== NEW_VERSION_ACTION ? null : (
        <div
          className="evidence-detail-artifact-actions"
          data-evidence-section="reports-ready-actions"
          data-evidence-output-state={output.state}
        >
          {action}
          {/* A generation incident affects a new version too; said beside it. */}
          {output.action === "NONE" && newVersion?.action === NEW_VERSION_ACTION ? (
            <RuntimeStatusBanner requires={["artifactGeneration"]} />
          ) : null}
          <NewVersionMenu
            offer={newVersion}
            busy={ctx.generateOutputsBusy}
            request={ctx.createNewVersion}
            menuLabel="More actions for this record's report"
            dataPrefix="evidence-output"
            testId="evidence-new-version"
          />
        </div>
      );
  }
}

/**
 * THE VERIFICATION PACKAGE, WHEN IT IS NOT PAIRED WITH THE CURRENT REPORT.
 *
 * Rendered only once the report exists: before that the package follows the
 * report's own action. A missing package is recovered from the STORED report
 * — same bytes, same version, no new timestamp — and this panel says so
 * rather than describing a regeneration.
 */
function PackageRecoveryPanel({
  ctx,
  report,
  pkg,
}: {
  ctx: EvidenceDetailCtx;
  report: EvidenceOutputProjection;
  pkg: EvidenceOutputProjection;
}) {
  if (report.state !== "READY") return null;
  const reasonCopy = outputUnavailableReasonCopy(pkg.actionUnavailableReason);
  const inFlight = pkg.state === "QUEUED" || pkg.state === "GENERATING";
  if (!inFlight && pkg.action === "NONE" && reasonCopy === null) return null;

  const forVersion =
    report.version != null ? ` for report version ${report.version}` : "";
  const older =
    pkg.latestAvailableVersion != null &&
    (report.version == null || pkg.latestAvailableVersion < report.version) ? (
      <p>
        The earlier package (version {pkg.latestAvailableVersion}) stays
        downloadable from the version history.
      </p>
    ) : null;

  if (inFlight) {
    return (
      <div
        className="app-alert"
        role="status"
        aria-live="polite"
        data-evidence-section="package-recovery-in-flight"
        data-evidence-output-state={pkg.state}
      >
        <strong>Recovering the verification package{forVersion}…</strong>
        <p>
          The package is being built around the stored report exactly as it is.
          The report is not changed and no new version is created. This page
          checks on its own.
        </p>
      </div>
    );
  }

  const title =
    pkg.action === "RECOVER"
      ? `The verification package${forVersion} is missing`
      : pkg.action === "RETRY"
        ? "Recovering the verification package failed"
        : "The verification package could not be recovered";
  return (
    <div
      className="app-alert app-alert--warn"
      role="status"
      data-evidence-section="package-recovery"
      data-evidence-output-state={pkg.state}
      data-evidence-output-action={pkg.action}
    >
      <strong>{title}</strong>
      {pkg.action === "RECOVER" ? (
        <p>
          The report is available. Recovery builds its verification package
          from the stored report bytes — it does not create a new report
          version or a new timestamp.
        </p>
      ) : pkg.action === "RETRY" ? (
        <p>
          The last attempt did not complete
          {pkg.attemptCount ? ` (attempt ${pkg.attemptCount})` : ""}. The
          report and the evidence record are unaffected.
        </p>
      ) : null}
      {older}
      {pkg.action !== "NONE" ? (
        <RuntimeStatusBanner requires={["artifactGeneration"]} />
      ) : null}
      <OutputActionButton ctx={ctx} kind="verificationPackage" output={pkg} />
      <OutputUnavailableNote kind="verificationPackage" output={pkg} />
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
      <PackageRecoveryPanel ctx={ctx} report={reportOutput} pkg={packageOutput} />

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

      {/* Only when something is downloadable: a downloads incident is about
          the download controls below, not about the record. */}
      {reportDownloadable || packageDownloadable ? (
        <RuntimeStatusBanner requires={["downloads"]} />
      ) : null}
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
