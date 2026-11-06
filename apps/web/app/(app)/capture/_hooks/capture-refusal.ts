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
