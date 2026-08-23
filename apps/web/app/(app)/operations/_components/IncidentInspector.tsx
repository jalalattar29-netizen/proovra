"use client";

/**
 * Operations workbench — the incident inspector.
 *
 * ---------------------------------------------------------------------------
 * WHY A PANEL AND NOT AN EXPANDED ROW
 * ---------------------------------------------------------------------------
 * Everything an operator needs to DECIDE about a condition — its history, who
 * has touched it, which record it is about, what actually failed — is more
 * than a table row can hold. Expanding rows in place would reflow the queue
 * under the operator's cursor every time they looked at something, which is
 * why the geometry of the list is deliberately unchanged when this opens.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY ABSENT
 * ---------------------------------------------------------------------------
 * There is no due date and no SLA section. `OperationalIncident` has no
 * `dueAt`, no policy authority and no escalation clock — the only time-based
 * signal the platform owns for a condition is its AGE, and the canonical
 * summary's `overdue` is exactly that: open and unattended past a fixed number
 * of hours. Rendering "Due in 4h" from an age threshold would be inventing an
 * SLA the product does not have and cannot honour. The age is shown as an age.
 *
 * There is also no runbook link. `runbookSlug` points into `docs/runbooks/*`,
 * which is not a tenant-reachable destination, and a link a tenant cannot open
 * is the defect this redesign removed from the page header.
 */

import * as React from "react";

import Link from "next/link";

import { AppStatusBadge } from "../../../../components/app-primitives/AppStatusBadge";
import { formatUserDateTime } from "../../../../lib/date";
import { describeRelativeTime } from "../../../../lib/relative-time";
import type {
  AssignableOperator,
  IncidentDetail,
  OperationsCapabilities,
  SourceState,
} from "../_lib/types";
import type { OperationsRowModel } from "../_lib/rowModel";
import { timelineEventLabel } from "../_lib/vocabulary";
import { AssignmentControl } from "./AssignmentControl";
import { IconClose, IconExternal, IconSpinner } from "./icons";

