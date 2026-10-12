"use client";

/**
 * Operations workbench — the boundary states.
 *
 * ---------------------------------------------------------------------------
 * SIX DIFFERENT STATEMENTS, SIX DIFFERENT PANELS
 * ---------------------------------------------------------------------------
 * The production console had ONE empty state — "No incidents match the
 * filters" — and rendered it whether the workspace was genuinely clear, the
 * filters excluded everything, the read had failed, or the caller was not
 * allowed to see anything. Four very different facts collapsed into one
 * reassuring sentence, and the most dangerous of them (a failed read) looked
 * exactly like the best one.
 *
 * The rule these panels enforce: NOTHING here may say "clear" unless the
 * source said `complete` AND `mayAssertAllClear`. An operations surface that
 * reports an all-clear over a partial read is worse than one that reports
 * nothing at all, because the operator stops looking.
 *
 * D10 (2026-10-12) — every sentence below comes from the shared Operations
 * dictionary, so a German or Arabic reader gets these states in their own
 * language rather than an English panel inside a translated page.
 */

import * as React from "react";

import Link from "next/link";

/*
 * The `formatTimestampForDashboard` import was REMOVED with
 * `ReconciliationStaleNotice` (2026-09-10) — that banner was its only consumer
 * in this file. The timestamp-policy contract still forbids direct formatting
 * outside that one layer; this file simply no longer formats a timestamp.
 */
import { ProovraSupportReference } from "../../../../components/feedback/ProovraSupportReference";
import type { SafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useOpsCopy } from "../_lib/copy";
import { IconOperations, IconSpinner } from "./icons";

// ---------------------------------------------------------------------------

export function LoadingState() {
  const copy = useOpsCopy();
  return (
    <div className="app-empty" data-ops-loading="true" role="status">
      <span className="app-empty__icon">
        <IconSpinner size={24} />
      </span>
      <strong>{copy.loadingConditions}</strong>
    </div>
  );
}

/**
 * The workspace is genuinely clear.
 *
 * The two destinations offered are the ones a tenant can actually open. The
 * previous surface offered "Open observability" and "Open runbooks", both of
 * which are platform-admin consoles that refuse a tenant invisibly — a
 * shortcut to a refusal is not a next step.
 */
export function ClearState() {
  const copy = useOpsCopy();
  return (
    <div className="app-empty" data-ops-empty="clear" data-tone="ok">
      <span className="app-empty__icon">
        <IconOperations size={24} />
      </span>
      <strong>{copy.clearTitle}</strong>
      <p>{copy.clearBody}</p>
      <div className="app-empty__actions">
        <Link className="app-secondary-action" href="/evidence">
          {copy.clearEvidenceLink}
        </Link>
        <Link className="app-secondary-action" href="/home">
          {copy.clearOverviewLink}
        </Link>
      </div>
    </div>
  );
}

/** The filters excluded everything. Not the same statement as "clear". */
export function NoMatchState({ onClear }: { onClear: () => void }) {
  const copy = useOpsCopy();
  return (
    <div className="app-empty" data-ops-empty="filtered">
      <strong>{copy.noMatchTitle}</strong>
      <p>{copy.noMatchBody}</p>
      <div className="app-empty__actions">
        <button type="button" className="app-primary-action" onClick={onClear}>
          {copy.clearFilters}
        </button>
      </div>
    </div>
  );
}

/**
 * D4 (2026-10-12) — the list came back empty, but the SUMMARY could not be
 * read, so nothing is known about whether this workspace has been examined.
 *
 * Neither "clear" (unlicensed), nor "Preparing" (an unreadable summary reports
 * `readiness: NEVER_RUN` as its honest floor, and claiming a first check is
 * running would be invented), nor "no match" (no filter is narrowing).
 */
export function UnconfirmedEmptyState({ onRetry }: { onRetry: () => void }) {
  const copy = useOpsCopy();
  return (
    <div className="app-empty" data-ops-empty="unconfirmed" role="status">
      <strong>{copy.unconfirmedTitle}</strong>
      <p>{copy.unconfirmedBody}</p>
      <div className="app-empty__actions">
        <button type="button" className="app-primary-action" onClick={onRetry}>
          {copy.refresh}
        </button>
      </div>
    </div>
  );
}

/**
 * The caller may not see operational conditions here.
 *
 * Rendered WITHOUT having made any request. The orchestrator refuses to fetch
 * when the capability is absent, so a restricted visit produces zero calls to
 * the Operations API rather than a 403 the panel then explains.
 */
export type RestrictedReason =
  | "not_included"
  | "no_envelope"
  | "no_workspace"
  | "context_mismatch"
  | "account_not_active";

export function RestrictedState({ reason }: { reason: RestrictedReason }) {
  // context_mismatch: the envelope disagrees with itself about which
  // workspace is active, so the permissions it carries may describe a
  // different one. Reading anything here would be authorised by the wrong
  // evidence, which is worse than showing nothing.
  const copy = useOpsCopy();
  const sentence = copy.restricted[reason] ?? copy.restricted.no_envelope;
  return (
    <div
      className="app-empty"
      data-tone="restricted"
      data-ops-restricted={reason}
      role="status"
    >
      <strong>{copy.restrictedTitle}</strong>
      <p>{sentence}</p>
    </div>
  );
}

