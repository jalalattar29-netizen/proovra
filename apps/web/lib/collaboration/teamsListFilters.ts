/**
 * COLLABORATION TEAMS LIST — the filters, as the URL carries them
 * (members experience E).
 *
 * Search, status, type, sort and the governor's scope lived in component
 * state only, so a reload, a shared link, or Back from a Team's page put the
 * operator on the unfiltered list. The app's list convention is the URL
 * (`useUrlFilterSync`, as /reports and the admin lists use): read once on
 * arrival, written back on every change, with defaults omitted so the plain
 * path means "no filters".
 *
 * Unknown or stale values fall back to their default rather than reaching the
 * server, which validates every one of them again regardless.
 */
import {
  COLLABORATION_TEAM_TYPES,
  type CollaborationTeamStatus,
  type CollaborationTeamType,
} from "@proovra/shared";

export type TeamsStatusFilter = "ALL" | CollaborationTeamStatus;
export type TeamsTypeFilter = "ALL" | CollaborationTeamType;
export type TeamsSortKey = "ACTIVITY_DESC" | "ACTIVITY_ASC" | "NAME_ASC";
export type TeamsScope = "PARTICIPATING" | "ALL";

export type TeamsListFilters = {
  search: string;
  status: TeamsStatusFilter;
  type: TeamsTypeFilter;
  sort: TeamsSortKey;
  /** `null` = not stated in the URL; the governor default may apply. */
  scope: TeamsScope | null;
};

export const DEFAULT_TEAMS_LIST_FILTERS: TeamsListFilters = {
  search: "",
  status: "ALL",
  type: "ALL",
  sort: "ACTIVITY_DESC",
  scope: null,
};

const STATUSES: ReadonlyArray<TeamsStatusFilter> = ["ALL", "ACTIVE", "ARCHIVED"];
const SORTS: ReadonlyArray<TeamsSortKey> = ["ACTIVITY_DESC", "ACTIVITY_ASC", "NAME_ASC"];

function pick<T extends string>(raw: string | null, allowed: ReadonlyArray<T>): T | null {
  if (raw === null) return null;
  const upper = raw.trim().toUpperCase();
  return (allowed as ReadonlyArray<string>).includes(upper) ? (upper as T) : null;
}

export function teamsFiltersFromSearch(search: string): TeamsListFilters {
  const params = new URLSearchParams(search);
  return {
    search: (params.get("q") ?? "").slice(0, 200),
    status: pick(params.get("status"), STATUSES) ?? "ALL",
    type: pick(params.get("type"), ["ALL", ...COLLABORATION_TEAM_TYPES] as TeamsTypeFilter[]) ?? "ALL",
    sort: pick(params.get("sort"), SORTS) ?? "ACTIVITY_DESC",
    scope:
      params.get("scope") === "all"
        ? "ALL"
        : params.get("scope") === "mine"
          ? "PARTICIPATING"
          : null,
  };
}

/** The managed query keys; a default value is written as "absent". */
export function teamsFiltersToSearch(
  f: Omit<TeamsListFilters, "scope"> & { scope: TeamsScope | null },
): Record<string, string | null> {
  return {
    q: f.search.trim() || null,
    status: f.status === "ALL" ? null : f.status.toLowerCase(),
    type: f.type === "ALL" ? null : f.type.toLowerCase(),
    sort: f.sort === "ACTIVITY_DESC" ? null : f.sort.toLowerCase(),
    scope: f.scope === "ALL" ? "all" : f.scope === "PARTICIPATING" ? "mine" : null,
  };
}

/**
 * Whether anything narrows the list beyond its defaults — the condition for
 * offering "Clear filters". Scope is not a narrowing filter of the list's
 * contents in the same sense (it is a view the server may decline), so it is
 * not cleared by it.
 */
export function teamsFiltersActive(f: Omit<TeamsListFilters, "scope">): boolean {
  return (
    f.search.trim().length > 0 ||
    f.status !== "ALL" ||
    f.type !== "ALL" ||
    f.sort !== "ACTIVITY_DESC"
  );
}
