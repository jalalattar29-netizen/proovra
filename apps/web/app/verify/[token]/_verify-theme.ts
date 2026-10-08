// The Public Verify page's colour and type tokens, shared by the page and its
// extracted panels (VerifyMatrixPanels). Moved verbatim from page.tsx.

export const VERIFY_BRAND = {
  ink: "#071A3A",
  accent: "#071A3A",
  accent2: "#12315A",
  muted: "rgba(7, 26, 58, 0.68)",
  subtle: "rgba(7, 26, 58, 0.72)",
  line: "rgba(7, 26, 58, 0.18)",
  softLine: "rgba(7, 26, 58, 0.12)",
  glass: "rgba(255, 255, 255, 0.58)",
  glassStrong: "rgba(255, 255, 255, 0.74)",
  silver: "#eef1ef",
  bronze: "rgba(96, 66, 24, 0.95)",
  bronzeSoft: "rgba(96, 66, 24, 0.10)",
  success: "#21755d",
  successSoft: "rgba(33, 117, 93, 0.12)",
  warning: "#8a6a2f",
  warningSoft: "rgba(138, 106, 47, 0.13)",
  danger: "#b54738",
  dangerSoft: "rgba(181, 71, 56, 0.12)",
};

export const VERIFY_FONT =
  `Inter, "Helvetica Neue", Arial, Helvetica, sans-serif`;

export const VERIFY_TYPO = {
  page: {
    fontFamily: VERIFY_FONT,
    letterSpacing: "-0.003em",
    WebkitFontSmoothing: "antialiased" as const,
    MozOsxFontSmoothing: "grayscale" as const,
  },
  kicker: {
    fontSize: 10.5,
    fontWeight: 750,
    letterSpacing: "0.085em",
    textTransform: "uppercase" as const,
    color: VERIFY_BRAND.subtle,
  },
  h1: {
    fontSize: "clamp(2rem, 3vw, 2.85rem)",
    lineHeight: 1.06,
    fontWeight: 800,
    letterSpacing: "-0.04em",
    color: VERIFY_BRAND.ink,
  },
  h2: {
    fontSize: "clamp(1.35rem, 1.9vw, 1.85rem)",
    lineHeight: 1.14,
    fontWeight: 800,
    letterSpacing: "-0.026em",
    color: VERIFY_BRAND.ink,
  },
  h3: {
    fontSize: 17,
    lineHeight: 1.25,
    fontWeight: 800,
    letterSpacing: "-0.014em",
    color: VERIFY_BRAND.ink,
  },
body: {
  fontSize: 14,
  lineHeight: 1.7,
  fontWeight: 430,
      color: VERIFY_BRAND.muted,
  },
small: {
  fontSize: 12,
  lineHeight: 1.6,
  fontWeight: 500,
      color: VERIFY_BRAND.muted,
  },
value: {
  fontSize: 14,
  lineHeight: 1.45,
  fontWeight: 650,
      color: VERIFY_BRAND.ink,
  },
  hash: {
    fontFamily: VERIFY_FONT,
    fontSize: 11,
    lineHeight: 1.45,
    fontWeight: 550,
    letterSpacing: "-0.006em",
    color: VERIFY_BRAND.ink,
    wordBreak: "break-all" as const,
    overflowWrap: "anywhere" as const,
    whiteSpace: "normal" as const,
  },
};
