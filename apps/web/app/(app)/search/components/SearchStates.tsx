"use client";

/**
 * The Search console's distinct states.
 *
 * They used to share one `emptyStateStyle` block, so "you have not searched
 * yet", "your query matched nothing" and "we could not reach the search
 * service" looked alike — and the last of those is an outage claim that must
 * never be shown for the first two. Each state below is its own component
 * with its own words, icon and actions.
 *
 * Presentation only: every one of them is told what happened by the console,
 * which learns it from the server. Nothing here infers a state.
 */

import type { ReactNode } from "react";
import {
  AlertCircle,
  Filter,
  Inbox,
  Loader2,
  Lock,
  Search as SearchIcon,
  SearchX,
  ServerCrash,
} from "lucide-react";

import type { SearchReadinessState } from "@proovra/shared";

/**
 * The shared anatomy every state below is built from.
 *
 * Internal again. It was briefly exported so the console could compose the
 * diagnostics-driven states itself; those states are named components in this
 * file now (`SearchEmptyWorkspaceState`, `SearchInitializingState`,
 * `SearchStalledState`), so nothing outside needs the raw anatomy. Keeping the
 * export would leave a helper that no surface mounts — which is precisely what
 * the convergence guard exists to catch.
 */
function SearchState({
  kind,
  icon,
  title,
  children,
  actions,
}: {
  kind: string;
  icon: ReactNode;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="search-state" data-search-state={kind}>
      <span className="search-state__icon" aria-hidden="true">
        {icon}
      </span>
      <h2 className="search-state__title">{title}</h2>
      <p className="search-state__body">{children}</p>
      {actions ? <div className="search-state__actions">{actions}</div> : null}
    </div>
  );
}

/**
 * A. No query yet — the true resting state.
 *
 * Not an error, not a zero-result answer: nothing has been asked yet.
 */
export function SearchPristineState() {
  return (
    <SearchState
      kind="pristine"
      icon={<SearchIcon size={34} strokeWidth={1.8} />}
      title="Search across this workspace"
    >
      Search evidence, cases, reports, verification packages and notes. OCR and
      transcript text appear in results where a record provides them.
    </SearchState>
  );
}

/** B. A query ran and matched nothing. Still not an error. */
export function SearchNoResultsState({
  onClearFilters,
  filtersActive,
  title,
  detail,
}: {
  onClearFilters?: () => void;
  filtersActive: boolean;
  /**
   * The console's own headline, when it knows something more specific than
   * "nothing matched" — e.g. "No Evidence records match" when the type filter
   * is what removed them, or the workspace name when a wrong-workspace
   * mistake is the likely cause.
   */
  title?: string;
  /** The console's own truthful explanation, when it has one. */
  detail?: string;
}) {
  return (
    <SearchState
      kind="no-results"
      icon={<SearchX size={34} strokeWidth={1.8} />}
      title={title ?? "No matching results"}
      actions={
        filtersActive && onClearFilters ? (
          <button
            type="button"
            className="app-secondary-action"
            onClick={onClearFilters}
            data-search-clear-filters
          >
            <Filter size={15} strokeWidth={2} aria-hidden="true" />
            Clear filters
          </button>
        ) : null
      }
    >
      {detail ??
        "Nothing matched this query. Try different words, or change the filters on the left."}
    </SearchState>
  );
}

/**
 * E. The search service could not be reached.
 *
 * ONLY a transport or index failure reaches this state — a permission answer
 * is a different state below, because retrying cannot fix it.
 */
export function SearchUnavailableState({
  onRetry,
  retrying,
  supportHref,
}: {
  onRetry: () => void;
  retrying: boolean;
  supportHref: string;
}) {
  return (
    <SearchState
      kind="unavailable"
      icon={<SearchX size={34} strokeWidth={1.8} />}
      title="Search is temporarily unavailable"
      actions={
        <>
          <button
            type="button"
            className="app-primary-action"
            onClick={onRetry}
            disabled={retrying}
            aria-busy={retrying}
            data-search-retry
          >
            {retrying ? "Retrying…" : "Retry Connection"}
          </button>
          <a className="app-secondary-action" href={supportHref} data-search-support>
            Contact Support
          </a>
        </>
      }
    >
      The secure connection to the data indexing service was interrupted. Try
      refreshing the page or checking your network status.
    </SearchState>
  );
}

