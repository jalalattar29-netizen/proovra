"use client";

/**
 * Intake Links Operations Console — the enterprise-grade list surface
 * for /intake-links. Replaces the legacy stacked-card layout with:
 *
 *   • KPI strip (Active / Sent / Opened / Started / Submitted / Expiring
 *     soon / Failed delivery / Revoked-or-expired). Derived from the
 *     loaded `items` array so the numbers are guaranteed to match the
 *     rows below — no second fetch, no fake aggregates.
 *
 *   • Status tabs (All / Active / Needs attention / Submitted /
 *     Expiring soon / Revoked or expired / Archived). One source of
 *     truth: every tab is a pure filter on the same loaded array.
 *
 *   • Search + filter chips (channel, lifecycle, delivery status,
 *     delivery failure, submissions). Plus a "Clear filters" button
 *     surfaced whenever any non-default filter is active.
 *
 *   • Sort dropdown (latest activity / created newest / expires
 *     soonest / status priority / recipient).
 *
 *   • Client-side pagination (25 default, 25 / 50 / 100). The backend
 *     limit caps the LOAD at 200; we paginate the resulting set so a
 *     workspace with 100+ links stays responsive.
 *
 *   • URL search-param state for q / tab / channel / lifecycle /
 *     delivery / sort / page / pageSize so reload + share works.
 *
 *   • Row-click details drawer with Overview / Delivery / Activity /
 *     Submissions / Safety sections.
 *
 *   • Archive / Unarchive action (POST /v1/workflow/intake-links/:id/
 *     archive | /unarchive). Distinct from revoke — archive hides
 *     without closing public access. Revoke remains the only
 *     destructive action surfaced primary.
 *
 * What is intentionally NOT here:
 *   • Delete. Not exposed by the UI. A revoke + archive combination
 *     achieves the operator's goal (close access + declutter) without
 *     destroying the audit trail. If hard deletion is ever needed it
 *     should live behind a server-side guard that proves no delivery,
 *     no sessions, no evidence.
 *   • Server-side filtering / pagination. The backend supports
 *     archiveScope server-side; the rest is client-side until a single
 *     workspace exceeds the 200-row backend cap. At that point this
 *     component is the natural place to switch to server-driven
 *     pagination — the URL state already exists.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { apiFetch } from "../../lib/api";

// =============================================================================
// Public types — mirror LinkListItem on the page (kept private to avoid
// importing across the page boundary in either direction). Keep these
// fields in sync with `IntakeLinkListItem` in
// services/api/src/services/intake-link-lifecycle.service.ts.
// =============================================================================

export type ConsoleLifecycle =
  | "CREATED"
  | "SENT"
  | "DELIVERY_FAILED"
  | "OPENED"
  | "STARTED"
  | "SUBMITTED"
  | "EXPIRED"
  | "REVOKED";

export type ConsoleItem = {
  link: {
    id: string;
    teamId: string;
    workflowTemplateSlug: string;
    workflowTemplateName: string;
    intakeMode: string;
    caseId: string | null;
    recipientLabel: string | null;
    recipientEmailPreview: string | null;
    recipientPhonePreview: string | null;
    maxUses: number;
    usedCount: number;
    status: string;
    expiresAtUtc: string;
    revokedAtUtc: string | null;
    revokedReason: string | null;
    archivedAtUtc: string | null;
    createdAt: string;
    updatedAt: string;
  };
  delivery: {
    latestStatus: string | null;
    latestChannel: string | null;
    latestAtUtc: string | null;
    latestSentAtUtc: string | null;
    latestDeliveredAtUtc: string | null;
    latestFailedAtUtc: string | null;
    latestErrorCode: string | null;
    attemptCount: number;
    channelsAttempted: string[];
    latestProviderMessageId: string | null;
  };
  activity: {
    firstOpenedAtUtc: string | null;
    lastOpenedAtUtc: string | null;
    firstStartedAtUtc: string | null;
    lastStartedAtUtc: string | null;
    firstSubmittedAtUtc: string | null;
    lastSubmittedAtUtc: string | null;
    sessionsCreated: number;
    sessionsOpened: number;
    sessionsStarted: number;
    sessionsSubmitted: number;
    sessionsExpired: number;
    sessionsRevoked: number;
    evidenceCount: number;
  };
  computedLifecycle: ConsoleLifecycle;
};

export type OperationsConsoleProps = {
  items: ConsoleItem[];
  /** Triggered after archive/unarchive succeeds so the parent can refetch. */
  onMutated: () => void;
  /** Opens the existing revoke flow (parent owns the confirmation modal). */
  onRevoke: (linkId: string) => void;
  /** Opens the existing delivery drawer. */
  onOpenDelivery: (linkId: string) => void;
  /** Opens the existing submissions drawer. */
  onOpenSubmissions: (linkId: string) => void;
  /** Sets URL query state so reload/share works. */
  initialQuery?: URLSearchParams;
  /** When the page wants to write state back into the URL. */
  writeQuery?: (q: URLSearchParams) => void;
};

// =============================================================================
// Local helpers — kept private to the console.
// =============================================================================

function clamp<T>(value: T | undefined, allowed: readonly T[]): T | undefined {
  if (!value) return undefined;
  return allowed.includes(value) ? value : undefined;
}

