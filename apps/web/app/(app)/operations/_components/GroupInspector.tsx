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
 * OPS-012 — EVERY MEMBER OPENS ITS CONDITION. The drawer used to offer only
 * "Close": in the default Grouped view a report failure's group showed counts
 * and no route to the condition that carries the recovery action. Each member
 * now opens the condition drawer, where the source's canonical action lives,
 * and a group of one offers that directly in its header.
 *
 * There is no bulk Resolve. Source-truth conditions close themselves when the
 * source recovers, so a control that closed thirty of them by hand would be
 * both unsafe and unnecessary; the existing bulk Acknowledge, Suppress and
 * Assign are unchanged and still live on the flat queue where a selection can
 * be made deliberately.
 */

import * as React from "react";

import Link from "next/link";

import { AppStatusBadge } from "../../../../components/app-primitives/AppStatusBadge";
import { formatUserDateTime } from "../../../../lib/date";
import type {
  AffectedRecord,
  IncidentGroup,
  IncidentSeverity,
  IncidentStatus,
} from "../_lib/types";
import { categoryLabel, severityEntry, statusEntry } from "../_lib/vocabulary";
import { IconClose, IconExternal, IconSpinner } from "./icons";
import { useDialogFocusTrap } from "../../../../components/ui/useDialogFocusTrap";
import { fillOperationsCopy, useOpsCopy, useOpsLocale, useOpsNumber, useOpsTime } from "../_lib/copy";
import { localizedGroupTitle, localizedRecordTitle } from "../_lib/groupTitle";
import { conditionSubjectLabel } from "@proovra/shared/i18n";

