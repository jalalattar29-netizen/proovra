/**
 * OPERATIONAL TIMELINE (T-14 OperationalTimelinePanel) —
 *   GET /v1/evidence/:id/operational-timeline?teamId&limit
 *   → { evidenceId, teamId, generatedAtUtc, entries: TimelineEntry[] }
 * (operational-timeline.service.ts). Lifecycle transitions, reviewer actions
 * and incidents, each with its actor and severity. Fail-closed: a read that
 * failed is never shown as "no activity". Pure: no React, no fetch.
 */

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export function buildOperationalTimelinePath(evidenceId: string, teamId: string, limit = 50): string {
  return `/v1/evidence/${encodeURIComponent(evidenceId)}/operational-timeline?teamId=${encodeURIComponent(teamId)}&limit=${limit}`;
}

export type TimelineSeverity = "INFO" | "WARNING" | "HIGH" | "CRITICAL";

export interface TimelineEntry {
  id: string;
  kind: string;
  label: string;
  severity: TimelineSeverity;
  occurredAtIso: string | null;
  actorUserId: string | null;
  safeSummary: string | null;
}

export function parseOperationalTimeline(payload: unknown): TimelineEntry[] {
  return (Array.isArray(obj(payload).entries) ? (obj(payload).entries as unknown[]) : [])
    .map(obj)
    .filter((e) => str(e.id))
    .map((e) => {
      const sev = str(e.severity);
      return {
        id: str(e.id) as string,
        kind: str(e.kind) ?? "lifecycle",
        label: str(e.label) ?? str(e.eventType) ?? "Activity",
        severity: sev === "WARNING" || sev === "HIGH" || sev === "CRITICAL" ? sev : "INFO",
        occurredAtIso: str(e.occurredAtUtc),
        actorUserId: str(e.actorUserId),
        safeSummary: str(e.safeSummary),
      };
    });
}

/** The web row's meta: "actor 1a2b3c4d · SEVERITY" (the actor id shortened, as the web shows it). */
export function timelineMeta(e: TimelineEntry): string {
  return [e.actorUserId ? `actor ${e.actorUserId.slice(0, 8)}` : null, e.severity].filter(Boolean).join(" · ");
}

export const TIMELINE_UNAVAILABLE =
  "Operational timeline could not be loaded. The platform is failing closed — assume activity exists until the timeline is available.";
export const TIMELINE_EMPTY_TITLE = "No operational activity recorded.";
export const TIMELINE_EMPTY_REASON =
  "The platform writes a timeline entry on every lifecycle transition, reviewer action, and incident. New entries will appear here as activity occurs.";
