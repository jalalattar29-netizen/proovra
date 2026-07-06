"use client";

/**
 * ProovraLoadingState — governed loading surface. Enterprise, honest
 * copy ("Preparing evidence record", "Generating verification report")
 * — never a bare "Loading…". Announced politely to assistive tech.
 *
 * For long real-progress workflows (upload, report/package generation),
 * pair with ProovraProgressState.
 */

import type { CSSProperties } from "react";

import { FEEDBACK_SURFACE, FeedbackIcon } from "./severity";

export function ProovraLoadingState({
  label,
  detail,
  size = "md",
  center = true,
}: {
  /** Honest present-tense label, e.g. "Generating verification report". */
  label: string;
  detail?: string;
  size?: "sm" | "md";
  center?: boolean;
}) {
  const dim = size === "sm" ? 16 : 20;
  return (
    <div
      data-proovra-loading
      role="status"
      aria-live="polite"
      aria-busy="true"
      style={{
        display: "flex",
        alignItems: center ? "center" : "flex-start",
        justifyContent: center ? "center" : "flex-start",
        flexDirection: detail ? "column" : "row",
        gap: detail ? 6 : 10,
        padding: size === "sm" ? 0 : "20px 16px",
        textAlign: center ? "center" : "left",
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
        <FeedbackIcon severity="loading" size={dim} />
        <span style={labelStyle}>{label}</span>
      </span>
      {detail ? <span style={detailStyle}>{detail}</span> : null}
    </div>
  );
}

const labelStyle: CSSProperties = {
  fontSize: 13.5,
  fontWeight: 600,
  color: FEEDBACK_SURFACE.ink,
};

const detailStyle: CSSProperties = {
  fontSize: 12.5,
  color: FEEDBACK_SURFACE.inkSubtle,
  lineHeight: 1.5,
};
