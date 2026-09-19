/**
 * CANONICAL PROOVRA DESIGN TOKENS — cross-platform source of truth (Law of One).
 *
 * These values are mirrored verbatim from the web design authority
 * `apps/web/lib/design-tokens/tokens.css` (the `:root` block). Web renders them
 * as CSS custom properties; native maps them through a StyleSheet adapter
 * (`apps/mobile/src/theme`). The two renderers differ; the VALUES are one set.
 *
 * A drift guard (`apps/mobile/test/design-token-parity.test.mjs`) asserts these
 * values equal the web authority and the native adapter, so the platforms can
 * never silently diverge again (the root cause of the 2026-02→2026-09 drift).
 *
 * This module is ADDITIVE. The legacy `colors`/`spacing`/`radius`/`typography`/
 * `shadows` exports remain for un-migrated mobile screens and are retired
 * per-surface as later convergence phases move screens onto `proovraTokens`.
 * Do not change a value here without updating tokens.css in the same change —
 * the parity guard will fail otherwise, which is the point.
 */

/** Semantic surface backgrounds. */
export const proovraSurface = {
  app: "#F7F8FC",
  card: "#FFFFFF",
  elevated: "#FFFFFF",
  muted: "#F1F4F9",
  header: "#F8FAFC",
} as const;

/** Hairline/border tones (translucent slate). */
export const proovraBorder = {
  subtle: "rgba(15, 23, 42, 0.06)",
  default: "rgba(15, 23, 42, 0.09)",
  strong: "rgba(15, 23, 42, 0.14)",
} as const;

/** Text ("ink") hierarchy. */
export const proovraInk = {
  primary: "#0F172A",
  secondary: "#475569",
  muted: "#94A3B8",
  inverse: "#F8FAFC",
} as const;

/** The ONE brand accent (purple). */
export const proovraAccent = {
  a050: "#F2ECFE",
  a200: "#D9C7FB",
  a500: "#7C3AED",
  a600: "#6D28D9",
} as const;

/** Semantic status colors + WCAG-tuned "ink" variants. */
export const proovraSemantic = {
  success: "#10B981",
  successInk: "#167A5B",
  successStandard: "#15803D",
  warning: "#F59E0B",
  warningInk: "#B45309",
  error: "#DC2626",
  errorInk: "#B91C1C",
  info: "#2563EB",
  orangeFill: "#F97316",
  orangeInk: "#C2410C",
  silverInk: "#5B6B7B",
} as const;

/** AppStatusBadge palette: bg / fg / border / solid per tone. */
export const proovraStatus = {
  verified: { bg: "#ECFDF5", fg: "#065F46", border: "#A7F3D0", solid: "#10B981" },
  pending: { bg: "#FEF3C7", fg: "#78350F", border: "#FDE68A", solid: "#F59E0B" },
  risk: { bg: "#FEF2F2", fg: "#991B1B", border: "#FECACA", solid: "#DC2626" },
  neutral: { bg: "#F1F5F9", fg: "#475569", border: "#CBD5E1", solid: "#64748B" },
  governance: { bg: "#EEEBFF", fg: "#4634C9", border: "#D6CFFB", solid: "#7C3AED" },
  info: { bg: "#EFF6FF", fg: "#1E40AF", border: "#BFDBFE", solid: "#2563EB" },
} as const;

/** Corner radii (px / RN numbers). Mirrors --radius-*. */
export const proovraRadius = {
  sm: 6,
  md: 8,
  lg: 12,
  card: 14,
  pill: 999,
} as const;

/** 4px spacing scale. Mirrors --space-N (N = px/4). */
export const proovraSpace = {
  s1: 4,
  s2: 8,
  s3: 12,
  s4: 16,
  s5: 20,
  s6: 24,
  s8: 32,
  s10: 40,
} as const;

/**
 * Elevation semantics. Web values (for reference/parity); the native adapter
 * translates these into RN shadow objects (iOS) + elevation (Android).
 */
export const proovraElevationWeb = {
  card: "0 1px 2px rgba(15, 23, 42, 0.04)",
  elevated: "0 8px 24px rgba(15, 23, 42, 0.08)",
  drawer: "0 0 40px rgba(15, 23, 42, 0.1)",
} as const;

/**
 * Type scale (native-authored, consistent with web body=14/600 card titles).
 * Web does not expose a single numeric scale as CSS vars, so this is NOT
 * parity-asserted against tokens.css — it is the canonical scale both platforms
 * consume. Fonts are the self-hosted Plus Jakarta Sans (latin) + Noto Arabic.
 */
export const proovraType = {
  family: { latin: "Plus Jakarta Sans", arabic: "Noto Sans Arabic" },
  size: { display: 28, h1: 22, h2: 18, h3: 16, body: 14, bodySm: 13, label: 12, mono: 12 },
  weight: { regular: "400", medium: "500", semibold: "600", bold: "700" },
  lineHeight: { display: 34, h1: 28, h2: 24, h3: 22, body: 20, bodySm: 18, label: 16 },
} as const;

/** The single canonical token bundle. */
export const proovraTokens = {
  surface: proovraSurface,
  border: proovraBorder,
  ink: proovraInk,
  accent: proovraAccent,
  semantic: proovraSemantic,
  status: proovraStatus,
  radius: proovraRadius,
  space: proovraSpace,
  elevationWeb: proovraElevationWeb,
  type: proovraType,
} as const;

export type ProovraTokens = typeof proovraTokens;
export type ProovraStatusTone = keyof typeof proovraStatus;
