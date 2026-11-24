/**
 * Stage D (T-084) — THE Review string-scan contract: no user-visible raw enum,
 * code, engine wording or id fragment in a Review area.
 *
 *   - no UPPER_SNAKE token (IN_REVIEW, REVIEW_OVERDUE, …);
 *   - none of the bare state enums the audit found on screen (ESCALATED, OPEN,
 *     ATTENTION, STANDARD, BREACHED, OVERDUE, PENDING, WARNING);
 *   - no engine wording ("reconcile");
 *   - no lowercase hex id fragment ("1a2b3c4d…", a 6+ hex run, a UUID).
 *
 * Acronyms (SLA, AI, PDF) and the product's own "Evidence ref A1B2C3"
 * references (upper-case, from `recordReference`) are allowed.
 */
export const REVIEW_STRING_SCAN: ReadonlyArray<[string, RegExp]> = [
  ["UPPER_SNAKE enum", /\b[A-Z]{2,}(?:_[A-Z0-9]+)+\b/],
  ["bare state enum", /\b(?:ESCALATED|OPEN|ATTENTION|STANDARD|BREACHED|OVERDUE|PENDING|WARNING|ACKNOWLEDGED)\b/],
  ["engine wording", /reconcile/i],
  ["id fragment", /\b[0-9a-f]{6,}…|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/],
];

export function reviewStringScanViolations(text: string): string[] {
  const out: string[] = [];
  for (const [name, re] of REVIEW_STRING_SCAN) {
    const m = re.exec(text);
    if (m) out.push(`${name}: "${m[0]}" in "…${text.slice(Math.max(0, m.index - 40), m.index + 40)}…"`);
  }
  return out;
}
