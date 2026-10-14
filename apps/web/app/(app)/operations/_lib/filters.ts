/**
 * Operations workbench — the filter state and the ONE place it becomes a query.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO CLIENT-SIDE FILTER PIPELINE HERE
 * ---------------------------------------------------------------------------
 * The obvious shape for this file is the one Intake Links uses: fetch the
 * collection, then filter, sort and paginate it in the browser. That is right
 * there because a workspace has tens of intake links.
 *
 * It is wrong here. Operations is a keyset-paginated collection that can hold
 * thousands of conditions, and the server returns ONE page. Filtering that page
 * in the browser would produce a surface that says "3 conditions" when it means
 * "3 of the 50 rows I happen to have loaded" — and an operator who filters to
 * Critical, sees an empty table and concludes there are none would be wrong in
 * exactly the situation where being wrong is most expensive.
 *
 * So every filter on this surface is a SERVER filter. This module turns the
 * state into a query string and back into a URL, and does no filtering itself.
 * The result count the toolbar renders is therefore the server's count for the
 * whole filtered collection, bounded by the same completeness flag the list
 * carries.
 */

import {
  INCIDENT_CATEGORIES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUS_FILTERS,
  type IncidentCategory,
  type IncidentSeverity,
  type IncidentStatusFilter,
} from "./types";
import type { SlaPosture } from "./types";
import { SORT_VALUES, type QueueMetricKey, type SortValue } from "./vocabulary";

/** The sentinel an AppListbox uses for "no constraint". */
export const ANY = "__any__";

/**
 * Ownership filter values.
 *
 * `me` and `unassigned` are the two a triage surface actually uses. A specific
 * other operator is reachable through the same control when the workspace has
 * eligible operators to name.
 */
export type OwnerFilter = "any" | "me" | "unassigned" | (string & {});

export type FilterState = {
  /**
   * One posture from the closed SLA vocabulary, or "" for no SLA filter.
   *
   * Carried in the URL like every other filter, so a filtered queue stays
   * shareable and a saved view can restore it.
   */
  sla: SlaPosture | "";
  /**
   * One stored status, the canonical unresolved set (UNRESOLVED = OPEN +
   * ACKNOWLEDGED + SUPPRESSED), or ALL (history included). Never "": an
   * absent `?status=` is the page default, ALL, and the state says so.
   */
  status: IncidentStatusFilter;
  severity: IncidentSeverity | "";
  category: IncidentCategory | "";
  owner: OwnerFilter;
  q: string;
  sort: SortValue;
};

/**
 * The default view is EVERY lifecycle state (2026-10-14).
 *
 * `/operations` with no query opens the flat "All conditions" list with
 * lifecycle ALL — open, acknowledged, silenced and resolved — so a workspace
 * whose only conditions are resolved history SEES that history instead of an
 * empty queue under a reassuring panel. The Status control says "All", and
 * the result count says "all statuses", so nothing is hidden by an invisible
 * unresolved filter.
 *
 * The 2026-10-12 contract is kept where it belongs: every KPI card still
 * opens the list with EXACTLY the predicate it counted (`filtersForMetric`
 * sets UNRESOLVED explicitly), and the grouped sections are partitions of the
 * unresolved set (see `groupsQuery`'s `sections` flag).
 *
 * An explicit `?status=` in the URL still wins — see `filtersFromParams`.
 */
export const DEFAULT_FILTERS: FilterState = Object.freeze({
  sla: "",
  status: "ALL",
  severity: "",
  category: "",
  owner: "any",
  q: "",
  sort: "recent",
});

/** True when anything differs from the default view, the sort order included. */
export function anyFilterActive(f: FilterState): boolean {
  return anyNarrowingFilter(f) || f.sort !== DEFAULT_FILTERS.sort;
}

/**
 * True when anything changes WHICH conditions are selected.
 *
 * The sort order is deliberately not one of them. It reorders the flat list
 * and nothing else, so it must never decide whether the grouped default
 * view's sections render — a sort control that silently hid "Action
 * required" and "Monitoring" was the defect (2026-10-12).
 */
export function anyNarrowingFilter(f: FilterState): boolean {
  return (
    f.sla !== "" ||
    f.status !== DEFAULT_FILTERS.status ||
    f.severity !== "" ||
    f.category !== "" ||
    f.owner !== "any" ||
    f.q.trim() !== ""
  );
}

// ---------------------------------------------------------------------------
// URL <-> state
// ---------------------------------------------------------------------------

function readEnum<T extends string>(
  raw: string | null,
  allowed: readonly T[],
): T | "" {
  if (!raw) return "";
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : "";
}

/**
 * Parse filters out of the URL.
 *
 * Unknown values fall back to the default rather than throwing. A shared link
 * carrying a filter value a later build removed should open the workbench, not
 * a crash — and silently widening a filter is safe here in a way that silently
 * narrowing one would not be.
 */
