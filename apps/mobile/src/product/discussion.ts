/**
 * DISCUSSION — pure projections for collaboration threads and messages.
 *
 * Ports the Discussion tab of
 * `apps/web/app/(app)/collaboration-teams/[teamId]/page.tsx` over
 * `GET /v1/collaboration/threads`, `GET|POST .../threads/:id/messages` and the
 * resolve/reopen transitions.
 *
 * ===========================================================================
 * WHY THIS IS THE DESTINATION OF A RETIRED ROUTE
 * ===========================================================================
 * `/collaboration-teams/:teamId/collaboration` was a second page for one
 * group, holding five panels. Three of them did nothing — guests wrote a row
 * and sent no invitation, access review recorded decisions and enforced none,
 * and the "Daily" digest had no consumer in the worker — and two duplicated
 * surfaces that already existed. What survived is the conversation, and it
 * lives beside the group's members and its work as the Discussion tab.
 *
 * The web kept the old route as a redirect because the links are in people's
 * history and in messages they sent each other. Native converges the same way:
 * the retired path resolves to this surface, not to a second screen.
 *
 * ===========================================================================
 * WHAT A 404 MEANS HERE
 * ===========================================================================
 * Every collaboration route requires the reviewer permission and answers 404
 * — never 403 — to a non-member or a member without it. That is deliberate
 * anti-enumeration: a 403 would confirm that a group exists. So a 404 on this
 * surface is NOT "there is no discussion"; it is "this is not yours to read",
 * and the two must never render the same way.
 *
 * Pure: no React, no react-native, no fetch.
 */
import type { ProovraStatusTone } from "@proovra/ui";

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export function buildThreadsPath(teamId: string, status?: string | null): string {
  const base = `/v1/collaboration/threads?teamId=${encodeURIComponent(teamId)}`;
  return status ? `${base}&status=${encodeURIComponent(status)}` : base;
}

export function buildThreadMessagesPath(threadId: string): string {
  return `/v1/collaboration/threads/${encodeURIComponent(threadId)}/messages`;
}

export function buildThreadResolvePath(threadId: string): string {
  return `/v1/collaboration/threads/${encodeURIComponent(threadId)}/resolve`;
}

export function buildThreadReopenPath(threadId: string): string {
  return `/v1/collaboration/threads/${encodeURIComponent(threadId)}/reopen`;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export interface DiscussionThread {
  id: string;
  title: string;
  status: string;
  kind: string;
  visibility: string;
  evidenceId: string | null;
  assignedToUserId: string | null;
  resolvedAtIso: string | null;
  escalatedAtIso: string | null;
  reopenCount: number;
  createdAtIso: string | null;
  updatedAtIso: string | null;
}

export function parseDiscussionThreads(payload: unknown): DiscussionThread[] {
  return rows(obj(payload).threads)
    .map((raw) => {
      const t = obj(raw);
      const id = str(t.id);
      if (!id) return null;
      return {
        id,
        // A thread with no title is shown as untitled, never as a blank row a
        // reader cannot tap with any idea of what it is.
        title: str(t.title) ?? "Untitled thread",
        status: str(t.status) ?? "OPEN",
        kind: str(t.kind) ?? "",
        visibility: str(t.visibility) ?? "",
        evidenceId: str(t.evidenceId),
        assignedToUserId: str(t.assignedToUserId),
        resolvedAtIso: str(t.resolvedAtUtc) ?? str(t.resolvedAt),
        escalatedAtIso: str(t.escalatedAtUtc) ?? str(t.escalatedAt),
        reopenCount: num(t.reopenCount) ?? 0,
        createdAtIso: str(t.createdAt),
        updatedAtIso: str(t.updatedAt),
      };
    })
    .filter((t): t is DiscussionThread => t !== null);
}

export interface DiscussionMessage {
  id: string;
  body: string;
  authorUserId: string | null;
  authorName: string | null;
  createdAtIso: string | null;
}

export function parseDiscussionMessages(payload: unknown): DiscussionMessage[] {
  return rows(obj(payload).messages ?? payload)
    .map((raw) => {
      const m = obj(raw);
      const id = str(m.id);
      if (!id) return null;
      const author = obj(m.author);
      return {
        id,
        body: typeof m.body === "string" ? m.body : (str(m.message) ?? ""),
        authorUserId: str(m.authorUserId) ?? str(author.id),
        authorName: str(author.displayName) ?? str(m.authorName),
        createdAtIso: str(m.createdAt) ?? str(m.createdAtUtc),
      };
    })
    .filter((m): m is DiscussionMessage => m !== null)
    // Oldest first: a conversation reads forwards.
    .sort((a, b) => {
      const at = a.createdAtIso ? Date.parse(a.createdAtIso) : 0;
      const bt = b.createdAtIso ? Date.parse(b.createdAtIso) : 0;
      return at - bt;
    });
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export function threadStatusTone(status: string): ProovraStatusTone {
  switch (status.toUpperCase()) {
    case "RESOLVED":
    case "CLOSED":
      return "verified";
    case "ESCALATED":
      return "risk";
    case "OPEN":
      return "pending";
    default:
      return "neutral";
  }
}

export function threadStatusLabel(status: string): string {
  const s = status.replace(/_/g, " ").toLowerCase();
  return s.length === 0 ? "Unknown" : s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Open threads first, then by most recent activity.
 *
 * A resolved thread at the top of a conversation list is a thread nobody needs
 * and an open one buried beneath it is work somebody is waiting on.
 */
export function sortThreads(threads: DiscussionThread[]): DiscussionThread[] {
  const rank = (t: DiscussionThread) => {
    const s = t.status.toUpperCase();
    if (s === "ESCALATED") return 0;
    if (s === "OPEN") return 1;
    return 2;
  };
  return [...threads].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    const at = a.updatedAtIso ? Date.parse(a.updatedAtIso) : 0;
    const bt = b.updatedAtIso ? Date.parse(b.updatedAtIso) : 0;
    return bt - at;
  });
}

/** A resolved thread is reopened; an open one is resolved. */
export function nextTransition(thread: DiscussionThread): "resolve" | "reopen" {
  const s = thread.status.toUpperCase();
  return s === "RESOLVED" || s === "CLOSED" ? "reopen" : "resolve";
}

/**
 * A 404 from a collaboration route is an authorization answer, not an empty
 * list — the routes answer 404 to non-members deliberately so that a 403 never
 * confirms a group exists.
 */
export function isCollaborationDenial(err: unknown): boolean {
  const e = obj(err);
  return num(e.statusCode) === 404 || str(e.kind) === "notFound";
}

/** A message must have something in it; whitespace is not a message. */
export function isSendableMessage(body: string): boolean {
  const v = body.trim();
  return v.length > 0 && v.length <= 10000;
}
