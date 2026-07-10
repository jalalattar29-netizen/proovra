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
  indigo: "#4f46e5",
  violet: "#6d28d9",
  teal: "#0e7490",

  // Status
  ok: "#059669",
  okDeep: "#065f46",
  warn: "#d97706",
  warnDeep: "#92400e",
  danger: "#dc2626",
  dangerDeep: "#991b1b",

  // Text
  ink: "#0f172a",
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
  indigo: "rgba(79, 70, 229, 0.08)",
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
  background: "rgba(255, 255, 255, 0.88)",
  border: "1px solid rgba(15, 23, 42, 0.07)",
  borderRadius: 20,
  padding: 22,
  margin: 0,
  boxShadow: "0 16px 40px rgba(15, 23, 42, 0.055)",
};

/** Denser variant for tables / data-heavy panels — a stronger opacity so
 * small text keeps full contrast. Same border/shadow/radius language. */
export const homeCardDenseStyle: React.CSSProperties = {
  ...homeCardStyle,
  background: "rgba(255, 255, 255, 0.94)",
};

/** Premium enterprise WARNING surface (Action needed / needs-attention).
 * Warm ivory, restrained amber accent — serious + operational, never the
 * cheap saturated-orange block. */
export const HOME_WARN = {
  bg: "rgba(255, 250, 240, 0.9)",
  bgSolid: "#FFF9ED",
  border: "rgba(180, 116, 35, 0.18)",
  accent: "#B7791F",
  accentDeep: "#A16207",
  badgeBg: "rgba(180, 116, 35, 0.10)",
  badgeText: "#7C4A03",
  buttonBg: "#1F2937",
  buttonText: "#ffffff",
} as const;

/** The premium enterprise warning card — ivory glass + a restrained amber
 * left accent. Consistent radius/shadow with the default card. */
export const homeWarningCardStyle: React.CSSProperties = {
  background: HOME_WARN.bg,
  border: `1px solid ${HOME_WARN.border}`,
  borderLeft: `3px solid ${HOME_WARN.accent}`,
  borderRadius: 20,
  padding: 22,
  margin: 0,
  boxShadow: "0 16px 40px rgba(120, 74, 3, 0.05)",
};

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
