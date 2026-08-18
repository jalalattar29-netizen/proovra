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
  | "slate";

export interface AppStatusBadgeProps {
  tone: AppTone;
  children: React.ReactNode;
  /** Show a small leading dot in the tone colour. */
  dot?: boolean;
  className?: string;
  title?: string;
}

export function AppStatusBadge({
  tone,
  children,
  dot = false,
  className,
  title,
}: AppStatusBadgeProps) {
  return (
    <span
      className={`app-status-badge${className ? ` ${className}` : ""}`}
      data-tone={tone}
      title={title}
    >
      {dot ? <span className="app-status-badge__dot" aria-hidden /> : null}
      {children}
    </span>
  );
}

export default AppStatusBadge;
