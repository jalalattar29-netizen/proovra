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
 * THE TIME COMMITMENT
 * ---------------------------------------------------------------------------
 * The commitment shown here is the workspace's OWN, resolved by the server
 * from the canonical SLA policy it publishes at `/governance/policy`, and
 * measured from instants that were actually recorded. It is rendered verbatim:
 * the browser holds no threshold of its own, because a second threshold here
 * would be a second SLA authority and the two would disagree the first time a
 * workspace edited its policy.
 *
 * `OperationalIncident` still carries NO due, breach or escalation column and
 * this adds none. The deadline is DERIVED from `firstSeenAtUtc` and the
 * current policy, so historical conditions read against the policy in force
 * now rather than against one invented for them by a backfill. A workspace
 * whose policy cannot be resolved gets no envelope and this section does not
 * render — an absent commitment is stated by absence, never by a default.
 *
 * There is also no runbook link. `runbookSlug` points into `docs/runbooks/*`,
 * which is not a tenant-reachable destination, and a link a tenant cannot open
 * is the defect this redesign removed from the page header.
 */

import * as React from "react";

import Link from "next/link";

import { AppStatusBadge } from "../../../../components/app-primitives/AppStatusBadge";
import { useConfirmAction } from "../../../../components/ui/ConfirmActionModal";
import { formatUserDateTime } from "../../../../lib/date";
import { describeRelativeTime } from "../../../../lib/relative-time";
import type {
  AssignableOperator,
  IncidentDetail,
  ProjectedRemediation,
  RemediationOutcome,
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
  showOwnership,
  operators,
  selfUserId,
  onClose,
  onAcknowledge,
  onResolve,
  onSuppress,
  onAssign,
  pending,
  remediation,
  remediationBusy,
  remediationOutcome,
  onRemediate,
}: {
  /** The row model for the condition, already in the list. */
  row: OperationsRowModel;
  /** Its history, loaded separately. */
  detail: SourceState<IncidentDetail>;
  capabilities: OperationsCapabilities;
  /**
   * Whether ownership is a real axis in this workspace.
   *
   * Server-projected from the count of eligible operators — NOT from the
   * caller's own assign capability, and NOT from whether this particular
   * condition happens to have an owner. Both of those hide "Unassigned" from
   * the reader who most needs it.
   */
  showOwnership: boolean;
  operators: ReadonlyArray<AssignableOperator>;
  selfUserId: string | null;
  onClose: () => void;
  onAcknowledge: () => void;
  onResolve: () => void;
  onSuppress: () => void;
  onAssign: (assigneeUserId: string | null) => void;
  pending: boolean;
  /**
   * What the SERVER says this caller may do about this condition.
   *
   * `null` while the detail read is in flight or after it failed. There is no
   * local fallback: a component that guesses at an action when the projection
   * is missing is a second authority, and the whole point of projecting this
   * is that there is only one.
   */
  remediation: ProjectedRemediation | null;
  /** The action id currently in flight, if any. */
  remediationBusy: string | null;
  /** The answer to the last REQUEST — never a claim about the work. */
  remediationOutcome: RemediationOutcome | null;
  onRemediate: (actionId: string) => void;
}) {
  const { confirm: confirmAction } = useConfirmAction();
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
          {/* What you can do                                             */}
          {/*                                                             */}
          {/* Rendered ONLY from the server projection. Every branch below */}
          {/* is a different honest answer, and the section is omitted     */}
          {/* entirely when there is nothing true to say — an empty        */}
          {/* "What you can do" heading reads as a missing feature.        */}
          {/* ---------------------------------------------------------- */}
          {remediation &&
          (remediation.actions.length > 0 ||
            remediation.deepLink ||
            remediation.guidance ||
            remediation.unsafeReason) ? (
            <section
              className="opsw-drawer__section"
              data-ops-remediation={remediation.disposition}
            >
              <h3 className="opsw-drawer__section-title">What you can do</h3>

              {remediation.guidance ? (
                <p className="opsw-summary-text">{remediation.guidance}</p>
              ) : null}

              {/* Why no action exists. Stated plainly, because "no button"
                  with no explanation reads as a product gap rather than a
                  deliberate refusal to assert something untrue. */}
              {remediation.unsafeReason ? (
                <p
                  className="opsw-muted opsw-remediation__unsafe"
                  data-ops-remediation-unsafe
                >
                  {remediation.unsafeReason}
                </p>
              ) : null}

              {remediation.actions.length > 0 ? (
                <div className="opsw-remediation__actions">
                  {remediation.actions.map((action) => (
                    <div key={action.actionId} className="opsw-remediation__action">
                      <button
                        type="button"
                        className="app-primary-action"
                        // Busy is per-ACTION, so a second action stays usable
                        // while one is in flight and the operator can see
                        // exactly which request they started.
                        disabled={remediationBusy !== null || pending}
                        aria-busy={remediationBusy === action.actionId}
                        data-ops-remediate={action.actionId}
                        onClick={() => {
                          // The CANONICAL confirmation surface, not the
                          // browser's. It is focus-managed, themed and
                          // announced; a native dialog is none of those and
                          // is banned app-wide for exactly that reason.
                          if (!action.confirm) {
                            onRemediate(action.actionId);
                            return;
                          }
                          void confirmAction({
                            title: action.label + "?",
                            description: action.description,
                            confirmLabel: action.label,
                            // Neutral, not danger: these actions RESUME work
                            // the record was already supposed to complete.
                            // Dressing them as destructive would misdescribe
                            // them and blunt the tone where it is real.
                            tone: "neutral",
                            testId: "ops-remediate-confirm",
                          }).then((ok) => {
                            if (ok) onRemediate(action.actionId);
                          });
                        }}
                      >
                        {remediationBusy === action.actionId ? (
                          <>
                            <IconSpinner size={14} /> Starting…
                          </>
                        ) : (
                          action.label
                        )}
                      </button>
                      <p className="opsw-muted opsw-remediation__hint">
                        {action.description}
                        {action.async ? (
                          <>
                            {" "}
                            This runs in the background; this condition closes
                            on its own once the record recovers.
                          </>
                        ) : null}
                      </p>
                    </div>
                  ))}
                </div>
              ) : null}

              {/* The answer to the REQUEST. Deliberately not phrased as a
                  completion: nothing here observed the work finish. */}
              {remediationOutcome ? (
                <p
                  className="opsw-remediation__outcome"
                  role="status"
                  aria-live="polite"
                  data-ops-remediation-result={remediationOutcome.result}
                >
                  {remediationOutcome.message}
                </p>
              ) : null}

              {remediation.deepLink ? (
                <Link
                  className="app-secondary-action opsw-affected-link"
                  href={remediation.deepLink.href}
                  data-ops-remediation-link
                >
                  <span>{remediation.deepLink.label}</span>
                  <IconExternal size={14} />
                </Link>
              ) : null}
            </section>
          ) : null}

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
              {/* The commitment, beside the instants it is measured from —
                  so the reader sees the promise and the verdict together
                  rather than a bare word like "Overdue". */}
              {row.sla ? (
                <Fact term="Time commitment">
                  <span data-ops-sla-fact={row.sla.posture}>
                    {row.sla.label}
                    {row.sla.dueAtUtc ? (
                      <>
                        {" — "}
                        {row.sla.posture === "MET" ||
                        row.sla.posture === "MET_LATE"
                          ? "was due "
                          : "due "}
                        {formatUserDateTime(row.sla.dueAtUtc)}
                      </>
                    ) : null}
                  </span>
                  <span className="opsw-muted opsw-sla-hint">
                    {row.sla.explanation}
                  </span>
                </Fact>
              ) : null}
            </dl>
          </section>

          {/* ---------------------------------------------------------- */}
          {/* Ownership                                                   */}
          {/* ---------------------------------------------------------- */}
          {showOwnership ? (
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
