/**
 * NATIVE THEME ADAPTER — the ONE bridge from the canonical cross-platform
 * tokens (`@proovra/ui` → proovraTokens, mirrored from the web design authority)
 * to React-Native StyleSheet values.
 *
 * Web consumes the tokens as CSS variables; native cannot (no var() cascade,
 * no CSS box-shadow), so this adapter is where the platform translation lives:
 *  - colors pass through as strings,
 *  - spacing/radii are already RN numbers,
 *  - elevation semantics become RN shadow objects (iOS) + `elevation` (Android).
 *
 * This is the single native theme source. Screens must consume `theme` here
 * rather than hardcoding hex/rgba or importing the legacy `@proovra/ui` colors
 * (that legacy path is what produced the dark-glass/light-slate palette drift).
 * The design-token parity guard asserts these values match the web authority.
 */
import { proovraTokens } from "@proovra/ui";

type FontWeight = "400" | "500" | "600" | "700";

/** RN shadow shape (iOS shadow* + Android elevation). */
export interface NativeShadow {
  shadowColor: string;
  shadowOffset: { width: number; height: number };
  shadowOpacity: number;
  shadowRadius: number;
  elevation: number;
}

const SHADOW_COLOR = proovraTokens.ink.primary;

/**
 * Elevation, PARSED from the canonical CSS box-shadow strings rather than
 * re-typed. `--shadow-card: 0 1px 2px rgba(15,23,42,0.04)` becomes the RN
 * offset/radius/opacity triple, so changing the shadow in tokens.css changes it
 * on both platforms instead of leaving native on a stale hand-copied value.
 * Android has no equivalent of an offset shadow, so `elevation` is derived from
 * the blur radius — the closest honest mapping the platform offers.
 */
function parseWebShadow(css: string): NativeShadow {
  const m = /(-?\d+)px\s+(-?\d+)px\s+(-?\d+)px[^)]*rgba\([^)]*,\s*([\d.]+)\s*\)/.exec(css);
  if (!m) {
    return { shadowColor: SHADOW_COLOR, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 2, elevation: 1 };
  }
  const [, x, y, blur, alpha] = m;
  return {
    shadowColor: SHADOW_COLOR,
    shadowOffset: { width: Number(x), height: Number(y) },
    shadowOpacity: Number(alpha),
    shadowRadius: Number(blur),
    elevation: Math.max(1, Math.round(Number(blur) / 3)),
  };
}

export const elevation: Record<"card" | "elevated" | "dropdown" | "drawer", NativeShadow> = {
  card: parseWebShadow(proovraTokens.elevationWeb.card),
  elevated: parseWebShadow(proovraTokens.elevationWeb.elevated),
  dropdown: parseWebShadow(proovraTokens.elevationWeb.dropdown),
  drawer: parseWebShadow(proovraTokens.elevationWeb.drawer),
};

/** Canonical native theme. */
export const theme = {
  color: {
    surface: proovraTokens.surface,
    border: proovraTokens.border,
    ink: proovraTokens.ink,
    accent: proovraTokens.accent,
    semantic: proovraTokens.semantic,
    status: proovraTokens.status,
    /** Text-only status tones (tokens.css declares these without a surface). */
    statusText: proovraTokens.statusText,
    /** Navigation shell tones — the web sidebar/rail palette. */
    nav: proovraTokens.nav,
    /**
     * Every other web token, verbatim. Before the tokens were derived, ~95 of
     * the CSS file's custom properties had NO native counterpart, so a screen
     * reaching for the web's tone ramp, row heights or section gaps had to
     * invent a value. They are all reachable here.
     */
    raw: proovraTokens.raw,
  },
  /** Layout measures the web shell clamps to (page width, gutters, row heights). */
  layout: proovraTokens.layout,
  space: proovraTokens.space,
  radius: proovraTokens.radius,
  type: {
    family: proovraTokens.type.family,
    size: proovraTokens.type.size,
    weight: proovraTokens.type.weight as Record<keyof typeof proovraTokens.type.weight, FontWeight>,
    lineHeight: proovraTokens.type.lineHeight,
  },
  elevation,
} as const;

export type NativeTheme = typeof theme;

/** Resolve an AppStatusBadge tone to its {bg,fg,border,solid} tokens. */
export function statusTone(tone: keyof typeof proovraTokens.status) {
  return proovraTokens.status[tone];
}
