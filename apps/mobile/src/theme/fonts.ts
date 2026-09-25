/**
 * CANONICAL NATIVE FONT AUTHORITY (T-04 / RC-04).
 *
 * THE DEFECT THIS CLOSES
 * ----------------------
 * `apps/mobile` registered NO fonts at all: `expo-font` was not a dependency,
 * nothing called `useFonts`/`loadAsync`, and there were zero `.ttf`/`.otf` files
 * in the app. Meanwhile `locale-context.tsx` asked for the family `"Inter"`.
 *
 * React Native resolves an UNREGISTERED `fontFamily` string by silently falling
 * back to the platform face, so every text element on all 64 routes rendered in
 * San Francisco (iOS) / Roboto (Android). Nothing errored and nothing logged —
 * which is why a token comparison could never see it: the typeface is a runtime
 * string, not a token.
 *
 * `"Inter"` was also the wrong target. `apps/web/app/fonts.google.ts` is the
 * canonical reference and loads:
 *   body    Plus Jakarta Sans  400/500/600/700/800   --font-jakarta
 *   heading Inter Tight                              --font-header
 *   arabic  Noto Sans Arabic                         --font-arabic
 *
 * And the token set ALREADY carried the right answer —
 * `theme.type.family.latin === "Plus Jakarta Sans"`,
 * `theme.type.family.arabic === "Noto Sans Arabic"` — it was simply not read.
 * This module is the ONE place that maps those canonical family names onto the
 * concrete per-weight faces React Native can actually use.
 *
 * WHY PER-WEIGHT FAMILIES
 * -----------------------
 * Android does not synthesise weights for a custom family: `fontWeight: "600"`
 * on a single registered face renders at 400. The only portable approach is to
 * register one family per weight and select the family, which is what
 * `familyFor()` does. `fontWeight` is then left unset by callers.
 *
 * HEADINGS: the web's Inter Tight is deliberately NOT ported. Shipping a third
 * family costs ~200 KB per weight for a distinction that does not survive at
 * phone heading sizes (22 px `h1`). Headings use Plus Jakarta Sans at 700/800,
 * which is the same family the web body uses. Recorded as a platform adaptation,
 * not an oversight.
 */
import {
  useFonts,
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
} from "@expo-google-fonts/plus-jakarta-sans";
import {
  NotoSansArabic_400Regular,
  NotoSansArabic_500Medium,
  NotoSansArabic_600SemiBold,
  NotoSansArabic_700Bold,
} from "@expo-google-fonts/noto-sans-arabic";
import Feather from "@expo/vector-icons/Feather";

/** The weights `theme.type.weight` declares, plus the web's 800 for display. */
export type FontWeightToken = "400" | "500" | "600" | "700" | "800";

/**
 * Every face the app registers. The KEY is the family name React Native will
 * resolve; `familyFor()` is the only thing that should construct these strings.
 */
export const APP_FONT_MAP = {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
  NotoSansArabic_400Regular,
  NotoSansArabic_500Medium,
  NotoSansArabic_600SemiBold,
  NotoSansArabic_700Bold,
} as const;

const LATIN: Record<FontWeightToken, string> = {
  "400": "PlusJakartaSans_400Regular",
  "500": "PlusJakartaSans_500Medium",
  "600": "PlusJakartaSans_600SemiBold",
  "700": "PlusJakartaSans_700Bold",
  "800": "PlusJakartaSans_800ExtraBold",
};

/** Noto Sans Arabic ships no 800; display weight falls back to 700. */
const ARABIC: Record<FontWeightToken, string> = {
  "400": "NotoSansArabic_400Regular",
  "500": "NotoSansArabic_500Medium",
  "600": "NotoSansArabic_600SemiBold",
  "700": "NotoSansArabic_700Bold",
  "800": "NotoSansArabic_700Bold",
};

/**
 * The registered family for a weight and script.
 *
 * PURE — no React, no side effects — so the mapping is unit-testable without a
 * device, which is the whole point: the previous defect was invisible precisely
 * because nothing could assert on it.
 */
export function familyFor(weight: FontWeightToken, isRTL: boolean): string {
  return (isRTL ? ARABIC : LATIN)[weight] ?? (isRTL ? ARABIC["400"] : LATIN["400"]);
}

/** The canonical family names the design tokens declare, for cross-checking. */
export const CANONICAL_FAMILY = {
  latin: "Plus Jakarta Sans",
  arabic: "Noto Sans Arabic",
} as const;

/**
 * Load every face. Returns `[loaded, error]`.
 *
 * The caller MUST hold first paint until `loaded` is true, otherwise the first
 * frame renders in the system face and then reflows — the visible "flash of
 * unstyled text" that makes a native app feel unfinished.
 *
 * An `error` is surfaced rather than swallowed. Silently falling back to the
 * system face is exactly the behaviour that hid this defect for the whole life
 * of the app, so a load failure must be visible to the caller.
 */
export function useAppFonts(): [boolean, Error | null] {
  // T-09f — the navigation glyph font joins the same first-paint gate. Left to
  // load lazily, every nav icon renders as an empty box for the first frame
  // and then pops in — the same flash this gate exists to prevent for text.
  const [loaded, error] = useFonts({ ...APP_FONT_MAP, ...Feather.font });
  return [loaded, error ?? null];
}
