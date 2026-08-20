/**
 * Intake links — the filter / sort / pagination pipeline.
 *
 * Pure functions over the already-loaded `items` array. The list surface is a
 * renderer over `applyFilters`; the KPI counts come from `computeIntakeKpis`
 * in the state model. Both call the SAME `matchesIntakeTab` predicate, so a
 * card that says 5 can never sit above a table that shows 3.
 *
 * URL param names are frozen for bookmark compatibility: `failed` and `closed`
 * are the legacy aliases of the canonical `failed_delivery` and
 * `revoked_or_expired` tabs.
 */

import {
  getDeliveryState,
  getLinkOperationalState,
  matchesIntakeTab,
  type IntakeTab,
} from "../../../../lib/intake-links/state-model";
import {
  DELIVERY_FILTER_WIRE_VALUES,
  type DeliveryFilterWireValue,
  type SortWireValue,
  CHANNEL_WIRE_VALUES,
  type ChannelWireValue,
} from "../../../../lib/intake-links/vocabulary";
import type { IntakeLinkListItem } from "./types";

// ---------------------------------------------------------------------------
// Tabs (URL-facing)
// ---------------------------------------------------------------------------

export const TAB_PARAMS = [
  "all",
  "active",
  "submitted",
  "opened",
  "failed",
  "archived",
  "closed",
] as const;
export type TabParam = (typeof TAB_PARAMS)[number];

export function tabParamToIntakeTab(tab: TabParam): IntakeTab {
  switch (tab) {
    case "failed":
      return "failed_delivery";
    case "closed":
      return "revoked_or_expired";
    default:
      return tab;
  }
}

