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

import type { MutableRefObject, ReactNode } from "react";
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
/**
 * The recovery control.
 *
 * ONE declaration, used by every state that offers recovery, so STALLED and
 * FAILED cannot drift into two differently-behaved buttons — which is how one
 * of them ends up without `aria-busy`, or with a label that claims completion.
 *
 * It renders ONLY when the server projected `canRecover === true`. Not when the
 * workspace is Enterprise, not when the client thinks the user looks like an
 * admin: the endpoint behind this button enforces the same capability, so a
 * button shown to anyone else would be a control that exists only to be
 * refused.
 */
function SearchRecoveryAction({
  label,
  pendingLabel,
  onRecover,
  recovering,
}: {
  label: string;
  /** Says the run STARTED. Never that it finished — it has not. */
  pendingLabel: string;
  onRecover: () => void;
  recovering: boolean;
}) {
  return (
    <button
      type="button"
      className="app-secondary-action search-readiness__recover"
      onClick={onRecover}
      // Disabled the instant it is pressed, so a second click cannot start a
      // second run. The console also holds a re-entrancy ref and the server
      // holds a durable per-workspace slot; none of the three is trusted alone.
      disabled={recovering}
      aria-busy={recovering}
      data-search-readiness-recover
    >
      {recovering ? pendingLabel : label}
    </button>
  );
}

/**
 * What to say when the index needs an operator and this actor is not one.
 *
 * Silence here was the worse option: a viewer saw "indexing is not
 * progressing" and no indication that anything could be done about it by
 * anyone. Naming who can act turns a dead end into a next step, and it does it
 * without offering a control the wire would refuse.
 */
function SearchRecoveryUnavailableHint() {
  return (
    <span
      className="search-readiness__hint"
      data-search-readiness-recover-unavailable
    >
      Ask a workspace administrator to restart indexing.
    </span>
  );
}

/**
 * The readiness disclosure, as a PANEL rather than a sentence.
 *
 * WHAT WAS WRONG
 *
 * `.app-alert` is a block of running text. The icon, the explanation and the
 * recovery button were siblings inside it, so the button was laid out as
 * another inline run — it appeared in the MIDDLE of the sentence, between
 * "…until indexing is restarted." and the status line. It read as an accident,
 * and it broke the reading order for anyone using a screen reader or a
 * magnifier: the explanation was interrupted by a control before it finished.
 *
 * The anatomy is now explicit and the same for every state that has an action:
 *
 *   heading        what state this is, in three or four words
 *   explanation    what it means, as one complete sentence
 *   reason         optional, bounded, only when the server supplied one
 *   ─── actions ─── a SEPARATE row, below the copy
 *   status         what the last recovery request actually did
 *
 * A control never sits inside a sentence, and the actions row exists only when
 * there is something to put in it.
 */
function SearchReadinessPanel({
  state,
  tone,
  icon,
  heading,
  children,
  reason,
  actions,
  status,
  role = "status",
}: {
  state: SearchReadinessState;
  tone: "warn" | "danger";
  icon: ReactNode;
  heading: string;
  children: ReactNode;
  reason?: string | null;
  actions?: ReactNode;
  status?: ReactNode;
  role?: "status" | "alert";
}) {
  return (
    <section
      // STATIC class names, not a composed one. `app-alert--${tone}` is
      // invisible to the convergence audit, which reads the classes a file
      // NAMES: it can neither confirm the class exists nor tell a typo from a
      // valid tone. A two-entry map costs nothing and keeps the surface
      // greppable.
      className={`app-alert ${tone === "danger" ? "app-alert--danger" : "app-alert--warn"} search-readiness-panel`}
      role={role}
      data-search-readiness={state}
    >
      <p className="search-readiness-panel__head">
        <span className="search-readiness-panel__icon" aria-hidden="true">
          {icon}
        </span>
        <span className="search-readiness-panel__heading">{heading}</span>
      </p>
      <p className="search-readiness-panel__body">{children}</p>
      {reason ? (
        <p className="search-readiness-panel__reason" data-search-readiness-reason>
          {reason}
        </p>
      ) : null}
      {actions ? (
        <div
          className="search-readiness-panel__actions"
          data-search-readiness-actions
        >
          {actions}
        </div>
      ) : null}
      {status}
    </section>
  );
}

