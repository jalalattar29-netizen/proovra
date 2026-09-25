/**
 * THIRD-PARTY SIGN-IN BRAND ASSETS — Google's "G" mark and the button colours
 * Google and Apple mandate for their sign-in buttons.
 *
 * These are NOT the PROOVRA palette and must not come from the theme: the
 * providers' brand guidelines fix them exactly, and a theme change must never
 * recolour another company's mark. They live here, beside the kit rather than
 * in it, for the same reason the web keeps the mark as a brand ASSET
 * (apps/web/public/assets/logos/google.svg) instead of in its design tokens —
 * so the kit itself (src/ui/index.tsx) still takes every colour from the theme.
 */
import React from "react";
import Svg, { Path } from "react-native-svg";

/** Google Identity branding: the four-colour "G". */
export function GoogleBrandIcon() {
  return (
    <Svg width={20} height={20} viewBox="0 0 48 48" accessibilityLabel="Google">
      <Path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
      <Path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.27 5.48-4.8 7.18l7.73 6C44.38 38.03 46.98 31.88 46.98 24.55z"/>
      <Path fill="#FBBC05" d="M10.53 28.59A14.4 14.4 0 0 1 9.75 24c0-1.59.27-3.13.76-4.59l-7.98-6.2A23.86 23.86 0 0 0 0 24c0 3.87.93 7.52 2.56 10.78l7.97-6.19z"/>
      <Path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.91-5.8l-7.73-6c-2.14 1.44-4.89 2.3-8.18 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
    </Svg>
  );
}

/** Provider-mandated sign-in button colours (Google light button; Apple black button). */
export const PROVIDER_BUTTON_COLORS = {
  google: { bg: "#FFFFFF", fg: "#1F2937", border: "#D1D5DB" },
  apple: { bg: "#000000", fg: "#FFFFFF", border: "#000000", icon: "#FFFFFF" },
} as const;
