/**
 * Phase HOME-POLISH — the PROOVRA Home visual system.
 *
 * One palette + card vocabulary shared by every Home widget. Inspired
 * by the premium-SaaS reference treatment (soft pearl surface, glassy
 * cards, icon blocks, restrained gradients) but adapted to PROOVRA's
 * identity: legal-grade evidence operations — deep wine primary,
 * indigo/violet secondary, teal trust accent. Serious, not neon.
 *
 * Color is used for STATUS and HIERARCHY only — never decoration of
 * fabricated numbers.
 */

import type * as React from "react";

export const HOME_COLORS = {
  // Brand accents
  wine: "#7a1638",
  wineDeep: "#5c1029",
  indigo: "#6D28D9",
  violet: "#6d28d9",
  teal: "#0e7490",

  /*
   * STATUS — the product tokens, not a second palette.
   *
   * These were hand-written hexes: `warn` was #d97706 (amber-600) while
   * Operations paints a High incident with tone `orange` -> `--orange-ink`
   * (#C2410C), and `ok` was #059669 against the canonical
   * `--success-standard` (#15803D). Two palettes for one product, so the same
   * state wore a different colour depending on which page you were looking at.
   *
   * They are `var()` references now with the canonical value as the fallback,
   * which works because every consumer here puts them in a CSS property.
   * `AppStatusText` resolves the same tone vocabulary the same way.
   */
  ok: "var(--success-standard, #15803D)",
  okDeep: "var(--success-standard, #15803D)",
  warn: "var(--orange-ink, #C2410C)",
  warnDeep: "var(--orange-ink, #C2410C)",
  danger: "var(--error, #DC2626)",
  dangerDeep: "var(--error, #DC2626)",

  /** Inline navigational actions — the blue Notifications and Search use. */
  action: "var(--info, #2563EB)",

  // Text
  ink: "var(--ink-primary, #0F172A)",
  slate: "#475569",
  muted: "#94a3b8",

  // Surfaces
  card: "#ffffff",
  cardBorder: "rgba(15, 23, 42, 0.07)",
  soft: "rgba(15, 23, 42, 0.025)",
  pearl: "#f7f7fb",
} as const;

/** Soft tints for status fills (chips, rows, stat tiles). */
export const HOME_TINTS = {
  wine: "rgba(122, 22, 56, 0.07)",
  indigo: "rgba(124, 58, 237, 0.08)",
  violet: "rgba(109, 40, 217, 0.08)",
  teal: "rgba(14, 116, 144, 0.08)",
  ok: "rgba(5, 150, 105, 0.09)",
  warn: "rgba(217, 119, 6, 0.10)",
  danger: "rgba(220, 38, 38, 0.08)",
} as const;

export type HomeTone = "ok" | "warn" | "danger" | "neutral";

export function toneColor(tone: HomeTone): { fg: string; bg: string; dot: string } {
  switch (tone) {
    case "ok":
      return { fg: HOME_COLORS.okDeep, bg: HOME_TINTS.ok, dot: HOME_COLORS.ok };
    case "warn":
      return { fg: HOME_COLORS.warnDeep, bg: HOME_TINTS.warn, dot: HOME_COLORS.warn };
    case "danger":
      return { fg: HOME_COLORS.dangerDeep, bg: HOME_TINTS.danger, dot: HOME_COLORS.danger };
    default:
      return { fg: HOME_COLORS.slate, bg: "rgba(100, 116, 139, 0.08)", dot: HOME_COLORS.muted };
  }
}

/** The canonical Home card — one consistent enterprise surface shared by
 * every Home widget: a lightly translucent white that reads as premium
 * glass over the branded app background (never a flat pure-white block),
 * a single hairline border, one soft depth shadow, 20px radius and calm
 * internal padding. Dense cards/tables can raise opacity via
 * `homeCardDenseStyle`. */
export const homeCardStyle: React.CSSProperties = {
  // Unified translucent OUTER-card surface shared by EVERY large Home module
  // (Overview / Operations / Analytics) so no module reads as solid white —
  // the branded page background shows through consistently. Inner rows/cells
  // stay more opaque for readability.
  background: "rgba(255, 255, 255, 0.30)",
  border: "1px solid rgba(255, 255, 255, 0.50)",
  borderRadius: 18,
  padding: 20,
  margin: 0,
  boxShadow: "0 10px 26px rgba(15, 23, 42, 0.025)",
  backdropFilter: "blur(5px)",
  WebkitBackdropFilter: "blur(5px)",
};

/** Denser variant for tables / data-heavy panels — a stronger opacity so
 * small text keeps full contrast. Same border/shadow/radius language. */
