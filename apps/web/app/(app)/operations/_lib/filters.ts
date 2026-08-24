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
  INCIDENT_STATUSES,
  type IncidentCategory,
  type IncidentSeverity,
  type IncidentStatus,
} from "./types";
import type { SlaPosture } from "./types";
import { SORT_VALUES, type SortValue } from "./vocabulary";

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
  status: IncidentStatus | "";
  severity: IncidentSeverity | "";
  category: IncidentCategory | "";
  owner: OwnerFilter;
  q: string;
  sort: SortValue;
};

/**
 * The default view is UNRESOLVED WORK.
 *
 * A workbench that opens showing every condition ever recorded, resolved ones
 * included, makes the operator's first action "filter out the noise". The
 * queue opens on what is still open; the Status control is right there and
 * says so.
 */
export const DEFAULT_FILTERS: FilterState = Object.freeze({
  sla: "",
  status: "OPEN",
  severity: "",
  category: "",
  owner: "any",
  q: "",
  sort: "recent",
});

/** True when anything narrows the collection beyond the default view. */
export function anyFilterActive(f: FilterState): boolean {
  return (
    f.sla !== "" ||
    f.status !== DEFAULT_FILTERS.status ||
    f.severity !== "" ||
    f.category !== "" ||
    f.owner !== "any" ||
    f.q.trim() !== "" ||
    f.sort !== DEFAULT_FILTERS.sort
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
  const status =
    statusRaw === "all"
      ? ""
      : (readEnum(statusRaw, INCIDENT_STATUSES) || DEFAULT_FILTERS.status);
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
 * and a pasted link carries exactly the deviations the sender chose.
 * `status=all` is spelled out because an ABSENT status means the default
 * (Open), not "no filter".
 */
export function filtersToParams(f: FilterState): URLSearchParams {
  const p = new URLSearchParams();
  if (f.sla) p.set("sla", f.sla);
  if (f.status !== DEFAULT_FILTERS.status) p.set("status", f.status || "all");
  if (f.severity) p.set("severity", f.severity);
  if (f.category) p.set("category", f.category);
  if (f.owner !== "any") p.set("owner", f.owner);
  if (f.q.trim()) p.set("q", f.q.trim());
  if (f.sort !== DEFAULT_FILTERS.sort) p.set("sort", f.sort);
  return p;
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
export function incidentsQuery(input: {
  teamId: string;
  filters: FilterState;
  cursor?: string | null;
}): string {
  const p = new URLSearchParams();
  p.set("teamId", input.teamId);
  if (input.filters.sla) p.set("sla", input.filters.sla);
  if (input.filters.status) p.set("status", input.filters.status);
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
