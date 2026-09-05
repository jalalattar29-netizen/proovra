"use client";

/**
 * REFLECT THE FILTERS IN THE ADDRESS BAR WITHOUT CANCELLING THE READER'S CLICK.
 *
 * ===========================================================================
 * WHAT THIS CAUGHT
 * ===========================================================================
 * Four admin list pages — `/admin/operations`, `/admin/users`,
 * `/admin/workspaces` and `/admin/evidence-ops/records` — wrote the shareable
 * URL from INSIDE the fetch callback, after the response landed:
 *
 *     const res = await apiFetch(`/v1/admin/incidents?${qs}`);
 *     setData(res);
 *     router.replace(`/admin/operations?${shareable}`);   // <- late
 *
 * A `router.replace` that lands after the reader has already clicked a link
 * out of the page navigates them back. Clicking the affected workspace, the
 * customer, a Runbook or an affected record within the load window put you
 * back on the list you just left, with no error and nothing to retry — the
 * click simply appeared not to work. Measured on `/admin/operations`: a click
 * 3s after arrival landed on `/admin/operations?status=OPEN`; the identical
 * click 9s after arrival landed on the record.
 *
 * ===========================================================================
 * WHY AN EFFECT ON THE FILTER STATE, NOT A GUARD ON THE REPLACE
 * ===========================================================================
 * The URL is a function of the FILTERS, not of the response — none of the four
 * pages used a single field of the response to build it. Deriving it where it
 * is actually derived from means it lands in the same tick as the fetch
 * kickoff rather than after the round trip, so the window in which a late
 * replace can cancel a navigation is one render instead of one request.
 *
 * The equality check is the second half: with it, a page whose URL already
 * says what the filters say issues no history entry at all, which is both the
 * common case on arrival and the case where a replace could only do harm.
 *
 * `/admin/identity/scim` is deliberately NOT a consumer: it replaces the URL
 * from the tab click itself, which is already a user gesture in the same tick.
 */

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Keep `pathname`'s query string equal to `values`, dropping empty entries.
 *
 * Only the keys in `values` are managed. A query parameter the page does not
 * declare is left alone rather than stripped, so a deep link carrying
 * something this page does not read survives.
 */
export function useUrlFilterSync(
  pathname: string,
  values: Record<string, string | number | boolean | null | undefined>,
): void {
  const router = useRouter();
  const here = usePathname();
  const current = useSearchParams();

  // Serialised so the effect depends on the VALUES rather than on the object
  // identity of a literal rebuilt on every render.
  const managed = Object.keys(values).sort();
  const target = new URLSearchParams(current.toString());
  for (const key of managed) {
    const raw = values[key];
    const text =
      raw === null || raw === undefined || raw === false ? "" : String(raw);
    if (text.trim()) target.set(key, text.trim());
    else target.delete(key);
  }
  const next = target.toString();
  const now = current.toString();

  useEffect(() => {
    // Another route is already rendering; replacing now would fight it.
    if (here !== pathname) return;
    if (next === now) return;
    router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false });
    // `next`/`now` are the serialised values; router/pathname are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [next, now, here, pathname]);
}
