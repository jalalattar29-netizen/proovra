/**
 * Phase EVIDENCE-IA-CUSTODY — Custody tab.
 *
 * Phase 1 — Custody is the SINGLE home for forensic + access event lists.
 * The Integrity tab no longer renders forensic event counts (moved to the
 * Technical Appendix in detail; Custody is the canonical timeline).
 *
 * Phase 2 — default view is grouped-by-day to avoid dumping hundreds of
 * identical "REPORT_DOWNLOADED" rows. The raw event list is still available
 * behind "Show raw events" inside each timeline.
 *
 * Phase EVIDENCE-DETAIL-REDESIGN — presentation only. Custody owns its own
 * timeline presentation instead of borrowing the generic
 * SectionHeading/item-row set from _lib, so a change here cannot ripple into
 * the other six tabs. The two timelines stay SEMANTICALLY SEPARATE: separate
 * cards, separate grouping passes, separate raw-event disclosures, and a
 * purple rail for the forensic lifecycle against a neutral rail for access.
 * No event, count, timestamp or permission rule was changed.
 */

"use client";

import { useMemo } from "react";
import { Eye, History, type LucideIcon } from "lucide-react";
import type { EvidenceDetailCtx } from "./_lib";
import type { TimelineEvent } from "../review-workspace-types";
import { OperationalTimelinePanel } from "../../../../../components/operational";
import { formatUserDateTime } from "../../../../../lib/date";

/**
 * One day bucket: the ISO day key, the total number of events that fell in
 * it, and one row per event TYPE carrying its own count and most recent
 * timestamp. Both timelines use this same shape so the row anatomy is
 * identical; only the rail tone differs.
 */
type DayGroup = {
  day: string;
  total: number;
  rows: Array<{ type: string; count: number; lastAtUtc: string }>;
};

function groupByDay(events: TimelineEvent[]): DayGroup[] {
  const buckets = new Map<string, Map<string, { count: number; lastAtUtc: string }>>();

  for (const ev of events) {
    // Day key derived from atUtc; falls back to "Undated" if the event has no
    // timestamp. The ISO date prefix (YYYY-MM-DD) is stable and sortable.
    const day = ev.atUtc?.slice(0, 10) || "Undated";
    const byType = buckets.get(day) ?? new Map();
    const prev = byType.get(ev.eventType);
    byType.set(ev.eventType, {
      count: (prev?.count ?? 0) + 1,
      lastAtUtc:
        prev?.lastAtUtc && prev.lastAtUtc > (ev.atUtc ?? "")
          ? prev.lastAtUtc
          : (ev.atUtc ?? ""),
    });
    buckets.set(day, byType);
  }

  // Days descending (newest first).
  return Array.from(buckets.entries())
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([day, byType]) => ({
      day,
      total: Array.from(byType.values()).reduce((sum, b) => sum + b.count, 0),
      rows: Array.from(byType.entries()).map(([type, b]) => ({
        type,
        count: b.count,
        lastAtUtc: b.lastAtUtc,
      })),
    }));
}

function formatDayTitle(day: string): string {
  if (day === "Undated") return "Undated";
  return formatUserDateTime(`${day}T00:00:00Z`)?.split(",")[0] ?? day;
}

/** Time + timezone only — the day already heads the group. */
function formatEventTime(atUtc: string | null | undefined): string {
  const full = atUtc ? formatUserDateTime(atUtc) : null;
  if (!full) return "Time not recorded";
  const parts = full.split(", ");
  return parts.length > 1 ? parts.slice(1).join(", ") : full;
}

/**
 * One timeline card. `tone` drives the rail and day marker only — it carries
 * no meaning beyond distinguishing the two chronologies from each other.
 */
