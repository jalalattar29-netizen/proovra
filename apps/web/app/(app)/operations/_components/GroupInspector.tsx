"use client";

/**
 * Operations workbench — THE GROUP INSPECTOR AND ITS DRILL-DOWN.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DRILL-DOWN IS THE POINT
 * ---------------------------------------------------------------------------
 * Grouping five thousand per-record conditions into one row is only honest if
 * the five thousand records are still reachable. Each one is a DIFFERENT
 * record that somebody has to fix — that is precisely why the integrity
 * conditions are per-record and why collapsing them into a count was retracted
 * once already.
 *
 * So this panel does two things: it says what the group is, and it pages
 * through its members. The paging is the server's keyset cursor, so an
 * operator can traverse every authorized row without the queue ever having
 * rendered them all at once.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES NOT OFFER
 * ---------------------------------------------------------------------------
 * There is no bulk Resolve. Source-truth conditions close themselves when the
 * source recovers, so a control that closed thirty of them by hand would be
 * both unsafe and unnecessary; the existing bulk Acknowledge, Suppress and
 * Assign are unchanged and still live on the flat queue where a selection can
 * be made deliberately.
 */

import * as React from "react";

import Link from "next/link";

import { AppStatusBadge } from "../../../../components/app-primitives/AppStatusBadge";
import { describeRelativeTime } from "../../../../lib/relative-time";
import { formatUserDateTime } from "../../../../lib/date";
import type {
  AffectedRecord,
  IncidentGroup,
  IncidentSeverity,
  IncidentStatus,
} from "../_lib/types";
import { SEVERITY_VOCABULARY, STATUS_VOCABULARY, categoryLabel } from "../_lib/vocabulary";
import { IconClose, IconExternal, IconSpinner } from "./icons";

