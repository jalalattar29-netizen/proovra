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
  /**
   * LEGACY FIELD NAME on the wire; the product name is `remindAt`. The
   * envelope emits both from one value so they cannot disagree.
   *
   * It was missing from this interface, which is why a snoozed item's return
   * time was invisible even though the endpoint had always sent it.
   */
  snoozedUntil?: string | null;
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

/* ---------------------------------------------------------------- additions
 * The canonical inbox is severity-ordered and carries per-item read / unread /
 * archive / remind state, persisted through
 * `/v1/me/inbox/items/:itemKey/{read,unread,archive,remind}`. Native offered
 * only mark-read and mark-all-read, so an item could be acknowledged but never
 * deferred or restored, and the list rendered in arrival order.
 */

/**
 * The per-item actions the canonical inbox persists — by their CANONICAL names.
 *
 * This read `"dismiss" | "snooze"`, which me-inbox.routes.ts registers under a
 * comment reading "BACKWARD-COMPATIBLE aliases for shipped clients". Both are
 * dispositioned COMPATIBILITY_TOMBSTONE, and the snooze disposition records
 * that "the web client was migrated to the canonical name in Attention
 * Architecture Phase 1, which is why it now shows zero product consumers".
 *
 * Native was that consumer. A tombstone with a live caller is a route nobody
 * can retire, and the alias and the canonical name point at the SAME handler
 * constant — so asking for the legacy name bought nothing and kept a legacy
 * surface alive.
 */
export type InboxItemAction = "read" | "unread" | "archive" | "remind";

export function inboxItemActionPath(itemKey: string, action: InboxItemAction): string {
  return `/v1/me/inbox/items/${encodeURIComponent(itemKey)}/${action}`;
}

/**
 * Severity rank. The canonical page renders "severity-ordered actionable rows";
 * a list in arrival order buries the thing that matters under routine noise.
 */
const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  risk: 1,
  medium: 2,
  warning: 2,
  pending: 2,
  low: 3,
  info: 3,
  neutral: 4,
};

export function inboxSeverityRank(item: InboxItem): number {
  const key = String(item.tone ?? "").toLowerCase();
  return SEVERITY_RANK[key] ?? 4;
}

/**
 * Sort a page: unread before read, then by severity, then newest first.
 *
 * Read items sink rather than disappear — the canonical inbox keeps them
 * visible so acknowledging something does not erase the record of it.
 */
export function sortInboxItems(items: readonly InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) => {
    const readDiff = Number(!!a.isRead) - Number(!!b.isRead);
    if (readDiff !== 0) return readDiff;
    const sev = inboxSeverityRank(a) - inboxSeverityRank(b);
    if (sev !== 0) return sev;
    return Date.parse(b.occurredAt ?? "") - Date.parse(a.occurredAt ?? "");
  });
}

/** A snoozed item is deferred, not gone; it returns when the time passes. */
export function isSnoozed(item: { snoozedUntil?: string | null }, nowMs: number = Date.now()): boolean {
  const until = item.snoozedUntil ? Date.parse(item.snoozedUntil) : NaN;
  return Number.isFinite(until) && until > nowMs;
}

/** The canonical category filters, as the inbox groups its rows. */
export const INBOX_FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "all", label: "All" },
  { value: "unread", label: "Unread" },
  { value: "org_invite", label: "Invitations" },
  { value: "submission", label: "Submissions" },
  { value: "review", label: "Reviews" },
];

/** Apply the chip filter locally to an already-fetched page. */
export function filterInboxItems(items: readonly InboxItem[], filter: string): InboxItem[] {
  if (filter === "all") return [...items];
  if (filter === "unread") return items.filter((i) => !i.isRead);
  return items.filter((i) => String(i.category ?? "").toLowerCase().includes(filter));
}

// ---------------------------------------------------------------------------
// Snooze (canonically: remind)
// ---------------------------------------------------------------------------

/**
 * A snoozed item is DEFERRED, not gone.
 *
 * The route's canonical body field is `remindAt`; `snoozedUntil` is the legacy
 * name it still accepts, and the envelope emits both from one value so they
 * cannot disagree. This sends the canonical name.
 *
 * The choices are offered as durations rather than a date picker, because the
 * question a user is answering on a phone is "not now — how long?", not "on
 * which calendar day should this return".
 */
export const SNOOZE_CHOICES: ReadonlyArray<{ key: string; label: string; hours: number }> = [
  { key: "1h", label: "1 hour", hours: 1 },
  { key: "4h", label: "4 hours", hours: 4 },
  { key: "tomorrow", label: "Tomorrow", hours: 24 },
  { key: "week", label: "Next week", hours: 24 * 7 },
];

export function buildSnoozeBody(hours: number, nowMs: number = Date.now()) {
  const until = new Date(nowMs + hours * 60 * 60 * 1000);
  // `remindAt` is canonical. `snoozedUntil` rides along because the route
  // accepts either and a shipped client may be read by either name.
  return { remindAt: until.toISOString(), snoozedUntil: until.toISOString() };
}

/**
 * When an item comes back, in words.
 *
 * `null` when it is not snoozed or the stored time has already passed — an
 * expired snooze is not a pending one, and saying "returns in -3 hours" is
 * worse than saying nothing.
 */
export function snoozeReturnLabel(
  item: { snoozedUntil?: string | null },
  nowMs: number = Date.now(),
): string | null {
  const until = item.snoozedUntil ? Date.parse(item.snoozedUntil) : NaN;
  if (!Number.isFinite(until) || until <= nowMs) return null;

  const minutes = Math.round((until - nowMs) / 60000);
  if (minutes < 60) return `Returns in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Returns in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `Returns in ${days} day${days === 1 ? "" : "s"}`;
}
