/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Source:    apps/web/lib/design-tokens/tokens.css (:root)
 * Generator: packages/ui/tools/generate-tokens.mjs
 * Guard:     packages/ui/tests/tokens-generated.test.mjs
 *
 * The web renders these as CSS custom properties; native maps them through the
 * StyleSheet adapter in apps/mobile/src/theme. One authored source, two
 * renderers — editing this file instead of the CSS will be overwritten and the
 * guard will fail.
 */

/** Semantic surface backgrounds. */
export const proovraSurface = {
  app: "#F7F8FC",
  card: "#FFFFFF",
  elevated: "#FFFFFF",
  muted: "#F1F4F9",
  translucentOuter: "rgba(255, 255, 255, 0.80)",
  translucentInner: "rgba(255, 255, 255, 0.62)",
  translucentInnerHover: "rgba(255, 255, 255, 0.76)",
  translucentSelected: "rgba(242, 236, 254, 0.72)",
  translucentBorder: "rgba(255, 255, 255, 0.58)",
  translucentBorderStrong: "rgba(15, 23, 42, 0.07)",
  header: "#F8FAFC",
  page: "#F7F8FC",
  subtle: "#F1F4F9",
  hover: "#F1F4F9",
  inset: "#0F172A",
} as const;

/** Hairline/border tones. */
export const proovraBorder = {
  subtle: "rgba(15, 23, 42, 0.06)",
  default: "rgba(15, 23, 42, 0.09)",
  strong: "rgba(15, 23, 42, 0.14)",
  standard: "rgba(15, 23, 42, 0.14)",
} as const;

/** Text ("ink") hierarchy. */
export const proovraInk = {
  primary: "#0F172A",
  secondary: "#475569",
  muted: "#94A3B8",
  inverse: "#F8FAFC",
} as const;

/** The brand accent ramp. */
export const proovraAccent = {
  "200": "#D9C7FB",
  "500": "#7C3AED",
  "600": "#6D28D9",
  a200: "#D9C7FB",
  a500: "#7C3AED",
  a600: "#6D28D9",
  "050": "#F2ECFE",
  a050: "#F2ECFE",
  standard: "#7C3AED",
} as const;

/** Semantic status colours and their WCAG-tuned ink variants. */
export const proovraSemantic = {
  success: "#10B981",
  warning: "#F59E0B",
  warningInk: "#B45309",
  successInk: "#167A5B",
  successStandard: "#15803D",
  error: "#DC2626",
  info: "#2563EB",
  orangeFill: "#F97316",
  orangeInk: "#C2410C",
  silverInk: "#5B6B7B",
  focusRing: "0 0 0 3px rgba(107, 91, 255, 0.28)",
  errorInk: "#B91C1C",
  danger500: "#DC2626",
  dangerStrong: "#B91C1C",
  dangerBorder: "#FECACA",
  infoBorder: "#BFDBFE",
  hairline: "rgba(15, 23, 42, 0.09)",
  inkLink: "#6D28D9",
  brandAccent: "#7C3AED",
} as const;

/** Status badge palette: bg / fg / border / solid per tone. */
export const proovraStatus = {
  verified: {
    bg: "#ECFDF5",
    fg: "#065F46",
    border: "#A7F3D0",
    solid: "#10B981",
  },
  pending: {
    bg: "#FEF3C7",
    fg: "#78350F",
    border: "#FDE68A",
    solid: "#F59E0B",
  },
  risk: {
    bg: "#FEF2F2",
    fg: "#991B1B",
    border: "#FECACA",
    solid: "#DC2626",
  },
  neutral: {
    bg: "#F1F5F9",
    fg: "#475569",
    border: "#CBD5E1",
    solid: "#64748B",
  },
  governance: {
    bg: "#EEEBFF",
    fg: "#4634C9",
    border: "#D6CFFB",
    solid: "#7C3AED",
  },
  info: {
    bg: "#EFF6FF",
    fg: "#1E40AF",
    border: "#BFDBFE",
    solid: "#2563EB",
  },
} as const;

/** Text-only status tones (tokens.css declares these without a surface). */
export const proovraStatusText = {
  ok: "#15803D",
  warn: "#C2410C",
} as const;

/** Corner radii (px numbers, ready for RN). */
export const proovraRadius = {
  sm: 6,
  md: 8,
  lg: 12,
  card: 14,
  pill: 999,
} as const;

