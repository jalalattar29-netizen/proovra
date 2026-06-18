"use client";

/**
 * Phase 4A Enterprise Closure — Trust article drift chip.
 *
 * Renders a bounded colour-coded badge for the three states emitted
 * by `trust-drift.service.ts`:
 *
 *   * CURRENT      — every implementationReferences path exists.
 *   * STALE        — at least one path no longer exists.
 *   * NEEDS_REVIEW — operator flagged the article for re-validation.
 *
 * No marketing language. Tooltip explains the verdict honestly.
 */

import type { TrustArticleDriftState } from "@proovra/shared";

export function DriftBadge({ state }: { state: TrustArticleDriftState }) {
  const palette: Record<
    TrustArticleDriftState,
    { bg: string; fg: string; border: string; tooltip: string }
  > = {
    CURRENT: {
      bg: "#dcfce7",
      fg: "#166534",
      border: "#86efac",
      tooltip: "Every cited implementation path resolves.",
    },
    STALE: {
      bg: "#fee2e2",
      fg: "#991b1b",
      border: "#fca5a5",
      tooltip: "At least one cited implementation path is missing.",
    },
    NEEDS_REVIEW: {
      bg: "#fef3c7",
      fg: "#92400e",
      border: "#fcd34d",
      tooltip: "Operator flagged this article for human re-validation.",
    },
  };
  const c = palette[state];
  return (
    <span
      data-trust-drift-badge={state}
      title={c.tooltip}
      style={{
        display: "inline-block",
        padding: "2px 8px",
        marginLeft: 6,
        borderRadius: 999,
        fontSize: 10,
        fontWeight: 700,
        background: c.bg,
        color: c.fg,
        border: `1px solid ${c.border}`,
      }}
    >
      {state}
    </span>
  );
}