/**
 * The SLA postures a FILTER may name.
 *
 * Mirrors the server's closed vocabulary. Kept as a local constant rather than
 * derived from a response because the codec runs before any response arrives —
 * and an unrecognised value is dropped, so a drift here can only ever widen
 * the queue, never silently narrow it.
 */
export const SLA_POSTURE_VALUES = [
  "UNTRACKED_LEGACY",
  "NOT_APPLICABLE",
  "ON_TRACK",
  "AT_RISK",
  "BREACHED",
  "ACKNOWLEDGED",
  "RESOLVED",
] as const;

export function filtersFromParams(
  params: URLSearchParams | null,
): FilterState {
  if (!params) return { ...DEFAULT_FILTERS };
  const statusRaw = params.get("status");
  // `status=all` is the legacy spelling of ALL, kept so an old link still
  // means what it said.
  const status: IncidentStatusFilter =
    statusRaw === "all"
      ? "ALL"
      : (readEnum(statusRaw, INCIDENT_STATUS_FILTERS) || DEFAULT_FILTERS.status);
  const sortRaw = params.get("sort");
  const sort = (SORT_VALUES as readonly string[]).includes(sortRaw ?? "")
    ? (sortRaw as SortValue)
    : DEFAULT_FILTERS.sort;
  const ownerRaw = params.get("owner");
  return {
    // Read through the closed vocabulary: an unrecognised posture becomes NO
    // filter rather than one nothing can satisfy, which would render an empty
    // queue that looks like good news.
    sla: readEnum(params.get("sla"), SLA_POSTURE_VALUES) as FilterState["sla"],
    status,
    severity: readEnum(params.get("severity"), INCIDENT_SEVERITIES),
    category: readEnum(params.get("category"), INCIDENT_CATEGORIES),
    owner: ownerRaw && ownerRaw.length <= 64 ? ownerRaw : "any",
    q: (params.get("q") ?? "").slice(0, 120),
    sort,
  };
}

/**
 * Serialise filters for the address bar.
 *
 * Only non-default values are written, so the ordinary view has a clean URL
 * and a pasted link carries exactly the deviations the sender chose. An
 * ABSENT status means the default (ALL); every narrower lifecycle — the
 * unresolved set included — is written explicitly.
 */
export function filtersToParams(f: FilterState): URLSearchParams {
  const p = new URLSearchParams();
  if (f.sla) p.set("sla", f.sla);
  if (f.status !== DEFAULT_FILTERS.status) p.set("status", f.status);
  if (f.severity) p.set("severity", f.severity);
  if (f.category) p.set("category", f.category);
  if (f.owner !== "any") p.set("owner", f.owner);
  if (f.q.trim()) p.set("q", f.q.trim());
  if (f.sort !== DEFAULT_FILTERS.sort) p.set("sort", f.sort);
  return p;
}

// ---------------------------------------------------------------------------
// PRESENTATION — a separate dimension from the lifecycle filter (2026-10-14)
// ---------------------------------------------------------------------------

/**
 * How the selected conditions are SHOWN: the flat "All conditions" list (the
 * default) or grouped by source. Orthogonal to every filter above — it never
 * changes which conditions are selected, so it is not part of `FilterState`
 * and never reaches the API query.
 *
 * Carried in the URL as `?view=grouped` (the default is absent), so refresh
 * keeps it and browser Back/Forward restores it exactly.
 */
export type Presentation = "flat" | "grouped";
export const DEFAULT_PRESENTATION: Presentation = "flat";
export const VIEW_PARAM = "view";

export function presentationFromParams(params: URLSearchParams | null): Presentation {
  return params?.get(VIEW_PARAM) === "grouped" ? "grouped" : DEFAULT_PRESENTATION;
}

/**
 * The address for a filter state and a presentation. The drawer address
 * (`?incident=`) is preserved when given, so changing a filter never closes
 * a condition the operator is reading, and opening one never resets filters.
 */
export function operationsHref(
  filters: FilterState,
  presentation: Presentation,
  incidentId?: string | null,
): string {
  const p = filtersToParams(filters);
  if (presentation !== DEFAULT_PRESENTATION) p.set(VIEW_PARAM, presentation);
  if (incidentId) p.set("incident", incidentId);
  const qs = p.toString();
  return qs ? `/operations?${qs}` : "/operations";
}

// ---------------------------------------------------------------------------
// state -> API query
// ---------------------------------------------------------------------------

/** How many conditions one page of the workbench holds. */
export const PAGE_SIZE = 50;

/**
 * Build the query string for `GET /v1/ops/incidents`.
 *
 * The cursor is the ONLY thing that changes between "first page" and "next
 * page": every filter is re-sent verbatim, so a page-2 read cannot silently
 * apply a different predicate from the page-1 read that produced its cursor.
 */