/**
 * A source failed. The queue may be showing part of the picture.
 *
 * `role="alert"` rather than `role="status"`: this changes what the numbers
 * above it MEAN, and a screen-reader user who is told politely and later is
 * the one most likely to act on a count that is a floor.
 */
export function DegradedNotice({
  what,
  message,
  requestId,
  onRetry,
}: {
  /** Which source, in the operator's words. */
  what: string;
  message: string;
  requestId?: string;
  onRetry?: () => void;
}) {
  const copy = useOpsCopy();
  return (
    <div className="app-alert app-alert--warn" data-ops-degraded={what} role="alert">
      <div>
        <strong>{what}</strong>{" "}
        <span>
          {message} {copy.degradedBody}
        </span>
        <ProovraSupportReference reference={requestId} compact />
      </div>
      {onRetry ? (
        <button type="button" className="app-secondary-action" onClick={onRetry}>
          {copy.retry}
        </button>
      ) : null}
    </div>
  );
}

/** The incident read itself failed. There is no queue to render at all. */
export function UnavailableState({
  message,
  requestId,
  onRetry,
}: {
  message: string;
  requestId?: string;
  onRetry: () => void;
}) {
  const copy = useOpsCopy();
  return (
    <div className="app-empty" data-tone="error" data-ops-unavailable="true" role="alert">
      <strong>{copy.unavailableTitle}</strong>
      <p>{message}</p>
      <ProovraSupportReference reference={requestId} />
      <div className="app-empty__actions">
        <button type="button" className="app-primary-action" onClick={onRetry}>
          {copy.retry}
        </button>
      </div>
    </div>
  );
}

/**
 * A mutation failed.
 *
 * Inline and dismissible, above the queue: an operator who just pressed
 * Resolve needs the failure next to the thing they pressed, not in a toast
 * that is gone before they look up.
 */
export function InlineMutationError({
  error,
  onDismiss,
  onRetry,
}: {
  error: SafeUserError;
  onDismiss: () => void;
  /**
   * Offered ONLY when the failure is retryable (D6). A "Try again" beside a
   * permission refusal or a deployment mismatch teaches the operator that the
   * button does nothing.
   */
  onRetry?: () => void;
}) {
  const copy = useOpsCopy();
  return (
    <div
      className={
        error.severity === "warning"
          ? "app-alert app-alert--warn"
          : "app-alert app-alert--danger"
      }
      role="alert"
      data-ops-mutation-error
      data-ops-mutation-retryable={onRetry ? "true" : "false"}
    >
      <div>
        <span>{error.message}</span>
        <ProovraSupportReference reference={error.supportReference} compact />
      </div>
      <div className="opsw-alert-actions">
        {onRetry ? (
          <button
            type="button"
            className="app-secondary-action"
            onClick={onRetry}
            data-ops-mutation-retry
          >
            {copy.retry}
          </button>
        ) : null}
        <button type="button" className="app-ghost-action" onClick={onDismiss}>
          {copy.dismiss}
        </button>
      </div>
    </div>
  );
}

/** A refresh is in flight over content that is already on screen. */
export function RefreshingNotice() {
  const copy = useOpsCopy();
  return (
    <p className="opsw-refreshing" role="status" data-ops-refreshing="true">
      <IconSpinner size={14} /> <span>{copy.refreshingNotice}</span>
    </p>
  );
}

// ---------------------------------------------------------------------------
// WORKSPACE-SCOPE CONVERGENCE (§16) — the RECONCILIATION states.
//
// Discovery used to run as a side effect of somebody opening Home, so there
// was no such thing as "this workspace has not been scanned yet" — every visit
// scanned it on the way in. Now that discovery is a scheduled run, four new
// facts are possible and each of them USED to render as "clear":
//
//   never run   — nothing has ever looked here
//   running     — something is looking right now
//   partial     — it looked, and could not see everything
//   stalled     — something started looking and died holding the lock
//
// Every panel below exists because collapsing one of those into the all-clear
// is how an operator stops looking at a workspace that has real, unexamined
// failures in it.
// ---------------------------------------------------------------------------

/**
 * Nothing has scanned this workspace yet.
 *
 * DELIBERATELY not an empty state and deliberately not reassuring. The count
 * of conditions is zero and that number means nothing at all until the first
 * run completes. Rendered ONLY when the summary was actually read and said
 * NEVER_RUN — never for an unreadable summary (see UnconfirmedEmptyState).
 */
export function PreparingState() {
  const copy = useOpsCopy();
  return (
    <div className="app-empty" data-ops-empty="preparing" role="status">
      <span className="app-empty__icon">
        <IconSpinner size={24} />
      </span>
      <strong>{copy.preparingTitle}</strong>
      <p>{copy.preparingBody}</p>
    </div>
  );
}

