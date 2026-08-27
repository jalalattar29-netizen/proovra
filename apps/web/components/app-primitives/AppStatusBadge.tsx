"use client";

/**
 * AppStatusBadge — semantic status pill for internal surfaces.
 *
 * Tone is the ONLY colour input, mapped to the app semantic contract:
 *   green healthy/active/completed · amber pending/warning/on-hold ·
 *   red destructive/failed · indigo selection/primary · slate neutral/closed.
 *
 * Visual style lives in `app-primitives.css` (`.app-status-badge[data-tone]`).
 */

import * as React from "react";

/**
 * Canonical semantic tones.
 *
 * `blue` is the OPERATIONAL / REVIEW-INFORMATIONAL tone. It is deliberately
 * distinct from `indigo`, which means active processing: a record that is
 * uploading and a record carrying operational notes are different statements,
 * and collapsing them onto one colour made the queue unreadable.
 */
export type AppTone =
  | "green"
  | "amber"
  | "red"
  | "indigo"
  | "blue"
  /**
   * ORANGE is a CLASSIFICATION tone, not a caution.
   *
   * `amber` already means "needs attention". A record TYPE borrowing it made
   * every report and every piece of evidence read as a warning, which is the
   * opposite of what a type label says.
   */
  | "orange"
  /**
   * PURPLE is the BRAND accent carrying WARNING severity.
   *
   * Distinct from `indigo`, which is the same family one weight darker and
   * means active processing / selection. The pair is deliberate: a severity
   * and a lifecycle state are read in different columns, and both always
   * carry their word.
   */
  | "purple"
  /**
   * SILVER is a CLOCK, not a caution — an approaching commitment.
   *
   * Distinct from `slate`, which means absent or unknown. "Due soon" and "no
   * commitment recorded" are opposite statements and must not share a grey.
   */
  | "silver"
  /**
   * BLACK is the TOTAL.
   *
   * Reserved for a figure that means "all of the above" rather than one
   * category within it. It is not a severity and never ranks against one.
   */
  | "black"
  | "slate"
  /**
   * INK is the DARKEST NEUTRAL — a TERMINAL state ("Closed").
   *
   * Distinct from `slate`, which is the tone for absent, unknown or genuinely
   * neutral. A record that has reached its end state is not missing
   * information; it is a settled fact, and it reads as ordinary ink rather
   * than as one more grey among the greys the page uses for absence.
   */
  | "ink";

/**
 * How the tone is painted.
 *
 * `soft` (default) is the tinted capsule most surfaces want. `solid` is the
 * compact filled rectangle a dense operational row wants, where the state is
 * the thing being scanned. Both read the SAME `tone`, so a surface can change
 * how a state looks without being able to change what colour it means.
 */
export type AppBadgeFill = "soft" | "solid";

export interface AppStatusBadgeProps {
  tone: AppTone;
  children: React.ReactNode;
  /** Show a small leading dot in the tone colour. */
  dot?: boolean;
  fill?: AppBadgeFill;
  className?: string;
  title?: string;
  /**
   * Contract hooks. Surfaces pin `data-*` attributes on their status chips so
   * end-to-end probes can read state out of the DOM; without a passthrough
   * every such call site has to wrap the badge in a second span purely to
   * carry the attribute. Only `data-` keys are accepted — this is not a
   * general prop escape hatch.
   */
  [dataAttr: `data-${string}`]: unknown;
}

export function AppStatusBadge({
  tone,
  children,
  dot = false,
  fill = "soft",
  className,
  title,
  ...dataAttrs
}: AppStatusBadgeProps) {
  return (
    <span
      className={`app-status-badge${className ? ` ${className}` : ""}`}
      data-tone={tone}
      data-fill={fill}
      title={title}
      {...dataAttrs}
    >
      {dot ? <span className="app-status-badge__dot" aria-hidden /> : null}
      {children}
    </span>
  );
}

export default AppStatusBadge;
