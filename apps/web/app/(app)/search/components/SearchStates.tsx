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
  Lock,
  Search as SearchIcon,
  SearchX,
  ServerCrash,
} from "lucide-react";

function State({
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
    <State
      kind="pristine"
      icon={<SearchIcon size={34} strokeWidth={1.8} />}
      title="Search across this workspace"
    >
      Search evidence, cases, reports, verification packages and notes. OCR and
      transcript text appear in results where a record provides them.
    </State>
  );
}

/** B. A query ran and matched nothing. Still not an error. */
export function SearchNoResultsState({
  onClearFilters,
  filtersActive,
  detail,
}: {
  onClearFilters?: () => void;
  filtersActive: boolean;
  /** The console's own truthful explanation, when it has one. */
  detail?: string;
}) {
  return (
    <State
      kind="no-results"
      icon={<SearchX size={34} strokeWidth={1.8} />}
      title="No matching results"
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
    </State>
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
    <State
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
    </State>
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
    <State
      kind="restricted"
      icon={<Lock size={32} strokeWidth={1.8} />}
      title="Search is not available for this workspace"
    >
      {message ??
        "Your current access does not include search in this workspace. Ask a workspace admin if you need it."}
    </State>
  );
}

/**
 * G. Part of the index answered.
 *
 * A degraded source is reported beside the results it could not cover — it is
 * never promoted into a total failure.
 */
export function SearchDegradedNotice({ sources }: { sources: string[] }) {
  if (sources.length === 0) return null;
  return (
    <div
      className="app-alert app-alert--warn"
      role="status"
      data-search-degraded={sources.join(",")}
    >
      <ServerCrash size={15} strokeWidth={2} aria-hidden="true" />{" "}
      {sources.length === 1
        ? `${sources[0]} results are unavailable right now. Everything else below is complete.`
        : `${sources.join(", ")} results are unavailable right now. Everything else below is complete.`}
    </div>
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
