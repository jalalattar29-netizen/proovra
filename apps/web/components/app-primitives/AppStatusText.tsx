"use client";

/**
 * AppStatusText — a semantic state rendered as WORDS, with no surface.
 *
 * The sibling of `AppStatusBadge`, and deliberately not a variant of it. Both
 * read the SAME `AppTone` vocabulary, so a surface chooses how a state LOOKS
 * without being able to change what its colour MEANS; what differs is only
 * whether the state gets a capsule of its own.
 *
 * Use this where a state is one labelled fact among many — a card header, a
 * key/value detail row, a per-signal result. Use `AppStatusBadge` where the
 * state is the thing a dense row is SCANNED BY.
 *
 * Visual style lives in `app-primitives.css` (`.app-status-text[data-tone]`),
 * which also carries the measured contrast for every tone. For several states
 * side by side, wrap them in `.app-status-text-row` so the gap — not a
 * reinstated capsule — provides the separation.
 */

import * as React from "react";

import type { AppTone } from "./AppStatusBadge";

/**
 * The compact size the label carries, restoring the FIXED size the capsule had
 * regardless of the surrounding text.
 *
 *   md  12px   — the status-badge default; most states
 *   sm  11.5px — the readiness / media-type label
 *   xs  10.5px — the Technical Appendix labels
 *
 * Defaults to `md` because a status is a compact label, not body copy — the
 * whole reason this exists is that inheriting a 16px parent made a 12px status
 * balloon. `inherit` opts back into the parent size for the rare surface that
 * genuinely wants it.
 */
export type AppStatusTextSize = "md" | "sm" | "xs" | "inherit";

export interface AppStatusTextProps {
  tone: AppTone;
  children: React.ReactNode;
  size?: AppStatusTextSize;
  className?: string;
  title?: string;
  /**
   * Contract hooks, on the same terms as `AppStatusBadge`: surfaces pin
   * `data-*` attributes on their status labels so end-to-end probes can read
   * state out of the DOM. Only `data-` keys are accepted — this is not a
   * general prop escape hatch.
   */
  [dataAttr: `data-${string}`]: unknown;
}

export function AppStatusText({
  tone,
  children,
  size = "md",
  className,
  title,
  ...dataAttrs
}: AppStatusTextProps) {
  return (
    <span
      className={`app-status-text${className ? ` ${className}` : ""}`}
      data-tone={tone}
      data-size={size === "inherit" ? undefined : size}
      title={title}
      {...dataAttrs}
    >
      {children}
    </span>
  );
}

export default AppStatusText;
