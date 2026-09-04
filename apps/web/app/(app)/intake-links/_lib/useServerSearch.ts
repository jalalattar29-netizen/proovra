"use client";

import * as React from "react";

import { apiFetch } from "../../../../lib/api";
import type { IntakeLinkListItem } from "./types";

/**
 * SEARCH THAT ASKS THE SERVER.
 *
 * The page used to filter rows it had already been sent, which meant it could
 * only ever match the MASKED contact previews — "find the request I sent to
 * john@example.com" could not work by construction — and the Customer ID was
 * not on the client at all. Sending every recipient's real address to the
 * browser so a text box could match it would have been the wrong repair.
 *
 * So the match happens on the server, over the stored values, inside the
 * tenant-scoped query. This hook owns the small amount of timing that needs:
 * debounce the keystrokes, skip the request when the rows in hand already
 * answer the term, and report which term they answer so the local filter
 * knows not to re-filter them against masks that could never match.
 *
 * It lives here rather than in the page because the page is an orchestrator —
 * it mounts the shell, the gate and the surface — and a fetch-timing concern
 * growing inside it is how that stops being true.
 */
export function useServerSearch(options: {
  /** Null while no workspace is resolved; the hook then does nothing. */
  workspaceId: string | null;
  /** The raw contents of the search box. */
  term: string;
  /** Runs the fetch for a term. "" means "no search". */
  fetchFor: (workspaceId: string, term: string) => void | Promise<void>;
  debounceMs?: number;
}): {
  /** The term the rows currently in hand were fetched for; "" when none. */
  searchedFor: string;
} {
  const [searchedFor, setSearchedFor] = React.useState("");
  const { workspaceId, term, fetchFor, debounceMs = 300 } = options;

  React.useEffect(() => {
    if (!workspaceId) return;
    const next = term.trim();
    // Already answered — a refetch would return the same rows and reset the
    // table under the operator mid-read.
    if (next === searchedFor) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      // Recorded only once the rows are actually in hand, so a request that
      // failed or was superseded does not leave the local filter believing
      // the table already answers a term it never fetched.
      void Promise.resolve(fetchFor(workspaceId, next)).then(() => {
        if (!cancelled) setSearchedFor(next);
      });
    }, debounceMs);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [workspaceId, term, searchedFor, fetchFor, debounceMs]);

  return { searchedFor };
}

/**
 * Load the list for one workspace and one search term.
 *
 * `archiveScope=all` so the Archived tab has rows to match: the backend
 * default hides them and every tab then filters in memory off the same array,
 * which is what keeps the KPI counts and the table honest with each other.
 *
 * The term is a SERVER parameter. A Customer ID, a full address, or a phone
 * number written any of the ways people write phone numbers can only be
 * matched against the stored values — and the alternative, shipping every
 * recipient's contact details to the browser so a text box could filter them,
 * would undo the disclosure policy to save a round trip.
 */
export async function fetchIntakeLinkList(
  workspaceId: string,
  term: string,
): Promise<IntakeLinkListItem[]> {
  const base = `/v1/workflow/intake-links?teamId=${encodeURIComponent(
    workspaceId,
  )}&archiveScope=all`;
  const trimmed = term.trim();
  const res = (await apiFetch(
    trimmed ? `${base}&search=${encodeURIComponent(trimmed)}` : base,
    { method: "GET" },
  )) as { items?: IntakeLinkListItem[] };
  return res.items ?? [];
}
