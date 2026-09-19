/**
 * CANONICAL NATIVE INBOX PROJECTION (Master Program §19, M3) — pure logic.
 *
 * GET /v1/me/inbox returns the unread count in `metricSummary.unread` (and
 * `scopeSummary.unread`); it has NO `counts.unread` / `summary.unread`. The screen
 * previously read those non-existent fields and silently fell back to counting the
 * current page, undercounting when the inbox is paginated. These pure resolvers
 * read the real shape and are contract-tested; the RN screen is a thin shell.
 */

export interface InboxItem {
  itemKey: string;
  title: string;
  href?: string | null;
  occurredAt: string;
  category?: string | null;
  tone?: string | null;
  isRead?: boolean;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/**
 * The authoritative unread count from the inbox envelope, or null when the
 * server didn't provide one (caller may fall back to a page-local count).
 * Priority: metricSummary.unread → scopeSummary.unread.
 */
export function resolveInboxUnread(data: unknown): number | null {
  const d = obj(data);
  return num(obj(d["metricSummary"])["unread"]) ?? num(obj(d["scopeSummary"])["unread"]);
}

/**
 * Map an inbox item's href to a native route, or null when native has no
 * destination for it (the row is shown but doesn't dead-link). The server still
 * authorizes the destination's data on navigation.
 */
export function resolveInboxRoute(href: string | null | undefined): string | null {
  if (!href || !href.startsWith("/")) return null;
  if (href.startsWith("/evidence/")) return href;
  if (href.startsWith("/case/")) return href;
  if (href.startsWith("/cases/")) return href.replace("/cases/", "/case/");
  return null;
}
