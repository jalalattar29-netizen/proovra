"use client";

import type { CSSProperties, ReactNode } from "react";

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
  cap,
  hasMore,
  noun,
  pluralNoun,
  filtered,
  loading,
  action,
  style,
  "data-testid": testId,
}: ResultCountProps) {
  const plural = pluralNoun ?? `${noun}s`;
  const word = shown === 1 ? noun : plural;

  // `hasMore` is the server's own answer and always wins. `cap` is the
  // client's inference from "we asked for N and got exactly N".
  const truncated = hasMore ?? (cap !== undefined && shown >= cap);

  let text: string;
  if (loading) {
    text = `Loading ${plural}…`;
  } else if (shown === 0) {
    text = filtered ? `No ${plural} match these filters` : `No ${plural} yet`;
  } else if (truncated) {
    text = cap !== undefined && hasMore === undefined
      ? `${shown} ${word} shown — the view is capped at ${cap}, so there may be more`
      : `${shown} ${word} shown — more are available`;
  } else {
    text = `${shown} ${word}`;
  }

  return (
    <div style={{ ...rowStyle, ...style }} data-testid={testId}>
      <span>{text}</span>
      {action ?? null}
    </div>
  );
}