function describeRelativeTime(iso: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diffMs = Date.now() - t;
  const m = Math.round(diffMs / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function describeAbsoluteDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function isExpiringSoon(iso: string): boolean {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  const now = Date.now();
  return t > now && t - now < 72 * 60 * 60 * 1000; // < 72h
}

// =============================================================================
// Filter / sort / tab definitions.
// =============================================================================

const TABS = [
  "all",
  "active",
  "needs_attention",
  "submitted",
  "expiring_soon",
  "closed",
  "archived",
] as const;
type Tab = (typeof TABS)[number];

const TAB_LABELS: Record<Tab, string> = {
  all: "All",
  active: "Active",
  needs_attention: "Needs attention",
  submitted: "Submitted",
  expiring_soon: "Expiring soon",
  closed: "Revoked or expired",
  archived: "Archived",
};

const CHANNELS = ["", "EMAIL", "SMS", "WHATSAPP", "MANUAL"] as const;
type ChannelFilter = (typeof CHANNELS)[number];
const CHANNEL_LABELS: Record<ChannelFilter, string> = {
  "": "Any channel",
  EMAIL: "Email",
  SMS: "SMS",
  WHATSAPP: "WhatsApp",
  MANUAL: "Copy link only",
};

const LIFECYCLES = [
  "",
  "CREATED",
  "SENT",
  "DELIVERY_FAILED",
  "OPENED",
  "STARTED",
  "SUBMITTED",
  "EXPIRED",
  "REVOKED",
] as const;
type LifecycleFilter = (typeof LIFECYCLES)[number];

const LIFECYCLE_LABELS: Record<Exclude<LifecycleFilter, "">, string> = {
  CREATED: "Created",
  SENT: "Sent",
  DELIVERY_FAILED: "Delivery failed",
  OPENED: "Opened",
  STARTED: "Upload started",
  SUBMITTED: "Submitted",
  EXPIRED: "Expired",
  REVOKED: "Revoked",
};

const DELIVERY_STATES = [
  "",
  "QUEUED",
  "SENT",
  "DELIVERED",
  "FAILED",
  "UNDELIVERED",
  "RETRY_SCHEDULED",
  "NONE",
] as const;
type DeliveryFilter = (typeof DELIVERY_STATES)[number];
const DELIVERY_LABELS: Record<DeliveryFilter, string> = {
  "": "Any delivery state",
  QUEUED: "Queued",
  SENT: "Sent",
  DELIVERED: "Delivered",
  FAILED: "Failed",
  UNDELIVERED: "Undelivered",
  RETRY_SCHEDULED: "Retry scheduled",
  NONE: "Not sent yet",
};

const SORTS = [
  "activity",
  "created",
  "expires",
  "priority",
  "recipient",
] as const;
type Sort = (typeof SORTS)[number];
const SORT_LABELS: Record<Sort, string> = {
  activity: "Latest activity",
  created: "Newest created",
  expires: "Expires soonest",
  priority: "Status priority",
  recipient: "Recipient (A→Z)",
};

const PAGE_SIZES = [25, 50, 100] as const;

// Lifecycle priority for the "status priority" sort. Lower = higher
// urgency. SUBMITTED is parked low so finished work doesn't drown out
// links that need operator attention.
const LIFECYCLE_PRIORITY: Record<ConsoleLifecycle, number> = {
  DELIVERY_FAILED: 0,
  STARTED: 1,
  OPENED: 2,
  SENT: 3,
  CREATED: 4,
  SUBMITTED: 5,
  EXPIRED: 6,
  REVOKED: 7,
};

const LIFECYCLE_CHIP: Record<ConsoleLifecycle, { bg: string; fg: string; border: string }> = {
  CREATED: { bg: "#f3f4f6", fg: "#374151", border: "#d1d5db" },
  SENT: { bg: "#dbeafe", fg: "#1e3a8a", border: "#93c5fd" },
  DELIVERY_FAILED: { bg: "#fef2f2", fg: "#991b1b", border: "#fca5a5" },
  OPENED: { bg: "#fef3c7", fg: "#92400e", border: "#fcd34d" },
  STARTED: { bg: "#e0e7ff", fg: "#3730a3", border: "#a5b4fc" },
  SUBMITTED: { bg: "#dcfce7", fg: "#166534", border: "#86efac" },
  EXPIRED: { bg: "#f3f4f6", fg: "#6b7280", border: "#d1d5db" },
  REVOKED: { bg: "#fee2e2", fg: "#7f1d1d", border: "#fca5a5" },
};

// =============================================================================
// Tab predicates — pure functions, easy to test, used both by the chip
// counts and by the row filter.
// =============================================================================

function isExpired(item: ConsoleItem): boolean {
  return item.computedLifecycle === "EXPIRED";
}
function isRevoked(item: ConsoleItem): boolean {
  return item.computedLifecycle === "REVOKED";
}
function isArchived(item: ConsoleItem): boolean {
  return Boolean(item.link.archivedAtUtc);
}
function needsAttention(item: ConsoleItem): boolean {
  if (item.computedLifecycle === "DELIVERY_FAILED") return true;
  if (
    item.link.status === "ACTIVE" &&
    !isArchived(item) &&
    !isExpired(item) &&
    isExpiringSoon(item.link.expiresAtUtc) &&
    item.activity.sessionsSubmitted === 0
  ) {
    return true;
  }
  return false;
}
function isSubmitted(item: ConsoleItem): boolean {
  return item.activity.sessionsSubmitted > 0;
}

function matchesTab(item: ConsoleItem, tab: Tab): boolean {
  if (tab === "all") return true;
  if (tab === "archived") return isArchived(item);
  // Default-view tabs never include archived links — archive is its own tab.
  if (isArchived(item)) return false;
  switch (tab) {
    case "active":
      return (
        item.link.status === "ACTIVE" &&
        !isExpired(item) &&
        !isRevoked(item)
      );
    case "needs_attention":
      return needsAttention(item);
    case "submitted":
      return isSubmitted(item);
    case "expiring_soon":
      return (
        item.link.status === "ACTIVE" &&
        !isExpired(item) &&
        !isRevoked(item) &&
        isExpiringSoon(item.link.expiresAtUtc)
      );
    case "closed":
      return isExpired(item) || isRevoked(item);
  }
}

// =============================================================================
// KPI strip — derived from the *full* loaded items array, NOT from the
// filtered view. The operator wants workspace-level metrics regardless
// of which tab they're sitting on.
// =============================================================================

function computeKpis(items: ConsoleItem[]) {
  let active = 0;
  let sent = 0;
  let opened = 0;
  let started = 0;
  let submitted = 0;
  let expiringSoon = 0;
  let failed = 0;
  let closed = 0;
  for (const it of items) {
    if (isArchived(it)) continue;
    if (it.link.status === "ACTIVE" && !isExpired(it) && !isRevoked(it)) active += 1;
    const d = it.delivery.latestStatus;
    if (d === "QUEUED" || d === "SENT" || d === "DELIVERED" || d === "RETRY_SCHEDULED") {
      sent += 1;
    }
    if (it.activity.sessionsOpened > 0) opened += 1;
    if (it.activity.sessionsStarted > 0) started += 1;
    if (it.activity.sessionsSubmitted > 0) submitted += 1;
    if (
      it.link.status === "ACTIVE" &&
      !isExpired(it) &&
      !isRevoked(it) &&
      isExpiringSoon(it.link.expiresAtUtc)
    ) {
      expiringSoon += 1;
    }
    if (it.computedLifecycle === "DELIVERY_FAILED") failed += 1;
    if (isExpired(it) || isRevoked(it)) closed += 1;
  }
  return { active, sent, opened, started, submitted, expiringSoon, failed, closed };
}

// =============================================================================
// Main component
// =============================================================================

export function IntakeLinksOperationsConsole(props: OperationsConsoleProps) {
  const { items, onMutated, onRevoke, onOpenDelivery, onOpenSubmissions } = props;

  // URL state — every filter dimension round-trips through the
  // searchParams so reload/share works. We seed from initialQuery
  // when present (the page passes useSearchParams() in).
  const initial = props.initialQuery ?? new URLSearchParams();

  const [q, setQ] = useState<string>(initial.get("q") ?? "");
  const [tab, setTab] = useState<Tab>(
    (clamp<Tab>(initial.get("tab") as Tab, TABS) ?? "active") as Tab,
  );
  const [channel, setChannel] = useState<ChannelFilter>(
    (clamp<ChannelFilter>(initial.get("channel") as ChannelFilter, CHANNELS) ?? "") as ChannelFilter,
  );
  const [lifecycle, setLifecycle] = useState<LifecycleFilter>(
    (clamp<LifecycleFilter>(initial.get("lifecycle") as LifecycleFilter, LIFECYCLES) ?? "") as LifecycleFilter,
  );
  const [delivery, setDelivery] = useState<DeliveryFilter>(
    (clamp<DeliveryFilter>(initial.get("delivery") as DeliveryFilter, DELIVERY_STATES) ?? "") as DeliveryFilter,
  );
  const [sort, setSort] = useState<Sort>(
    (clamp<Sort>(initial.get("sort") as Sort, SORTS) ?? "activity") as Sort,
  );
  const [page, setPage] = useState<number>(() => {
    const raw = Number.parseInt(initial.get("page") ?? "1", 10);
    return Number.isFinite(raw) && raw >= 1 ? raw : 1;
  });
  const [pageSize, setPageSize] = useState<number>(() => {
    const raw = Number.parseInt(initial.get("pageSize") ?? "25", 10);
    return PAGE_SIZES.includes(raw as 25 | 50 | 100) ? raw : 25;
  });
  const [detailsLinkId, setDetailsLinkId] = useState<string | null>(null);

  // Push state back into the URL whenever anything changes. Skipping
  // empty values keeps the bar tidy ("/intake-links" stays clean when
  // no filters are active).
  useEffect(() => {
    if (!props.writeQuery) return;
    const next = new URLSearchParams();
    if (q.trim()) next.set("q", q.trim());
    if (tab !== "active") next.set("tab", tab);
    if (channel) next.set("channel", channel);
    if (lifecycle) next.set("lifecycle", lifecycle);
    if (delivery) next.set("delivery", delivery);
    if (sort !== "activity") next.set("sort", sort);
    if (page !== 1) next.set("page", String(page));
    if (pageSize !== 25) next.set("pageSize", String(pageSize));
    props.writeQuery(next);
  }, [q, tab, channel, lifecycle, delivery, sort, page, pageSize, props]);

  // Reset to page 1 whenever filters change so the operator never
  // gets stranded on an empty page after narrowing.
  useEffect(() => {
    setPage(1);
  }, [q, tab, channel, lifecycle, delivery, pageSize]);

  const kpis = useMemo(() => computeKpis(items), [items]);

  // -- Filter + sort pipeline. Pure function of state → rows so a
  //    refetch with the same filters renders the same view.
  const filtered = useMemo(() => {
    const qLower = q.trim().toLowerCase();
    return items.filter((it) => {
      if (!matchesTab(it, tab)) return false;
      if (channel && (it.delivery.latestChannel ?? "MANUAL") !== channel) return false;
      if (lifecycle && it.computedLifecycle !== lifecycle) return false;
      if (delivery) {
        if (delivery === "NONE") {
          if (it.delivery.latestStatus !== null) return false;
        } else if (it.delivery.latestStatus !== delivery) return false;
      }
      if (qLower) {
        const hay = [
          it.link.workflowTemplateName,
          it.link.workflowTemplateSlug,
          it.link.recipientLabel,
          it.link.recipientEmailPreview,
          it.link.recipientPhonePreview,
          it.link.id.slice(0, 8),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(qLower)) return false;
      }
      return true;
    });
  }, [items, q, tab, channel, lifecycle, delivery]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    switch (sort) {
      case "activity":
        arr.sort((a, b) =>
          activitySortKey(b).localeCompare(activitySortKey(a)),
        );
        break;
      case "created":
        arr.sort((a, b) => b.link.createdAt.localeCompare(a.link.createdAt));
        break;
      case "expires":
        arr.sort((a, b) =>
          a.link.expiresAtUtc.localeCompare(b.link.expiresAtUtc),
        );
        break;
      case "priority":
        arr.sort(
          (a, b) =>
            LIFECYCLE_PRIORITY[a.computedLifecycle] -
            LIFECYCLE_PRIORITY[b.computedLifecycle],
        );
        break;
      case "recipient":
        arr.sort((a, b) =>
          (a.link.recipientLabel ?? a.link.recipientEmailPreview ?? "~").localeCompare(
            b.link.recipientLabel ?? b.link.recipientEmailPreview ?? "~",
          ),
        );
        break;
    }
    return arr;
  }, [filtered, sort]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const pageClamped = Math.min(page, pageCount);
  const pageStart = (pageClamped - 1) * pageSize;
  const visible = sorted.slice(pageStart, pageStart + pageSize);

  const anyFilterActive =
    q.trim() !== "" ||
    tab !== "active" ||
    channel !== "" ||
    lifecycle !== "" ||
    delivery !== "" ||
    sort !== "activity";

  const clearFilters = () => {
    setQ("");
    setTab("active");
    setChannel("");
    setLifecycle("");
    setDelivery("");
    setSort("activity");
  };

  const handleArchive = useCallback(
    async (linkId: string, archived: boolean) => {
      const path = archived ? "unarchive" : "archive";
      try {
        await apiFetch(
          `/v1/workflow/intake-links/${encodeURIComponent(linkId)}/${path}`,
          { method: "POST" },
        );
        onMutated();
      } catch {
        // The page's refresh-on-error path surfaces this; we don't
        // throw so a stale-401 doesn't crash the row action.
      }
    },
    [onMutated],
  );

  const detailsItem = detailsLinkId
    ? items.find((it) => it.link.id === detailsLinkId) ?? null
    : null;

  return (
    <section
      data-intake-links-operations-console="true"
      aria-label="Intake links operations console"
    >
      {/* KPI strip */}
      <KpiStrip
        kpis={kpis}
        onTab={(t) => setTab(t)}
        onLifecycle={(l) => {
          // Lifecycle KPIs (Upload started / Opened) reset the tab to
          // "all" so the chosen lifecycle filter is the only narrowing
          // dimension — otherwise the implicit "active" tab would hide
          // any older OPENED/STARTED rows.
          setTab("all");
          setLifecycle(l);
        }}
        currentTab={tab}
        currentLifecycle={lifecycle}
      />

      {/* Search + filter chips */}
      <div style={controlsRowStyle} data-intake-links-controls>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by request, recipient, or link id…"
          aria-label="Search intake links"
          style={searchInputStyle}
          data-intake-links-search
        />
        <select
          value={channel}
          onChange={(e) => setChannel(e.target.value as ChannelFilter)}
          aria-label="Filter by channel"
          style={selectStyle}
          data-intake-links-filter-channel
        >
          {CHANNELS.map((c) => (
            <option key={c} value={c}>
              {CHANNEL_LABELS[c]}
            </option>
          ))}
        </select>
        <select
          value={lifecycle}
          onChange={(e) => setLifecycle(e.target.value as LifecycleFilter)}
          aria-label="Filter by lifecycle"
          style={selectStyle}
          data-intake-links-filter-lifecycle
        >
          <option value="">Any lifecycle</option>
          {LIFECYCLES.filter((l) => l !== "").map((l) => (
            <option key={l} value={l}>
              {LIFECYCLE_LABELS[l as Exclude<LifecycleFilter, "">]}
            </option>
          ))}
        </select>
        <select
          value={delivery}
          onChange={(e) => setDelivery(e.target.value as DeliveryFilter)}
          aria-label="Filter by delivery state"
          style={selectStyle}
          data-intake-links-filter-delivery
        >
          {DELIVERY_STATES.map((s) => (
            <option key={s} value={s}>
              {DELIVERY_LABELS[s]}
            </option>
          ))}
        </select>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
          aria-label="Sort"
          style={selectStyle}
          data-intake-links-sort
        >
          {SORTS.map((s) => (
            <option key={s} value={s}>
              Sort: {SORT_LABELS[s]}
            </option>
          ))}
        </select>
        {anyFilterActive ? (
          <button
            type="button"
            onClick={clearFilters}
            style={clearButtonStyle}
            data-intake-links-clear
          >
            Clear filters
          </button>
        ) : null}
      </div>

      {/* Results metadata */}
      <p style={metaLineStyle} data-intake-links-meta>
        {sorted.length === 0
          ? "No links match the current filters."
          : sorted.length === 1
            ? "1 link"
            : `${sorted.length} links`}
        {sorted.length > pageSize ? (
          <>
            {" "}
            ·{" "}
            <span style={mutedSpanStyle}>
              Page {pageClamped} of {pageCount}
            </span>
          </>
        ) : null}
      </p>

      {/* Table — desktop. Mobile collapses to compact cards via CSS. */}
      <div style={tableScrollStyle}>
        <table
          style={tableStyle}
          data-intake-links-table
          role="table"
          aria-label="Intake links"
        >
          <thead>
            <tr>
              <th style={thStyle}>Request</th>
              <th style={thStyle}>Recipient</th>
              <th style={thStyle}>Channel</th>
              <th style={thStyle}>Lifecycle</th>
              <th style={thStyle}>Delivery</th>
              <th style={thStyle}>Activity</th>
              <th style={thStyle}>Expires</th>
              <th style={thStyle}>Submissions</th>
              <th style={thStyleRight} aria-label="Actions"></th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={9} style={emptyRowStyle}>
                  Nothing matches these filters. Try{" "}
                  <button
                    type="button"
                    onClick={clearFilters}
                    style={inlineLinkStyle}
                  >
                    clearing them
                  </button>
                  .
                </td>
              </tr>
            ) : (
              visible.map((it) => (
                <ConsoleRow
                  key={it.link.id}
                  item={it}
                  onOpenDetails={() => setDetailsLinkId(it.link.id)}
                  onRevoke={() => onRevoke(it.link.id)}
                  onArchive={() =>
                    handleArchive(it.link.id, Boolean(it.link.archivedAtUtc))
                  }
                  onOpenDelivery={() => onOpenDelivery(it.link.id)}
                  onOpenSubmissions={() => onOpenSubmissions(it.link.id)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {sorted.length > pageSize ? (
        <div style={paginationRowStyle} data-intake-links-pagination>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <label htmlFor="ic-page-size" style={mutedSpanStyle}>
              Rows per page
            </label>
            <select
              id="ic-page-size"
              value={pageSize}
              onChange={(e) => setPageSize(Number.parseInt(e.target.value, 10))}
              style={selectStyle}
              data-intake-links-page-size
            >
              {PAGE_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button
              type="button"
              onClick={() => setPage(Math.max(1, pageClamped - 1))}
              disabled={pageClamped === 1}
              style={pagerButtonStyle}
              aria-label="Previous page"
              data-intake-links-prev-page
            >
              ←
            </button>
            <span style={mutedSpanStyle}>
              {pageClamped} / {pageCount}
            </span>
            <button
              type="button"
              onClick={() => setPage(Math.min(pageCount, pageClamped + 1))}
              disabled={pageClamped === pageCount}
              style={pagerButtonStyle}
              aria-label="Next page"
              data-intake-links-next-page
            >
              →
            </button>
          </div>
        </div>
      ) : null}

      {/* Details drawer */}
      {detailsItem ? (
        <DetailsDrawer
          item={detailsItem}
          onClose={() => setDetailsLinkId(null)}
          onRevoke={() => {
            onRevoke(detailsItem.link.id);
          }}
          onArchive={() =>
            handleArchive(
              detailsItem.link.id,
              Boolean(detailsItem.link.archivedAtUtc),
            )
          }
          onOpenDelivery={() => {
            onOpenDelivery(detailsItem.link.id);
          }}
          onOpenSubmissions={() => {
            onOpenSubmissions(detailsItem.link.id);
          }}
        />
      ) : null}
    </section>
  );
}

// =============================================================================
// KPI strip — clickable chips that ALSO act as tab shortcuts. Clicking
// "Expiring soon" jumps to the expiring_soon tab without changing other
// filters; clicking the active label switches back to "active".
// =============================================================================

function KpiStrip({
  kpis,
  onTab,
  onLifecycle,
  currentTab,
  currentLifecycle,
}: {
  kpis: ReturnType<typeof computeKpis>;
  onTab: (t: Tab) => void;
  onLifecycle: (l: LifecycleFilter) => void;
  currentTab: Tab;
  currentLifecycle: LifecycleFilter;
}) {
  // Every KPI is clickable. Some jump to a tab (Active, Submitted,
  // Expiring soon, Failed delivery, Revoked/expired); the lifecycle
  // ones (Upload started, Opened) set the lifecycle filter on the
  // "all" tab so the operator can see every link in that state
  // regardless of the surrounding "active" gate.
  type Entry =
    | { key: string; label: string; value: number; kind: "tab"; tab: Tab }
    | {
        key: string;
        label: string;
        value: number;
        kind: "lifecycle";
        lifecycle: Exclude<LifecycleFilter, "">;
      };
  const entries: Entry[] = [
    { key: "active", label: "Active", value: kpis.active, kind: "tab", tab: "active" },
    {
      key: "submitted",
      label: "Submitted",
      value: kpis.submitted,
      kind: "tab",
      tab: "submitted",
    },
    {
      key: "started",
      label: "Upload started",
      value: kpis.started,
      kind: "lifecycle",
      lifecycle: "STARTED",
    },
    {
      key: "opened",
      label: "Opened",
      value: kpis.opened,
      kind: "lifecycle",
      lifecycle: "OPENED",
    },
    {
      key: "expiring_soon",
      label: "Expiring soon",
      value: kpis.expiringSoon,
      kind: "tab",
      tab: "expiring_soon",
    },
    {
      key: "failed",
      label: "Failed delivery",
      value: kpis.failed,
      kind: "tab",
      tab: "needs_attention",
    },
    {
      key: "closed",
      label: "Revoked or expired",
      value: kpis.closed,
      kind: "tab",
      tab: "closed",
    },
  ];
  return (
    <ul style={kpiStripStyle} data-intake-links-kpis>
      {entries.map((e) => {
        const isCurrent =
          e.kind === "tab"
            ? currentTab === e.tab
            : currentLifecycle === e.lifecycle && currentTab === "all";
        return (
          <li key={e.key}>
            <button
              type="button"
              onClick={() =>
                e.kind === "tab" ? onTab(e.tab) : onLifecycle(e.lifecycle)
              }
              style={{
                ...kpiCardStyle,
                cursor: "pointer",
                borderColor: isCurrent ? "#1e40af" : "#e5e7eb",
                boxShadow: isCurrent ? "0 0 0 2px #dbeafe" : "none",
              }}
              data-intake-links-kpi={e.key}
              data-intake-links-kpi-active={isCurrent ? "true" : "false"}
              data-intake-links-kpi-kind={e.kind}
              aria-pressed={isCurrent}
            >
              <span style={kpiValueStyle}>{e.value}</span>
              <span style={kpiLabelStyle}>{e.label}</span>
            </button>
          </li>
        );
      })}
      <li style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => onTab(t)}
            style={{
              ...tabPillStyle,
              backgroundColor: currentTab === t ? "#1e3a8a" : "#ffffff",
              color: currentTab === t ? "#ffffff" : "#1f2937",
              borderColor: currentTab === t ? "#1e3a8a" : "#d1d5db",
            }}
            data-intake-links-tab={t}
            data-intake-links-tab-active={currentTab === t ? "true" : "false"}
            aria-pressed={currentTab === t}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </li>
    </ul>
  );
}

// =============================================================================
// Console row — one per intake link.
// =============================================================================

function ConsoleRow({
  item,
  onOpenDetails,
  onRevoke,
  onArchive,
  onOpenDelivery,
  onOpenSubmissions,
}: {
  item: ConsoleItem;
  onOpenDetails: () => void;
  onRevoke: () => void;
  onArchive: () => void;
  onOpenDelivery: () => void;
  onOpenSubmissions: () => void;
}) {
  const { link, delivery, activity, computedLifecycle } = item;
  const chip = LIFECYCLE_CHIP[computedLifecycle];
  const isActive =
    link.status === "ACTIVE" &&
    computedLifecycle !== "EXPIRED" &&
    computedLifecycle !== "REVOKED";
  const archived = Boolean(link.archivedAtUtc);
  const channel = delivery.latestChannel ?? "MANUAL";
  const submissions = activity.sessionsSubmitted;
  const inProgress = activity.sessionsStarted - submissions;
  const lastActivityIso =
    activity.lastSubmittedAtUtc ??
    activity.lastStartedAtUtc ??
    activity.lastOpenedAtUtc ??
    delivery.latestAtUtc ??
    link.createdAt;
  const submissionsCell =
    submissions > 0 ? (
      <button
        type="button"
        onClick={onOpenSubmissions}
        style={inlineButtonStyle}
        data-intake-links-row-submissions
      >
        View ({submissions})
      </button>
    ) : inProgress > 0 ? (
      <span style={mutedSpanStyle}>In progress ({inProgress})</span>
    ) : (
      <span style={mutedSpanStyle}>None yet</span>
    );
  const recipientText =
    link.recipientLabel ??
    link.recipientEmailPreview ??
    link.recipientPhonePreview ??
    "No recipient";

  return (
    <tr
      style={trStyle}
      data-intake-links-row
      data-intake-links-row-id={link.id}
      data-intake-links-row-archived={archived ? "true" : "false"}
      data-intake-links-row-lifecycle={computedLifecycle}
    >
      <td style={tdStyle}>
        <button
          type="button"
          onClick={onOpenDetails}
          style={rowTitleButtonStyle}
          aria-label={`Open details for ${link.workflowTemplateName}`}
          data-intake-links-row-open-details
        >
          {link.workflowTemplateName}
        </button>
        <div style={mutedSubLineStyle}>
          {link.intakeMode === "EXTERNAL_ANONYMOUS"
            ? "Anonymous"
            : link.intakeMode === "EXTERNAL_PSEUDONYMOUS"
              ? "Alias"
              : link.intakeMode === "EXTERNAL_REUSABLE"
                ? "Reusable"
                : "One-time"}
          {archived ? " · Archived" : ""}
        </div>
      </td>
      <td style={tdStyle}>{recipientText}</td>
      <td style={tdStyle}>
        <span
          style={channelChipStyle}
          data-intake-links-row-channel={channel}
        >
          {CHANNEL_LABELS[
            (channel as ChannelFilter) in CHANNEL_LABELS
              ? (channel as ChannelFilter)
              : "MANUAL"
          ]}
        </span>
      </td>
      <td style={tdStyle}>
        <span
          style={{
            ...chipBaseStyle,
            backgroundColor: chip.bg,
            color: chip.fg,
            borderColor: chip.border,
          }}
          data-intake-links-row-lifecycle-chip={computedLifecycle}
        >
          {LIFECYCLE_LABELS[
            computedLifecycle as Exclude<LifecycleFilter, "">
          ] ?? computedLifecycle}
        </span>
      </td>
      <td style={tdStyle}>
        <DeliveryCell delivery={delivery} />
      </td>
      <td style={tdStyle}>
        {lastActivityIso ? describeRelativeTime(lastActivityIso) : "—"}
      </td>
      <td style={tdStyle}>
        <ExpiresCell expiresAtUtc={link.expiresAtUtc} />
      </td>
      <td style={tdStyle}>{submissionsCell}</td>
      <td style={tdStyleRight}>
        <RowMenu
          item={item}
          isActive={isActive}
          archived={archived}
          onOpenDetails={onOpenDetails}
          onRevoke={onRevoke}
          onArchive={onArchive}
          onOpenDelivery={onOpenDelivery}
          onOpenSubmissions={onOpenSubmissions}
        />
      </td>
    </tr>
  );
}

function DeliveryCell({ delivery }: { delivery: ConsoleItem["delivery"] }) {
  if (delivery.attemptCount === 0) {
    return <span style={mutedSpanStyle}>Not sent</span>;
  }
  // Truthful labels: QUEUED never lies as "Delivered". A row is only
  // "Delivered" when the provider's StatusCallback webhook has
  // confirmed it. "Sent to provider" reflects ok=true from POST
  // /Messages.json (Twilio accepted the job, hasn't yet handed off).
  // "Queued with provider" reflects ongoing provider queueing —
  // operator can recheck with the recheck CLI if it stalls.
  const s = delivery.latestStatus ?? "UNKNOWN";
  const label =
    s === "QUEUED" || s === "RETRY_SCHEDULED"
      ? "Queued with provider"
      : s === "SENT"
        ? "Sent to provider"
        : s === "DELIVERED"
          ? "Delivered"
          : s === "FAILED" || s === "UNDELIVERED"
            ? "Failed"
            : s;
  // Surface error code when present so the operator can act without
  // opening the delivery drawer. Known WhatsApp/Twilio codes are
  // translated to plain English (e.g. 63016 → "WhatsApp template
  // required or not approved"); unknown codes pass through verbatim.
  const codeBit = delivery.latestErrorCode
    ? ` · ${friendlyTwilioErrorCode(delivery.latestErrorCode)}`
    : "";
  return (
    <span data-intake-links-row-delivery={s}>
      {label}
      {delivery.attemptCount > 1 ? ` · ${delivery.attemptCount} attempts` : ""}
      {codeBit}
    </span>
  );
}

/**
 * Friendly mapping of the Twilio error codes we routinely see on the
 * intake-link delivery path. Operators should never have to look up
 * a code from a row — the most common ones get a plain-English label
 * here, the rest fall through unchanged so we don't silently swallow
 * a new code.
 */
function friendlyTwilioErrorCode(code: string): string {
  switch (code) {
    case "63016":
      return "WhatsApp template required or not approved.";
    case "63015":
      return "WhatsApp recipient is not opted in / sandbox not joined.";
    case "63018":
      return "WhatsApp recipient blocked the sender.";
    case "63003":
      return "WhatsApp number is not a valid recipient.";
    case "30007":
      return "Carrier filtered the SMS as spam.";
    case "30008":
      return "Carrier reported the SMS as undeliverable.";
    default:
      return `code ${code}`;
  }
}

function ExpiresCell({ expiresAtUtc }: { expiresAtUtc: string }) {
  const t = new Date(expiresAtUtc).getTime();
  const now = Date.now();
  const expired = t <= now;
  const soon = !expired && t - now < 72 * 60 * 60 * 1000;
  const label = expired
    ? `Expired ${describeRelativeTime(expiresAtUtc)}`
    : describeRelativeTime(new Date(t).toISOString()).replace(" ago", "");
  return (
    <span
      style={{
        color: expired ? "#991b1b" : soon ? "#92400e" : "#1f2937",
        fontWeight: soon || expired ? 600 : 400,
      }}
      title={new Date(expiresAtUtc).toLocaleString()}
      data-intake-links-row-expires
    >
      {expired ? label : `in ${label}`}
    </span>
  );
}

function RowMenu(props: {
  item: ConsoleItem;
  isActive: boolean;
  archived: boolean;
  onOpenDetails: () => void;
  onRevoke: () => void;
  onArchive: () => void;
  onOpenDelivery: () => void;
  onOpenSubmissions: () => void;
}) {
  // Portal the menu out of the table so the table wrapper's
  // `overflow-x: auto` (which creates a block clipping context per
  // CSS spec) doesn't truncate the dropdown. We compute the panel's
  // viewport-fixed position from the trigger's bounding rect on
  // every open + window resize / scroll.
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(
    null,
  );
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLUListElement | null>(null);
  const { isActive, archived } = props;

  const positionPanel = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const PANEL_WIDTH = 200;
    const ESTIMATED_HEIGHT = 220;
    const margin = 8;
    // Right-align under the trigger, but flip up if the panel would
    // run off the bottom edge of the viewport.
    let top = rect.bottom + 4;
    if (top + ESTIMATED_HEIGHT > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - ESTIMATED_HEIGHT - 4);
    }
    let left = rect.right - PANEL_WIDTH;
    if (left < margin) left = margin;
    if (left + PANEL_WIDTH > window.innerWidth - margin) {
      left = window.innerWidth - PANEL_WIDTH - margin;
    }
    setCoords({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    positionPanel();
  }, [open, positionPanel]);

  useEffect(() => {
    if (!open) return;
    const onScroll = () => positionPanel();
    const onResize = () => positionPanel();
    const onClickAway = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (
        t &&
        !triggerRef.current?.contains(t) &&
        !panelRef.current?.contains(t)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("mousedown", onClickAway);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("mousedown", onClickAway);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, positionPanel]);

  const menu =
    open && coords && typeof window !== "undefined" ? (
      <ul
        ref={panelRef}
        role="menu"
        style={{
          ...menuPanelStyle,
          position: "fixed",
          top: coords.top,
          left: coords.left,
          right: "auto",
          margin: 0,
        }}
        data-intake-links-row-menu-panel
      >
        <li>
          <button
            type="button"
            role="menuitem"
            style={menuItemStyle}
            onClick={() => {
              setOpen(false);
              props.onOpenDetails();
            }}
            data-intake-links-row-action="details"
          >
            View details
          </button>
        </li>
        <li>
          <button
            type="button"
            role="menuitem"
            style={menuItemStyle}
            onClick={() => {
              setOpen(false);
              props.onOpenDelivery();
            }}
            data-intake-links-row-action="delivery"
          >
            Delivery history
          </button>
        </li>
        {props.item.activity.sessionsCreated > 0 ? (
          <li>
            <button
              type="button"
              role="menuitem"
              style={menuItemStyle}
              onClick={() => {
                setOpen(false);
                props.onOpenSubmissions();
              }}
              data-intake-links-row-action="submissions"
            >
              View submissions
            </button>
          </li>
        ) : null}
        {isActive ? (
          <li>
            <button
              type="button"
              role="menuitem"
              style={{ ...menuItemStyle, color: "#7f1d1d" }}
              onClick={() => {
                setOpen(false);
                props.onRevoke();
              }}
              data-intake-links-row-action="revoke"
            >
              Revoke link
            </button>
          </li>
        ) : null}
        <li>
          <button
            type="button"
            role="menuitem"
            style={menuItemStyle}
            onClick={() => {
              setOpen(false);
              props.onArchive();
            }}
            data-intake-links-row-action={archived ? "unarchive" : "archive"}
          >
            {archived ? "Unarchive" : "Archive"}
          </button>
        </li>
      </ul>
    ) : null;

  return (
    <div style={{ position: "relative", textAlign: "right" }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={menuTriggerStyle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Row actions"
        data-intake-links-row-menu-trigger
      >
        Actions ▾
      </button>
      {menu && typeof document !== "undefined"
        ? createPortal(menu, document.body)
        : null}
    </div>
  );
}

// =============================================================================
// Details drawer
// =============================================================================

function DetailsDrawer({
  item,
  onClose,
  onRevoke,
  onArchive,
  onOpenDelivery,
  onOpenSubmissions,
}: {
  item: ConsoleItem;
  onClose: () => void;
  onRevoke: () => void;
  onArchive: () => void;
  onOpenDelivery: () => void;
  onOpenSubmissions: () => void;
}) {
  const { link, delivery, activity, computedLifecycle } = item;
  const archived = Boolean(link.archivedAtUtc);
  const isActive =
    link.status === "ACTIVE" &&
    computedLifecycle !== "EXPIRED" &&
    computedLifecycle !== "REVOKED";
  return (
    <div
      role="dialog"
      aria-label="Link details"
      style={drawerBackdropStyle}
      onClick={onClose}
      data-intake-links-details-drawer
    >
      <aside
        style={drawerPanelStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <header style={drawerHeaderStyle}>
          <div style={{ minWidth: 0 }}>
            <h2 style={drawerTitleStyle}>{link.workflowTemplateName}</h2>
            <p style={drawerSubtitleStyle}>
              Link ID: <code>{link.id.slice(0, 8)}…</code>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={drawerCloseStyle}
            aria-label="Close details"
          >
            ✕
          </button>
        </header>

        {/* Overview */}
        <section style={drawerSectionStyle} data-intake-links-details-overview>
          <h3 style={drawerSectionHeadStyle}>Overview</h3>
          <dl style={dlStyle}>
            <dt style={dtStyle}>Request type</dt>
            <dd style={ddStyle}>
              {link.workflowTemplateName}{" "}
              <code style={mutedCodeStyle}>{link.workflowTemplateSlug}</code>
            </dd>
            <dt style={dtStyle}>Mode</dt>
            <dd style={ddStyle}>{link.intakeMode}</dd>
            <dt style={dtStyle}>Recipient</dt>
            <dd style={ddStyle}>
              {link.recipientLabel ?? "—"}
              {link.recipientEmailPreview ? (
                <span style={mutedSpanStyle}> · {link.recipientEmailPreview}</span>
              ) : null}
              {link.recipientPhonePreview ? (
                <span style={mutedSpanStyle}> · {link.recipientPhonePreview}</span>
              ) : null}
            </dd>
            <dt style={dtStyle}>Lifecycle</dt>
            <dd style={ddStyle}>
              {LIFECYCLE_LABELS[
                computedLifecycle as Exclude<LifecycleFilter, "">
              ] ?? computedLifecycle}
            </dd>
            <dt style={dtStyle}>Created</dt>
            <dd style={ddStyle}>{describeAbsoluteDate(link.createdAt)}</dd>
            <dt style={dtStyle}>Expires</dt>
            <dd style={ddStyle}>{describeAbsoluteDate(link.expiresAtUtc)}</dd>
            {link.revokedAtUtc ? (
              <>
                <dt style={dtStyle}>Revoked</dt>
                <dd style={ddStyle}>
                  {describeAbsoluteDate(link.revokedAtUtc)}
                  {link.revokedReason ? ` · ${link.revokedReason}` : ""}
                </dd>
              </>
            ) : null}
            {archived ? (
              <>
                <dt style={dtStyle}>Archived</dt>
                <dd style={ddStyle}>{describeAbsoluteDate(link.archivedAtUtc)}</dd>
              </>
            ) : null}
          </dl>
        </section>

        {/* Delivery */}
        <section style={drawerSectionStyle} data-intake-links-details-delivery>
          <h3 style={drawerSectionHeadStyle}>Delivery</h3>
          {delivery.attemptCount === 0 ? (
            <p style={mutedSpanStyle}>
              Nothing has been sent for this link yet.
            </p>
          ) : (
            <>
              <p style={{ margin: "4px 0" }}>
                Latest:{" "}
                <strong>{delivery.latestStatus ?? "Unknown"}</strong>{" "}
                via {delivery.latestChannel ?? "—"} ·{" "}
                {describeRelativeTime(delivery.latestAtUtc)}
              </p>
              <p style={mutedSpanStyle}>
                {delivery.attemptCount} attempt
                {delivery.attemptCount === 1 ? "" : "s"} across{" "}
                {delivery.channelsAttempted.length} channel
                {delivery.channelsAttempted.length === 1 ? "" : "s"}
              </p>
              {delivery.latestProviderMessageId === null &&
              delivery.attemptCount > 0 ? (
                <p style={{ ...mutedSpanStyle, marginTop: 6 }}>
                  Provider tracking unavailable for older attempts (legacy
                  rows pre-dating the SID column split).
                </p>
              ) : null}
              <button
                type="button"
                onClick={onOpenDelivery}
                style={drawerButtonStyle}
              >
                Open full delivery history
              </button>
            </>
          )}
        </section>

        {/* Activity timeline */}
        <section style={drawerSectionStyle} data-intake-links-details-activity>
          <h3 style={drawerSectionHeadStyle}>Activity</h3>
          <ul style={timelineStyle}>
            <TimelineRow
              label="Created"
              iso={link.createdAt}
            />
            <TimelineRow
              label="Sent"
              iso={delivery.latestSentAtUtc ?? delivery.latestAtUtc}
            />
            <TimelineRow
              label="Opened"
              iso={activity.firstOpenedAtUtc}
            />
            <TimelineRow
              label="Upload started"
              iso={activity.firstStartedAtUtc}
            />
            <TimelineRow
              label="Submitted"
              iso={activity.firstSubmittedAtUtc}
            />
            {link.revokedAtUtc ? (
              <TimelineRow label="Revoked" iso={link.revokedAtUtc} />
            ) : null}
            {archived ? (
              <TimelineRow label="Archived" iso={link.archivedAtUtc} />
            ) : null}
          </ul>
        </section>

        {/* Submissions */}
        <section style={drawerSectionStyle} data-intake-links-details-submissions>
          <h3 style={drawerSectionHeadStyle}>Submissions</h3>
          <p style={{ margin: "4px 0" }}>
            {activity.sessionsSubmitted} submitted ·{" "}
            {activity.sessionsStarted} in progress ·{" "}
            {activity.evidenceCount} evidence record
            {activity.evidenceCount === 1 ? "" : "s"} produced
          </p>
          {activity.sessionsCreated > 0 ? (
            <button
              type="button"
              onClick={onOpenSubmissions}
              style={drawerButtonStyle}
            >
              View submissions
            </button>
          ) : null}
        </section>

        {/* Safety */}
        <section style={drawerSectionStyle} data-intake-links-details-safety>
          <h3 style={drawerSectionHeadStyle}>Safety</h3>
          <p style={mutedSpanStyle}>
            The raw token is shown only once, immediately after creation.
            It is not stored or shown anywhere else. Contributors can
            submit files without accessing the workspace.
          </p>
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            {isActive ? (
              <button
                type="button"
                onClick={onRevoke}
                style={drawerDestructiveStyle}
              >
                Revoke link
              </button>
            ) : null}
            <button
              type="button"
              onClick={onArchive}
              style={drawerButtonStyle}
            >
              {archived ? "Unarchive" : "Archive"}
            </button>
          </div>
        </section>
      </aside>
    </div>
  );
}

function TimelineRow({ label, iso }: { label: string; iso: string | null }) {
  return (
    <li style={timelineLiStyle}>
      <span style={{ width: 140, color: "#4b5563" }}>{label}</span>
      <span>{iso ? describeAbsoluteDate(iso) : "—"}</span>
    </li>
  );
}

// =============================================================================
// Sort keys
// =============================================================================

function activitySortKey(item: ConsoleItem): string {
  return (
    item.activity.lastSubmittedAtUtc ??
    item.activity.lastStartedAtUtc ??
    item.activity.lastOpenedAtUtc ??
    item.delivery.latestAtUtc ??
    item.link.updatedAt
  );
}

// =============================================================================
// Styles — all CSS-in-JS so the component is drop-in (no global CSS
// dependencies, no styled-components, no Tailwind in this app).
// =============================================================================

const controlsRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  margin: "16px 0 8px",
  alignItems: "center",
};
const searchInputStyle: React.CSSProperties = {
  flex: "1 1 220px",
  minWidth: 200,
  padding: "8px 12px",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  fontSize: 14,
};
const selectStyle: React.CSSProperties = {
  padding: "8px 10px",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  fontSize: 13,
  backgroundColor: "#ffffff",
};
const clearButtonStyle: React.CSSProperties = {
  padding: "8px 12px",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  backgroundColor: "#ffffff",
  fontSize: 13,
  cursor: "pointer",
};
const metaLineStyle: React.CSSProperties = {
  margin: "4px 0 12px",
  fontSize: 13,
  color: "#4b5563",
};
const mutedSpanStyle: React.CSSProperties = { color: "#6b7280", fontSize: 13 };
const tableScrollStyle: React.CSSProperties = {
  overflowX: "auto",
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  backgroundColor: "#ffffff",
};
const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 14,
};
const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  borderBottom: "1px solid #e5e7eb",
  backgroundColor: "#f9fafb",
  fontSize: 12,
  fontWeight: 600,
  color: "#374151",
  whiteSpace: "nowrap",
};
const thStyleRight: React.CSSProperties = { ...thStyle, textAlign: "right" };
const trStyle: React.CSSProperties = {
  borderBottom: "1px solid #f3f4f6",
};
const tdStyle: React.CSSProperties = {
  padding: "12px",
  verticalAlign: "top",
};
const tdStyleRight: React.CSSProperties = { ...tdStyle, textAlign: "right" };
const emptyRowStyle: React.CSSProperties = {
  padding: 24,
  textAlign: "center",
  color: "#6b7280",
};
const inlineLinkStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#1d4ed8",
  cursor: "pointer",
  textDecoration: "underline",
  padding: 0,
  fontSize: "inherit",
};
const rowTitleButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#111827",
  fontWeight: 600,
  textAlign: "left",
  padding: 0,
  cursor: "pointer",
  fontSize: 14,
};
const mutedSubLineStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#6b7280",
  marginTop: 2,
};
const chipBaseStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 999,
  border: "1px solid",
  fontSize: 12,
  fontWeight: 600,
};
const channelChipStyle: React.CSSProperties = {
  ...chipBaseStyle,
  backgroundColor: "#eef2ff",
  color: "#3730a3",
  borderColor: "#c7d2fe",
};
const inlineButtonStyle: React.CSSProperties = {
  background: "#1e3a8a",
  border: "none",
  color: "#ffffff",
  padding: "4px 10px",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
};
const menuTriggerStyle: React.CSSProperties = {
  padding: "6px 10px",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  backgroundColor: "#ffffff",
  cursor: "pointer",
  fontSize: 13,
};
const menuPanelStyle: React.CSSProperties = {
  position: "absolute",
  right: 0,
  top: "100%",
  marginTop: 4,
  background: "#ffffff",
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  boxShadow: "0 8px 24px rgba(0,0,0,0.08)",
  listStyle: "none",
  padding: 4,
  margin: 0,
  zIndex: 20,
  minWidth: 180,
};
const menuItemStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  background: "none",
  border: "none",
  padding: "8px 10px",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 13,
  color: "#111827",
};
const kpiStripStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  listStyle: "none",
  padding: 0,
  margin: "12px 0 16px",
  alignItems: "center",
};
const kpiCardStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  background: "#ffffff",
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  padding: "8px 12px",
  minWidth: 110,
  textAlign: "left",
};
const kpiValueStyle: React.CSSProperties = {
  fontSize: 20,
  fontWeight: 700,
  color: "#111827",
  lineHeight: 1.2,
};
const kpiLabelStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#6b7280",
  marginTop: 2,
};
const tabPillStyle: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: 999,
  border: "1px solid",
  fontSize: 13,
  cursor: "pointer",
};
const paginationRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  margin: "12px 0",
  flexWrap: "wrap",
  gap: 8,
};
const pagerButtonStyle: React.CSSProperties = {
  padding: "6px 12px",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  backgroundColor: "#ffffff",
  cursor: "pointer",
  fontSize: 13,
};
const drawerBackdropStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.35)",
  zIndex: 60,
  display: "flex",
  justifyContent: "flex-end",
};
const drawerPanelStyle: React.CSSProperties = {
  width: "min(520px, 100%)",
  height: "100%",
  background: "#ffffff",
  padding: 20,
  overflowY: "auto",
  boxShadow: "-8px 0 24px rgba(0,0,0,0.12)",
};
const drawerHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 8,
  borderBottom: "1px solid #e5e7eb",
  paddingBottom: 12,
  marginBottom: 12,
};
const drawerTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 18,
  fontWeight: 700,
};
const drawerSubtitleStyle: React.CSSProperties = {
  margin: "4px 0 0",
  fontSize: 12,
  color: "#6b7280",
};
const drawerCloseStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  fontSize: 18,
  color: "#6b7280",
};
const drawerSectionStyle: React.CSSProperties = {
  borderTop: "1px solid #f3f4f6",
  paddingTop: 12,
  marginBottom: 8,
};
const drawerSectionHeadStyle: React.CSSProperties = {
  margin: "0 0 8px",
  fontSize: 13,
  fontWeight: 600,
  color: "#374151",
  textTransform: "uppercase",
  letterSpacing: 0.5,
};
const drawerButtonStyle: React.CSSProperties = {
  marginTop: 8,
  padding: "6px 12px",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  background: "#ffffff",
  cursor: "pointer",
  fontSize: 13,
};
const drawerDestructiveStyle: React.CSSProperties = {
  ...drawerButtonStyle,
  background: "#fef2f2",
  borderColor: "#fca5a5",
  color: "#7f1d1d",
};
const dlStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "140px 1fr",
  rowGap: 6,
  margin: 0,
};
const dtStyle: React.CSSProperties = { color: "#6b7280", fontSize: 13 };
const ddStyle: React.CSSProperties = { margin: 0, fontSize: 13 };
const mutedCodeStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#6b7280",
};
const timelineStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
};
const timelineLiStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  fontSize: 13,
  padding: "4px 0",
  borderBottom: "1px dashed #f3f4f6",
};
