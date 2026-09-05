"use client";

import type { CSSProperties, ReactNode } from "react";

import { resultCountSentence } from "../../lib/ui/resultCountSentence";

/**
 * HOW MANY ROWS, AND WHETHER THAT IS ALL OF THEM.
 *
 * =============================================================================
 * WHY THIS IS NOT JUST `{rows.length} items`
 * =============================================================================
 * Ten admin lists rendered rows and never said how many. That alone is a small
 * fault. What the audit turned up underneath it is the real one: most of those
 * lists are CAPPED — the identity runtime asks for 500 sessions, the identity
 * audit for 250 events, operations for 200 incidents, queues and automation
 * for 50 — and none of them says so.
 *
 * A capped list that reports a bare count is worse than one that reports
 * nothing, because "200 incidents" reads as the total. An operator counting
 * incidents during a review, or checking whether a workspace appears in a
 * list, gets a confident wrong answer. The page has to distinguish
 *
 *     200 incidents                  ← this is all of them
 *     200 incidents shown (capped)   ← there may be more you cannot see
 *
 * and a component is the only way that distinction survives ten call sites.
 *
 * =============================================================================
 * THE EMPTY CASES ARE ALSO TWO CASES
 * =============================================================================
 * "No incidents yet" and "No incidents match these filters" are different
 * statements, and showing the first while a filter is active tells the reader
 * their data is gone. `filtered` decides which one, and a caller that cannot
 * say is better off omitting it than guessing.
 */
export type ResultCountProps = {
  /** Rows currently rendered. */
  shown: number;
  /**
   * The server's count of everything matching the current filter.
   *
   * The AUTHORITATIVE number, and it outranks every inference below. With it
   * the component can say "Showing 100 of 250" instead of guessing from the
   * row count — which is the difference between a fact and an assumption
   * dressed as one.
   *
   * Omit it when the endpoint does not return a count. Do NOT pass shown.
   */
  total?: number;
  /**
   * The limit the request asked for, when there is one.
   *
   * When `shown === cap` the view is assumed truncated. That is a deliberate
   * over-report by at most one case — a collection whose size happens to equal
   * the cap exactly — and erring toward "there may be more" is the safe
   * direction for a page somebody makes decisions on.
   */
  cap?: number;
  /** True when the server said there is another page. Beats `cap`. */
  hasMore?: boolean;
  /** Singular noun, lower case: "incident", "session", "grant". */
  noun: string;
  /** Plural, when it is not the singular plus "s". */
  pluralNoun?: string;
  /** Whether any filter is currently narrowing the request. */
  filtered?: boolean;
  loading?: boolean;
  /**
   * The request failed. Without it an errored list renders "No records yet",
   * which states there is nothing at the one moment the page cannot know.
   */
  failed?: boolean;
  /**
   * The server returned every row, so `shown` IS the population.
   *
   * Only for a route declared in `scripts/admin-complete-lists.mjs`, where an
   * API test asserts the handler has no row cap. Setting it anywhere else
   * turns `rows.length` into a claim nothing supports.
   */
  complete?: boolean;
  /** A continuation control, rendered on the right when supplied. */
  action?: ReactNode;
  style?: CSSProperties;
  "data-testid"?: string;
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  flexWrap: "wrap",
  marginTop: 12,
  fontSize: 13,
  color: "var(--ink-secondary, #475569)",
};

export function ResultCount({
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
  action,
  style,
  "data-testid": testId,
}: ResultCountProps) {
  // The sentence lives in lib/ui/resultCountSentence so its test can import
  // it. It used to be inline, and the test carried a hand-copied duplicate
  // that kept passing after the logic changed underneath it.
  const text = resultCountSentence({
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
  });

  /**
   * DON'T SAY IT TWICE.
   *
   * A list that is empty for the ordinary reason already says so, in its own
   * empty state, in a sentence written for that list. This component then
   * added "No entitlements yet" underneath — /admin/costs showed the pair
   * stacked, and so did every other all-empty admin list.
   *
   * It is suppressed ONLY for the plain empty case. Every other zero is
   * information the empty state cannot carry:
   *
   *   filtered  "No customers match these filters" is the one thing that
   *             distinguishes a filter that found nothing from no data.
   *   loading   the count is the only thing that says a read is in flight
   *             over an as-yet-empty table.
   *   failed    "Count unavailable" is the difference between a list that
   *             is empty and one that could not be read.
   *   action    a continuation control lives in this row and must render.
   */
  const redundantEmpty =
    shown === 0 &&
    (total === undefined || total === 0) &&
    !filtered &&
    !loading &&
    !failed &&
    action == null;
  if (redundantEmpty) return null;

  return (
    <div
      style={{ ...rowStyle, ...style }}
      data-testid={testId}
      /* Addressable. This carried nothing but an OPTIONAL test id, so on a
         page that did not pass one the count was unfindable by anything but
         a text match against its own sentence — which means no sweep could
         assert that a table states its count, and §14's "every list states
         how many" could only be checked by reading. The attribute is what
         makes the claim measurable. */
      data-result-count=""
      /* The sentence changes when a filter changes, and it is the only thing
         on the page that says a filter found nothing. Announcing it politely
         is what tells a screen-reader operator their filter did something. */
      role="status"
    >
      <span>{text}</span>
      {action ?? null}
    </div>
  );
}
