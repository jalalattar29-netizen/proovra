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
  /** History lifecycle — each a real timestamp from the server, never inferred. */
  dismissedAt?: string | null;
  resolvedAt?: string | null;
  sourceClearedAt?: string | null;
  /** The server's answer to "may this reader archive it"; absent means yes (legacy envelopes). */
  canDismiss?: boolean;
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
 * T-09d / RC-10 — the HEADER BELL's count.
 *
 * `services/api/src/routes/me-inbox.routes.ts:1376-1386` states the contract
 * outright: `/v1/me/inbox`, `/v1/me/inbox/summary` and `mark-all-read` share
 * ONE aggregation, so "the badge, the page, and bulk actions can never disagree
 * on authorization, category scope, or read state". `/summary` is the cached
 * variant intended for the bell, which is why the header reads it instead of
 * pulling a 50-item page just to count.
 *
 * The count is parsed with the SAME resolver the page uses, so a server shape
 * change moves both together rather than leaving the badge on a stale field —
 * the bug this module's own header documents.
 */
export const INBOX_SUMMARY_PATH = "/v1/me/inbox/summary";

/** Parse the bell count. `null` means "unknown", never "zero". */
export function resolveInboxSummaryUnread(data: unknown): number | null {
  return resolveInboxUnread(data);
}

/**
 * How the badge renders a count. The web caps the label rather than letting a
 * four-digit number stretch the chrome; `null` renders NO badge at all,
 * because an unknown count must not be shown as a confident zero.
 */
export function inboxBadgeLabel(unread: number | null): string | null {
  if (unread === null || unread <= 0) return null;
  return unread > 99 ? "99+" : String(unread);
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
  // The other hrefs me-inbox.routes.ts emits that have a native destination.
  // Anything else (reviewer-ops, security-center, communications) has none,
  // and the row renders without an Open control rather than dead-linking.
  if (href.startsWith("/evidence-requests/")) return href.replace("/evidence-requests/", "/evidence-request/");
  if (href === "/organizations" || href.startsWith("/organizations/")) return href;
  if (href === "/settings/security") return href;
  if (href === "/intake-links" || href.startsWith("/intake-links?")) return "/intake-links";
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
export type InboxItemAction = "read" | "unread" | "archive" | "unarchive" | "remind";

/** The inbox read for the active or the ARCHIVED half (the web's `lifecycle=archived`). */
export function buildInboxListPath(archived: boolean): string {
  return `/v1/me/inbox?pageSize=50${archived ? "&lifecycle=archived" : ""}`;
}

/** The web's history chips: "No longer active <date>" and "Archived <date>". */
export function inboxHistoryChips(item: InboxItem, formatDate: (iso: string) => string): string[] {
  const out: string[] = [];
  const cleared = item.sourceClearedAt ?? item.resolvedAt ?? null;
  if (item.resolvedAt && cleared) out.push(`No longer active ${formatDate(cleared)}`);
  if (item.dismissedAt) out.push(`Archived ${formatDate(item.dismissedAt)}`);
  return out;
}

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
