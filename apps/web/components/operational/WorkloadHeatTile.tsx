"use client";

/**
 * Phase 25.6 — Reviewer workload heat tile.
 *
 * Renders ONE reviewer's workload pressure as a dense operational
 * tile. Designed to mosaic into a workload heatmap (caller arranges
 * the grid). Each tile carries:
 *
 *   - reviewer display label
 *   - pressure tone (available / balanced / overloaded)
 *   - active reviews count
 *   - overdue + due-soon + escalated counts (severity-coloured chips)
 *   - inactivity warning when applicable
 *
 * Hard rules:
 *   - No fake counters — every number must come from the workload
 *     snapshot the caller passes in.
 *   - No charts. This is an operational tile, not a BI surface.
 *   - Severity tones use the Phase 28-I OPS_TONES palette so contrast
 *     stays WCAG-readable.
 *   - Reviewer identity passed via `displayName` or falls back to a
 *     truncated id. Names are caller-resolved so the component does
 *     not bypass RBAC.
 */

import { OPS_INK, OPS_SURFACE, OPS_TONES } from "./tokens";

export type ReviewerWorkloadSnapshot = {
  reviewerId: string;
  displayName?: string | null;
  activeReviews: number;
  overdueReviews: number;
  dueSoonReviews: number;
  escalatedReviews: number;
  recentCompleted: number;
  pressure: "available" | "balanced" | "overloaded";
  lastActivityAtUtc: string | null;
};

export type WorkloadHeatTileProps = {
  snapshot: ReviewerWorkloadSnapshot;
  /** Caller can pass the team's mean active count so the tile renders
   *  a relative-load indicator. Optional. */
  teamMeanActive?: number | null;
  onSelect?: () => void;
};

const PRESSURE_PALETTE = {
  available: OPS_TONES.healthy,
  balanced: OPS_TONES.info,
  overloaded: OPS_TONES.high,
} as const;

const PRESSURE_LABEL = {
  available: "Available",
  balanced: "Balanced",
  overloaded: "Overloaded",
} as const;

function fallbackName(id: string): string {
  return `Reviewer ${id.slice(0, 8)}…`;
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.round((Date.now() - then) / (24 * 60 * 60 * 1000)));
}

export function WorkloadHeatTile({
  snapshot,
  teamMeanActive,
  onSelect,
}: WorkloadHeatTileProps) {
  const palette = PRESSURE_PALETTE[snapshot.pressure];
  const pressureLabel = PRESSURE_LABEL[snapshot.pressure];
  const reviewerLabel =
    snapshot.displayName?.trim() || fallbackName(snapshot.reviewerId);
  const inactivityDays = daysSince(snapshot.lastActivityAtUtc);
  const inactive = inactivityDays !== null && inactivityDays >= 14;
  const imbalance =
    teamMeanActive !== null &&
    teamMeanActive !== undefined &&
    teamMeanActive > 0 &&
    snapshot.activeReviews > teamMeanActive * 1.5;

  const tileStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: 12,
    background: palette.bg,
    border: `1px solid ${palette.border}`,
    borderRadius: 8,
    color: palette.ink,
    fontFamily: "inherit",
    width: "100%",
    textAlign: "left",
    cursor: onSelect ? "pointer" : "default",
  };

  const content = (
    <>
      <div
        data-workload-header
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 6,
        }}
      >
        <strong
          data-reviewer-label
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: palette.ink,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 200,
          }}
        >
          {reviewerLabel}
        </strong>
        <span
          data-workload-pressure
          data-pressure={snapshot.pressure}
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 0.4,
            textTransform: "uppercase",
            color: palette.kicker,
          }}
        >
          {pressureLabel}
        </span>
      </div>
      <div
        data-workload-active-row
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
        }}
      >
        <span
          data-workload-active
          style={{
            fontSize: 24,
            fontWeight: 700,
            color: palette.ink,
            lineHeight: 1.0,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {snapshot.activeReviews}
        </span>
        <span
          style={{
            fontSize: 10,
            letterSpacing: 0.4,
            textTransform: "uppercase",
            color: palette.inkMuted,
            fontWeight: 600,
          }}
        >
          active reviews
        </span>
      </div>
      <div
        data-workload-chips
        style={{
          display: "flex",
          gap: 4,
          flexWrap: "wrap",
        }}
      >
        <Chip
          label="Overdue"
          value={snapshot.overdueReviews}
          tone={snapshot.overdueReviews > 0 ? "high" : "muted"}
        />
        <Chip
          label="Due soon"
          value={snapshot.dueSoonReviews}
          tone={snapshot.dueSoonReviews > 0 ? "warning" : "muted"}
        />
        <Chip
          label="Escalated"
          value={snapshot.escalatedReviews}
          tone={snapshot.escalatedReviews > 0 ? "high" : "muted"}
        />
        <Chip
          label="Completed 7d"
          value={snapshot.recentCompleted}
          tone="muted"
        />
      </div>
      {(imbalance || inactive) ? (
        <div
          data-workload-warnings
          style={{
            display: "flex",
            gap: 4,
            flexWrap: "wrap",
            marginTop: 2,
          }}
        >
          {imbalance ? (
            <span
              data-warning="imbalance"
              style={warningPillStyle("warning")}
              title={`Reviewer carries ${snapshot.activeReviews} active vs. team mean ${teamMeanActive?.toFixed(1) ?? "?"}`}
            >
              IMBALANCED
            </span>
          ) : null}
          {inactive ? (
            <span
              data-warning="inactive"
              style={warningPillStyle("warning")}
              title={`No activity in ${inactivityDays} days`}
            >
              INACTIVE {inactivityDays}d
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  );

  if (onSelect) {
    return (
      <button
        type="button"
        data-workload-heat-tile
        data-pressure={snapshot.pressure}
        onClick={onSelect}
        style={tileStyle}
      >
        {content}
      </button>
    );
  }
  return (
    <div
      data-workload-heat-tile
      data-pressure={snapshot.pressure}
      style={tileStyle}
    >
      {content}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

const CHIP_PALETTE = {
  high: OPS_TONES.high,
  warning: OPS_TONES.warning,
  muted: { bg: OPS_SURFACE.cardMuted, border: OPS_SURFACE.border, ink: OPS_INK.muted, inkMuted: OPS_INK.subtle, kicker: OPS_INK.subtle, link: OPS_INK.muted },
} as const;

function Chip({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: keyof typeof CHIP_PALETTE;
}) {
  const palette = CHIP_PALETTE[tone];
  return (
    <span
      data-workload-chip={label.toLowerCase().replace(/\s+/g, "_")}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "1px 7px",
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: 999,
        color: palette.ink,
        fontSize: 10,
        fontWeight: 700,
      }}
    >
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{value}</span>
      <span
        style={{
          color: palette.inkMuted,
          fontWeight: 600,
          letterSpacing: 0.3,
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
    </span>
  );
}

function warningPillStyle(
  tone: "warning" | "high",
): React.CSSProperties {
  const palette = tone === "warning" ? OPS_TONES.warning : OPS_TONES.high;
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "1px 7px",
    background: palette.bg,
    border: `1px solid ${palette.border}`,
    color: palette.ink,
    borderRadius: 4,
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: 0.4,
  };
}
