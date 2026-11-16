/**
 * Free audit B5A-F-11 — `POST /v1/evidence/:id/lock` on a record in the Trash
 * (or destroyed) now answers 409 `{ code: "EVIDENCE_NOT_LOCKABLE", message }`.
 *
 * The body is FLAT, so `apiFetch` raises a plain Error carrying `code` and
 * `statusCode` (not an ApiError), and the shared catalog has no entry for the
 * code yet: `toSafeUserError` would answer "Please review your input and try
 * again". This names the actual reason. Read by code only, so both the flat
 * and a future nested shape match.
 */
export const EVIDENCE_NOT_LOCKABLE_COPY =
  "Only a record in your working set can be locked. Restore it from the Trash first, then lock it.";

export function lockRefusalMessage(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && code.toUpperCase() === "EVIDENCE_NOT_LOCKABLE"
    ? EVIDENCE_NOT_LOCKABLE_COPY
    : null;
}
