/**
 * THE SENTENCE A RESULT COUNT SHOWS.
 *
 * =============================================================================
 * WHY THIS IS A SEPARATE MODULE
 * =============================================================================
 * It lived inside `ResultCount.tsx`, and its test could not import a `.tsx`
 * file, so the test carried a hand-copied duplicate of the logic. That worked
 * exactly until the logic changed: `total` was added, the component started
 * saying "Showing 100 of 250", and all eight tests kept passing against the
 * old copy. A test that duplicates the thing it tests stops being a test at
 * the first change and says nothing about it.
 *
 * Pure, no JSX, no React — so the component and the test use the same code.
 *
 * =============================================================================
 * AUTHORITY ORDER
 * =============================================================================
 * A weaker signal must never override a stronger one:
 *
 *   total     the server counted everything matching the filter — a fact
 *   hasMore   the server said whether another page exists — a fact
 *   cap       inferred from "we asked for N and got exactly N" — a guess
 *
 * Passing `shown` as `total` defeats all of it, which is why the caller
 * documentation says not to.
 */
export type ResultCountFacts = {
  /** Rows currently rendered. */
  shown: number;
  /** The server's count of everything matching the filter. Authoritative. */
  total?: number;
  /** The limit the request asked for. Only an inference about truncation. */
  cap?: number;
  /** The server's own answer about a further page. Beats `cap`. */
  hasMore?: boolean;
  /** Singular noun, lower case. */
  noun: string;
  /** Plural, where it is not the singular plus "s". */
  pluralNoun?: string;
  /** Whether a filter is currently narrowing the request. */
  filtered?: boolean;
  loading?: boolean;
  /**
   * The request FAILED.
   *
   * Without this a failed load is indistinguishable from an empty one: the
   * rows array is `[]` either way, and the count reads "No records yet" — a
   * confident statement that there is nothing, made at the moment the page
   * knows least. On a control plane where an operator checks whether a
   * workspace has any evidence at all, that is the wrong answer in the
   * dangerous direction.
   */
  failed?: boolean;
  /**
   * The server returned EVERY row.
   *
   * The one case where `shown` may be presented as the population. Not a
   * judgement the page gets to make on its own: the route must appear in
   * `apps/web/scripts/admin-complete-lists.mjs`, and an API test asserts the
   * handler still runs its query with no row cap. Without that, this is just
   * `rows.length` with a confident label on it.
   */
  complete?: boolean;
};

export function resultCountSentence({
  shown,
  total,
  cap,
  hasMore,
  noun,
  pluralNoun,
  filtered,
  loading,
  failed,
  complete,
}: ResultCountFacts): string {
  const plural = pluralNoun ?? `${noun}s`;
  const word = shown === 1 ? noun : plural;
  const totalWord = total === 1 ? noun : plural;

  const truncated =
    complete === true
      ? false
      : total !== undefined
        ? shown < total
        : (hasMore ?? (cap !== undefined && shown >= cap));

  // A retry in flight outranks the last failure — the page is no longer
  // reporting a stale error, it is asking again.
  if (loading) return `Loading ${plural}…`;

  // Before the empty wording, so a failed load never claims emptiness.
  if (failed) return `Count unavailable`;

  if (total === 0 || (total === undefined && shown === 0)) {
    return filtered ? `No ${plural} match these filters` : `No ${plural} yet`;
  }

  // A declared-complete list states its population without a server total,
  // because there is nothing the server held back.
  if (complete === true && total === undefined) {
    return `${shown} ${word}`;
  }

  if (total !== undefined) {
    // The only wording that states a fact rather than a bound.
    return truncated
      ? `Showing ${shown} of ${total} ${totalWord}`
      : `${total} ${totalWord}`;
  }

  if (truncated) {
    return cap !== undefined && hasMore === undefined
      ? `${shown} ${word} shown — the view is capped at ${cap}, so there may be more`
      : `${shown} ${word} loaded — more available`;
  }

  return `${shown} ${word}`;
}
