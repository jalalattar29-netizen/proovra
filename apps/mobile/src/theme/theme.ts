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

const SHADOW_COLOR = "#0F172A";

/** Elevation semantics mapped from proovraTokens.elevationWeb to RN. */
export const elevation: Record<"card" | "elevated" | "drawer", NativeShadow> = {
  card: { shadowColor: SHADOW_COLOR, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 2, elevation: 1 },
  elevated: { shadowColor: SHADOW_COLOR, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.08, shadowRadius: 24, elevation: 8 },
  drawer: { shadowColor: SHADOW_COLOR, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.1, shadowRadius: 40, elevation: 16 },
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
  },
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
