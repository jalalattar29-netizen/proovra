/**
 * F-21 (Free-user audit) — every page of `GET /v1/cases` for a picker.
 *
 * The route answered only its newest 200 cases, so the evidence filter and the
 * attach selector could not offer an older accessible case. It now pages with a
 * keyset cursor (`nextCursor`, services/pagination/keyset-cursor on the API);
 * a picker that lists every case follows it. MAX_PAGES is a runaway stop for a
 * cursor that never ends, not a product limit (200 per page).
 *
 * The caller performs each request itself, naming the literal `/v1/cases` URL,
 * so every consumer of the route stays visible at its own call site (the
 * capability map reads call sites, not this helper). `cursorParam` is "" for
 * the first page, then `cursor=<encoded>` to append to the caller's query.
 */
export const CASE_LIST_MAX_PAGES = 50;

type CasePage<T> = { items?: T[]; nextCursor?: string | null };

export async function listAllCases<T>(
  fetchPage: (cursorParam: string) => Promise<unknown>,
): Promise<{ items: T[] }> {
  const items: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < CASE_LIST_MAX_PAGES; page += 1) {
    const body = (await fetchPage(cursor ? `cursor=${encodeURIComponent(cursor)}` : "")) as CasePage<T> | null;
    if (Array.isArray(body?.items)) items.push(...body.items);
    cursor = typeof body?.nextCursor === "string" && body.nextCursor.length > 0 ? body.nextCursor : null;
    if (!cursor) break;
  }
  return { items };
}
