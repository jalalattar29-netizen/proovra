/**
 * THE PORTAL SESSION, IN MEMORY ONLY.
 *
 * An external reviewer's credential is their portal token and the session id
 * the exchange returns. Neither is persisted:
 *
 *   - the token grants access to somebody else's evidence, and a phone that is
 *     shared, lost or handed over must not carry it past the moment it is
 *     used;
 *   - the reviewer is not a PROOVRA user, so there is no account for this to
 *     belong to and nothing that should survive a relaunch;
 *   - the web client holds its bearer in memory for the same reason.
 *
 * A relaunch therefore re-authenticates from the link, which is the correct
 * behaviour: possession of the link is the credential.
 */

let token: string | null = null;
let sessionId: string | null = null;

export function setPortalToken(next: string | null): void {
  token = next;
}

export function getPortalToken(): string | null {
  return token;
}

export function setPortalSessionId(next: string | null): void {
  sessionId = next;
}

export function getPortalSessionId(): string | null {
  return sessionId;
}

/** Forget everything. Called on logout, on denial, and on leaving the portal. */
export function clearPortalSession(): void {
  token = null;
  sessionId = null;
}
