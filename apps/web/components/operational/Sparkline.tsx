"use client";

/**
 * Phase 28-J — Compact operational sparkline.
 *
 * Tiny inline SVG sparkline for operator dashboards. NOT a BI chart —
 * deliberately low-fidelity, designed to fit next to a counter or a
 * label.
 *
 * Hard rules:
 *   - No external chart library. SVG only.
 *   - No fake data. Caller passes real observed values.
 *   - Renders a "no data" hint instead of an empty box when there are
 *     fewer than 2 samples (a single point cannot trend).
 *   - Color is severity-aware via the OPS_TONES palette.
 *   - Width and height are bounded; the sparkline never grows past the
 *     operator's "glance" zone.
 *   - Includes a high-contrast last-value label so the trend is
 *     readable without hover state.
 */

import { OPS_INK, OPS_TONES } from "./tokens";

export type SparklineSeverity =
  | "neutral"
  | "healthy"
  | "warning"
  | "high"
  | "critical";

export type SparklineProps = {
  values: ReadonlyArray<number>;
  /** Caption above the sparkline, e.g. "Queue depth". */
  caption: string;
  /** Severity tone — drives the stroke color. */
  severity?: SparklineSeverity;
  /** Width in pixels. Default 120. */
  width?: number;
  /** Height in pixels. Default 32. */
  height?: number;
  /**
   * Optional delta — the change vs the first observation. Renderered
   * as a tiny "+12" / "-4" pill. Caller computes; this component does
   * NOT fabricate a delta.
   */
  delta?: number | null;
  /** Bounded delta unit label, e.g. "in 15m" / "this session". */
  deltaWindow?: string;
};

const STROKE_FOR: Record<SparklineSeverity, string> = {
  neutral: "#475569", // slate-600
  healthy: "#10b981", // emerald-500
  warning: "#f59e0b", // amber-500
  high: "#ef4444", // red-500
  critical: "#b91c1c", // red-700
};

const FILL_FOR: Record<SparklineSeverity, string> = {
  neutral: "rgba(71, 85, 105, 0.08)",
  healthy: "rgba(16, 185, 129, 0.08)",
  warning: "rgba(245, 158, 11, 0.10)",
  high: "rgba(239, 68, 68, 0.10)",
  critical: "rgba(185, 28, 28, 0.12)",
};

function buildPath(
  values: ReadonlyArray<number>,
  width: number,
  height: number,
): { line: string; area: string } {
  if (values.length === 0) return { line: "", area: "" };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = values.length === 1 ? 0 : width / (values.length - 1);
  // Use 2px padding top/bottom so the stroke isn't clipped.
  const pad = 2;
  const usable = height - pad * 2;
  const points = values.map((v, i) => {
    const x = stepX * i;
    const y = pad + usable - ((v - min) / span) * usable;
    return [x, y] as const;
  });
  const line = points
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`)
    .join(" ");
  const area = `${line} L${(stepX * (values.length - 1)).toFixed(2)},${height} L0,${height} Z`;
  return { line, area };
}

/*
 * 11px, NOT 10, ON EVERY LABEL IN HERE.
 *
 * The admin responsive sweep found this component supplying the last sub-11px
 * text in the console content — the caption, the delta and the "collecting
 * samples..." placeholder, on /admin/platform/observability at every one of
 * the seven widths. A sparkline caption is what tells the reader WHICH series
 * they are looking at, and a delta is the only number on it; both are read,
 * not decoration.
 */
export function Sparkline({
  values,
  caption,
  severity = "neutral",
  width = 120,
  height = 32,
  delta = null,
  deltaWindow,
}: SparklineProps) {
  const safeValues = values.filter((v) => Number.isFinite(v));
  const enough = safeValues.length >= 2;
  const { line, area } = enough
    ? buildPath(safeValues, width, height)
    : { line: "", area: "" };
  const lastValue = safeValues[safeValues.length - 1];
  const stroke = STROKE_FOR[severity];
  const fill = FILL_FOR[severity];

  const deltaTone =
    typeof delta !== "number" || delta === 0
      ? "neutral"
      : delta > 0
        ? severity === "healthy"
          ? "healthy"
          : "high"
        : severity === "healthy"
          ? "high"
          : "healthy";
  const deltaColor =
    deltaTone === "high"
      ? OPS_TONES.high.inkMuted
      : deltaTone === "healthy"
        ? OPS_TONES.healthy.inkMuted
        : OPS_INK.subtle;

  return (
    <div
      data-sparkline
      data-severity={severity}
      data-sample-count={safeValues.length}
      style={{ display: "flex", flexDirection: "column", gap: 2 }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 8,
        }}
      >
        <span
          style={{
            fontSize: 11,
            letterSpacing: 0.4,
            textTransform: "uppercase",
            color: OPS_INK.subtle,
            fontWeight: 700,
          }}
        >
          {caption}
        </span>
        {typeof delta === "number" ? (
          <span
            data-sparkline-delta
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: deltaColor,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {delta > 0 ? "+" : ""}
            {delta}
            {deltaWindow ? ` ${deltaWindow}` : ""}
          </span>
        ) : null}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 6,
        }}
      >
        {enough ? (
          <svg
            role="img"
            /**
             * THE LABEL CARRIES THE READING, NOT JUST THE SUBJECT.
             *
             * `"${caption} trend"` names what the picture is ABOUT and says
             * nothing about what it shows: to a screen reader the shape was a
             * word, and the only number in reach was the current value beside
             * it — which is the one figure a trend is not. The label now says
             * where the series started, where it is now, and over how many
             * samples, which is the same three facts a sighted reader takes
             * from the line.
             */
            aria-label={`${caption}: ${safeValues[0]?.toLocaleString() ?? "—"} to ${
              lastValue?.toLocaleString() ?? "—"
            } over the last ${safeValues.length} samples`}
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            style={{ display: "block" }}
          >
            <path d={area} fill={fill} stroke="none" />
            <path d={line} fill="none" stroke={stroke} strokeWidth={1.5} />
          </svg>
        ) : (
          <span
            data-sparkline-empty
            style={{
              fontSize: 11,
              color: OPS_INK.subtle,
              fontStyle: "italic",
              width,
              display: "inline-block",
            }}
          >
            collecting samples…
          </span>
        )}
        {typeof lastValue === "number" ? (
          <span
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: OPS_INK.default,
              fontVariantNumeric: "tabular-nums",
              lineHeight: 1,
            }}
          >
            {lastValue.toLocaleString()}
          </span>
        ) : null}
      </div>
    </div>
  );
}
