/**
 * Members re-audit N-8 — a legacy Collaboration Team row still holding a value
 * outside the vocabulary.
 *
 * The DOM-08 CHECK constraints (`collaboration_team*_vocab`) were added
 * NOT VALID; 20281026001400 normalised every value with a deterministic
 * canonical meaning and validated the clean ones. A row holding a value with
 * no canonical meaning stays as it was until an operator decides, and any
 * later write of that row is refused by PostgreSQL (23514). That is a known
 * data condition, not a crash: callers answer it with a typed 409
 * LEGACY_RECORD_NEEDS_REVIEW, logged for the operator with the constraint,
 * never a 500 and never a Sentry incident.
 *
 * Recognised through the driver adapter's cause (Postgres code 23514 plus the
 * constraint name), so only the vocabulary checks qualify.
 */

/** The violated `collaboration_team*_vocab` constraint, or null. */
export function legacyVocabularyViolation(err: unknown): string | null {
  const cause = (err as { cause?: { originalCode?: unknown; code?: unknown; message?: unknown } } | null)?.cause;
  const pgCode = cause?.originalCode ?? cause?.code;
  if (pgCode !== "23514") return null;
  const text = typeof cause?.message === "string" ? cause.message : "";
  const match = /violates check constraint "(collaboration_team[a-z_]*_vocab)"/.exec(text);
  return match ? match[1]! : null;
}

export const LEGACY_RECORD_NEEDS_REVIEW = {
  code: "LEGACY_RECORD_NEEDS_REVIEW",
  message: "This record holds a value from an earlier version. An administrator needs to review it before it can be changed.",
} as const;
