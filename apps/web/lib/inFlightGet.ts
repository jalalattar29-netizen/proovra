"use client";

/**
 * ONE REQUEST WHEN TWO COMPONENTS ASK THE SAME QUESTION AT THE SAME MOMENT.
 *
 * The sidebar storage widget and Home's data hook both read
 * `GET /v1/billing/overview`. The widget lives in the app shell, so on Home
 * they mount together and the page issues the request twice — measured in
 * Chrome, on every Home load.
 *
 * WHAT THIS IS NOT: a cache. Nothing is retained after the request settles, so
 * a later read — Home's focus revalidation, a fresh mount after an upload —
 * always goes to the server and always sees current data. The window in which
 * two callers share a response is the window in which the request is already
 * in flight, where they would otherwise have received two responses generated
 * milliseconds apart from the same rows.
 *
 * GETs only, and keyed by the full path including its query, because a request
 * that differs in a parameter is a different question. Nothing that mutates
 * goes through here.
 *
 * A rejection is shared too, and then forgotten: the entry is cleared in a
 * `finally`, so a failed read never poisons the next caller.
 */

const inFlight = new Map<string, Promise<unknown>>();

export function inFlightGet<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  const started = run().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, started);
  return started;
}

/** Test seam: how many reads are currently sharing a response. */
export function inFlightCount(): number {
  return inFlight.size;
}
