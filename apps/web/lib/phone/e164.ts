/**
 * Phase IA-intake-completion — E.164 phone number helpers.
 *
 * E.164 is the international standard for telephone numbers:
 *   + then country code then subscriber number, 8–15 digits total,
 *   no spaces, no separators, no leading zeros after the country code.
 *
 * These helpers are intentionally permissive on input (operators paste
 * formatted numbers from contacts) but strict on output (Twilio expects
 * canonical E.164). We surface a single boolean predicate + one
 * canonicalizer so the create-link form can normalize before sending.
 */

const E164_RE = /^\+[1-9]\d{7,14}$/;

/** True when `value` already matches the canonical E.164 grammar. */
export function isCanonicalE164(value: string): boolean {
  return E164_RE.test(value);
}

/**
 * Strip every character that isn't a digit or leading `+`, then validate.
 * Returns null when the cleaned value isn't a valid E.164 number.
 *
 * Examples:
 *   "+1 (415) 555-0123"   → "+14155550123"
 *   "+44 20 7946 0958"    → "+442079460958"
 *   "415-555-0123"        → null   (no country code)
 *   "00 44 20 7946 0958"  → null   (00-prefix not supported; ask for `+`)
 */
export function canonicalizeE164(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  // Allow exactly one leading `+`. We strip any other character that
  // isn't a digit so "(415) 555-0123" formatting is forgiving — but
  // we don't try to GUESS the country code, the user must include `+CC`.
  if (!trimmed.startsWith("+")) return null;
  const digitsOnly = trimmed.slice(1).replace(/\D+/g, "");
  if (digitsOnly.length === 0) return null;
  const canonical = `+${digitsOnly}`;
  return isCanonicalE164(canonical) ? canonical : null;
}

/**
 * UI-friendly validator: returns a structured outcome the form can use
 * directly without re-parsing.
 */
export type E164Validation =
  | { ok: true; canonical: string }
  | { ok: false; reason: "empty" | "missing_plus" | "invalid_length" };

export function validateE164(input: string): E164Validation {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  if (!trimmed.startsWith("+"))
    return { ok: false, reason: "missing_plus" };
  const canonical = canonicalizeE164(trimmed);
  if (!canonical) return { ok: false, reason: "invalid_length" };
  return { ok: true, canonical };
}