export const homeCardDenseStyle: React.CSSProperties = {
  ...homeCardStyle,
  background: "rgba(255, 255, 255, 0.94)",
};

/** Premium enterprise WARNING surface (Action needed / needs-attention).
 * A near-WHITE card with only a thin muted-amber LEFT accent — restrained
 * and enterprise, never a full yellow fill or saturated-orange block. */
export const HOME_WARN = {
  bg: "rgba(255, 255, 255, 0.72)",
  bgSolid: "#ffffff",
  border: "rgba(15, 23, 42, 0.07)",
  // Muted enterprise amber for the thin left accent line (not bright yellow).
  accent: "#C8922D",
  accentDeep: "#A16207",
  // Status badge: very light warm ivory + muted amber/brown text.
  badgeBg: "rgba(200, 146, 45, 0.10)",
  badgeText: "#7C4A03",
} as const;

/** The enterprise warning card — near-white surface, a thin ~3px muted-amber
 * left accent line, a very subtle neutral border + soft shadow. */
export const homeWarningCardStyle: React.CSSProperties = {
  background: HOME_WARN.bg,
  border: `1px solid ${HOME_WARN.border}`,
  borderLeft: `3px solid ${HOME_WARN.accent}`,
  borderRadius: 18,
  padding: 20,
  margin: 0,
  boxShadow: "0 10px 28px rgba(15, 23, 42, 0.045)",
};

/** Light enterprise SECONDARY action button — white surface, subtle indigo
 * border, indigo/blue-violet text. The premium secondary-action language
 * shared by Home module CTAs (matches "All evidence →" text actions), never
 * a heavy black fill. */
export const homeSecondaryButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 14px",
  borderRadius: 10,
  background: "rgba(255, 255, 255, 0.94)",
  border: "1px solid rgba(124, 58, 237, 0.20)",
  color: "#6D28D9",
  fontSize: 12.5,
  fontWeight: 650,
  textDecoration: "none",
  whiteSpace: "nowrap",
  boxShadow: "0 6px 16px rgba(124, 58, 237, 0.06)",
  cursor: "pointer",
};

/** Indigo/blue-violet accent family for file-type badges (DOC/IMG/etc.) and
 * other Home chips — consistent with the "All evidence →" action colour. */
export const HOME_ACCENT = {
  ink: "#6D28D9",
  inkStrong: "#7C3AED",
  bg: "rgba(124, 58, 237, 0.08)",
  border: "rgba(124, 58, 237, 0.10)",
} as const;

/**
 * The Operations-tab semantic colours — the PRODUCT's, not this file's.
 *
 * This block called itself "ONE unified enterprise semantic colour system",
 * and within Home it was: every pending used the same amber, every failure
 * the same red. The problem is that it was a THIRD system. `#A86612` is a
 * brown; Operations paints a pending state with tone `orange`, which
 * `AppStatusText` resolves to `--orange-ink` (#C2410C). `#B9383E` is a
 * muted rose; canonical critical is `--error` (#DC2626). `#167A5B` is a
 * teal-green against `--success-standard` (#15803D).
 *
 * So "10 pending" on Home and "High" on /operations described the same
 * urgency in two different colours, and neither was wrong locally — they were
 * just answering to different authorities.
 *
 * Every `strong` value is now the token `AppStatusText` would resolve for the
 * same tone. The soft backgrounds are derived from those tokens rather than
 * hand-mixed, so a tint can no longer drift away from the ink it sits behind.
 */
export const HOME_SEMANTIC = {
  success: {
    strong: "var(--success-standard, #15803D)",
    text: "var(--success-standard, #15803D)",
    icon: "var(--success-standard, #15803D)",
    softBg: "rgba(21, 128, 61, 0.08)",
    subtleBg: "rgba(21, 128, 61, 0.06)",
    border: "rgba(21, 128, 61, 0.16)",
  },
  amber: {
    strong: "var(--orange-ink, #C2410C)",
    softBg: "rgba(194, 65, 12, 0.07)",
    border: "rgba(194, 65, 12, 0.16)",
  },
  critical: {
    strong: "var(--error, #DC2626)",
    softBg: "rgba(220, 38, 38, 0.07)",
    border: "rgba(220, 38, 38, 0.16)",
  },
  info: {
    /* Informational badges ("Report v2") and inline actions read as the
       product's action blue, the one Notifications and Search use. */
    strong: "var(--info, #2563EB)",
    softBg: "rgba(37, 99, 235, 0.08)",
    border: "rgba(37, 99, 235, 0.14)",
  },
  neutral: {
    numberInk: "#111827",
    secondary: "#64748B",
    softBg: "rgba(248, 250, 252, 0.78)",
    border: "rgba(15, 23, 42, 0.045)",
  },
} as const;