/** The banner that accompanies the outage state. */
export function SearchUnavailableAlert() {
  return (
    <div
      className="app-alert app-alert--danger search-alert"
      role="alert"
      data-search-alert="unavailable"
    >
      <AlertCircle size={18} strokeWidth={2} aria-hidden="true" />
      <div>
        <p className="search-alert__title">Service Connection Interrupted</p>
        <p className="search-alert__body">
          We couldn&apos;t reach the search service. Check your connection and try
          again — your evidence data has not been changed.
        </p>
      </div>
    </div>
  );
}

/**
 * F. The workspace refused the request.
 *
 * No retry control: retrying the same request with the same grant produces the
 * same answer, and the copy never confirms whether anything exists behind the
 * refusal.
 */
export function SearchRestrictedState({ message }: { message?: string }) {
  return (
    <SearchState
      kind="restricted"
      icon={<Lock size={32} strokeWidth={1.8} />}
      title="Search is not available for this workspace"
    >
      {message ??
        "Your current access does not include search in this workspace. Ask a workspace admin if you need it."}
    </SearchState>
  );
}

/**
 * G. What the index can currently answer for.
 *
 * ONE surface for every readiness state that has something to say beside real
 * results. It replaces a notice that compared two numbers and concluded
 * "catching up" — which is why a workspace with nothing running told its users
 * to wait, indefinitely.
 *
 * The state is the SERVER's, derived from persisted facts. This component
 * chooses words for it and nothing else; it never infers a state from a count.
 */
export function SearchReadinessNotice({
  state,
  indexedCount,
  eligibleCount,
  failureReason,
  canRecover,
  onRecover,
  recovering,
}: {
  state: SearchReadinessState;
  indexedCount: number;
  eligibleCount: number;
  failureReason: string | null;
  /** Whether THIS actor may run the recovery path. */
  canRecover: boolean;
  onRecover?: () => void;
  recovering?: boolean;
}) {
  // READY has nothing to disclose, and neither has a state whose whole
  // message belongs in the results region rather than beside them.
  if (state === "READY" || state === "EMPTY_WORKSPACE" || state === "RESTRICTED") {
    return null;
  }

  if (state === "PARTIAL" || state === "INITIALIZING") {
    // Compact and beside the results summary — the work IS progressing, so
    // this is a disclosure, not an alarm. It disappears on its own.
    return (
      <p
        className="search-readiness search-readiness--progress"
        role="status"
        data-search-readiness={state}
      >
        <Loader2 size={14} strokeWidth={2} aria-hidden="true" />
        {state === "INITIALIZING"
          ? "Preparing workspace search…"
          : `Indexing in progress — ${indexedCount} of ${eligibleCount} records searchable. Recent records may not appear yet.`}
      </p>
    );
  }

  if (state === "STALLED") {
    // The honest version of the sentence this product used to show. Nothing is
    // running, so the copy must not imply that waiting will help.
    return (
      <div
        className="app-alert app-alert--warn"
        role="status"
        data-search-readiness="STALLED"
      >
        <AlertCircle size={15} strokeWidth={2} aria-hidden="true" />
        <span>
          Indexing is not progressing — {indexedCount} of {eligibleCount} records
          are searchable. What is below is real and complete for what has been
          indexed; the rest will not appear until indexing is restarted.
        </span>
        {canRecover && onRecover ? (
          <button
            type="button"
            className="app-secondary-action"
            onClick={onRecover}
            disabled={recovering}
            aria-busy={recovering}
            data-search-readiness-recover
          >
            {recovering ? "Rebuilding…" : "Rebuild index"}
          </button>
        ) : null}
      </div>
    );
  }

  if (state === "FAILED") {
    return (
      <div
        className="app-alert app-alert--danger"
        role="alert"
        data-search-readiness="FAILED"
      >
        <AlertCircle size={15} strokeWidth={2} aria-hidden="true" />
        <span>
          The last indexing run did not finish
          {failureReason ? `: ${failureReason}` : ""}. {indexedCount} of{" "}
          {eligibleCount} records are searchable.
        </span>
        {canRecover && onRecover ? (
          <button
            type="button"
            className="app-secondary-action"
            onClick={onRecover}
            disabled={recovering}
            aria-busy={recovering}
            data-search-readiness-recover
          >
            {recovering ? "Retrying…" : "Retry indexing"}
          </button>
        ) : null}
      </div>
    );
  }

  // DEGRADED — search itself works. Name only what does not.
  if (state === "DEGRADED") {
    return (
      <div
        className="app-alert app-alert--warn"
        role="status"
        data-search-readiness="DEGRADED"
      >
        <ServerCrash size={15} strokeWidth={2} aria-hidden="true" />{" "}
        Search is working. One secondary capability is unavailable right now.
      </div>
    );
  }

  return null;
}

