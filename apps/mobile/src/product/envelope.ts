/**
 * READING A LIST ENVELOPE — one rule, for every list the app fetches.
 *
 * Two surfaces shipped unable to display a single row because the parser
 * guessed the envelope key and the tests were written from the same guess:
 *
 *   evidence legal notes / annotations   read `notes` / `annotations`
 *                                        route sends `{ items }`
 *   intake submissions                   read `submissions`
 *                                        route sends `{ link, sessions, totals }`
 *
 * Both then fell through to the bare payload, found it was not an array, and
 * reported an empty list. In an evidence product that is not a blank panel; it
 * is a false statement about the file - and it is indistinguishable, to the
 * person reading it, from a record that genuinely has nothing on it.
 *
 * So there is one reader, it is told the keys the route actually sends, and it
 * REFUSES anything else instead of returning `[]`. A shape we cannot read is
 * not an absence of data. The caller's existing error path turns the refusal
 * into a failure the user can see and report, which is what a client that has
 * fallen behind its server should do.
 *
 * `tools/contract-audit.mjs` reads the key list out of each call and checks it
 * against the handler in services/api/src/routes, so a future guess is caught
 * by the build rather than by somebody's missing evidence.
 */
export function listEnvelope(payload: unknown, keys: readonly string[]): unknown[] {
  // Some list routes answer with a bare array.
  if (Array.isArray(payload)) return payload;

  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of keys) {
      const value = record[key];
      if (Array.isArray(value)) return value;
    }
  }

  throw new Error(`Unreadable list response: expected an array under ${keys.join(" or ")}.`);
}
