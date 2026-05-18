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

import { useEffect, useState } from "react";

import { apiFetch } from "../../lib/api";
import { NoOperationalTimelineEmptyState } from "./OperationalEmptyState";

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

const SEVERITY_DOT_COLOR: Record<TimelineEntry["severity"], string> = {
  INFO: "rgba(96, 165, 250, 0.8)",
  WARNING: "rgba(252, 211, 77, 0.85)",
  HIGH: "rgba(252, 165, 165, 0.85)",
  CRITICAL: "rgba(254, 202, 202, 0.95)",
};

const KIND_LABEL: Record<TimelineEntry["kind"], string> = {
  lifecycle: "Lifecycle",
  review: "Review",
  incident: "Incident",
};

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
          setError(e?.message ?? "timeline_unavailable");
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
          border: "1px solid rgba(239, 68, 68, 0.35)",
          background: "rgba(239, 68, 68, 0.06)",
          borderRadius: 8,
          padding: 14,
          fontSize: 13,
          color: "rgba(252, 165, 165, 0.95)",
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
          color: "rgba(255,255,255,0.5)",
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

  return (
    <ol
      data-operational-timeline
      data-evidence-id={timeline.evidenceId}
      style={{
        listStyle: "none",
        margin: 0,
        padding: 0,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        borderLeft: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      {timeline.entries.map((entry) => (
        <li
          key={entry.id}
          style={{
            display: "grid",
            gridTemplateColumns: "12px 1fr auto",
            gap: 12,
            alignItems: "flex-start",
            padding: "8px 12px 8px 0",
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 8,
              height: 8,
              borderRadius: 8,
              background: SEVERITY_DOT_COLOR[entry.severity],
              marginTop: 6,
              marginLeft: -4,
              border: "2px solid rgba(0,0,0,0.4)",
            }}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <div
              style={{
                fontSize: 13,
                color: "rgba(255,255,255,0.9)",
                fontWeight: 500,
              }}
            >
              {entry.label}
            </div>
            {entry.safeSummary ? (
              <div
                style={{
                  fontSize: 12,
                  color: "rgba(255,255,255,0.55)",
                  lineHeight: 1.45,
                }}
              >
                {entry.safeSummary}
              </div>
            ) : null}
            <div
              style={{
                fontSize: 11,
                color: "rgba(255,255,255,0.4)",
                marginTop: 2,
                display: "flex",
                gap: 8,
              }}
            >
              <span>{KIND_LABEL[entry.kind]}</span>
              <span>·</span>
              <span>{entry.eventType}</span>
            </div>
          </div>
          <div
            style={{
              fontSize: 11,
              color: "rgba(255,255,255,0.45)",
              whiteSpace: "nowrap",
            }}
            title={entry.occurredAtUtc}
          >
            {formatRelative(entry.occurredAtUtc)}
          </div>
        </li>
      ))}
    </ol>
  );
}