export function GroupInspector({
  group,
  records,
  loading,
  error,
  hasMore,
  onLoadMore,
  onClose,
  canOpenRecords,
}: {
  group: IncidentGroup;
  /** The pages loaded so far, concatenated. */
  records: ReadonlyArray<AffectedRecord>;
  loading: boolean;
  /** A bounded, already-safe message. Never a raw transport error. */
  error: string | null;
  hasMore: boolean;
  onLoadMore: () => void;
  onClose: () => void;
  /**
   * May this reader open an individual Evidence record?
   *
   * Server-projected. A link the reader cannot follow is withheld rather than
   * rendered and refused — the same rule the condition inspector's deep links
   * already follow.
   */
  canOpenRecords: boolean;
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
      // Focus returns to whatever opened this, so a keyboard user is not
      // stranded at the top of a five-thousand-row page.
      restoreRef.current?.focus?.();
    };
  }, [onClose]);

  const severity =
    SEVERITY_VOCABULARY[group.severity as IncidentSeverity] ?? SEVERITY_VOCABULARY.INFO;
  const status =
    STATUS_VOCABULARY[group.statusPosture as IncidentStatus] ?? STATUS_VOCABULARY.OPEN;

  return (
    <div
      className="opsw-drawer-overlay"
      onClick={onClose}
      data-ops-group-inspector-overlay
    >
      <aside
        ref={panelRef}
        className="opsw-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        data-ops-group-inspector={group.groupKey}
      >
        <header className="opsw-drawer__head">
          <div className="opsw-drawer__heading">
            <div className="opsw-drawer__chips">
              <AppStatusBadge tone={severity.tone} fill="solid">
                {severity.label}
              </AppStatusBadge>
              <AppStatusBadge tone={status.tone}>{status.label}</AppStatusBadge>
            </div>
            <h2 id={titleId} className="opsw-drawer__title">
              {group.title}
            </h2>
          </div>
          <button
            type="button"
            className="app-ghost-action opsw-drawer__close"
            onClick={onClose}
            aria-label="Close"
          >
            <IconClose />
          </button>
        </header>

        <div className="opsw-drawer__body">
          <section className="opsw-drawer__section">
            <h3 className="opsw-drawer__section-title">What this is</h3>
            <dl className="opsw-facts">
              <div className="opsw-fact">
                <dt>Source</dt>
                <dd>
                  <span className="opsw-muted">{categoryLabel(group.category)}</span>
                </dd>
              </div>
              {/*
                THE EXACT NUMBERS. The queue row bounds them for display; this
                is where somebody has stopped to look at one group, so the last
                three digits are shown.
              */}
              <div className="opsw-fact">
                <dt>Conditions</dt>
                <dd data-ops-group-exact-conditions={group.conditionCount}>
                  {group.conditionCount.toLocaleString("en-US")}
                </dd>
              </div>
              {group.affectedRecordCount != null ? (
                <div className="opsw-fact">
                  <dt>Affected {group.metric?.unit ?? "records"}</dt>
                  <dd data-ops-group-exact-affected={group.affectedRecordCount}>
                    {group.affectedRecordCount.toLocaleString("en-US")}
                  </dd>
                </div>
              ) : null}
              <div className="opsw-fact">
                <dt>First seen</dt>
                <dd>
                  {formatUserDateTime(group.firstSeenAtUtc)}{" "}
                  <span className="opsw-muted">
                    ({describeRelativeTime(group.firstSeenAtUtc)})
                  </span>
                </dd>
              </div>
              <div className="opsw-fact">
                <dt>Last seen</dt>
                <dd>
                  {formatUserDateTime(group.latestActivityAtUtc)}{" "}
                  <span className="opsw-muted">
                    ({describeRelativeTime(group.latestActivityAtUtc)})
                  </span>
                </dd>
              </div>
            </dl>
          </section>

          {/* ---------------------------------------------------------- */}
          {/* THE AFFECTED RECORDS                                        */}
          {/* ---------------------------------------------------------- */}
          <section className="opsw-drawer__section" data-ops-affected-section>
            <h3 className="opsw-drawer__section-title">Affected records</h3>

            {error ? (
              <p className="opsw-summary-text" data-ops-affected-error>
                {error}
              </p>
            ) : null}

            {records.length === 0 && !loading && !error ? (
              <p className="opsw-summary-text">
                No individual records to show for this group.
              </p>
            ) : null}

            <ul className="opsw-affected" data-ops-affected-list>
              {records.map((r) => (
                <li
                  key={r.conditionId}
                  className="opsw-affected__row"
                  data-ops-affected-row={r.conditionId}
                >
                  <span className="opsw-affected__title">{r.title}</span>
                  <span className="opsw-affected__meta">
                    <AppStatusBadge
                      tone={
                        (SEVERITY_VOCABULARY[r.severity as IncidentSeverity] ??
                          SEVERITY_VOCABULARY.INFO).tone
                      }
                    >
                      {(SEVERITY_VOCABULARY[r.severity as IncidentSeverity] ??
                        SEVERITY_VOCABULARY.INFO).label}
                    </AppStatusBadge>
                    <span aria-hidden="true">·</span>
                    <span title={formatUserDateTime(r.firstSeenAtUtc)}>
                      {describeRelativeTime(r.firstSeenAtUtc)}
                    </span>
                    {r.assignedOperatorUserId ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>owned</span>
                      </>
                    ) : null}
                    {/*
                      A link only where there IS a record and the reader may
                      open it. A per-record integrity condition names its
                      Evidence; an aggregate condition names nothing, and a
                      link to nowhere is worse than no link.
                    */}
                    {r.evidenceId && canOpenRecords ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <Link
                          href={`/evidence/${encodeURIComponent(r.evidenceId)}`}
                          className="opsw-affected__link"
                          data-ops-affected-link={r.evidenceId}
                        >
                          Open record <IconExternal />
                        </Link>
                      </>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>

            {loading ? (
              <p className="opsw-summary-text" data-ops-affected-loading>
                <IconSpinner /> Loading affected records…
              </p>
            ) : null}

            {hasMore && !loading ? (
              <button
                type="button"
                className="app-secondary-action"
                onClick={onLoadMore}
                data-ops-affected-more
              >
                View more affected records
              </button>
            ) : null}
          </section>
        </div>
      </aside>
    </div>
  );
}

export default GroupInspector;
