/**
 * THE INLINE TOKENIZER FOR RUNBOOK MARKDOWN.
 *
 * ===========================================================================
 * WHY THIS IS SEPARATE FROM THE RENDERER
 * ===========================================================================
 * A browser found a defect the test suite could not: the search-index runbook
 * says "what is degraded is *finding* them" and the page showed the asterisks,
 * because the renderer knew `**bold**` and not `*italic*`.
 *
 * Writing a test for that meant calling the renderer, and the renderer returns
 * React elements — which the web suite (node:test, source contracts, no DOM
 * and no React runtime) cannot construct. So the part that decides WHAT a span
 * is now lives here as plain data, and `render.tsx` maps tokens to elements.
 *
 * The consequence is that the corpus can be swept for unrendered emphasis
 * without a browser, which is how this class of defect should have been caught
 * the first time.
 */

export type InlineToken =
  | { kind: "text"; value: string }
  | { kind: "bold"; value: string }
  | { kind: "italic"; value: string }
  | { kind: "code"; value: string }
  | { kind: "link"; value: string; href: string };

/**
 * One combined pattern rather than sequential passes, because a sequence would
 * let a link's URL be reinterpreted by a later rule.
 *
 * Order matters within it. `**bold**` is listed before `*italic*` so that at
 * the same start position the two-asterisk form wins; the other way round,
 * every bold span would render as an italic wrapping a stray asterisk.
 */
const INLINE =
  /(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(`[^`]+`)|(\[[^\]]+\]\([^)]+\))/g;

export function tokenizeInline(text: string): InlineToken[] {
  const out: InlineToken[] = [];
  let last = 0;

  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: "text", value: text.slice(last, at) });

    const tok = m[0];
    if (tok.startsWith("**")) {
      out.push({ kind: "bold", value: tok.slice(2, -2) });
    } else if (tok.startsWith("*")) {
      out.push({ kind: "italic", value: tok.slice(1, -1) });
    } else if (tok.startsWith("`")) {
      out.push({ kind: "code", value: tok.slice(1, -1) });
    } else {
      out.push({
        kind: "link",
        value: tok.slice(1, tok.indexOf("]")),
        href: tok.slice(tok.indexOf("](") + 2, -1),
      });
    }
    last = at + tok.length;
  }

  if (last < text.length) out.push({ kind: "text", value: text.slice(last) });
  return out;
}
