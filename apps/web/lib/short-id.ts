/**
 * THE ONE SHORTENER FOR AN IDENTIFIER RENDERED IN A CELL.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS
 * ===========================================================================
 * Three copies of this function existed — `evidence/lib/evidence-library-
 * formatters.ts`, `evidence/[id]/_tabs/_lib.tsx` and `admin/identity/_sections/
 * identity-admin-shared.ts` — across fourteen consumers, and they did not
 * agree: two truncated 8-head/6-tail at a 14-character threshold and returned
 * "Not available" for a missing value, the third truncated 6/6 at 12 and threw
 * on null. So the same UUID rendered differently depending on which page you
 * were looking at, and the same missing value rendered as a crash on one page
 * and as a sentence on another.
 *
 * ===========================================================================
 * WHY HEAD AND TAIL, NOT A PREFIX
 * ===========================================================================
 * A truncation that truncates away the distinguishing part is worse than no
 * truncation at all: the column looks like data and carries none, and an
 * operator picking a row to act on cannot tell which one they are acting on.
 *
 * A UUID's entropy is at its END and this platform allocates them
 * sequentially, so a head-only shortener collapses a whole column. On
 * `/admin/identity/runtime` all twenty-five session rows rendered the
 * identical string `0adf0000-000…`, and on `/admin/operations` five conditions
 * read "Trusted timestamping failed · EVIDENCE_INTEGRITY · seen 10x · last 1m
 * ago" against the same workspace, and the records they covered were
 * `…0000c1`, `…0000c2`,
 * `…0000c3`, `…0000c8` and `…0000c9`. A head-only shortener would have shown
 * `0adf0000…` five times and been no better than the blank it replaced.
 *
 * The head keeps the value recognisable as this platform's id shape; the tail
 * is what differs. Short values are returned whole rather than padded with an
 * ellipsis that hides nothing.
 */

/** How long a value has to be before shortening it removes more than it adds. */
const THRESHOLD = 14;
const HEAD = 8;
const TAIL = 6;

export function shortId(value: string | null | undefined): string {
  const text = (value ?? "").trim();
  if (!text) return "Not available";
  if (text.length <= THRESHOLD) return text;
  return `${text.slice(0, HEAD)}…${text.slice(-TAIL)}`;
}