/**
 * H. Preparing — the workspace's first index is being built.
 *
 * A distinct STATE, not an empty result. It must never render beside a result
 * count: there is nothing to count yet, and "0 results" next to "setting up"
 * told users their records were gone.
 */
export function SearchInitializingState({
  indexedCount,
  eligibleCount,
}: {
  indexedCount: number;
  eligibleCount: number;
}) {
  return (
    <SearchState
      kind="initializing"
      icon={<Loader2 size={34} strokeWidth={1.8} />}
      title="Preparing workspace search…"
    >
      {eligibleCount > 0
        ? `${indexedCount} of ${eligibleCount} records are searchable so far. This page updates on its own.`
        : "This page updates on its own."}
    </SearchState>
  );
}

/**
 * I. Nothing to search yet.
 *
 * Distinct from "being set up": there is no work outstanding, so promising
 * that something is coming would be false.
 */
export function SearchEmptyWorkspaceState({
  workspaceName,
}: {
  workspaceName?: string | null;
}) {
  return (
    <SearchState
      kind="empty-workspace"
      icon={<Inbox size={34} strokeWidth={1.8} />}
      title={`No searchable records yet${
        workspaceName ? ` in "${workspaceName}"` : ""
      }`}
    >
      Evidence, cases, reports, packages and notes become searchable once they
      are created in this workspace.
    </SearchState>
  );
}

/**
 * J. Indexing has stopped with records outstanding.
 *
 * Shown when there is nothing to list at all. When there ARE rows, the notice
 * above sits beside them instead — the results are real and worth showing.
 */
export function SearchStalledState({
  indexedCount,
  eligibleCount,
  canRecover,
  onRecover,
  recovering,
}: {
  indexedCount: number;
  eligibleCount: number;
  canRecover: boolean;
  onRecover?: () => void;
  recovering?: boolean;
}) {
  return (
    <SearchState
      kind="stalled"
      icon={<AlertCircle size={32} strokeWidth={1.8} />}
      title="Search indexing is not progressing"
      actions={
        canRecover && onRecover ? (
          <button
            type="button"
            className="app-primary-action"
            onClick={onRecover}
            disabled={recovering}
            aria-busy={recovering}
            data-search-readiness-recover
          >
            {recovering ? "Rebuilding…" : "Rebuild index"}
          </button>
        ) : null
      }
    >
      {indexedCount} of {eligibleCount} records in this workspace are
      searchable, and no indexing run is currently making progress.{" "}
      {canRecover
        ? "Rebuilding will index the outstanding records."
        : "Ask a workspace admin to rebuild the search index."}
    </SearchState>
  );
}

/** B. Loading — the result geometry, before the results. */
export function SearchResultSkeletons({ rows = 4 }: { rows?: number }) {
  return (
    <div data-search-state="loading" aria-busy="true" aria-live="polite">
      <span className="app-visually-hidden">Searching…</span>
      <div className="search-results__list">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="app-skeleton search-skeleton" />
        ))}
      </div>
    </div>
  );
}
