"use client";

/**
 * Phase 28-G — Operational Activity Timeline panel.
 *
 * Consumes `GET /v1/evidence/:id/operational-timeline` (Phase 28-D).
 * Renders a dense chronological feed of lifecycle / review /
 * incident events.
 *
 * Hard contracts:
 *   - Never invents events. Every row comes from a real backend row.
 *   - Never renders private review notes / decision-note bodies /
 *     legal-note bodies. The timeline endpoint already strips them.
 *   - Empty state uses the bounded `NoOperationalTimelineEmptyState`.
 *   - On API failure: renders unknown state (never claims "no
 *     activity" when the read itself failed).
 */

import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import { useEffect, useState } from "react";

import { apiFetch } from "../../lib/api";
import { NoOperationalTimelineEmptyState } from "./OperationalEmptyState";
import { OPS_INK, OPS_SEVERITY_DOT, OPS_SURFACE, OPS_TONES } from "./tokens";

type TimelineEntry = {
  id: string;
  kind: "lifecycle" | "review" | "incident";
  eventType: string;
  label: string;
  severity: "INFO" | "WARNING" | "HIGH" | "CRITICAL";
  occurredAtUtc: string;
  actorUserId: string | null;
  safeSummary: string | null;
};

type OperationalTimeline = {
  evidenceId: string;
  teamId: string;
  generatedAtUtc: string;
  entries: TimelineEntry[];
};

const SEVERITY_DOT_COLOR: Record<TimelineEntry["severity"], string> =
  OPS_SEVERITY_DOT;

const KIND_LABEL: Record<TimelineEntry["kind"], string> = {
  lifecycle: "Lifecycle",
  review: "Review",
  incident: "Incident",
};

/**
 * Phase 28-J — governance/incident event-type recognition. Drives the
 * "highlight" treatment on the timeline so legal-hold / retention /
 * immutable-drift / package-blocked rows visually dominate ordinary
 * lifecycle ticks.
 *
 * Matches by stable prefix of the canonical eventType. Never matches by
 * free-text fields — those can be locale-translated or rephrased.
 */
function isGovernanceEvent(entry: TimelineEntry): boolean {
  const t = entry.eventType.toUpperCase();
  return (
    t.startsWith("LEGAL_HOLD_") ||
    t.startsWith("CASE_LEGAL_HOLD_") ||
    t.startsWith("RETENTION_") ||
    t.startsWith("DESTRUCTION_") ||
    t.startsWith("IMMUTABLE_") ||
    t.startsWith("EXPORT_BLOCKED") ||
    t.startsWith("PACKAGE_BLOCKED") ||
    t.startsWith("LIFECYCLE_") ||
    t.startsWith("GOVERNANCE_")
  );
}

function isLifecycleTransition(entry: TimelineEntry): boolean {
  return (
    entry.kind === "lifecycle" ||
    entry.eventType.toUpperCase().includes("ASSIGN") ||
    entry.eventType.toUpperCase().includes("ESCALAT") ||
    entry.eventType.toUpperCase().includes("RESOLVE") ||
    entry.eventType.toUpperCase().includes("ACKNOWLEDG") ||
    entry.eventType.toUpperCase().includes("SUPPRESS") ||
    entry.eventType.toUpperCase().includes("BREACH")
  );
}

function dateBucket(iso: string): string {
  // YYYY-MM-DD grouping. UTC bucket keeps grouping stable across
  // user-side TZ changes.
  return iso.slice(0, 10);
}

function bucketLabel(bucket: string): string {
  const today = new Date().toISOString().slice(0, 10);
  if (bucket === today) return "Today";
  const yesterday = new Date(Date.now() - 24 * 60 * 60_000)
    .toISOString()
    .slice(0, 10);
  if (bucket === yesterday) return "Yesterday";
  // Stable absolute fallback. Local format would drift in tests.
  return bucket;
}

function formatRelative(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const diffMs = Date.now() - then;
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return iso.slice(0, 10);
}

export type OperationalTimelinePanelProps = {
  evidenceId: string;
  teamId: string;
  limit?: number;
};

