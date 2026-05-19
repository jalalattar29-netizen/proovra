"use client";

/**
 * Phase 25.6 — Reviewer queue PriorityChip.
 *
 * Compact, dense chip that renders a `PriorityScoreResult` from the
 * shared reviewer-priority engine. Designed to drop into a queue row
 * without taking layout space — the chip is the operator's at-a-glance
 * signal for "why this row is here".
 *
 * Hard rules:
 *   - Consumes the canonical typed shape from `@proovra/shared` —
 *     never invents a score or reason.
 *   - Severity colors come from the Phase 28-I OPS_TONES catalog so
 *     contrast is WCAG-readable on every page surface.
 *   - The chip surfaces only operator-readable bounded labels — never
 *     leaks evidence content, workflow IDs, or actor identifiers.
 *   - On hover / focus, the chip exposes a `title` attribute with the
 *     summarized top-3 reasons. Operators see "why URGENT" without
 *     opening a popover.
 *   - Accessible: `<button>` element when `onSelect` is provided so
 *     keyboard users can activate it; otherwise inert.
 */

import type { PriorityScoreResult } from "@proovra/shared";
import { summarisePriorityReasons } from "@proovra/shared";

import { OPS_INK, OPS_SURFACE, OPS_TONES } from "./tokens";

export type PriorityChipProps = {
  priority: PriorityScoreResult;
  /** Optional click handler — when set, the chip becomes a button. */
  onSelect?: () => void;
  /** Optional dense mode — drops the score number to a smaller weight. */
  dense?: boolean;
};

const BAND_PALETTE = {
  URGENT: OPS_TONES.critical,
  ATTENTION: OPS_TONES.warning,
  STANDARD: OPS_TONES.healthy,
} as const;

const BAND_LABEL: Record<PriorityScoreResult["band"], string> = {
  URGENT: "URGENT",
  ATTENTION: "ATTENTION",
  STANDARD: "STANDARD",
};

export function PriorityChip({
  priority,
  onSelect,
  dense = false,
}: PriorityChipProps) {
  const palette = BAND_PALETTE[priority.band];
  const label = BAND_LABEL[priority.band];
  const summary = summarisePriorityReasons(priority.reasons, 3);
  const topReason = priority.reasons[0]?.label ?? "";
  const tooltip = `${label} (${priority.score}) — ${summary}`;

  const baseStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: dense ? "2px 8px" : "3px 10px",
    background: palette.bg,
    border: `1px solid ${palette.border}`,
    borderRadius: 4,
    color: palette.ink,
    fontSize: dense ? 10 : 11,
    fontWeight: 700,
    letterSpacing: 0.3,
    lineHeight: 1.2,
    fontFamily: "inherit",
    maxWidth: 320,
  };

  const content = (
    <>
      <span
        data-priority-band-label
        style={{
          fontWeight: 700,
          letterSpacing: 0.5,
        }}
      >
        {label}
      </span>
      <span
        data-priority-score
        style={{
          padding: "0 6px",
          background: OPS_SURFACE.cardMuted,
          color: OPS_INK.default,
          border: `1px solid ${OPS_SURFACE.border}`,
          borderRadius: 999,
          fontVariantNumeric: "tabular-nums",
          fontWeight: 700,
          fontSize: dense ? 10 : 11,
        }}
      >
        {priority.score}
      </span>
      {topReason ? (
        <span
          data-priority-top-reason
          style={{
            color: palette.inkMuted,
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 200,
          }}
        >
          {topReason}
        </span>
      ) : null}
    </>
  );

  if (onSelect) {
    return (
      <button
        type="button"
        data-priority-chip
        data-priority-band={priority.band}
        onClick={onSelect}
        title={tooltip}
        style={{
          ...baseStyle,
          cursor: "pointer",
        }}
      >
        {content}
      </button>
    );
  }
  return (
    <span
      data-priority-chip
      data-priority-band={priority.band}
      title={tooltip}
      style={baseStyle}
    >
      {content}
    </span>
  );
}
