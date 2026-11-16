/**
 * B4-F-101 (Free-user audit 0ea0, native half) — a stale capture record is
 * RELEASED on the server before it is cleared on the device.
 *
 * Capture judged a persisted record stale by the client's last known expiry
 * and cleared it locally only. The server keeps an ACTIVE session with staged
 * parts until 24 h after it started, and its UNSEALED reserved record counts
 * against the Free allowance (3 records), so the person lost a slot for up to
 * a day while being told the capture "was cleared". The existing release —
 * the session discard (POST /v1/capture/direct-sessions/:id/discard) — now
 * runs first.
 *
 *   - a record that holds only a draft (both ids carry the draft id) has no
 *     direct session to release: cleared as before;
 *   - the discard answered (or refused for good: the session is already gone,
 *     or no account action could release it): cleared;
 *   - the discard could not be answered (no connection, timeout, 5xx) or the
 *     sign-in ended: the record is KEPT, so the next visit to Capture tries
 *     the release again instead of forgetting the reservation.
 */
import { captureHoldReason, classifyCaptureError } from "./capture-retry";
import type { PersistedCaptureSession } from "./capture-session-store";

export type StaleReleaseDeps = {
  discard: (session: { captureSessionId: string; expiresAtUtc: string }) => Promise<unknown>;
  clear: (key: { captureSessionId: string; draftId: string | null | undefined }) => Promise<unknown>;
};

/** PURE — does this persisted record hold a direct-capture session (a reservation) to release? */
export function holdsDirectSession(r: Pick<PersistedCaptureSession, "captureSessionId" | "evidenceId" | "draftId">): boolean {
  if (!r.captureSessionId) return false;
  // A record that never reached finalize holds only a DRAFT: both slots carry its id.
  if (r.captureSessionId === r.evidenceId) return false;
  if (r.draftId && r.captureSessionId === r.draftId) return false;
  return true;
}

/** PURE — after a failed discard, may the local record still be dropped? */
export function staleReleaseSettled(err: unknown): boolean {
  if (classifyCaptureError(err) === "RETRYABLE") return false;
  if (captureHoldReason(err) === "SIGNED_OUT") return false;
  return true;
}

/**
 * Release (then clear) one stale record. Returns "released" when the server
 * session was discarded, "cleared" when there was nothing to release or the
 * refusal was final, and "kept" when the release must be tried again later.
 */
export async function releaseStaleCaptureRecord(
  r: PersistedCaptureSession,
  deps: StaleReleaseDeps,
): Promise<"released" | "cleared" | "kept"> {
  let outcome: "released" | "cleared" = "cleared";
  if (holdsDirectSession(r)) {
    try {
      await deps.discard({ captureSessionId: r.captureSessionId, expiresAtUtc: r.expiresAtUtc });
      outcome = "released";
    } catch (err) {
      if (!staleReleaseSettled(err)) return "kept";
    }
  }
  await deps.clear({ captureSessionId: r.captureSessionId, draftId: r.draftId });
  return outcome;
}