export function OperationalTimelinePanel({
  evidenceId,
  teamId,
  limit = 50,
}: OperationalTimelinePanelProps) {
  const [timeline, setTimeline] = useState<OperationalTimeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const data = (await apiFetch(
          `/v1/evidence/${encodeURIComponent(evidenceId)}/operational-timeline?teamId=${encodeURIComponent(teamId)}&limit=${limit}`,
        )) as OperationalTimeline;
        if (!cancelled) {
          setTimeline(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setTimeline(null);
          const e = err as { message?: string };
          setError(toSafeUserError(e, { message: "timeline_unavailable" }).message);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [evidenceId, teamId, limit]);

  // FAIL-CLOSED: when the API fails, render unknown state. Never
  // claim "no activity" — that would be silently wrong.
  if (!loading && error) {
    return (
      <div
        role="status"
        data-timeline-state="unavailable"
        style={{
          border: `1px solid ${OPS_TONES.unknown.border}`,
          background: OPS_TONES.unknown.bg,
          borderRadius: 8,
          padding: 14,
          fontSize: 13,
          color: OPS_TONES.unknown.ink,
          fontWeight: 500,
        }}
      >
        Operational timeline could not be loaded. The platform is failing closed
        — assume activity exists until the timeline is available.
      </div>
    );
  }
  if (loading || !timeline) {
    return (
      <div
        role="status"
        aria-busy="true"
        style={{
          padding: 12,
          color: OPS_INK.muted,
          fontSize: 13,
        }}
      >
        Loading operational activity…
      </div>
    );
  }
  if (timeline.entries.length === 0) {
    return <NoOperationalTimelineEmptyState />;
  }

  // Phase 28-J — group entries by UTC date so the operator can scan a
  // workflow's lifecycle by day. Inside a bucket, entries retain the
  // backend order (newest first per the timeline service).
  const buckets: Array<{ key: string; entries: TimelineEntry[] }> = [];
  for (const entry of timeline.entries) {
    const key = dateBucket(entry.occurredAtUtc);
    const last = buckets[buckets.length - 1];
    if (last && last.key === key) {
      last.entries.push(entry);
    } else {
      buckets.push({ key, entries: [entry] });
    }
  }

  return (
    <div
      data-operational-timeline
      data-evidence-id={timeline.evidenceId}
      data-bucket-count={buckets.length}
      style={{ display: "flex", flexDirection: "column", gap: 14 }}
    >
      {buckets.map((bucket) => (
        <section
          key={bucket.key}
          data-timeline-bucket={bucket.key}
          aria-label={`Activity on ${bucketLabel(bucket.key)}`}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              marginBottom: 6,
            }}
          >
            <strong
              style={{
                fontSize: 11,
                letterSpacing: 0.5,
                textTransform: "uppercase",
                color: OPS_INK.subtle,
                fontWeight: 700,
              }}
            >
              {bucketLabel(bucket.key)}
            </strong>
            <span
              style={{
                fontSize: 11,
                color: OPS_INK.subtle,
                fontWeight: 600,
              }}
            >
              {bucket.entries.length}{" "}
              {bucket.entries.length === 1 ? "event" : "events"}
            </span>
          </div>
          <ol
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: 6,
              borderLeft: `1px solid ${OPS_SURFACE.border}`,
            }}
          >
            {bucket.entries.map((entry) => {
              const governance = isGovernanceEvent(entry);
              const lifecycle = isLifecycleTransition(entry);
              const critical =
                entry.severity === "CRITICAL" || entry.severity === "HIGH";
              // Background emphasis: governance OR high/critical
              // severity → tinted card; otherwise transparent.
              const rowBg =
                entry.severity === "CRITICAL"
                  ? OPS_TONES.critical.bg
                  : governance
                    ? OPS_TONES.warning.bg
                    : entry.severity === "HIGH"
                      ? OPS_TONES.high.bg
                      : "transparent";
              const rowBorder =
                entry.severity === "CRITICAL"
                  ? OPS_TONES.critical.border
                  : governance
                    ? OPS_TONES.warning.border
                    : entry.severity === "HIGH"
                      ? OPS_TONES.high.border
                      : "transparent";
              return (
                <li
                  key={entry.id}
                  data-timeline-entry-id={entry.id}
                  data-event-type={entry.eventType}
                  data-governance={governance ? "true" : "false"}
                  data-lifecycle={lifecycle ? "true" : "false"}
                  data-severity={entry.severity}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "12px 1fr auto",
                    gap: 12,
                    alignItems: "flex-start",
                    padding: critical || governance ? "8px 12px" : "6px 12px 6px 0",
                    background: rowBg,
                    border:
                      critical || governance
                        ? `1px solid ${rowBorder}`
                        : "none",
                    borderRadius: critical || governance ? 6 : 0,
                    marginLeft: critical || governance ? -2 : 0,
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 9,
                      height: 9,
                      borderRadius: 9,
                      background: SEVERITY_DOT_COLOR[entry.severity],
                      marginTop: 6,
                      marginLeft: -4,
                      border: `2px solid ${OPS_SURFACE.card}`,
                      boxShadow: `0 0 0 1px ${OPS_SURFACE.border}`,
                    }}
                  />
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <div
                      style={{
                        fontSize: 13,
                        color:
                          entry.severity === "CRITICAL"
                            ? OPS_TONES.critical.ink
                            : OPS_INK.default,
                        fontWeight: critical || governance ? 700 : 600,
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        flexWrap: "wrap",
                      }}
                    >
                      {entry.label}
                      {governance ? (
                        <span
                          data-tag="governance"
                          style={{
                            fontSize: 9,
                            letterSpacing: 0.5,
                            fontWeight: 700,
                            textTransform: "uppercase",
                            color: OPS_TONES.warning.kicker,
                            background: OPS_TONES.warning.bg,
                            border: `1px solid ${OPS_TONES.warning.border}`,
                            padding: "1px 6px",
                            borderRadius: 4,
                          }}
                        >
                          Governance
                        </span>
                      ) : null}
                      {lifecycle && !governance ? (
                        <span
                          data-tag="lifecycle"
                          style={{
                            fontSize: 9,
                            letterSpacing: 0.5,
                            fontWeight: 700,
                            textTransform: "uppercase",
                            color: OPS_TONES.info.kicker,
                            background: OPS_TONES.info.bg,
                            border: `1px solid ${OPS_TONES.info.border}`,
                            padding: "1px 6px",
                            borderRadius: 4,
                          }}
                        >
                          Lifecycle
                        </span>
                      ) : null}
                    </div>
                    {entry.safeSummary ? (
                      <div
                        style={{
                          fontSize: 12,
                          color:
                            entry.severity === "CRITICAL"
                              ? OPS_TONES.critical.inkMuted
                              : OPS_INK.muted,
                          lineHeight: 1.45,
                        }}
                      >
                        {entry.safeSummary}
                      </div>
                    ) : null}
                    <div
                      style={{
                        fontSize: 11,
                        color: OPS_INK.subtle,
                        marginTop: 2,
                        display: "flex",
                        gap: 8,
                      }}
                    >
                      <span>{KIND_LABEL[entry.kind]}</span>
                      <span>·</span>
                      <span>{entry.eventType}</span>
                      {entry.actorUserId ? (
                        <>
                          <span>·</span>
                          <span title={`actor ${entry.actorUserId}`}>
                            actor {entry.actorUserId.slice(0, 8)}
                          </span>
                        </>
                      ) : null}
                      <span>·</span>
                      <span
                        data-severity-tag={entry.severity}
                        style={{
                          fontWeight: 700,
                          color:
                            entry.severity === "CRITICAL"
                              ? OPS_TONES.critical.kicker
                              : entry.severity === "HIGH"
                                ? OPS_TONES.high.kicker
                                : entry.severity === "WARNING"
                                  ? OPS_TONES.warning.kicker
                                  : OPS_INK.subtle,
                        }}
                      >
                        {entry.severity}
                      </span>
                    </div>
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: OPS_INK.subtle,
                      whiteSpace: "nowrap",
                    }}
                    title={entry.occurredAtUtc}
                  >
                    {formatRelative(entry.occurredAtUtc)}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