/** A bounded, LTR-isolated, copyable identifier. */
function Identifier({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <div className="opsw-ident">
      <span className="opsw-ident__label">{label}</span>
      {/* `dir="ltr"` and the isolation class keep a hex id from being
          re-ordered inside an Arabic sentence, where a bidi-neutral run
          otherwise reads back-to-front and is copied wrong. */}
      <code className="opsw-ident__value opsw-ltr" dir="ltr">
        {value}
      </code>
      <button
        type="button"
        className="app-ghost-action opsw-ident__copy"
        aria-label={`Copy ${label.toLowerCase()}`}
        onClick={() => {
          try {
            void navigator.clipboard?.writeText(value);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          } catch {
            /* clipboard blocked — the value is still visible to read */
          }
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function Fact({
  term,
  children,
}: {
  term: string;
  children: React.ReactNode;
}) {
  return (
    <div className="opsw-fact">
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function IncidentInspector({
  row,
  detail,
  capabilities,
  operators,
  selfUserId,
  onClose,
  onAcknowledge,
  onResolve,
  onSuppress,
  onAssign,
  pending,
}: {
  /** The row model for the condition, already in the list. */
  row: OperationsRowModel;
  /** Its history, loaded separately. */
  detail: SourceState<IncidentDetail>;
  capabilities: OperationsCapabilities;
  operators: ReadonlyArray<AssignableOperator>;
  selfUserId: string | null;
  onClose: () => void;
  onAcknowledge: () => void;
  onResolve: () => void;
  onSuppress: () => void;
  onAssign: (assigneeUserId: string | null) => void;
  pending: boolean;
}) {
  const panelRef = React.useRef<HTMLElement | null>(null);
  const restoreRef = React.useRef<HTMLElement | null>(null);
  const titleId = React.useId();

  React.useEffect(() => {
    restoreRef.current =
      typeof document !== "undefined"
        ? (document.activeElement as HTMLElement | null)
        : null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Focus returns to whatever opened this. A drawer that drops focus back
      // onto <body> strands a keyboard user at the top of the page, several
      // dozen tab stops from the row they were reading.
      restoreRef.current?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className="opsw-drawer-overlay"
      onClick={onClose}
      data-ops-inspector-overlay
    >
      <aside
        ref={panelRef}
        className="opsw-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        data-ops-inspector={row.id}
      >
        <header className="opsw-drawer__head">
          <div className="opsw-drawer__heading">
            <div className="opsw-drawer__chips">
              <AppStatusBadge
                tone={row.severityTone}
                fill="solid"
                data-ops-severity={row.severityValue}
              >
                {row.severityLabel}
              </AppStatusBadge>
              <AppStatusBadge tone={row.statusTone} data-ops-status={row.statusValue}>
                {row.statusLabel}
              </AppStatusBadge>
            </div>
            <h2 className="app-dialog__title" id={titleId}>
              {row.title}
            </h2>
            <p className="app-dialog__subtitle">{row.statusExplanation}</p>
          </div>
          <button
            type="button"
            className="app-ghost-action"
            onClick={onClose}
            aria-label="Close condition details"
          >
            <IconClose size={16} />
          </button>
        </header>

        <div className="opsw-drawer__body">
          {/* ---------------------------------------------------------- */}
          {/* What happened                                               */}
          {/* ---------------------------------------------------------- */}
          <section className="opsw-drawer__section">
            <h3 className="opsw-drawer__section-title">What happened</h3>
            <p className="opsw-summary-text">{row.summary}</p>
            <dl className="opsw-facts">
              <Fact term="Source">{row.categoryLabel}</Fact>
              <Fact term="Severity">
                {row.severityLabel} — {row.severityExplanation}
              </Fact>
              {row.affectedLabel ? (
                <Fact term="Affected record">
                  {row.affectedHref ? (
                    <Link
                      className="app-secondary-action opsw-affected-link"
                      href={row.affectedHref}
                      data-ops-affected-link
                    >
                      <span>{row.affectedLabel}</span>
                      <IconExternal size={14} />
                    </Link>
                  ) : (
                    row.affectedLabel
                  )}
                </Fact>
              ) : null}
            </dl>
          </section>

          {/* ---------------------------------------------------------- */}
          {/* When                                                        */}
          {/* ---------------------------------------------------------- */}
          <section className="opsw-drawer__section">
            <h3 className="opsw-drawer__section-title">When</h3>
            <dl className="opsw-facts">
              <Fact term="First seen">
                {formatUserDateTime(row.firstSeenAtUtc)}{" "}
                <span className="opsw-muted">
                  ({describeRelativeTime(row.firstSeenAtUtc)})
                </span>
              </Fact>
              <Fact term="Latest occurrence">
                {formatUserDateTime(row.lastSeenAtUtc)}{" "}
                <span className="opsw-muted">
                  ({describeRelativeTime(row.lastSeenAtUtc)})
                </span>
              </Fact>
              <Fact term="Times seen">{row.occurrenceCount}</Fact>
            </dl>
          </section>

          {/* ---------------------------------------------------------- */}
          {/* Ownership                                                   */}
          {/* ---------------------------------------------------------- */}
          {capabilities.canAssign || row.owner.kind !== "unassigned" ? (
            <section className="opsw-drawer__section">
              <h3 className="opsw-drawer__section-title">Ownership</h3>
              <AssignmentControl
                incidentId={row.id}
                assignedOperatorUserId={row.assignedOperatorUserId}
                ownerDisplay={row.owner}
                canAssign={capabilities.canAssign}
                operators={operators}
                selfUserId={selfUserId}
                busy={pending}
                onAssign={onAssign}
              />
            </section>
          ) : null}

          {/* ---------------------------------------------------------- */}
          {/* History                                                     */}
          {/* ---------------------------------------------------------- */}
          <section className="opsw-drawer__section">
            <h3 className="opsw-drawer__section-title">History</h3>
            {detail.kind === "loading" ? (
              <p className="opsw-muted" role="status">
                <IconSpinner size={14} /> Loading history…
              </p>
            ) : detail.kind === "error" ? (
              // A history that failed to load is NOT an empty history, and
              // this says so rather than rendering an empty list that reads
              // as "nothing has ever happened to this".
              <p className="opsw-muted" role="alert" data-ops-timeline-error>
                {detail.message} The history could not be loaded, so what is
                shown here is not the full record.
              </p>
            ) : detail.data.timeline.length === 0 ? (
              <p className="opsw-muted">
                Nothing has happened to this condition since it opened.
              </p>
            ) : (
              <>
                <ol className="opsw-timeline" data-ops-timeline>
                  {detail.data.timeline.map((entry) => (
                    <li key={entry.id} className="opsw-timeline__item">
                      <span className="opsw-timeline__type">
                        {timelineEventLabel(entry.eventType)}
                      </span>
                      <span className="opsw-timeline__message">
                        {entry.safeMessage}
                      </span>
                      <span
                        className="opsw-timeline__when"
                        title={formatUserDateTime(entry.occurredAtUtc)}
                      >
                        {describeRelativeTime(entry.occurredAtUtc)}
                      </span>
                    </li>
                  ))}
                </ol>
                {!detail.data.timelineComplete ? (
                  <p className="opsw-muted" data-ops-timeline-truncated="true">
                    Older history exists beyond what is shown here.
                  </p>
                ) : null}
              </>
            )}
          </section>

          {/* ---------------------------------------------------------- */}
          {/* Technical references                                        */}
          {/* ---------------------------------------------------------- */}
          {detail.kind === "ready" &&
          (detail.data.requestId ||
            detail.data.traceId ||
            detail.data.relatedJobId ||
            detail.data.relatedProvider) ? (
            <section className="opsw-drawer__section">
              <h3 className="opsw-drawer__section-title">
                Technical references
              </h3>
              <p className="opsw-muted">
                Identifiers to quote if you contact support about this
                condition.
              </p>
              {detail.data.relatedProvider ? (
                <Identifier label="Provider" value={detail.data.relatedProvider} />
              ) : null}
              {detail.data.relatedJobId ? (
                <Identifier label="Job" value={detail.data.relatedJobId} />
              ) : null}
              {detail.data.requestId ? (
                <Identifier label="Request" value={detail.data.requestId} />
              ) : null}
              {detail.data.traceId ? (
                <Identifier label="Trace" value={detail.data.traceId} />
              ) : null}
            </section>
          ) : null}
        </div>

        {/* ------------------------------------------------------------ */}
        {/* Actions                                                       */}
        {/* ------------------------------------------------------------ */}
        {row.canAcknowledge || row.canResolve || row.canSuppress ? (
          <footer className="opsw-drawer__foot" data-ops-inspector-actions>
            {row.canAcknowledge ? (
              <button
                type="button"
                className="app-secondary-action"
                disabled={pending}
                onClick={onAcknowledge}
                data-ops-action="acknowledge"
              >
                Acknowledge
              </button>
            ) : null}
            {row.canResolve ? (
              <button
                type="button"
                className="app-primary-action"
                disabled={pending}
                onClick={onResolve}
                data-ops-action="resolve"
              >
                Resolve
              </button>
            ) : null}
            {row.canSuppress ? (
              <button
                type="button"
                className="app-secondary-action app-secondary-action--danger"
                disabled={pending}
                onClick={onSuppress}
                data-ops-action="suppress"
              >
                Stop notifying
              </button>
            ) : null}
          </footer>
        ) : null}
      </aside>
    </div>
  );
}

export default IncidentInspector;
