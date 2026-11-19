/**
 * ENDING THE SESSION ON THIS DEVICE — the one sequence sign-out and an account
 * switch share (PRO-113 / MOBILE-01, PRO-116 / MOBILE-04).
 *
 * Sign-out already did this in two places by hand (Settings, the workspace
 * invitation's "switch account"); a sign-in that REPLACED a live session did
 * none of it, so the old session stayed valid on the server, the recorders kept
 * running and the old account's staged records and residue stayed for the new
 * one. Every path that ends a session now comes here:
 *
 *   1. native capture is stopped (capture-teardown.ts). PRO-NBC-03 / DEC-24:
 *      the account's staged captures, their files and server sessions are
 *      PRESERVED — keyed by their owner, unreadable by another account — so an
 *      unproven "same account" verdict or a failed logout can never destroy
 *      unsealed evidence;
 *   2. the old session is revoked on the server (`POST /v1/auth/logout`);
 *   3. what the person left on the device goes (account-residue.ts).
 *
 * Each step is best effort: ending a session must never fail on a cleanup.
 */
import { getAuthToken, setAuthToken } from "../api";
import { teardownCaptureOnSignOut } from "../capture/capture-teardown";
import { clearAccountResidue } from "./account-residue";
import { logout, type ServerSignOutResult } from "./auth-api";

/**
 * A NEW SIGN-IN replaces the session: the old account ends on this device
 * whatever the server answers, so capture is stopped (preserving what was
 * captured, and claiming it for the old account) after the revoke was tried.
 * The caller clears the token.
 */
export async function endDeviceSession(): Promise<void> {
  await logout();
  await teardownCaptureOnSignOut().catch(() => undefined);
}

/**
 * THE SIGN-OUT A PERSON ASKS FOR (Settings, the invitation's "switch account").
 *
 * PRO-NBC-03 (review gap 3) — the recorder used to be stopped BEFORE the
 * server's answer was known, so a sign-out that failed (offline, busy) left
 * the person signed in with their recording stopped. A recorder cannot be
 * resumed (the OS consent is gone), so it is stopped only once the server has
 * confirmed the sign-out. On a failed sign-out nothing is touched: the person
 * is still signed in and still recording. Stopping needs no token, and the
 * caller clears the token only after this returns ok.
 */
export async function signOutOnDevice(): Promise<ServerSignOutResult> {
  const outcome = await logout();
  if (!outcome.ok) return outcome;
  await teardownCaptureOnSignOut().catch(() => undefined);
  return outcome;
}


/**
 * A new sign-in is about to replace `previousToken` on this device.
 *
 * `sameAccount` is true only when the new session is PROVEN to belong to the
 * account already signed in (same user id). Then nothing of the account's is
 * torn down — only the superseded session is revoked, so no second live
 * session is left behind. Otherwise the old account ends here exactly as a
 * sign-out would end it, before the new token is stored.
 *
 * Leaves the API client on `previousToken`'s successor: the caller sets the new
 * token next.
 */
export async function endSessionReplacedBy(previousToken: string, sameAccount: boolean): Promise<void> {
  const current = getAuthToken();
  setAuthToken(previousToken);
  try {
    if (sameAccount) {
      await logout();
    } else {
      await endDeviceSession();
      clearAccountResidue();
    }
  } finally {
    // Never leave the client on the revoked token.
    if (getAuthToken() === previousToken) setAuthToken(current === previousToken ? null : current);
  }
}
