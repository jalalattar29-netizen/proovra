/**
 * PROOVRA Feedback System — shared severity model.
 *
 * One source of truth for the colours, ARIA semantics and icon per
 * feedback severity, consumed by every feedback primitive (toast,
 * alert, banner, inline error, empty/error/loading/progress states).
 *
 * Visual direction: light pearl/white surfaces, deep-navy ink, a small
 * severity ACCENT (restrained green / amber / red / slate-blue) carried
 * by a left rail + a tinted icon chip. No dark-navy blocks, no loud
 * colours, no gradients. Values align with lib/design-tokens/tokens.css.
 */

import type { CSSProperties } from "react";

export type FeedbackSeverity =
  | "success"
  | "error"
  | "warning"
  | "info"
  | "neutral"
  | "loading";

export interface SeverityToken {
  /** Strong accent — left rail, icon stroke, primary emphasis. */
  accent: string;
  /** Deep ink for the severity (used sparingly, e.g. titles). */
  ink: string;
  /** Very soft tint for the icon chip background. */
  tint: string;
  /** Icon chip border. */
  chipBorder: string;
}

export const SEVERITY: Record<FeedbackSeverity, SeverityToken> = {
  success: { accent: "#059669", ink: "#065F46", tint: "#ECFDF5", chipBorder: "rgba(5,150,105,0.28)" },
  error: { accent: "#DC2626", ink: "#991B1B", tint: "#FEF2F2", chipBorder: "rgba(220,38,38,0.26)" },
  warning: { accent: "#D97706", ink: "#92400E", tint: "#FFFBEB", chipBorder: "rgba(217,119,6,0.28)" },
  info: { accent: "#2563EB", ink: "#1E40AF", tint: "#EFF6FF", chipBorder: "rgba(37,99,235,0.26)" },
  neutral: { accent: "#64748B", ink: "#334155", tint: "#F8FAFC", chipBorder: "rgba(100,116,139,0.24)" },
  loading: { accent: "#6D28D9", ink: "#3730A3", tint: "#EEF2FF", chipBorder: "rgba(89,73,228,0.26)" },
} as const;

/** Shared surface tokens — premium light card, deep-navy ink. */
export const FEEDBACK_SURFACE = {
  card: "#FFFFFF",
  pearl: "#F7F8FC",
  ink: "#0F172A",
  inkMuted: "#475569",
  inkSubtle: "#64748B",
  border: "#E7ECF4",
  shadow: "0 8px 28px rgba(15, 23, 42, 0.10), 0 1px 2px rgba(15, 23, 42, 0.04)",
  shadowSoft: "0 1px 2px rgba(15, 23, 42, 0.04), 0 6px 20px rgba(15, 23, 42, 0.06)",
  radius: 14,
} as const;

/**
 * ARIA live semantics: errors/warnings interrupt (assertive/alert);
 * success/info/neutral/loading are polite (status).
 */
export function feedbackRole(severity: FeedbackSeverity): "alert" | "status" {
  return severity === "error" || severity === "warning" ? "alert" : "status";
}

export function feedbackAriaLive(
  severity: FeedbackSeverity,
): "assertive" | "polite" {
  return severity === "error" || severity === "warning" ? "assertive" : "polite";
}

/**
 * FeedbackIcon — small, calm, stroke-based severity glyph. `loading`
 * renders an indeterminate spinner. No oversized icons.
 */
export function FeedbackIcon({
  severity,
  size = 16,
  color,
}: {
  severity: FeedbackSeverity;
  size?: number;
  color?: string;
}) {
  const stroke = color ?? SEVERITY[severity].accent;
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke,
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (severity === "loading") {
    return (
      <svg {...common} style={spinnerStyle}>
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
    );
  }
  if (severity === "success") {
    return (
      <svg {...common}>
        <path d="M20 6 9 17l-5-5" />
      </svg>
    );
  }
  if (severity === "error") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M15 9l-6 6M9 9l6 6" />
      </svg>
    );
  }
  if (severity === "warning") {
    return (
      <svg {...common}>
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
        <path d="M12 9v4M12 17h.01" />
      </svg>
    );
  }
  // info + neutral
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4M12 8h.01" />
    </svg>
  );
}

const spinnerStyle: CSSProperties = {
  animation: "pf-spin 0.8s linear infinite",
};
