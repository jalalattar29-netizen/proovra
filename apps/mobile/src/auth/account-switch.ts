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
 *   1. capture is torn down while the old token is still the current one, so
 *      its open server sessions can still be released (capture-teardown.ts);
 *   2. the old session is revoked on the server (`POST /v1/auth/logout`);
 *   3. what the person left on the device goes (account-residue.ts).
 *
 * Each step is best effort: ending a session must never fail on a cleanup.
 */
import { getAuthToken, setAuthToken } from "../api";
import { teardownCaptureOnSignOut } from "../capture/capture-teardown";
import { clearAccountResidue } from "./account-residue";
import { logout } from "./auth-api";

/** Sign-out: tear down capture, then revoke the current session. The caller clears the token. */
export async function endDeviceSession(): Promise<void> {
  await teardownCaptureOnSignOut().catch(() => undefined);
  await logout();
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
