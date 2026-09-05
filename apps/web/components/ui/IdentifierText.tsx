"use client";

/**
 * AN IDENTIFIER THAT BREAKS WHERE IT MEANS SOMETHING.
 *
 * ===========================================================================
 * WHAT THIS FIXES
 * ===========================================================================
 * The console prints machine identifiers — Prisma model names, metric keys,
 * queue names — beside the numbers they explain, on purpose: a surface whose
 * claim is "every value traces to a table" is only as good as the reader's
 * ability to check it, and the next thing an operator does with one of these
 * is grep for it.
 *
 * A browser has no break opportunity inside `AutomationWebhookDestination` or
 * `media_intelligence_processor_started_total`, and these sit in tiles about a
 * hundred and twenty pixels wide. So they rendered like this:
 *
 *     source: AutomationWebhookDestinati        media_intelligence_processo
 *     on                                        r_started_total
 *
 * A name split mid-syllable is not a name. Eleven of them were on
 * `/admin/platform/media-graph` alone.
 *
 * ===========================================================================
 * WHY <wbr> AND NOT A WRAP RULE
 * ===========================================================================
 * `overflow-wrap: anywhere` is what PRODUCED the mid-word break — it breaks at
 * whatever character reaches the edge. `word-break: keep-all` would push the
 * name out of its tile instead. `hyphens: auto` does not apply: these are not
 * words in any language, and a rendered hyphen would corrupt a value someone
 * is about to copy.
 *
 * `<wbr>` is a break OPPORTUNITY and contributes no character. So the text
 * still copies exactly, still matches the identifier byte for byte, and breaks
 * only at boundaries a reader recognises:
 *
 *     source: AutomationWebhook                 media_intelligence_
 *     Destination                               processor_started_total
 *
 * ===========================================================================
 * WHERE THE BOUNDARIES ARE
 * ===========================================================================
 *   • before an interior capital     AutomationWebhook|Destination
 *   • after _ . / : -                media_|intelligence_|processor_|…
 *
 * A run of capitals is left alone: `TSA` and `DLQ` are one token each, and
 * offering a break inside an acronym is the defect this exists to remove.
 */

import type { ReactNode } from "react";

/**
 * Split into the pieces a break may fall between.
 *
 * Lookahead/lookbehind only, so nothing is consumed and joining the pieces
 * reproduces the input exactly — asserted by the tests, because a formatter
 * that silently drops a character from an identifier is worse than one that
 * wraps badly.
 */
export function identifierParts(value: string): string[] {
  return value
    .split(/(?<=[_./:-])|(?=[A-Z][a-z])/g)
    .filter((part) => part.length > 0);
}

export function IdentifierText({
  value,
  className,
}: {
  value: string;
  className?: string;
}): ReactNode {
  const parts = identifierParts(value);
  if (parts.length < 2) {
    return className ? <span className={className}>{value}</span> : value;
  }
  const body = parts.map((part, i) => (
    // The index IS the identity: these are positions in one string, not
    // records, and the string is re-split on every render.
    <span key={`${i}-${part}`}>
      {i > 0 ? <wbr /> : null}
      {part}
    </span>
  ));
  return className ? <span className={className}>{body}</span> : <>{body}</>;
}

export default IdentifierText;
