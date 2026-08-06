/**
 * The DEPLOYED font strategy: the three families, self-hosted by `next/font`.
 *
 * `next/font/google` downloads each family AT BUILD TIME and materialises the
 * faces into the output, so a deployed page serves them from its own origin and
 * makes no third-party request. The network dependency is real but it belongs
 * to the build, not to the running product.
 *
 * That build-time dependency is why this module has a sibling. A hermetic build
 * — an air-gapped release machine, or the Point-7 local matrix — cannot reach
 * `fonts.googleapis.com`, and `next/font` fails the build rather than degrading
 * quietly. `fonts.system.ts` is the deterministic local answer, selected by
 * `FONT_STRATEGY=system` through a resolver alias in `next.config.js`, so the
 * SWAP happens before the loader ever runs.
 *
 * Both modules export the same shape and set the same three CSS variables, so
 * there is exactly one presentation authority: whatever `--font-jakarta`,
 * `--font-header` and `--font-arabic` resolve to.
 */

import { Inter_Tight, Noto_Sans_Arabic, Plus_Jakarta_Sans } from "next/font/google";

export const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-jakarta",
  display: "swap",
});

export const headerFont = Inter_Tight({
  subsets: ["latin"],
  variable: "--font-header",
  display: "swap",
});

export const notoArabic = Noto_Sans_Arabic({
  subsets: ["arabic"],
  variable: "--font-arabic",
  display: "swap",
});

/** Which strategy produced these variables. Rendered as a `data-` attribute. */
export const FONT_STRATEGY = "self-hosted" as const;
