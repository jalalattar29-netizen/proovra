/**
 * THE RECORDS-BY-TYPE DONUT, WITH ITS LABELS AROUND IT.
 *
 * =============================================================================
 * WHY THIS IS NOT A LEGEND
 * =============================================================================
 * The previous chart was a continuous ring with a list underneath it, so
 * reading "how many videos?" meant finding the green swatch in the list, then
 * finding the green arc in the ring, then trusting that the two greens were the
 * same green. Five categories is exactly the size where that lookup is annoying
 * and the answer is already obvious if you just write it next to the arc.
 *
 * So each segment carries its own annotation, connected by a leader line:
 *
 *     9% (16)
 *     Videos   ·······────┐
 *                         │  ◜◝
 *                          ◟ ◞
 *
 * The percentage and count take the segment's colour; the type name stays navy,
 * because the name is what the row IS and the colour is only how to find it.
 *
 * =============================================================================
 * THE GEOMETRY IS TRUTHFUL
 * =============================================================================
 * Arc length is `count / total`, always. Nothing is padded to a minimum:
 * a 1% slice draws a 1% arc. What makes a 1% slice FINDABLE is the round cap,
 * which adds half a stroke-width of visual mass at each end without changing
 * the angle the data asked for — the same trick a scatter point uses to be
 * bigger than a mathematical dot.
 *
 * The gap between segments is angular and constant (`GAP_DEG`), taken off the
 * END of each arc. A gap cannot be larger than the arc it is taken from, so it
 * is clamped per slice; a very small slice keeps a smaller gap rather than
 * inverting into a negative sweep.
 *
 * =============================================================================
 * LABEL PLACEMENT IS COMPUTED, NOT DRAWN
 * =============================================================================
 * Every coordinate here comes from the slice's own mid-angle. There are no
 * hand-placed positions tied to one set of sample values, so the chart stays
 * correct when the distribution changes — which it does, every capture.
 *
 * Labels are then pushed apart vertically per side (`spread`), because two
 * adjacent thin slices produce two mid-angles a degree apart and their text
 * would otherwise overlap.
 */

"use client";

import type * as React from "react";

import { HOME_COLORS } from "./home-theme";

export type DonutSlice = {
  key: string;
  label: string;
  count: number;
  percent: number;
};

/* ---------------------------------------------------------------------------
   Geometry. One place, so the SVG and the label maths cannot disagree.
--------------------------------------------------------------------------- */
/*
 * A WIDE BOX, because the labels are part of the picture.
 *
 * The ring is centred in a landscape viewBox with a text column reserved on
 * each side. A square box forced every annotation to start near the ring, and
 * a label for a segment near 12 o'clock then sat ON the ring — the leader line
 * had nowhere to lead to.
 */
const VIEW_W = 500;
const VIEW_H = 360;
const CX = VIEW_W / 2;
const CY = VIEW_H / 2;
/** Ring radius to the CENTRE of the stroke. */
const R = 96;
const STROKE = 36;
/** Angular separation between neighbouring arcs, in degrees. */
const GAP_DEG = 4;
/** Where a leader line leaves the ring, and where it turns out of it. */
const LEAVE = R + STROKE / 2 + 4;
const ELBOW = R + STROKE / 2 + 22;
/*
 * THE TEXT COLUMNS. Every annotation on a side starts at the same x, which is
 * what makes five labels read as a list rather than as debris around a circle —
 * and it is why the leader lines are needed at all.
 */
const LABEL_X_RIGHT = CX + R + STROKE / 2 + 40;
const LABEL_X_LEFT = CX - R - STROKE / 2 - 40;
/** Minimum vertical distance between two annotations on the same side. */
const LABEL_PITCH = 48;

const polar = (deg: number, radius: number) => {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: CX + radius * Math.cos(rad), y: CY + radius * Math.sin(rad) };
};

type Placed = {
  slice: DonutSlice;
  colour: string;
  /** Mid-angle of the arc, degrees clockwise from 12 o'clock. */
  mid: number;
  side: "left" | "right";
  anchor: { x: number; y: number };
  elbow: { x: number; y: number };
  label: { x: number; y: number };
};

/**
 * Push same-side annotations apart so their text cannot collide.
 *
 * Ordered by the y the geometry asked for, then walked downwards enforcing a
 * minimum pitch. The line still points at the right arc — only the text moves,
 * which is the whole reason a leader line exists.
 */
function spread(items: Placed[]): Placed[] {
  const sorted = [...items].sort((a, b) => a.label.y - b.label.y);
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (cur.label.y - prev.label.y < LABEL_PITCH) {
      cur.label = { ...cur.label, y: prev.label.y + LABEL_PITCH };
    }
  }
  return sorted;
}