function EventTimelineCard({
  title,
  description,
  events,
  icon: Icon,
  tone,
  emptyMessage,
  testid,
}: {
  title: string;
  description: string;
  events: TimelineEvent[];
  icon: LucideIcon;
  tone: "forensic" | "access";
  emptyMessage: string;
  testid: string;
}) {
  const groups = useMemo(() => groupByDay(events), [events]);

  return (
    <section
      className="evidence-detail-timeline-card"
      data-evidence-timeline={testid}
      data-timeline-tone={tone}
    >
      <div className="evidence-detail-timeline-card__head">
        <span className="evidence-detail-timeline-card__icon" aria-hidden="true">
          <Icon size={20} strokeWidth={2} />
        </span>
        <h2 className="evidence-detail-timeline-card__title">{title}</h2>
      </div>
      <p className="evidence-detail-timeline-card__description">{description}</p>

      {events.length === 0 ? (
        <p
          className="evidence-detail-timeline-empty"
          data-evidence-timeline-empty={testid}
        >
          {emptyMessage}
        </p>
      ) : (
        <div className="evidence-detail-chrono" data-grouped-timeline>
          {groups.map((group) => (
            <article
              key={group.day}
              className="evidence-detail-chrono-day"
              data-chrono-day={group.day}
            >
              <div className="evidence-detail-chrono-day__head">
                <span className="evidence-detail-chrono-marker" aria-hidden="true" />
                <h3 className="evidence-detail-chrono-day__title">
                  {formatDayTitle(group.day)}
                </h3>
                <span className="evidence-detail-chrono-day__total">
                  {group.total} {group.total === 1 ? "event" : "events"}
                </span>
              </div>
              <ul className="evidence-detail-chrono-rows">
                {group.rows.map((row) => (
                  <li key={row.type} className="evidence-detail-chrono-row">
                    <span className="evidence-detail-chrono-row__rail" aria-hidden="true" />
                    <span className="evidence-detail-chrono-row__label">
                      {row.type.replace(/_/g, " ")}
                      <span className="evidence-detail-chrono-row__count">
                        {" "}
                        &times; {row.count}
                      </span>
                    </span>
                    <span className="evidence-detail-chrono-row__time">
                      {formatEventTime(row.lastAtUtc)}
                    </span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      )}

      {/* The raw list stays available for every reader who can see the
          grouped view: grouping is a readability default, not a redaction.
          <details> keeps the native disclosure semantics and keyboard
          behaviour that the previous build relied on. */}
      {events.length > 0 ? (
        <details
          className="evidence-detail-raw-disclosure"
          data-grouped-timeline-raw
          data-evidence-raw-events={testid}
        >
          <summary className="evidence-detail-raw-summary">Show raw events</summary>
          <ul className="evidence-detail-raw-list">
            {events.map((event) => (
              <li
                key={`${event.sequence}-${event.eventType}`}
                className="evidence-detail-raw-row"
              >
                <div className="evidence-detail-raw-row__head">
                  <span className="evidence-detail-raw-row__label">
                    {event.eventType.replace(/_/g, " ")}
                  </span>
                  <span className="evidence-detail-raw-row__time">
                    {formatUserDateTime(event.atUtc) ?? "Time not recorded"}
                  </span>
                </div>
                <p className="evidence-detail-raw-row__summary">
                  {event.payloadSummary || "No event summary recorded."}
                </p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

export function EvidenceCustodyTab({ ctx }: { ctx: EvidenceDetailCtx }) {
  const { workspace, evidenceId, canSeeReviewerOps } = ctx;

  return (
    <>
      <EventTimelineCard
        title="Forensic Custody"
        description="Integrity-relevant lifecycle chronology — grouped by day"
        events={workspace.custodyLifecycle.forensicEvents}
        icon={History}
        tone="forensic"
        emptyMessage="No forensic custody events are recorded in the current response."
        testid="forensic"
      />

      <EventTimelineCard
        title="Access Activity"
        description="Viewing, download, and verification access — grouped by day"
        events={workspace.custodyLifecycle.accessEvents}
        icon={Eye}
        tone="access"
        emptyMessage="No access activity is recorded in the current response."
        testid="access"
      />

      {canSeeReviewerOps && workspace.reviewWorkflow?.teamId ? (
        <OperationalTimelinePanel
          evidenceId={evidenceId}
          teamId={workspace.reviewWorkflow.teamId}
        />
      ) : null}
    </>
  );
}