/** Spacing scale (px numbers, ready for RN). */
export const proovraSpace = {
  "1": 4,
  "2": 8,
  "3": 12,
  "4": 16,
  "5": 20,
  "6": 24,
  "8": 32,
  "10": 40,
  s1: 4,
  s2: 8,
  s3: 12,
  s4: 16,
  s5: 20,
  s6: 24,
  s8: 32,
  s10: 40,
} as const;

/** Navigation shell tones. */
export const proovraNav = {
  inkStrong: "#F8FAFC",
  ink: "rgba(226, 232, 240, 0.82)",
  inkMuted: "rgba(226, 232, 240, 0.42)",
  iconIdle: "rgba(226, 232, 240, 0.58)",
  hoverBg: "rgba(255, 255, 255, 0.05)",
  activeBg: "rgba(255, 255, 255, 0.06)",
  divider: "rgba(255, 255, 255, 0.08)",
} as const;

/** Layout measures the web shell clamps to. */
export const proovraLayout = {
  pageMaxW: 1360,
  pagePadX: 32,
  pagePadY: 28,
  headerH: 72,
  cellMaxW: "34ch",
  admWWide: 1440,
  admWPage: 1280,
  admWRead: "74ch",
} as const;

/** Every other web token, verbatim, so nothing is unavailable to native. */
export const proovraRaw = {
  error050: "#FEF2F2",
  error200: "#FECACA",
  orange050: "#FFF7ED",
  orange200: "#FED7AA",
  orange500: "#EA580C",
  toneRed: "#DC2626",
  toneOrange: "#EA580C",
  toneAmber: "#B45309",
  toneGreen: "#167A5B",
  toneBlue: "#2563EB",
  toneIndigo: "#6D28D9",
  toneSlate: "#475569",
  tonePurple: "#7C3AED",
  toneSilver: "#5B6B7B",
  toneBlack: "#0F172A",
  layerDialog: "1000",
  layerAnchoredOverlay: "100000",
  shadowCard: "0 1px 2px rgba(15, 23, 42, 0.04)",
  shadowElevated: "0 8px 24px rgba(15, 23, 42, 0.08)",
  shadowDropdown: "0 12px 40px rgba(15, 23, 42, 0.12),\n    0 2px 6px rgba(15, 23, 42, 0.04)",
  shadowDrawer: "0 0 40px rgba(15, 23, 42, 0.1)",
  scrim: "rgba(15, 23, 42, 0.42)",
  fontMono: "ui-monospace, \"SF Mono\", \"Cascadia Mono\", \"Segoe UI Mono\",\n    \"Roboto Mono\", Menlo, Consolas, monospace",
  success050: "#F0FDF4",
  success200: "#BBF7D0",
  warning050: "#FFFBEB",
  warning200: "#FDE68A",
  info050: "#EFF6FF",
  dangerStandard: "#B91C1C",
  dangerSubtleBg: "#FEF2F2",
  riskStrong: "#B91C1C",
  riskBorder: "#FECACA",
  riskSurface: "#FEF2F2",
  warning500: "#EA580C",
  warningStandard: "#C2410C",
  warningStrong: "#C2410C",
  warningBorder: "#FED7AA",
  warningSurface: "#FFF7ED",
  warningSubtleBg: "#FFF7ED",
  successBorder: "#BBF7D0",
  successSubtleBg: "#F0FDF4",
  successStrong: "#15803D",
  infoSubtleBg: "#EFF6FF",
  adminGround: "#F7F8FC",
  rule: "rgba(15, 23, 42, 0.09)",
  sectionGap: "28px",
  sidebarCollapsed: "68px",
  sidebarExpanded: "240px",
  sidebarTransition: "220ms cubic-bezier(0.16, 1, 0.3, 1)",
  fontCardTitle: "600 14px/1.4 -apple-system, \"Segoe UI\", system-ui",
  fontMeta: "500 12.5px/1.4 -apple-system, \"Segoe UI\", system-ui",
  fontLabel: "700 10.5px/1 -apple-system, \"Segoe UI\", system-ui",
  rowH: "52px",
  rowHCompact: "44px",
  rowPadX: "14px",
} as const;

/** Everything above, as one bundle. */
export const proovraGenerated = {
  surface: proovraSurface,
  border: proovraBorder,
  ink: proovraInk,
  accent: proovraAccent,
  semantic: proovraSemantic,
  status: proovraStatus,
  statusText: proovraStatusText,
  radius: proovraRadius,
  space: proovraSpace,
  nav: proovraNav,
  layout: proovraLayout,
  raw: proovraRaw,
} as const;

export type ProovraStatusTone = keyof typeof proovraStatus;
