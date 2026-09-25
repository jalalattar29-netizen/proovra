/**
 * PRESENCE (T-15) — the native port of
 * `apps/web/components/presence/PresenceIndicator.tsx`.
 *
 *   POST /v1/me/presence/heartbeat { teamId, resourceKind, resourceId } → { viewers }  (claim + read)
 *   GET  /v1/me/presence/here?teamId&resourceKind&resourceId            → { viewers }  (read only)
 *
 * Foreground claims presence; a backgrounded app only OBSERVES, so it never
 * advertises an operator who has walked away (the web's hidden-tab rule, with
 * AppState standing in for document.visibilityState). Bounded payload: only
 * userId, displayName and lastSeenAtUtc are read. "Also here" — never
 * watching/tracking language. Failures are silent and never invent viewers.
 */
export const PRESENCE_HEARTBEAT_PATH = "/v1/me/presence/heartbeat";
export const PRESENCE_INTERVAL_MS = 30_000;
export const PRESENCE_VISIBLE_LIMIT = 4;

export type PresenceResourceKind = "evidence" | "matter" | "discussion_thread" | "reviewer_workflow" | "evidence_request";

export function buildPresenceHerePath(teamId: string, kind: PresenceResourceKind, resourceId: string): string {
  return `/v1/me/presence/here?teamId=${encodeURIComponent(teamId)}&resourceKind=${encodeURIComponent(kind)}&resourceId=${encodeURIComponent(resourceId)}`;
}

export interface PresenceViewer {
  userId: string;
  displayName: string;
  lastSeenAtUtc: string | null;
}

export function parsePresenceViewers(payload: unknown): PresenceViewer[] {
  const d = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const list = Array.isArray(d["viewers"]) ? (d["viewers"] as unknown[]) : [];
  const out: PresenceViewer[] = [];
  for (const raw of list) {
    const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const userId = typeof v["userId"] === "string" ? (v["userId"] as string) : "";
    const displayName = typeof v["displayName"] === "string" ? (v["displayName"] as string) : "";
    if (!userId || !displayName) continue;
    out.push({ userId, displayName, lastSeenAtUtc: typeof v["lastSeenAtUtc"] === "string" ? (v["lastSeenAtUtc"] as string) : null });
  }
  return out;
}

export function presenceSummary(count: number): string {
  return `${count} other operator${count === 1 ? "" : "s"} also here`;
}
