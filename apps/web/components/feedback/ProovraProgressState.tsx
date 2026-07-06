"use client";

/**
 * ProovraProgressState — governed progress surface for long, real
 * workflows (upload, signing, RFC3161 timestamping, OTS anchoring,
 * report/verification-package generation, evidence processing).
 *
 * If real progress is known, pass `value` (0–100) for a determinate bar.
 * If not, omit `value` for an HONEST indeterminate bar — never fake a
 * percentage. Copy stays enterprise ("Signing preserved package").
 */

import type { CSSProperties } from "react";

import { FEEDBACK_SURFACE, SEVERITY } from "./severity";

export function ProovraProgressState({
  label,
  value,
  stepLabel,
  accent = SEVERITY.loading.accent,
}: {
  label: string;
  /** 0–100 for determinate; omit for indeterminate. */
  value?: number;
  /** Optional "Step 2 of 4" style hint. */
  stepLabel?: string;
  accent?: string;
}) {
  const determinate = typeof value === "number";
  const pct = determinate ? Math.max(0, Math.min(100, value as number)) : undefined;

  return (
    <div data-proovra-progress data-determinate={determinate ? "true" : "false"} style={wrapStyle}>
      <div style={headerStyle}>
        <span style={labelStyle}>{label}</span>
        {determinate ? (
          <span style={pctStyle}>{Math.round(pct as number)}%</span>
        ) : stepLabel ? (
          <span style={pctStyle}>{stepLabel}</span>
        ) : null}
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={determinate ? 0 : undefined}
        aria-valuemax={determinate ? 100 : undefined}
        aria-valuenow={determinate ? Math.round(pct as number) : undefined}
        style={trackStyle}
      >
        {determinate ? (
          <span style={{ ...fillStyle, width: `${pct}%`, background: accent }} />
        ) : (
          <span style={{ ...indeterminateStyle, background: accent }} />
        )}
      </div>
    </div>
  );
}

const wrapStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 6, width: "100%" };
const headerStyle: CSSProperties = { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 };
const labelStyle: CSSProperties = { fontSize: 13, fontWeight: 600, color: FEEDBACK_SURFACE.ink };
const pctStyle: CSSProperties = { fontSize: 12, fontWeight: 600, color: FEEDBACK_SURFACE.inkSubtle, fontVariantNumeric: "tabular-nums" };
const trackStyle: CSSProperties = {
  position: "relative",
  height: 6,
  borderRadius: 999,
  background: "rgba(15, 23, 42, 0.08)",
  overflow: "hidden",
};
const fillStyle: CSSProperties = { display: "block", height: "100%", borderRadius: 999, transition: "width 240ms ease" };
const indeterminateStyle: CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  height: "100%",
  width: "40%",
  borderRadius: 999,
  animation: "pf-indeterminate 1.2s ease-in-out infinite",
};
