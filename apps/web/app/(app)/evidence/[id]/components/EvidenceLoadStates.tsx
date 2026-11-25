"use client";

/**
 * Evidence Detail — load and refresh states (Team remediation stage F:
 * T-137, T-138, T-145; audit JRN-08 a, b, i).
 *
 *   - A failure on the FIRST load is a card that says which failure it is:
 *     not found (or no longer reachable), no permission, or a connection /
 *     service problem. Only the last offers Retry (retrying a 404 or a 403
 *     cannot help).
 *   - A failure on a BACKGROUND reload (after a mutation, the readiness poll)
 *     never replaces the record: the last good data stays and a dismissible
 *     status banner offers Retry.
 *   - A failed case-list read in the "Assign to case" dialog is an error with
 *     Retry, never "No attachable cases".
 * Kept beside the page, which is held under a byte-size guard.
 */
import { AppListbox } from "../../../../../components/app-primitives/AppListbox";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";

export type EvidenceLoadFailure = {
  kind: "not_found" | "forbidden" | "unavailable";
  message: string;
};

/** The class of a failed read, from the HTTP status the API answered. */
export function classifyEvidenceLoadFailure(err: unknown): EvidenceLoadFailure {
  const e = (err && typeof err === "object" ? err : {}) as { statusCode?: unknown; status?: unknown };
  const status = typeof e.statusCode === "number" ? e.statusCode : typeof e.status === "number" ? e.status : null;
  if (status === 404) {
    return {
      kind: "not_found",
      message: "This record was not found, or you no longer have access to it. Check the link, or ask the workspace owner.",
    };
  }
  if (status === 403) {
    return {
      kind: "forbidden",
      message: "You don't have permission to open this record in this workspace. Ask a workspace administrator for access.",
    };
  }
  return {
    kind: "unavailable",
    message: toSafeUserError(err, { message: "The record could not be loaded. Check your connection and try again." }).message,
  };
}

export function EvidenceLoadErrorCard({
  failure,
  onRetry,
}: {
  failure: EvidenceLoadFailure | null;
  onRetry: () => void;
}) {
  const kind = failure?.kind ?? "unavailable";
  return (
    <div className="evidence-detail-page">
      <div className="evidence-detail-shell">
        <section
          className="evidence-detail-section evidence-detail-error-card"
          data-evidence-load-failure={kind}
          role="alert"
        >
          <p className="evidence-detail-kicker">Evidence record</p>
          <h1>
            {kind === "not_found"
              ? "Record not found"
              : kind === "forbidden"
                ? "You don't have permission to open this record"
                : "Unable to load the record"}
          </h1>
          <p>{failure?.message ?? "This evidence record is unavailable right now."}</p>
          {kind === "unavailable" ? (
            <div className="evidence-detail-inline-actions">
              <button type="button" className="app-primary-action" onClick={onRetry} data-evidence-load-retry>
                Retry
              </button>
            </div>
          ) : (
            <div className="evidence-detail-inline-actions">
              <a className="app-secondary-action" href="/evidence">
                Back to Evidence
              </a>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/** T-137 — a failed background reload: the record stays, this says so. */
export function EvidenceRefreshBanner({
  message,
  onRetry,
  onDismiss,
}: {
  message: string;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <aside
      className="evidence-detail-record-banner evidence-detail-record-banner--split"
      data-banner-tone="warn"
      role="status"
      aria-live="polite"
      data-evidence-refresh-error
    >
      <div className="evidence-detail-record-banner__copy">
        <strong className="evidence-detail-record-banner__title">This page could not be refreshed</strong>
        <span className="evidence-detail-record-banner__body">
          {message} What you see is the last version that loaded.
        </span>
      </div>
      <div className="evidence-detail-inline-actions">
        <button type="button" className="app-secondary-action" onClick={onRetry} data-evidence-refresh-retry>
          Retry
        </button>
        <button type="button" className="app-ghost-action" onClick={onDismiss} data-evidence-refresh-dismiss>
          Dismiss
        </button>
      </div>
    </aside>
  );
}

/**
 * T-138 — the "Assign to case" dialog body. The list is the eligibility-
 * narrowed `/v1/cases?eligibleForEvidenceId=…` (no same-team active case →
 * the empty line, Save disabled); a failed read is said as a failure with
 * Retry. The backend cross-workspace gate stays authoritative.
 */
export function AssignCaseDialogBody({
  cases,
  casesFailed,
  selectedCaseId,
  onSelect,
  onRetry,
}: {
  cases: ReadonlyArray<{ id: string; name: string }>;
  casesFailed: boolean;
  selectedCaseId: string;
  onSelect: (id: string) => void;
  onRetry: () => void;
}) {
  if (casesFailed) {
    return (
      <p className="evidence-detail-muted" role="alert" data-evidence-assign-case-error>
        The cases could not be loaded.{" "}
        <button type="button" className="app-secondary-action" onClick={onRetry} data-evidence-assign-case-retry>
          Retry
        </button>
      </p>
    );
  }
  if (cases.length === 0) {
    return (
      <p className="evidence-detail-muted" data-evidence-assign-case-empty>
        No attachable cases are available in this workspace.
      </p>
    );
  }
  return (
    <div data-evidence-assign-case-select>
      <AppListbox
        value={selectedCaseId || null}
        placeholder="Select case"
        ariaLabel="Select case"
        options={cases.map((item) => ({ value: item.id, label: item.name }))}
        onChange={(next) => onSelect(next)}
      />
    </div>
  );
}