/**
 * The query for `GET /v1/ops/incident-groups`: the SAME predicate as the flat
 * list (minus sort and paging), so the grouped and flat views select the same
 * conditions.
 */
export function groupsQuery(input: {
  teamId: string;
  filters: FilterState;
  /**
   * The grouped SECTIONS read (no narrowing filter): "Action required" and
   * "Monitoring" are partitions of the UNRESOLVED set, so this read asks for
   * exactly that set whatever the lifecycle default is. Under ALL a group's
   * posture would be OPEN while its count also carried resolved members —
   * a section count that is not what its heading says. Resolved history has
   * its own section and its own read.
   */
  sections?: boolean;
}): string {
  const p = new URLSearchParams({ teamId: input.teamId });
  p.set(
    "status",
    input.sections ? "UNRESOLVED" : input.filters.status || DEFAULT_FILTERS.status,
  );
  if (input.filters.severity) p.set("severity", input.filters.severity);
  if (input.filters.category) p.set("category", input.filters.category);
  if (input.filters.owner && input.filters.owner !== "any") p.set("owner", input.filters.owner);
  if (input.filters.sla) p.set("sla", input.filters.sla);
  const q = input.filters.q.trim();
  if (q) p.set("q", q);
  return p.toString();
}

export function incidentsQuery(input: {
  teamId: string;
  filters: FilterState;
  cursor?: string | null;
}): string {
  const p = new URLSearchParams();
  p.set("teamId", input.teamId);
  if (input.filters.sla) p.set("sla", input.filters.sla);
  // ALWAYS sent, the default included: the list must be read with the exact
  // predicate the KPI that opened it counted with, not with whatever the
  // server happens to default to.
  p.set("status", input.filters.status || DEFAULT_FILTERS.status);
  if (input.filters.severity) p.set("severity", input.filters.severity);
  if (input.filters.category) p.set("category", input.filters.category);
  if (input.filters.owner !== "any") p.set("owner", input.filters.owner);
  const q = input.filters.q.trim();
  if (q) p.set("q", q);
  p.set("sort", input.filters.sort);
  p.set("limit", String(PAGE_SIZE));
  if (input.cursor) p.set("cursor", input.cursor);
  return p.toString();
}

// ---------------------------------------------------------------------------
// KPI <-> filters (2026-10-12)
// ---------------------------------------------------------------------------

/**
 * The KPI a filter state is EXACTLY the predicate of, or null.
 *
 * Derived from the filters rather than stored, so a browser Back that changes
 * the URL never leaves a highlighted card disagreeing with the queue.
 */
export function metricForFilters(f: FilterState): QueueMetricKey | null {
  if (f.category !== "" || f.q.trim() !== "") return null;
  if (f.status === "RESOLVED") {
    return f.sla === "" && f.severity === "" && f.owner === "any" ? "resolved" : null;
  }
  if (f.status !== "UNRESOLVED") return null;
  const onlySla = f.severity === "" && f.owner === "any";
  const onlySeverity = f.sla === "" && f.owner === "any";
  const onlyOwner = f.sla === "" && f.severity === "";
  if (f.sla === "BREACHED" && onlySla) return "slaBreached";
  if (f.sla === "AT_RISK" && onlySla) return "slaAtRisk";
  if (f.severity === "CRITICAL" && onlySeverity) return "critical";
  if (f.severity === "HIGH" && onlySeverity) return "high";
  if (f.severity === "WARNING" && onlySeverity) return "warning";
  if (f.owner === "me" && onlyOwner) return "assignedToMe";
  if (f.owner === "unassigned" && onlyOwner) return "unassigned";
  // The Unresolved card's predicate is the unresolved set and nothing else.
  // Since the default lifecycle became ALL (2026-10-14) that is a CHOSEN
  // view, so the card that opened it shows as the one driving the queue.
  if (f.sla === "" && f.severity === "" && f.owner === "any") return "open";
  return null;
}

/**
 * The filter state a KPI card opens: EXACTLY the predicate that produced its
 * count. Every card sets every axis it implies and clears the ones it does
 * not; the unresolved cards all carry status UNRESOLVED, Resolved carries
 * RESOLVED.
 */
export function filtersForMetric(key: QueueMetricKey): FilterState {
  const base: FilterState = { ...DEFAULT_FILTERS, status: "UNRESOLVED" };
  switch (key) {
    case "slaBreached":
      return { ...base, sla: "BREACHED" };
    case "slaAtRisk":
      return { ...base, sla: "AT_RISK" };
    case "critical":
      return { ...base, severity: "CRITICAL" };
    case "high":
      return { ...base, severity: "HIGH" };
    case "warning":
      return { ...base, severity: "WARNING" };
    case "resolved":
      return { ...base, status: "RESOLVED" };
    case "assignedToMe":
      return { ...base, owner: "me" };
    case "unassigned":
      return { ...base, owner: "unassigned" };
    case "open":
    default:
      return base;
  }
}
