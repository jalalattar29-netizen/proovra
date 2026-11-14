import { normalizeClientMimeType } from "../_lib/file-utils";
import type { SessionItem } from "../_lib/types";

/**
 * PRO-078 — POST /v1/evidence/:id/parts answered 415 FILE_VALIDATION_BLOCKED
 * and released the record's empty reservation (`reservationReleased: true`),
 * so no record slot is held. The capture hook then forgets the reservation:
 * resuming into it would address a record that no longer exists, and the next
 * Finish starts a new one. apiFetch keeps a flat body's fields under
 * `body.error`.
 */
export function refusedUploadReleasedReservation(err: unknown): boolean {
  const e = err as { code?: unknown; body?: { error?: { reservationReleased?: unknown } } } | null;
  return e?.code === "FILE_VALIDATION_BLOCKED" && e.body?.error?.reservationReleased === true;
}

/** The person is told no record slot was used. */
export function withReleasedNote(message: string, released: boolean): string {
  return released ? `${message} No record slot was used.` : message;
}

/**
 * F-03 (Free-user audit 2026-11-13) — the declared file manifest POST
 * /v1/evidence compares with the parts a draft's reserved record already holds
 * (the same name, type and staged digest the part presign sends per index).
 * The server resumes that record only while every part it holds is still the
 * file declared at its index; otherwise it releases the stale reservation and
 * reserves a fresh record in the same transaction.
 */
export function buildResumeManifest(
  items: readonly SessionItem[],
): Array<{ originalFileName: string; mimeType: string; sha256Base64?: string }> {
  return items.map((item) => ({
    originalFileName: item.relativePath || item.file.name,
    mimeType: normalizeClientMimeType(item.mimeType),
    ...(item.clientSignals?.clientHintSha256Base64
      ? { sha256Base64: item.clientSignals.clientHintSha256Base64 }
      : {}),
  }));
}

const RESERVATION_UNUSABLE_CODES = new Set([
  "EVIDENCE_RESERVATION_EXPIRED",
  "PART_INDEX_TAKEN",
  "PART_DIGEST_MISMATCH",
]);

/**
 * F-03 / F-09 — a refusal after which the in-memory reservation must not be
 * resumed (expired; an index bound to another file; stored bytes that are not
 * the staged file). The capture hook forgets it, so the next Finish asks the
 * server again with the manifest instead of repeating the same refusal.
 */
export function reservationUnusable(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && RESERVATION_UNUSABLE_CODES.has(code);
}
