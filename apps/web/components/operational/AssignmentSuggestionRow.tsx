"use client";

/**
 * Phase 25.6 — Reviewer assignment suggestion row.
 *
 * Renders ONE entry from the shared `rankReviewerSuggestions` ranker
 * output: the recommended reviewer, score band, top reasons, and any
 * operational risk flags (overload / overdue pressure / escalation
 * pressure / burst / imbalance / inactivity).
 *
 * Hard rules:
 *   - Consumes the typed `ReviewerSuggestion` shape from
 *     `@proovra/shared` — never invents a reviewer or a reason.
 *   - Bounded reason / risk-flag vocabulary — no free-text leak.
 *   - Reviewer identity is shown via the caller-supplied
 *     `displayName` (or a truncated ID if the caller chose not to
 *     resolve names). The component itself does NOT fetch reviewer
 *     directory data — that's the caller's responsibility, which
 *     keeps RBAC enforcement out-of-component.
 *   - Risk flags are color-coded by severity. HIGH-severity flags
 *     render with the high-tone palette so the operator sees an
 *     overload warning even on a RECOMMENDED reviewer.
 *   - When `onSelect` is provided the whole row becomes a button.
 */

import type { ReviewerSuggestion } from "@proovra/shared";

import { OPS_INK, OPS_SURFACE, OPS_TONES } from "./tokens";

export type AssignmentSuggestionRowProps = {
  suggestion: ReviewerSuggestion;
  /** Caller-resolved display name. Falls back to a truncated id. */
  displayName?: string | null;
  /** Optional click → triggers assignment action in the caller. */
  onSelect?: () => void;
  /** Optional dense mode for inline rendering inside a queue row. */
  dense?: boolean;
};

const BAND_PALETTE = {
  RECOMMENDED: OPS_TONES.healthy,
  ACCEPTABLE: OPS_TONES.info,
  LAST_RESORT: OPS_TONES.warning,
  NOT_RECOMMENDED: OPS_TONES.high,
} as const;

const BAND_LABEL = {
  RECOMMENDED: "Recommended",
  ACCEPTABLE: "Acceptable",
  LAST_RESORT: "Last resort",
  NOT_RECOMMENDED: "Not recommended",
} as const;

const RISK_PALETTE = {
  INFO: OPS_TONES.info,
  WARNING: OPS_TONES.warning,
  HIGH: OPS_TONES.high,
} as const;

function fallbackName(id: string): string {
  return `${id.slice(0, 8)}…`;
}

export function AssignmentSuggestionRow({
  suggestion,
  displayName,
  onSelect,
  dense = false,
}: AssignmentSuggestionRowProps) {
  const palette = BAND_PALETTE[suggestion.recommendationBand];
  const bandLabel = BAND_LABEL[suggestion.recommendationBand];
  const reviewerLabel = displayName?.trim() || fallbackName(suggestion.reviewerId);
  const tooltip = `${bandLabel} (score ${suggestion.score}, confidence ${suggestion.confidence.toLowerCase()})`;

  const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: dense ? "6px 10px" : "10px 14px",
    background: OPS_SURFACE.card,
    border: `1px solid ${OPS_SURFACE.border}`,
    borderRadius: 8,
    width: "100%",
    textAlign: "left",
    fontFamily: "inherit",
    color: OPS_INK.default,
    fontSize: dense ? 12 : 13,
  };

  const content = (
    <>
      <span
        data-suggestion-band
        data-band={suggestion.recommendationBand}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: dense ? "1px 7px" : "2px 10px",
          background: palette.bg,
          border: `1px solid ${palette.border}`,
          color: palette.ink,
          borderRadius: 999,
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 0.4,
          textTransform: "uppercase",
        }}
      >
        {bandLabel}
      </span>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 2,
          flex: 1,
          minWidth: 0,
        }}
      >
        <div
          data-suggestion-reviewer
          style={{
            fontWeight: 700,
            color: OPS_INK.default,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {reviewerLabel}
        </div>
        {suggestion.reasons.length > 0 ? (
          <div
            data-suggestion-top-reason
            style={{
              fontSize: 11,
              color: OPS_INK.muted,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {suggestion.reasons[0]!.label}
            {suggestion.reasons.length > 1 ? (
              <span
                style={{
                  color: OPS_INK.subtle,
                  marginLeft: 4,
                  fontWeight: 600,
                }}
              >
                +{suggestion.reasons.length - 1}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          flexWrap: "wrap",
        }}
      >
        {suggestion.riskFlags.map((flag) => {
          const flagPalette = RISK_PALETTE[flag.severity];
          return (
            <span
              key={flag.code}
              data-risk-flag
              data-risk-severity={flag.severity}
              title={flag.label}
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "1px 7px",
                background: flagPalette.bg,
                border: `1px solid ${flagPalette.border}`,
                color: flagPalette.ink,
                borderRadius: 4,
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: 0.3,
              }}
            >
              {flag.code === "reviewer_overloaded"
                ? "OVERLOAD"
                : flag.code === "reviewer_overdue_pressure"
                  ? "OVERDUE"
                  : flag.code === "reviewer_escalation_pressure"
                    ? "ESC"
                    : flag.code === "reviewer_recent_assignment_burst"
                      ? "BURST"
                      : flag.code === "reviewer_inactive_warning"
                        ? "INACTIVE"
                        : flag.code === "workload_imbalance"
                          ? "IMBAL"
                          : "RISK"}
            </span>
          );
        })}
      </div>
      <span
        data-suggestion-score
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: OPS_INK.subtle,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {suggestion.score}
      </span>
    </>
  );

  if (onSelect) {
    return (
      <button
        type="button"
        data-suggestion-row
        data-suggestion-band={suggestion.recommendationBand}
        onClick={onSelect}
        title={tooltip}
        style={{
          ...rowStyle,
          cursor: "pointer",
        }}
      >
        {content}
      </button>
    );
  }

  return (
    <div
      data-suggestion-row
      data-suggestion-band={suggestion.recommendationBand}
      title={tooltip}
      style={rowStyle}
    >
      {content}
    </div>
  );
}
