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
 */

import * as React from "react";

import Link from "next/link";

import { ProovraSupportReference } from "../../../../components/feedback/ProovraSupportReference";
import type { SafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { IconOperations, IconSpinner } from "./icons";

// ---------------------------------------------------------------------------

export function LoadingState() {
  return (
    <div className="app-empty" data-ops-loading="true" role="status">
      <span className="app-empty__icon">
        <IconSpinner size={24} />
      </span>
      <strong>Loading operational conditions…</strong>
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
  return (
    <div className="app-empty" data-ops-empty="clear" data-tone="ok">
      <span className="app-empty__icon">
        <IconOperations size={24} />
      </span>
      <strong>Workspace operations are clear</strong>
      <p>
        There are no unresolved operational conditions requiring action in this
        workspace.
      </p>
      <div className="app-empty__actions">
        <Link className="app-secondary-action" href="/evidence">
          Evidence library
        </Link>
        <Link className="app-secondary-action" href="/home">
          Workspace overview
        </Link>
      </div>
    </div>
  );
}

/** The filters excluded everything. Not the same statement as "clear". */
export function NoMatchState({ onClear }: { onClear: () => void }) {
  return (
    <div className="app-empty" data-ops-empty="filtered">
      <strong>No operational conditions match these filters</strong>
      <p>
        This workspace may still have unresolved work. Widen the filters to see
        it.
      </p>
      <div className="app-empty__actions">
        <button type="button" className="app-primary-action" onClick={onClear}>
          Clear filters
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
  const copy =
    reason === "not_included"
      ? "Operations is available to workspaces that produce operational conditions, or that more than one person shares. This workspace does neither right now, so there is no shared triage queue to show."
      : reason === "no_workspace"
        ? "No workspace is selected yet. Choose a workspace to see its operational conditions."
        : reason === "context_mismatch"
          ? // The envelope disagrees with itself about which workspace is
            // active, so the permissions it carries may describe a different
            // one. Reading anything here would be authorised by the wrong
            // evidence, which is worse than showing nothing.
            "This workspace couldn't be confirmed. Reload the page, or switch workspace again."
          : reason === "account_not_active"
            ? "This account is suspended, so operational work can't be shown or acted on. Contact a workspace owner."
            : "Your access for this workspace hasn't been confirmed. Reload the page, or ask a workspace owner to check your role.";
  return (
    <div
      className="app-empty"
      data-tone="restricted"
      data-ops-restricted={reason}
      role="status"
    >
      <strong>Operations isn&apos;t available for this workspace</strong>
      <p>{copy}</p>
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
  return (
    <div className="app-alert app-alert--warn" data-ops-degraded={what} role="alert">
      <div>
        <strong>{what} could not be loaded.</strong>{" "}
        <span>{message} Anything shown below may be incomplete.</span>
        <ProovraSupportReference reference={requestId} compact />
      </div>
      {onRetry ? (
        <button type="button" className="app-secondary-action" onClick={onRetry}>
          Retry
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
  return (
    <div className="app-empty" data-tone="error" data-ops-unavailable="true" role="alert">
      <strong>Operational conditions are temporarily unavailable</strong>
      <p>{message}</p>
      <ProovraSupportReference reference={requestId} />
      <div className="app-empty__actions">
        <button type="button" className="app-primary-action" onClick={onRetry}>
          Try again
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
}: {
  error: SafeUserError;
  onDismiss: () => void;
}) {
  return (
    <div className="app-alert app-alert--danger" role="alert" data-ops-mutation-error>
      <div>
        <span>{error.message}</span>
        <ProovraSupportReference reference={error.supportReference} compact />
      </div>
      <button type="button" className="app-ghost-action" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

/** A refresh is in flight over content that is already on screen. */
export function RefreshingNotice() {
  return (
    <p className="opsw-refreshing" role="status" data-ops-refreshing="true">
      <IconSpinner size={14} /> <span>Refreshing…</span>
    </p>
  );
}