export function GroupInspector({
  group,
  records,
  loading,
  error,
  hasMore,
  onLoadMore,
  onClose,
  canOpenRecords,
  onOpenCondition,
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
   * Server-projected (D15, 2026-10-12): the envelope's EVIDENCE_VIEW
   * capability for this workspace. Operations access alone does not grant
   * evidence read, so a link the reader cannot follow is withheld rather than
   * rendered and refused.
   */
  canOpenRecords: boolean;
  /** OPS-012 — open one member's condition drawer (where its action is). */
  onOpenCondition: (conditionId: string) => void;
}) {
  const panelRef = React.useRef<HTMLElement | null>(null);
  const titleId = React.useId();
  const copy = useOpsCopy();
  const locale = useOpsLocale();
  const fmt = useOpsNumber();
  const time = useOpsTime();

  // OPS-020 — the shared focus contract: into the drawer, trapped, Escape
  // closes, back to the group row that opened it.
  useDialogFocusTrap(panelRef, onClose);

  // A group of ONE is that condition: its header offers it directly.
  const soleConditionId =
    group.conditionCount === 1
      ? (records[0]?.conditionId ?? group.affectedSample[0]?.conditionId ?? null)
      : null;

  const severity = severityEntry(group.severity as IncidentSeverity, copy);
  const status = statusEntry(group.statusPosture as IncidentStatus, copy);

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
              {localizedGroupTitle(group, locale)}
            </h2>
          </div>
          <button
            type="button"
            className="app-ghost-action opsw-drawer__close"
            onClick={onClose}
            aria-label={copy.closeGroup}
            data-dialog-initial-focus
          >
            <IconClose />
          </button>
        </header>
        {soleConditionId ? (
          <div className="opsw-drawer__lead-action">
            <button
              type="button"
              className="app-primary-action"
              onClick={() => onOpenCondition(soleConditionId)}
              data-ops-group-open-condition={soleConditionId}
            >
              {copy.openCondition}
            </button>
          </div>
        ) : null}

        <div className="opsw-drawer__body">
          <section className="opsw-drawer__section">
            <h3 className="opsw-drawer__section-title">{copy.group.whatThisIs}</h3>
            <dl className="opsw-facts">
              <div className="opsw-fact">
                <dt>{copy.drawer.factSource}</dt>
                <dd>
                  <span className="opsw-muted">{categoryLabel(group.category, copy)}</span>
                </dd>
              </div>
              {/*
                THE EXACT NUMBERS. The queue row bounds them for display; this
                is where somebody has stopped to look at one group, so the last
                three digits are shown.
              */}
              <div className="opsw-fact">
                <dt>{copy.group.factConditions}</dt>
                <dd data-ops-group-exact-conditions={group.conditionCount}>
                  {fmt(group.conditionCount)}
                </dd>
              </div>
              {group.affectedRecordCount != null ? (
                <div className="opsw-fact">
                  {/* The SOURCE's unit. The retry-storm group counts
                      conditions, and calling those records would send an
                      operator looking for evidence that does not exist. */}
                  <dt>
                    {fillOperationsCopy(copy.group.factAffected, {
                      unit:
                        (copy.group.unitWord as Record<string, string | undefined>)[
                          group.affectedUnit ?? "records"
                        ] ?? (group.affectedUnit ?? copy.group.unitWord.records),
                    })}
                  </dt>
                  <dd data-ops-group-exact-affected={group.affectedRecordCount}>
                    {fmt(group.affectedRecordCount)}
                  </dd>
                </div>
              ) : null}
              {group.metric && group.metric.contract === "AGGREGATE_THRESHOLD" ? (
                <div className="opsw-fact">
                  {/* SEPARATE from the count, because "26" is not actionable
                      without the number it is measured against. */}
                  <dt>{copy.drawer.factThreshold}</dt>
                  <dd data-ops-group-exact-threshold={group.metric.thresholdValue}>
                    {fmt(group.metric.thresholdValue)}
                    {group.metric.criticalThresholdValue != null ? (
                      <span className="opsw-muted">
                        {" "}
                        {fillOperationsCopy(copy.drawer.criticalAt, {
                          n: fmt(group.metric.criticalThresholdValue),
                        })}
                      </span>
                    ) : null}
                  </dd>
                </div>
              ) : null}
              {group.durationSeconds != null ? (
                <div className="opsw-fact">
                  {/* An elapsed span, in words. The raw "902m" this replaces
                      was a number nobody reads fifteen hours out of. */}
                  <dt>{copy.group.factElapsed}</dt>
                  <dd data-ops-group-exact-duration={group.durationSeconds}>
                    {time.span(group.durationSeconds)}
                  </dd>
                </div>
              ) : null}
              {/*
                THE THIRD NUMBER, kept out of the queue row and named here.

                How many times the sweep looked and found the condition still
                true — not how many things are affected, and not how many
                conditions the group holds.
              */}
              <div className="opsw-fact">
                <dt>{copy.drawer.factSourceObservations}</dt>
                <dd data-ops-group-observations={group.observations}>
                  {copy.observedInChecks.replace("{n}", fmt(group.observations))}
                </dd>
              </div>
              {group.metric?.stale ? (
                <div className="opsw-fact">
                  <dt>{copy.group.factMetricFreshness}</dt>
                  <dd data-ops-group-metric-stale="true">
                    {fillOperationsCopy(copy.group.metricFreshnessNote, {
                      when: formatUserDateTime(group.metric.observedAtUtc),
                    })}
                  </dd>
                </div>
              ) : null}
              <div className="opsw-fact">
                <dt>{copy.drawer.factFirstSeen}</dt>
                <dd>
                  {formatUserDateTime(group.firstSeenAtUtc)}{" "}
                  <span className="opsw-muted">
                    ({time.ago(group.firstSeenAtUtc)})
                  </span>
                </dd>
              </div>
              <div className="opsw-fact">
                <dt>{copy.group.factLastSeen}</dt>
                <dd>
                  {formatUserDateTime(group.latestActivityAtUtc)}{" "}
                  <span className="opsw-muted">
                    ({time.ago(group.latestActivityAtUtc)})
                  </span>
                </dd>
              </div>
            </dl>
          </section>

          {/* ---------------------------------------------------------- */}
          {/* THE AFFECTED RECORDS                                        */}
          {/* ---------------------------------------------------------- */}
          <section className="opsw-drawer__section" data-ops-affected-section>
            <h3 className="opsw-drawer__section-title">{copy.group.affectedHeading}</h3>

            {error ? (
              <p className="opsw-summary-text" data-ops-affected-error>
                {error}
              </p>
            ) : null}

            {records.length === 0 && !loading && !error ? (
              <p className="opsw-summary-text">{copy.group.noRecords}</p>
            ) : null}

            <ul className="opsw-affected" data-ops-affected-list>
              {records.map((r) => (
                <li
                  key={r.conditionId}
                  className="opsw-affected__row"
                  data-ops-affected-row={r.conditionId}
                >
                  <span className="opsw-affected__title">{localizedRecordTitle(r, locale)}</span>
                  {/* WHAT this member is about, confirmed for this workspace by
                      the server — never a signal code. */}
                  {conditionSubjectLabel(locale, r.subject ?? null) ? (
                    <span className="opsw-affected__subject opsw-muted" data-ops-affected-subject={r.subject!.state}>
                      {conditionSubjectLabel(locale, r.subject ?? null)}
                    </span>
                  ) : null}
                  <span className="opsw-affected__meta">
                    <AppStatusBadge tone={severityEntry(r.severity, copy).tone}>
                      {severityEntry(r.severity, copy).label}
                    </AppStatusBadge>
                    <span aria-hidden="true">·</span>
                    {/* OPS-012 — each member's OWN current state. */}
                    <span data-ops-affected-status={r.status}>
                      {statusEntry(r.status, copy).label}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span title={formatUserDateTime(r.firstSeenAtUtc)}>
                      {time.ago(r.firstSeenAtUtc)}
                    </span>
                    {r.assignedOperatorUserId ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{copy.group.owned}</span>
                      </>
                    ) : null}
                    <span aria-hidden="true">·</span>
                    <button
                      type="button"
                      className="app-ghost-action opsw-affected__open"
                      onClick={() => onOpenCondition(r.conditionId)}
                      aria-label={`${copy.openCondition}: ${localizedRecordTitle(r, locale)}`}
                      data-ops-affected-open={r.conditionId}
                    >
                      {copy.openCondition}
                    </button>
                    {/*
                      A link only where there IS a record and the reader may
                      open it. A per-record integrity condition names its
                      Evidence; an aggregate condition names nothing, and a
                      link to nowhere is worse than no link.
                    */}
                    {r.evidenceId && canOpenRecords && r.subject?.state !== "UNAVAILABLE" ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <Link
                          href={`/evidence/${encodeURIComponent(r.evidenceId)}`}
                          className="opsw-affected__link"
                          data-ops-affected-link={r.evidenceId}
                        >
                          {copy.group.openRecord} <IconExternal />
                        </Link>
                      </>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>

            {loading ? (
              <p className="opsw-summary-text" data-ops-affected-loading>
                <IconSpinner /> {copy.group.loadingAffected}
              </p>
            ) : null}

            {hasMore && !loading ? (
              <button
                type="button"
                className="app-secondary-action"
                onClick={onLoadMore}
                data-ops-affected-more
              >
                {copy.group.viewMore}
              </button>
            ) : null}
          </section>
        </div>
      </aside>
    </div>
  );
}

export default GroupInspector;