export function AnnotatedDonut({
  slices,
  total,
  colourFor,
  centreLabel,
  ariaLabel,
  idPrefix,
}: {
  slices: DonutSlice[];
  total: number;
  colourFor: (key: string) => string;
  /** The word under the total — "Records" or "Files". */
  centreLabel: string;
  ariaLabel: string;
  /** Distinguishes two donuts on one page for any id-bearing markup. */
  idPrefix: string;
}) {
  const drawable = slices.filter((s) => s.count > 0);
  const sum = drawable.reduce((a, s) => a + s.count, 0) || 1;

  // ---- arcs ---------------------------------------------------------------
  let cursor = 0;
  const arcs = drawable.map((s) => {
    const sweep = (s.count / sum) * 360;
    // The gap comes off the end of the arc and can never exceed it.
    const gap = Math.min(GAP_DEG, sweep * 0.6);
    const start = cursor;
    const end = cursor + sweep - gap;
    cursor += sweep;
    return { slice: s, start, end, mid: start + (end - start) / 2 };
  });

  // ---- annotations --------------------------------------------------------
  const placed: Placed[] = arcs.map(({ slice, mid }) => {
    const side: "left" | "right" = Math.cos(((mid - 90) * Math.PI) / 180) >= 0
      ? "right"
      : "left";
    const anchor = polar(mid, LEAVE);
    const elbow = polar(mid, ELBOW);
    return {
      slice,
      colour: colourFor(slice.key),
      mid,
      side,
      anchor,
      elbow,
      label: { x: side === "right" ? LABEL_X_RIGHT : LABEL_X_LEFT, y: elbow.y },
    };
  });

  const right = spread(placed.filter((p) => p.side === "right"));
  const left = spread(placed.filter((p) => p.side === "left"));
  const annotations = [...right, ...left];

  return (
    <svg
      className="home-donut"
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      role="img"
      aria-label={ariaLabel}
      data-annotated-donut={idPrefix}
      style={{ width: "100%", height: "auto", maxWidth: VIEW_W, overflow: "visible" }}
    >
      {/* The track. Visible only where a gap exposes it, which is what makes
          the separation read as deliberate rather than as a rendering seam. */}
      <circle cx={CX} cy={CY} r={R} fill="none" stroke="#EEF1F6" strokeWidth={STROKE} />

      {arcs.map(({ slice, start, end }) => {
        const from = polar(start, R);
        const to = polar(end, R);
        const large = end - start > 180 ? 1 : 0;
        return (
          <path
            key={slice.key}
            d={`M ${from.x} ${from.y} A ${R} ${R} 0 ${large} 1 ${to.x} ${to.y}`}
            fill="none"
            stroke={colourFor(slice.key)}
            strokeWidth={STROKE}
            /* The cap is what makes a 1% slice findable without lying about
               its size — it adds mass, not angle. */
            strokeLinecap="round"
            data-donut-arc={slice.key}
          />
        );
      })}

      {/* The total, inside the cutout. */}
      <text
        x={CX}
        y={CY - 2}
        textAnchor="middle"
        style={{
          fontSize: 46,
          fontWeight: 700,
          fill: "var(--ink-primary, #0F172A)",
          fontVariantNumeric: "tabular-nums",
        }}
        data-donut-total
      >
        {total.toLocaleString()}
      </text>
      <text
        x={CX}
        y={CY + 24}
        textAnchor="middle"
        style={{ fontSize: 16, fill: "var(--ink-muted, #94a3b8)" }}
      >
        {centreLabel}
      </text>

      {annotations.map((p) => {
        const isRight = p.side === "right";
        // The line ends a little short of the text so the two never touch.
        const textX = p.label.x;
        const lineEndX = isRight ? textX - 8 : textX + 8;
        return (
          <g key={p.slice.key} data-donut-annotation={p.slice.key}>
            {/* Leader: out of the ring, to the elbow, then level to the text.
                Dotted and hairline — it connects, it does not compete. */}
            <polyline
              points={`${p.anchor.x},${p.anchor.y} ${p.elbow.x},${p.elbow.y} ${lineEndX},${p.label.y}`}
              fill="none"
              stroke="rgba(15, 23, 42, 0.22)"
              strokeWidth={1}
              strokeDasharray="2 3"
            />
            <text
              x={textX}
              y={p.label.y - 6}
              textAnchor={isRight ? "start" : "end"}
              style={{
                fontSize: 17,
                fontWeight: 700,
                fill: p.colour,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {`${p.slice.percent}% (${p.slice.count.toLocaleString()})`}
            </text>
            <text
              x={textX}
              y={p.label.y + 13}
              textAnchor={isRight ? "start" : "end"}
              style={{ fontSize: 15.5, fill: HOME_COLORS.ink }}
            >
              {p.slice.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/**
 * The same numbers as words, for a screen reader and for the narrow layout.
 *
 * The SVG's own `aria-label` can only carry a sentence; this carries the table.
 * On a phone the annotations cannot fit around the ring at a readable size, so
 * this list is shown instead of being hidden — the data does not change, only
 * where it sits.
 */
export function DonutReadout({
  slices,
  colourFor,
  unit,
  hidden,
}: {
  slices: DonutSlice[];
  colourFor: (key: string) => string;
  unit: string;
  hidden?: boolean;
}) {
  return (
    <ul
      className="home-donut-readout"
      data-donut-readout={hidden ? "sr-only" : "visible"}
      style={
        hidden
          ? ({
              position: "absolute",
              width: 1,
              height: 1,
              overflow: "hidden",
              clip: "rect(0 0 0 0)",
              whiteSpace: "nowrap",
            } as React.CSSProperties)
          : undefined
      }
    >
      {slices.map((s) => (
        <li key={s.key}>
          <span
            aria-hidden
            className="home-donut-readout__dot"
            style={{ background: colourFor(s.key) }}
          />
          <span className="home-donut-readout__label">{s.label}</span>
          <span className="home-donut-readout__value" style={{ color: colourFor(s.key) }}>
            {`${s.percent}% (${s.count.toLocaleString()})`}
          </span>
          <span className="app-visually-hidden">{`${s.label}: ${s.count} ${unit}, ${s.percent} percent`}</span>
        </li>
      ))}
    </ul>
  );
}