/** Chip base (inlined to avoid a TDZ ref to `homeChipStyle` defined later). */
const CHIP_BASE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  padding: "3px 9px",
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 650,
  whiteSpace: "nowrap",
};

/** Shared success badge (Live / Package ready / Active links / …). */
export const successBadgeStyle: React.CSSProperties = {
  ...CHIP_BASE,
  background: HOME_SEMANTIC.success.softBg,
  color: HOME_SEMANTIC.success.strong,
  border: `1px solid ${HOME_SEMANTIC.success.border}`,
};

/** Shared informational badge (e.g. "Report v2"). */
export const infoBadgeStyle: React.CSSProperties = {
  ...CHIP_BASE,
  background: HOME_SEMANTIC.info.softBg,
  color: HOME_SEMANTIC.info.strong,
  border: `1px solid ${HOME_SEMANTIC.info.border}`,
};

/** Consistent inner list-row surface shared by every Operations card. */
export const homeOpsRowStyle: React.CSSProperties = {
  background: "rgba(248, 250, 252, 0.72)",
  border: "1px solid rgba(15, 23, 42, 0.045)",
  borderRadius: 12,
};

/** Large OUTER module surface — lighter + more translucent than the inner
 * rows/tiles so the page background shows through and we avoid the
 * "white card inside white card" look. Inner rows use homeOpsRowStyle /
 * ~0.72 white for readability; charts stay transparent. Subtle, not heavy
 * glassmorphism. */
export const homeOuterCardStyle: React.CSSProperties = {
  background: "rgba(255, 255, 255, 0.30)",
  border: "1px solid rgba(255, 255, 255, 0.50)",
  borderRadius: 18,
  padding: 20,
  boxShadow: "0 10px 26px rgba(15, 23, 42, 0.025)",
  backdropFilter: "blur(5px)",
  WebkitBackdropFilter: "blur(5px)",
};

/** Inner metric cell / tile surface — more opaque than the translucent
 * outer module so small numbers stay readable, but not solid white. */
export const homeInnerCellStyle: React.CSSProperties = {
  background: "rgba(255, 255, 255, 0.64)",
  border: "1px solid rgba(15, 23, 42, 0.045)",
  borderRadius: 12,
};

/** Refined ANALYTICS-only palette (charts). Kept SEPARATE from the semantic
 * status system (HOME_SEMANTIC) — analytics colours never leak into health
 * status rows and vice-versa. */
export const ANALYTICS_PALETTE = {
  // Two clean series for the Evidence Activity chart.
  evidenceSeries: "#6D4AFF",
  reportsSeries: "#2F6FE4",
  // Records-by-type donut — Indigo & Rose enterprise palette. These are the
  // LEGEND-dot base colours (each matches its donut segment gradient).
images: "#A92F54",
documents: "#6654E8",
videos: "#3974DC",
audio: "#746FE8",
archives: "#293A58",
//   // Storage progress value.
  storageBar: "#7C3AED",
  storageTrack: "rgba(226, 232, 240, 0.88)",
  // Chart chrome.
  gridLine: "rgba(15, 23, 42, 0.07)",
  axisText: "#7A8699",
  legendText: "#556274",
} as const;

export const homeCardHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  marginBottom: 14,
  gap: 10,
};

export const homeCardTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  fontWeight: 700,
  color: HOME_COLORS.ink,
  textTransform: "uppercase",
  letterSpacing: 0.4,
};

export const homeCardCtaStyle: React.CSSProperties = {
  fontSize: 12,
  color: HOME_COLORS.indigo,
  textDecoration: "none",
  fontWeight: 600,
  whiteSpace: "nowrap",
};

export const homeChipStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "3px 9px",
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 600,
  whiteSpace: "nowrap",
};

/** Icon block — the colored rounded square behind each card/KPI icon. */
export const iconBlockStyle = (
  tint: string,
  size = 36,
): React.CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: size,
  height: size,
  borderRadius: Math.round(size * 0.3),
  background: tint,
  flexShrink: 0,
});

/**
 * The page container. Sits directly on the app surface — NO colored
 * hero panel, NO purple radials, NO rounded banner. A wide, centered
 * responsive container so cards fill the available width on desktop
 * instead of floating inside big empty margins. Spacing is on the 8px
 * system (24px padding / 20px section gap).
 */
export const homePageStyle: React.CSSProperties = {
  // Centered container. The app shell already supplies the horizontal
  // gutter (40px), so the page adds NONE — avoiding double padding.
  // Vertical rhythm + section gaps stay on the 8px grid.
  maxWidth: 1600,
  margin: "0 auto",
  padding: "4px 0 40px",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  display: "flex",
  flexDirection: "column",
  gap: 20,
  background: "transparent",
};
