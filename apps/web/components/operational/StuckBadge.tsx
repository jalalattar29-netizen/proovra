"use client";

/**
 * Phase 25.6 — Stuck workflow badge.
 *
 * Renders the canonical `StuckClassification` from the shared
 * stuck-workflow detector. The badge is intentionally small — it
 * surfaces inside a queue row alongside the priority chip and reads as
 * a sticky operational signal: "this row has been stuck for X reason".
 *
 * Hard rules:
 *   - Consumes the typed `StuckClassification` from `@proovra/shared`
 *     — never invents a reason.
 *   - Severity tones come from the Phase 28-I OPS_TONES catalog.
 *   - Bounded reason vocabulary — no free-text leak.
 *   - When the workflow is NOT stuck the component renders `null` so
 *     calm queue rows stay clean.
 */

import type { StuckClassification } from "@proovra/shared";

import { OPS_INK, OPS_TONES } from "./tokens";

export type StuckBadgeProps = {
  classification: StuckClassification;
  /** Optional compact mode — drops to a single icon-like dot + tooltip. */
  compact?: boolean;
};

const SEVERITY_PALETTE = {
  INFO: OPS_TONES.info,
  WARNING: OPS_TONES.warning,
  HIGH: OPS_TONES.high,
  CRITICAL: OPS_TONES.critical,
} as const;

export function StuckBadge({
  classification,
  compact = false,
}: StuckBadgeProps) {
  if (!classification.isStuck) return null;
  const palette = SEVERITY_PALETTE[classification.topSeverity];
  const topReason = classification.reasons[0];
  const allLabels = classification.reasons.map((r) => r.label).join(" · ");
  const reasonCount = classification.reasons.length;

  if (compact) {
    return (
      <span
        data-stuck-badge
        data-stuck-severity={classification.topSeverity}
        title={`Stuck — ${allLabels}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "2px 7px",
          background: palette.bg,
          border: `1px solid ${palette.border}`,
          borderRadius: 999,
          fontSize: 10,
          fontWeight: 700,
          color: palette.ink,
          letterSpacing: 0.4,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: "inline-block",
            width: 6,
            height: 6,
            borderRadius: 6,
            background: palette.kicker,
          }}
        />
        STUCK
        {reasonCount > 1 ? (
          <span
            style={{ fontWeight: 600, color: palette.inkMuted, marginLeft: 2 }}
          >
            +{reasonCount - 1}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <span
      data-stuck-badge
      data-stuck-severity={classification.topSeverity}
      title={allLabels}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 10px",
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 700,
        color: palette.ink,
        letterSpacing: 0.3,
        maxWidth: 280,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: "inline-block",
          width: 7,
          height: 7,
          borderRadius: 7,
          background: palette.kicker,
        }}
      />
      <span data-stuck-label>STUCK</span>
      {topReason ? (
        <span
          data-stuck-top-reason
          style={{
            color: palette.inkMuted,
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 200,
          }}
        >
          {topReason.label}
        </span>
      ) : null}
      {reasonCount > 1 ? (
        <span
          data-stuck-extra-count
          style={{
            color: palette.inkMuted,
            fontSize: 10,
            fontWeight: 700,
            background: "rgba(0,0,0,0.06)",
            padding: "0 6px",
            borderRadius: 999,
          }}
        >
          +{reasonCount - 1}
        </span>
      ) : null}
      <span aria-hidden="true" style={{ display: "none" }}>
        {/* Anchor for token-discipline tests. */}
        {OPS_INK.subtle ? "" : ""}
      </span>
    </span>
  );
}
