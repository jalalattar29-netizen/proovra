/**
 * The HERMETIC font strategy: the design's own fallback stack, no network.
 *
 * Selected by `FONT_STRATEGY=system`, which `next.config.js` turns into a
 * resolver alias so this module replaces `fonts.google.ts` in the build graph
 * entirely — the `next/font/google` loader is never reached, so no request is
 * made, attempted, or blocked.
 *
 * It is NOT a downgrade invented for tests. The stack below is the one
 * `globals.css` already declares after `--font-jakarta`, so a page rendered
 * this way falls back to exactly what a user on a slow connection or with the
 * webfont blocked already sees. Choosing it deliberately is the difference
 * between a deterministic local render and an accidental one.
 *
 * Same export shape and the same three CSS variables as `fonts.google.ts`.
 * There is one presentation authority either way: what `--font-jakarta`,
 * `--font-header` and `--font-arabic` resolve to.
 *
 * The class name is defined once, in `globals.css`.
 */

type FontBinding = { variable: string; className: string };

const HERMETIC_CLASS = "font-strategy-system";

export const jakarta: FontBinding = {
  variable: HERMETIC_CLASS,
  className: HERMETIC_CLASS,
};

export const headerFont: FontBinding = {
  variable: HERMETIC_CLASS,
  className: HERMETIC_CLASS,
};

export const notoArabic: FontBinding = {
  variable: HERMETIC_CLASS,
  className: HERMETIC_CLASS,
};

/** Which strategy produced these variables. Rendered as a `data-` attribute. */
export const FONT_STRATEGY = "system" as const;