/** A discovery run holds the lock right now. */
export function ReconcilingNotice() {
  const copy = useOpsCopy();
  return (
    <p className="opsw-refreshing" role="status" data-ops-reconciling="true">
      <IconSpinner size={14} /> <span>{copy.reconcilingNotice}</span>
    </p>
  );
}

/**
 * The run finished without seeing everything.
 *
 * `role="alert"`, because this changes what every count on the page MEANS:
 * they become a floor rather than a total, and a reader who is told politely
 * and later is the one most likely to act on the smaller number.
 */
export function PartialCoverageNotice({
  failedCount,
  truncatedCount,
  onRetry,
  retryable = true,
}: {
  failedCount: number;
  truncatedCount: number;
  onRetry?: () => void;
  /**
   * Could running the same check again plausibly succeed?
   *
   * SERVER-COMPUTED, from the bounded failure category on the run row. A
   * deployment/schema disagreement fails identically every time until
   * something is deployed, so offering a re-check for one is an instruction
   * to waste an operator's time during an incident.
   */
  retryable?: boolean;
}) {
  const copy = useOpsCopy();
  const what =
    truncatedCount > 0 && failedCount > 0
      ? copy.reconcile.partialBoth
      : truncatedCount > 0
        ? copy.reconcile.partialTruncated
        : copy.reconcile.partialFailed;
  return (
    <div
      className="app-alert app-alert--warn"
      data-ops-partial="true"
      role="alert"
    >
      <div>
        <strong>{what}.</strong> <span>{copy.reconcile.partialBody}</span>
        {!retryable ? (
          <span data-ops-partial-nonretryable="true">
            {" "}
            {copy.reconcile.partialNonRetryable}
          </span>
        ) : null}
      </div>
      {onRetry && retryable ? (
        <button type="button" className="app-secondary-action" onClick={onRetry}>
          {copy.checkAgain}
        </button>
      ) : null}
    </div>
  );
}

/**
 * A run claimed the workspace and never finished.
 *
 * The most misleading state of all before this existed: an abandoned run looks
 * exactly like a busy one, and nobody investigates busy.
 */
export function ReconciliationStalledNotice({ onRetry }: { onRetry?: () => void }) {
  const copy = useOpsCopy();
  return (
    <div
      className="app-alert app-alert--warn"
      data-ops-stalled="true"
      role="alert"
    >
      <div>
        <strong>{copy.reconcile.stalledTitle}</strong>{" "}
        <span>{copy.reconcile.stalledBody}</span>
      </div>
      {onRetry ? (
        <button type="button" className="app-secondary-action" onClick={onRetry}>
          {copy.checkAgain}
        </button>
      ) : null}
    </div>
  );
}

/**
 * The last run failed outright.
 *
 * The category is a BOUNDED server-side classification, never a provider
 * message, a stack or a SQL fragment — the run row stores an exception message
 * and it is reduced at the API boundary precisely so nothing like that can
 * reach here.
 */
export function ReconciliationFailedNotice({
  category,
  onRetry,
}: {
  category: string | null;
  onRetry?: () => void;
}) {
  const copy = useOpsCopy();
  // `schema_mismatch` and `permission_denied` describe a deployment, not a
  // transient. Retrying cannot change either, and the copy has to say so
  // instead of implying the operator simply caught a bad moment.
  const retryable =
    category !== "schema_mismatch" && category !== "permission_denied";
  const explanation =
    category === "database_unavailable"
      ? copy.reconcile.failedDatabase
      : category === "timeout"
        ? copy.reconcile.failedTimeout
        : category === "schema_mismatch"
          ? copy.reconcile.failedSchema
          : category === "permission_denied"
            ? copy.reconcile.failedPermission
            : copy.reconcile.failedGeneric;
  return (
    <div
      className="app-alert app-alert--danger"
      data-ops-reconcile-failed={category ?? "unexpected_error"}
      data-ops-reconcile-retryable={retryable ? "true" : "false"}
      role="alert"
    >
      <div>
        <strong>{copy.reconcile.failedTitle}</strong>{" "}
        <span>
          {explanation} {copy.reconcile.failedEarlier}
        </span>
      </div>
      {onRetry && retryable ? (
        <button type="button" className="app-secondary-action" onClick={onRetry}>
          {copy.retry}
        </button>
      ) : null}
    </div>
  );
}

/*
 * =============================================================================
 * `ReconciliationStaleNotice` WAS DELETED HERE (2026-09-10).
 * =============================================================================
 * It rendered "These conditions may be out of date. … A new one is being
 * scheduled." with a "Check again" button on every read whose last complete
 * run had aged past the freshness window. The data under the banner was
 * correct, and the scheduled check it announced had already been started on
 * the same read. Removed as PRESENTATION, not as semantics: `readiness:
 * "STALE"` is untouched on the wire, and `mayAssertOperationsClear` still
 * refuses the all-clear for it.
 */
