/**
 * The ONE place the application asks for its fonts.
 *
 * Re-exports the deployed strategy. `next.config.js` aliases `./fonts.google`
 * to `./fonts.system` when `FONT_STRATEGY=system`, so this file never changes
 * and no consumer has to know which strategy is in force — they read the same
 * three CSS variables either way.
 */

export { jakarta, headerFont, notoArabic, FONT_STRATEGY } from "./fonts.google";
