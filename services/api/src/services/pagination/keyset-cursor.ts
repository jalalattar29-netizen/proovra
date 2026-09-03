/**
 * KEYSET CURSORS FOR TIME-ORDERED LISTS.
 *
 * =============================================================================
 * WHY NOT `limit=200`
 * =============================================================================
 * Five admin lists — sessions, quarantined sessions, workspace security
 * events, MFA events and the recovery feed — each asked the server for its
 * cap and rendered whatever came back in one table. A workspace with 86 live
 * sessions produced a page nine screens tall; one with 500 would have been
 * silently truncated with nothing on the page to say so.
 *
 * A cursor fixes both. The page asks for 25 rows and the server says whether
 * another page exists, so the count on screen is a fact rather than a guess
 * (see apps/web/lib/ui/resultCountSentence.ts — `hasMore` outranks `cap`).
 *
 * =============================================================================
 * WHY KEYSET AND NOT OFFSET
 * =============================================================================
 * Every one of these lists is ordered by a timestamp descending, and rows are
 * inserted at the top while an operator reads. An offset cursor re-shows the
 * row that was pushed down by an insert and skips one on a delete; a keyset
 * cursor — "rows strictly after (timestamp, id)" — does neither, because it
 * names a position in the ORDER rather than a position in the array.
 *
 * The timestamp alone is not a total order (two events in the same
 * millisecond are real on a busy tenant), so the row id is the tiebreaker and
 * the query MUST order by `[{ <field>: "desc" }, { id: "desc" }]` for the
 * predicate below to be correct.
 *
 * =============================================================================
 * OPAQUE TO THE CLIENT
 * =============================================================================
 * The cursor is base64url of `{"at": <ISO>, "id": <uuid>}`. It is not a
 * secret — it names a row the caller has already been shown — but it is not a
 * contract either: the page echoes it back verbatim and never parses it. A
 * malformed one decodes to `null`, and the route answers 400 rather than
 * silently restarting from the top, which would make "Next" loop forever.
 */

export type KeysetKey = {
  /** The sort timestamp of the last row on the previous page. */
  at: Date;
  /** The id of that row — the tiebreaker within one timestamp. */
  id: string;
};

/** Small enough to bound the query string, large enough for any real key. */
const CURSOR_MAX_CHARS = 512;

/**
 * Loose on purpose: Prisma ids here are UUIDs, but the fake transports in
 * the test suites mint readable ids like `se-2`. What matters is that the
 * value is a short printable token — anything else is not a key.
 */
const ID_SHAPE = /^[A-Za-z0-9_.:-]{1,128}$/;

export function encodeKeysetCursor(key: {
  at: Date | string;
  id: string;
}): string {
  const at = key.at instanceof Date ? key.at.toISOString() : key.at;
  return Buffer.from(JSON.stringify({ at, id: key.id }), "utf8").toString(
    "base64url",
  );
}

/**
 * `undefined` for "no cursor was given", `null` for "a cursor was given and
 * it is not one". Callers turn the second into a 400.
 */
export function decodeKeysetCursor(
  cursor: string | null | undefined,
): KeysetKey | null | undefined {
  if (cursor === undefined || cursor === null || cursor === "") return undefined;
  if (typeof cursor !== "string" || cursor.length > CURSOR_MAX_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { at, id } = parsed as { at?: unknown; id?: unknown };
  if (typeof at !== "string" || typeof id !== "string") return null;
  if (!ID_SHAPE.test(id)) return null;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  return { at: date, id };
}

/**
 * The predicate for "strictly after `key`" under `<field> desc, id desc`.
 *
 * Returned as its own object so the caller can AND it with the list's
 * filters without either side clobbering the other's keys.
 */
export function keysetAfter<F extends string>(
  field: F,
  key: KeysetKey,
): { OR: Array<Record<string, unknown>> } {
  return {
    OR: [
      { [field]: { lt: key.at } },
      { [field]: key.at, id: { lt: key.id } },
    ],
  };
}

export type KeysetPage<T> = {
  rows: T[];
  nextCursor: string | null;
  hasMore: boolean;
};

/**
 * Split a `take: limit + 1` result into the page and its continuation.
 *
 * Fetching one row past the limit is what makes `hasMore` a fact rather than
 * the "we asked for N and got N" inference: the extra row, when present, IS
 * the next page's first row, and it is dropped rather than shown.
 */
export function keysetPage<T>(
  fetched: ReadonlyArray<T>,
  limit: number,
  keyOf: (row: T) => { at: Date | string; id: string },
): KeysetPage<T> {
  const hasMore = fetched.length > limit;
  const rows = hasMore ? fetched.slice(0, limit) : [...fetched];
  const last = rows[rows.length - 1];
  return {
    rows,
    hasMore,
    nextCursor: hasMore && last ? encodeKeysetCursor(keyOf(last)) : null,
  };
}