export function SearchReadinessNotice({
  state,
  indexedCount,
  eligibleCount,
  failureReason,
  canRecover,
  onRecover,
  recovering,
  recoveryNotice,
  recoveryStatusRef,
}: {
  state: SearchReadinessState;
  indexedCount: number;
  eligibleCount: number;
  failureReason: string | null;
  /** Whether THIS actor may run the recovery path. Server-projected. */
  canRecover: boolean;
  onRecover?: () => void;
  recovering?: boolean;
  /**
   * What the SERVER said happened to the last recovery request.
   *
   * "Started" and "already running" are different facts and neither of them is
   * "finished". Announced through a live region so a screen-reader user learns
   * the outcome of a button that is about to unmount.
   */
  recoveryNotice?: string | null;
  recoveryStatusRef?: MutableRefObject<HTMLParagraphElement | null>;
}) {
  /**
   * The outcome line, shared by every state that offers recovery.
   *
   * `tabIndex={-1}` so the console can move focus here when the button that
   * produced it unmounts: focus would otherwise fall to `<body>` at the exact
   * moment the operator's action produced a result.
   */
  const status =
    recoveryNotice ? (
      <p
        className="search-readiness__status"
        role="status"
        aria-live="polite"
        tabIndex={-1}
        ref={recoveryStatusRef}
        data-search-readiness-recover-status
      >
        {recoveryNotice}
      </p>
    ) : null;

  // READY has nothing to disclose, and neither has a state whose whole
  // message belongs in the results region rather than beside them.
  if (state === "READY" || state === "EMPTY_WORKSPACE" || state === "RESTRICTED") {
    return null;
  }

  if (state === "PARTIAL" || state === "INITIALIZING") {
    // Compact and beside the results summary — the work IS progressing, so
    // this is a disclosure, not an alarm. It disappears on its own.
    //
    // No recovery control: a run is already holding this workspace's slot, so
    // a button here could only ever produce "already running".
    return (
      <>
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
        {status}
      </>
    );
  }

  if (state === "STALLED") {
    // The honest version of the sentence this product used to show. Nothing is
    // running, so the copy must not imply that waiting will help.
    return (
      <SearchReadinessPanel
        state="STALLED"
        tone="warn"
        icon={<AlertCircle size={15} strokeWidth={2} />}
        heading="Indexing is not progressing"
        actions={
          canRecover && onRecover ? (
            <SearchRecoveryAction
              label="Rebuild index"
              pendingLabel="Starting…"
              onRecover={onRecover}
              recovering={recovering === true}
            />
          ) : (
            <SearchRecoveryUnavailableHint />
          )
        }
        status={status}
      >
        {indexedCount} of {eligibleCount} records are searchable. What is below
        is real and complete for what has been indexed; the rest will not appear
        until indexing is restarted.
      </SearchReadinessPanel>
    );
  }

  if (state === "FAILED") {
    // Retry is offered HERE and in STALLED, and nowhere else: both are
    // terminal. A run that is still inside its lease is neither, and offering
    // "retry" against it would ask for a second run of work already in hand.
    return (
      <SearchReadinessPanel
        state="FAILED"
        tone="danger"
        role="alert"
        icon={<AlertCircle size={15} strokeWidth={2} />}
        heading="The last indexing run did not finish"
        // A BOUNDED category the server chose, on its own line. Never a stack,
        // never SQL, and never concatenated into the sentence above — where a
        // long value would have pushed the action further out of reach.
        reason={failureReason ? `Reason: ${failureReason}` : null}
        actions={
          canRecover && onRecover ? (
            <SearchRecoveryAction
              label="Retry indexing"
              pendingLabel="Starting…"
              onRecover={onRecover}
              recovering={recovering === true}
            />
          ) : (
            <SearchRecoveryUnavailableHint />
          )
        }
        status={status}
      >
        {indexedCount} of {eligibleCount} records are searchable. The rest will
        not appear until indexing runs again.
      </SearchReadinessPanel>
    );
  }

  // DEGRADED — search itself works. Name only what does not.
  //
  // No recovery action: rebuilding the index would not repair a secondary
  // capability, and offering it here would be a control that cannot help.
  if (state === "DEGRADED") {
    return (
      <SearchReadinessPanel
        state="DEGRADED"
        tone="warn"
        icon={<ServerCrash size={15} strokeWidth={2} />}
        heading="Search is working"
        status={status}
      >
        One secondary capability is unavailable right now. Everything below is
        complete for the search you ran.
      </SearchReadinessPanel>
    );
  }

  // UNAVAILABLE — the service could not be reached at all. Nothing is known
  // about the index, so nothing is claimed about it, and a rebuild cannot be
  // requested through a transport that is not answering.
  if (state === "UNAVAILABLE") {
    return (
      <SearchReadinessPanel
        state="UNAVAILABLE"
        tone="danger"
        role="alert"
        icon={<ServerCrash size={15} strokeWidth={2} />}
        heading="Search is temporarily unavailable"
        status={status}
      >
        The search service could not be reached, so nothing can be said about
        this workspace&apos;s index right now. Try again shortly.
      </SearchReadinessPanel>
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
  recoveryNotice,
  recoveryStatusRef,
}: {
  indexedCount: number;
  eligibleCount: number;
  canRecover: boolean;
  onRecover?: () => void;
  recovering?: boolean;
  recoveryNotice?: string | null;
  recoveryStatusRef?: MutableRefObject<HTMLParagraphElement | null>;
}) {
  return (
    <SearchState
      kind="stalled"
      icon={<AlertCircle size={32} strokeWidth={1.8} />}
      title="Search indexing is not progressing"
      actions={
        // The SAME control the inline notice mounts. Two hand-written buttons
        // for one action is how one of them loses , or keeps a
        // pending label that claims the rebuild finished.
        canRecover && onRecover ? (
          <SearchRecoveryAction
            label="Rebuild index"
            pendingLabel="Starting…"
            onRecover={onRecover}
            recovering={recovering === true}
          />
        ) : null
      }
    >
      {indexedCount} of {eligibleCount} records in this workspace are
      searchable, and no indexing run is currently making progress.{" "}
      {canRecover
        ? "Rebuilding will index the outstanding records."
        : "Ask a workspace administrator to restart indexing."}
      {recoveryNotice ? (
        <p
          className="search-readiness__status"
          role="status"
          aria-live="polite"
          tabIndex={-1}
          ref={recoveryStatusRef}
          data-search-readiness-recover-status
        >
          {recoveryNotice}
        </p>
      ) : null}
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
