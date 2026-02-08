export const baseColors = {
  navy: "#0B1F53",
  ink: "#111527",
  ink2: "#1F1827",
  sky: "#2F7DAA",
  bg: "#F8FAFC",
  white: "#FFFFFF",
  border: "rgba(17, 21, 39, 0.10)",
  muted: "rgba(17, 21, 39, 0.60)",
  green: "#1F9955",
  red: "#C53030",
} as const;

/**
 * Aliases to keep backwards-compatibility with existing app code.
 * (So old keys like colors.primaryNavy keep working.)
 */
export const colors = {
  ...baseColors,

  // legacy / app-friendly names (used in your mobile + web code)
  primaryNavy: baseColors.navy,
  textDark: baseColors.ink,
  lightBg: baseColors.bg,

  // status / semantic
  greenValid: baseColors.green,
  blueInfo: baseColors.sky,

  // keep common names (some code uses white/border already)
  // already included via baseColors
} as const;

export type AppColorKey = keyof typeof colors;
