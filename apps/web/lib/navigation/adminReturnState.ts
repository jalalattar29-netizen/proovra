/**
 * PHASE 6 §7 — THE INVESTIGATION SURVIVES THE DRILL-DOWN.
 *
 * An operator filters a list to three rows, opens one, acts on it, and comes
 * back to the unfiltered first page of everything. They then re-type the
 * filter. That is the loop this module closes.
 *
 * ===========================================================================
 * WHY A SINGLE ENCODED PARAMETER
 * ===========================================================================
 * The obvious alternative — copy the list's whole query string onto the detail
 * URL — collides: a detail page has its own parameters, and a list filter
 * named `status` would fight the detail's own `status`. So the list state
 * travels as ONE opaque parameter that no detail page reads, and the return
 * link decodes it.
 *
 * ===========================================================================
 * WHAT IS ALLOWED TO TRAVEL
 * ===========================================================================
 * An allowlist, not the whole query. §7 forbids putting secrets, personal data
 * or transient authorization material in a URL, and "copy whatever happens to
 * be there" is how a token added to a list URL next year would silently start
 * travelling too. Only names that describe a POSITION IN A COLLECTION are
 * carried; anything else is dropped.
 *
 * A search term is carried, and is the one judgement call here: it is already
 * in the list's own URL, visible in the address bar and in history, so
 * carrying it back adds no exposure that the operator has not already created
 * by typing it. It is bounded so a pathological value cannot become the URL.
 */

/** Parameter names that describe where you were in a collection. */
const LIST_STATE_PARAMS = new Set([
  "search",
  "q",
  "status",
  "priority",
  "severity",
  "source",
  "kind",
  "kinds",
  "outcome",
  "actorType",
  "category",
  "tab",
  "sort",
  "order",
  "page",
  "cursor",
  "limit",
  "from",
  "until",
  "range",
  "workspaceId",
  "organizationId",
]);

/** The parameter the encoded list state travels in. */
export const RETURN_STATE_PARAM = "back";

const MAX_ENCODED_LENGTH = 512;
const MAX_VALUE_LENGTH = 200;

/**
 * Capture the part of a query string that describes a position in a list.
 *
 * Returns null when there is nothing worth carrying, so a caller can link to
 * the bare collection rather than to `?back=` with an empty value.
 */
export function captureListState(
  search: string | URLSearchParams | null | undefined,
): string | null {
  if (!search) return null;
  const params =
    typeof search === "string" ? new URLSearchParams(search) : search;
  const kept = new URLSearchParams();
  for (const [key, value] of params.entries()) {
    if (!LIST_STATE_PARAMS.has(key)) continue;
    if (!value) continue;
    /*
     * An over-long value is DROPPED, not truncated.
     *
     * Truncating it would carry the operator back to a filter that is not
     * the one they had — a list narrowed by the first 200 characters of
     * their search, presented as the search they typed. Returning to the
     * unfiltered collection is visibly not what they left; returning to a
     * silently different filter is not.
     */
    if (value.length > MAX_VALUE_LENGTH) continue;
    kept.append(key, value);
  }
  const encoded = kept.toString();
  if (!encoded) return null;
  return encoded.length > MAX_ENCODED_LENGTH ? null : encoded;
}

/**
 * Build the href for a detail page, carrying the list state you are leaving.
 *
 * `detailHref` is the canonical route; the list state is appended as the one
 * opaque parameter. A detail page never reads it — only the return link does.
 */
export function detailHrefWithReturn(
  detailHref: string,
  listSearch: string | URLSearchParams | null | undefined,
): string {
  const state = captureListState(listSearch);
  if (!state) return detailHref;
  const sep = detailHref.includes("?") ? "&" : "?";
  return `${detailHref}${sep}${RETURN_STATE_PARAM}=${encodeURIComponent(state)}`;
}

/**
 * Rebuild the list href an operator should return to.
 *
 * Falls back to the bare collection when no state travelled, which is the
 * honest answer: it is where they were, minus a filter we were not told about.
 * The state is re-filtered through the same allowlist on the way OUT, so a
 * hand-edited `back=` cannot inject a parameter the list would then act on.
 */
export function returnHrefFor(
  parentHref: string,
  search: string | URLSearchParams | null | undefined,
): string {
  if (!search) return parentHref;
  const params =
    typeof search === "string" ? new URLSearchParams(search) : search;
  const raw = params.get(RETURN_STATE_PARAM);
  if (!raw) return parentHref;
  const state = captureListState(raw);
  if (!state) return parentHref;
  const sep = parentHref.includes("?") ? "&" : "?";
  return `${parentHref}${sep}${state}`;
}
