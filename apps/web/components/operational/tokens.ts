/**
 * Phase 28-I — Operational color tokens (light-surface enterprise palette).
 *
 * The Phase 28-G/H operational components were originally drafted for a
 * dark velvet shell and used `rgba(255,255,255,...)` text on translucent
 * tinted backgrounds. When those components were dropped onto our light
 * authenticated pages (governance, reviewer-ops, observability, evidence
 * detail) the text became invisible. This module is the SINGLE source of
 * truth for operational color tokens that are readable on light
 * enterprise surfaces.
 *
 * Hard rules:
 *   - Backgrounds are tinted but light (50/100 shades). Text is dark
 *     enough to clear WCAG AA on those backgrounds.
 *   - Severity colors are consistent across every component (warning =
 *     amber, high = red, critical = deep red, info = blue, healthy =
 *     emerald).
 *   - No literal `rgba(255,255,255,...)` outside this file.
 *   - Inline `style` consumers import named tokens — no hex literals
 *     scattered across components.
 */

export const OPS_INK = {
  /** Default body text on a light card. WCAG-readable on white/slate-50. */
  default: "#0f172a", // slate-900
  /** Secondary / muted text. WCAG-readable on white. */
  muted: "#475569", // slate-600
  /** Tertiary / kicker / table-meta text. */
  subtle: "#64748b", // slate-500
} as const;

export const OPS_SURFACE = {
  card: "#ffffff",
  cardMuted: "#f8fafc", // slate-50
  border: "#e2e8f0", // slate-200
  borderStrong: "#cbd5e1", // slate-300
} as const;

export const OPS_LINK = {
  /** Default link inside operational cards. WCAG-readable on white + amber/red 50. */
  default: "#1d4ed8", // blue-700
  defaultHover: "#1e40af", // blue-800
  /** Link sitting on a red-tinted (CRITICAL/UNKNOWN) banner. */
  onRed: "#991b1b", // red-800 — readable on red-50/red-100
  /** Link sitting on an amber-tinted (DEGRADED/WARNING) banner. */
  onAmber: "#92400e", // amber-800
} as const;

/**
 * Severity tone — readable on a light card. Each variant pairs a tinted
 * background with a dark foreground (dark enough to clear WCAG AA).
 */
export type OpsSeverity =
  | "neutral"
  | "info"
  | "healthy"
  | "warning"
  | "degraded"
  | "high"
  | "critical"
  | "unknown";

export type OpsToneToken = {
  bg: string;
  border: string;
  ink: string;
  inkMuted: string;
  kicker: string;
  /** Link color guaranteed to clear AA on this background. */
  link: string;
};

export const OPS_TONES: Record<OpsSeverity, OpsToneToken> = {
  neutral: {
    bg: OPS_SURFACE.card,
    border: OPS_SURFACE.border,
    ink: OPS_INK.default,
    inkMuted: OPS_INK.muted,
    kicker: OPS_INK.subtle,
    link: OPS_LINK.default,
  },
  info: {
    bg: "#eff6ff", // blue-50
    border: "#bfdbfe", // blue-200
    ink: "#1e3a8a", // blue-900
    inkMuted: "#1d4ed8", // blue-700
    kicker: "#1d4ed8",
    link: "#1e3a8a",
  },
  healthy: {
    bg: "#ecfdf5", // emerald-50
    border: "#a7f3d0", // emerald-200
    ink: "#064e3b", // emerald-900
    inkMuted: "#065f46", // emerald-800
    kicker: "#065f46",
    link: "#064e3b",
  },
  warning: {
    bg: "#fffbeb", // amber-50
    border: "#fcd34d", // amber-300
    ink: "#78350f", // amber-900
    inkMuted: "#92400e", // amber-800
    kicker: "#92400e",
    link: OPS_LINK.onAmber,
  },
  degraded: {
    bg: "#fffbeb", // amber-50
    border: "#fbbf24", // amber-400
    ink: "#78350f",
    inkMuted: "#92400e",
    kicker: "#b45309", // amber-700
    link: OPS_LINK.onAmber,
  },
  high: {
    bg: "#fef2f2", // red-50
    border: "#fca5a5", // red-300
    ink: "#7f1d1d", // red-900
    inkMuted: "#991b1b", // red-800
    kicker: "#b91c1c", // red-700
    link: OPS_LINK.onRed,
  },
  critical: {
    bg: "#fee2e2", // red-100
    border: "#ef4444", // red-500
    ink: "#7f1d1d",
    inkMuted: "#991b1b",
    kicker: "#b91c1c",
    link: OPS_LINK.onRed,
  },
  unknown: {
    bg: "#fef2f2",
    border: "#fca5a5",
    ink: "#7f1d1d",
    inkMuted: "#991b1b",
    kicker: "#b91c1c",
    link: OPS_LINK.onRed,
  },
};

/**
 * Severity dot color for inline lists (timeline / warning rows). These
 * are saturated and small enough that the WCAG ratio isn't load-bearing
 * — they're decorative indicators paired with text label.
 */
export const OPS_SEVERITY_DOT: Record<
  "INFO" | "WARNING" | "HIGH" | "CRITICAL",
  string
> = {
  INFO: "#3b82f6", // blue-500
  WARNING: "#f59e0b", // amber-500
  HIGH: "#ef4444", // red-500
  CRITICAL: "#b91c1c", // red-700
};

/**
 * Eligibility pill — bounded set of palettes (loading / unknown /
 * eligible / blocked). Each pairs a tinted background with dark text.
 */
export const OPS_PILL = {
  loading: {
    bg: OPS_SURFACE.cardMuted,
    color: OPS_INK.subtle,
    border: OPS_SURFACE.border,
  },
  unknown: {
    bg: OPS_TONES.unknown.bg,
    color: OPS_TONES.unknown.inkMuted,
    border: OPS_TONES.unknown.border,
  },
  eligible: {
    bg: OPS_TONES.healthy.bg,
    color: OPS_TONES.healthy.inkMuted,
    border: OPS_TONES.healthy.border,
  },
  blocked: {
    bg: OPS_TONES.high.bg,
    color: OPS_TONES.high.inkMuted,
    border: OPS_TONES.high.border,
  },
} as const;