export function intakeTabToTabParam(tab: IntakeTab): TabParam {
  switch (tab) {
    case "failed_delivery":
      return "failed";
    case "revoked_or_expired":
      return "closed";
    default:
      return tab;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle filter
// ---------------------------------------------------------------------------
//
// The dropdown offers the FOUR operational states the operator can actually
// see on a row, not the backend's eight-value conflated enum. Filtering on a
// value the rows never display is how the previous console produced empty
// tables for no visible reason.

export const LIFECYCLE_FILTER_VALUES = [
  "ACTIVE",
  "ARCHIVED",
  "REVOKED",
  "EXPIRED",
] as const;
export type LifecycleFilterValue = (typeof LIFECYCLE_FILTER_VALUES)[number];

// ---------------------------------------------------------------------------
// Filter state
// ---------------------------------------------------------------------------

export type FilterState = {
  q: string;
  tab: TabParam;
  channel: ChannelWireValue | "";
  lifecycle: LifecycleFilterValue | "";
  delivery: DeliveryFilterWireValue | "";
  sort: SortWireValue;
  page: number;
  pageSize: number;
};

export const PAGE_SIZES = [25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

export const DEFAULT_FILTERS: FilterState = {
  q: "",
  tab: "all",
  channel: "",
  lifecycle: "",
  delivery: "",
  sort: "activity",
  page: 1,
  pageSize: 25,
};

function clampTo<T extends string>(
  value: string | null,
  allowed: ReadonlyArray<T>,
  fallback: T,
): T {
  return value && (allowed as ReadonlyArray<string>).includes(value)
    ? (value as T)
    : fallback;
}

export function filtersFromQuery(query: URLSearchParams): FilterState {
  const pageRaw = Number.parseInt(query.get("page") ?? "1", 10);
  const sizeRaw = Number.parseInt(query.get("pageSize") ?? "25", 10);
  return {
    q: query.get("q") ?? "",
    tab: clampTo(query.get("tab"), TAB_PARAMS, "all"),
    channel: clampTo(query.get("channel"), [...CHANNEL_WIRE_VALUES, ""], ""),
    lifecycle: clampTo(
      query.get("lifecycle"),
      [...LIFECYCLE_FILTER_VALUES, ""],
      "",
    ),
    delivery: clampTo(
      query.get("delivery"),
      [...DELIVERY_FILTER_WIRE_VALUES, ""],
      "",
    ),
    sort: clampTo(query.get("sort"), ["activity", "created", "expires"], "activity"),
    page: Number.isFinite(pageRaw) && pageRaw >= 1 ? pageRaw : 1,
    pageSize: (PAGE_SIZES as ReadonlyArray<number>).includes(sizeRaw)
      ? (sizeRaw as PageSize)
      : 25,
  };
}

/** Only non-default values reach the address bar, so `/intake-links` is clean. */
export function filtersToQuery(state: FilterState): URLSearchParams {
  const q = new URLSearchParams();
  if (state.q.trim()) q.set("q", state.q.trim());
  if (state.tab !== DEFAULT_FILTERS.tab) q.set("tab", state.tab);
  if (state.channel) q.set("channel", state.channel);
  if (state.lifecycle) q.set("lifecycle", state.lifecycle);
  if (state.delivery) q.set("delivery", state.delivery);
  if (state.sort !== DEFAULT_FILTERS.sort) q.set("sort", state.sort);
  if (state.page !== 1) q.set("page", String(state.page));
  if (state.pageSize !== DEFAULT_FILTERS.pageSize) {
    q.set("pageSize", String(state.pageSize));
  }
  return q;
}

export function anyFilterActive(state: FilterState): boolean {
  return (
    state.q.trim() !== "" ||
    state.tab !== DEFAULT_FILTERS.tab ||
    state.channel !== "" ||
    state.lifecycle !== "" ||
    state.delivery !== "" ||
    state.sort !== DEFAULT_FILTERS.sort
  );
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

function matchesLifecycle(
  item: IntakeLinkListItem,
  lifecycle: LifecycleFilterValue | "",
  now: Date,
): boolean {
  if (!lifecycle) return true;
  return getLinkOperationalState(item.link, now) === lifecycle;
}

function matchesDelivery(
  item: IntakeLinkListItem,
  delivery: DeliveryFilterWireValue | "",
): boolean {
  if (!delivery) return true;
  if (delivery === "NONE") return item.delivery.latestStatus === null;
  // FAILED must also catch the states `getDeliveryState` folds into it,
  // otherwise the dropdown and the row chip disagree about the same row.
  if (delivery === "FAILED") return getDeliveryState(item.delivery) === "FAILED";
  return (
    String(item.delivery.latestStatus ?? "").toUpperCase() === delivery
  );
}

function matchesSearch(item: IntakeLinkListItem, qLower: string): boolean {
  if (!qLower) return true;
  const haystack = [
    item.link.workflowTemplateName,
    item.link.workflowTemplateSlug,
    item.link.recipientLabel,
    item.link.recipientEmailPreview,
    item.link.recipientPhonePreview,
    item.link.id.slice(0, 8),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(qLower);
}

function activitySortKey(item: IntakeLinkListItem): string {
  return (
    item.activity.lastSubmittedAtUtc ??
    item.activity.lastStartedAtUtc ??
    item.activity.lastOpenedAtUtc ??
    item.delivery.latestAtUtc ??
    item.link.updatedAt
  );
}

export type FilterResult = {
  /** Every row matching the filters, sorted. */
  matched: IntakeLinkListItem[];
  /** The rows on the current page. */
  visible: IntakeLinkListItem[];
  page: number;
  pageCount: number;
  pageStart: number;
};

export function applyFilters(
  items: ReadonlyArray<IntakeLinkListItem>,
  state: FilterState,
  now: Date = new Date(),
): FilterResult {
  const qLower = state.q.trim().toLowerCase();
  const intakeTab = tabParamToIntakeTab(state.tab);

  const matched = items.filter((item) => {
    if (!matchesIntakeTab(item, intakeTab, now)) return false;
    if (
      state.channel &&
      String(item.delivery.latestChannel ?? "MANUAL").toUpperCase() !==
        state.channel
    ) {
      return false;
    }
    if (!matchesLifecycle(item, state.lifecycle, now)) return false;
    if (!matchesDelivery(item, state.delivery)) return false;
    if (!matchesSearch(item, qLower)) return false;
    return true;
  });

  switch (state.sort) {
    case "activity":
      matched.sort((a, b) =>
        activitySortKey(b).localeCompare(activitySortKey(a)),
      );
      break;
    case "created":
      matched.sort((a, b) => b.link.createdAt.localeCompare(a.link.createdAt));
      break;
    case "expires":
      matched.sort((a, b) =>
        a.link.expiresAtUtc.localeCompare(b.link.expiresAtUtc),
      );
      break;
  }

  const pageCount = Math.max(1, Math.ceil(matched.length / state.pageSize));
  // A page beyond the end is clamped rather than rendered empty — a stale
  // bookmark must land on real rows, not on a blank table.
  const page = Math.min(Math.max(1, state.page), pageCount);
  const pageStart = (page - 1) * state.pageSize;

  return {
    matched,
    visible: matched.slice(pageStart, pageStart + state.pageSize),
    page,
    pageCount,
    pageStart,
  };
}
