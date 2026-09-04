/**
 * CUSTOMER ID — the organization's identifier for its own customer.
 *
 * Supplied when an organization creates an External Intake. PROOVRA does not
 * issue it, does not validate it against anything, and does not verify that it
 * refers to a real person. It is a foreign key into somebody else's system,
 * stored as the opaque string they gave us.
 *
 * WHAT IT IS NOT: a PROOVRA user id, an account id, proof of identity, a
 * submitter id, a recipient id, an evidence id, an intake link id, or a
 * case reference — unless the organization happens to use its customer
 * identifier that way, which is their business and not a claim we make.
 *
 * SHAPE. Real customer identifiers look like `CUST-849271`, `AC/2026/0031`,
 * `4711_A`. So letters, digits, and the separators those conventions actually
 * use are allowed; control characters and whitespace runs are not, because a
 * value that cannot be typed back into a search box is not an identifier
 * anyone can use. Trimmed, and an empty string collapses to null — absence is
 * absence, never "N/A" or "".
 */
export const CUSTOMER_ID_MAX_LENGTH = 120;

/** Letters, digits, and the separators identifier conventions actually use. */
const CUSTOMER_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._\-/:#]{0,118}[\p{L}\p{N}]$|^[\p{L}\p{N}]$/u;

export function isValidCustomerId(value: string): boolean {
  return value.length <= CUSTOMER_ID_MAX_LENGTH && CUSTOMER_ID_PATTERN.test(value);
}

/**
 * Trim, collapse an empty value to null, and reject anything that is not a
 * usable identifier. Returns `undefined` when the input is invalid so the
 * caller can raise its own validation error in its own vocabulary.
 */
export function normalizeCustomerId(
  raw: string | null | undefined,
): string | null | undefined {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  if (trimmed.length === 0) return null;
  return isValidCustomerId(trimmed) ? trimmed : undefined;
}
