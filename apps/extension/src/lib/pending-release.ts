/**
 * Free audit F-12 — a reservation stranded by a sign-in that ended mid-capture.
 *
 * When the token is refused (401) after the session opened, the record is
 * already reserved and the discard that releases it cannot run: it needs a
 * token. The reservation then held one of the account's slots (3 on Free)
 * until the server's reservation sweep released it, up to 24 hours later.
 *
 * Now the session id is remembered, and the SAME discard the failure path uses
 * (POST /v1/capture/direct-sessions/:id/discard) is sent once the user has
 * signed in again. The discard is idempotent and refuses a sealed session, so
 * sending it is safe whatever happened; a session that belongs to another
 * account is refused and simply forgotten. Only server-issued session ids are
 * stored — no page content, no account data.
 */
import { ApiError } from "./api-client.js";

export const PENDING_RELEASE_KEY = "proovra.capture.unreleased";
/** The server sweep releases a reservation within 24 h; nothing older is kept. */
export const PENDING_RELEASE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const PENDING_RELEASE_MAX_ENTRIES = 20;

export type PendingRelease = { captureSessionId: string; atMs: number };

export type PendingReleaseStore = {
  read(): Promise<PendingRelease[]>;
  write(entries: PendingRelease[]): Promise<void>;
};

function fresh(entries: PendingRelease[], nowMs: number): PendingRelease[] {
  return entries
    .filter(
      (e) =>
        e &&
        typeof e.captureSessionId === "string" &&
        /^[A-Za-z0-9_-]{1,128}$/.test(e.captureSessionId) &&
        typeof e.atMs === "number" &&
        nowMs - e.atMs < PENDING_RELEASE_MAX_AGE_MS,
    )
    .slice(-PENDING_RELEASE_MAX_ENTRIES);
}

/** Remember a session whose reservation could not be released. */
export async function rememberUnreleased(store: PendingReleaseStore, captureSessionId: string, nowMs = Date.now()): Promise<void> {
  const current = fresh(await store.read().catch(() => []), nowMs).filter((e) => e.captureSessionId !== captureSessionId);
  await store.write(fresh([...current, { captureSessionId, atMs: nowMs }], nowMs));
}

/**
 * Send the discard for every remembered session with a working token. An entry
 * is forgotten on any definite answer (released, already terminal, sealed, not
 * this account's) and kept when there was no answer or the token was refused
 * again. Returns how many were settled.
 */
export async function releasePending(
  store: PendingReleaseStore,
  token: string,
  discard: (token: string, captureSessionId: string) => Promise<unknown>,
  nowMs = Date.now(),
): Promise<number> {
  const entries = fresh(await store.read().catch(() => []), nowMs);
  if (entries.length === 0) {
    await store.write([]).catch(() => undefined);
    return 0;
  }
  const keep: PendingRelease[] = [];
  let settled = 0;
  for (const e of entries) {
    try {
      await discard(token, e.captureSessionId);
      settled += 1;
    } catch (err) {
      const definite = err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 429 && err.denial !== "SESSION_BUSY";
      if (definite) settled += 1;
      else keep.push(e);
    }
  }
  await store.write(keep).catch(() => undefined);
  return settled;
}
