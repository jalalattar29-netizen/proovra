"use client";

/**
 * ProovraInlineError — the one-line feedback that sits under a form field
 * (missing required input, invalid email/password, etc). Announced to
 * assistive tech. Use inline validation for field problems — NOT a toast.
 */

import type { CSSProperties, ReactNode } from "react";

import { FeedbackIcon, SEVERITY, type FeedbackSeverity } from "./severity";

export function ProovraInlineError({
  children,
  severity = "error",
  id,
}: {
  children: ReactNode;
  /** "error" (default) for hard failures, "warning" for soft/advisory. */
  severity?: Extract<FeedbackSeverity, "error" | "warning" | "info">;
  id?: string;
}) {
  const tone = SEVERITY[severity];
  return (
    <div
      id={id}
      data-proovra-inline-error
      data-severity={severity}
      role="alert"
      aria-live="assertive"
      style={{ ...rowStyle, color: tone.ink }}
    >
      <span aria-hidden style={{ display: "inline-flex", flexShrink: 0, marginTop: 1 }}>
        <FeedbackIcon severity={severity} size={13} />
      </span>
      <span>{children}</span>
    </div>
  );
}

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 6,
  marginTop: 6,
  fontSize: 12.5,
  fontWeight: 550,
  lineHeight: 1.45,
};
