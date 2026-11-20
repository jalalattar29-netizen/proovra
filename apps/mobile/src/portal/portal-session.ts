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

/**
 * NEW-RG-25-5 — the bearer is not navigation state (which reaches logs and
 * crash breadcrumbs), as M350 keeps verify/reset tokens out of it and the web
 * portal holds its bearer in memory (M348). The portal screen stays at
 * `/portal/[token]` (an invitation link still opens it), but once the bearer is
 * captured the segment names only this placeholder, and in-app callers hold the
 * bearer here and navigate to PORTAL_HELD_ROUTE. It is shorter than the 8-char
 * minimum PortalAuthBody accepts, so it can never be a real token.
 */
export const PORTAL_HELD_TOKEN_SEGMENT = "held";
export const PORTAL_HELD_ROUTE = `/portal/${PORTAL_HELD_TOKEN_SEGMENT}`;

/** Hold the bearer in memory and answer the route that opens the portal with it. */
export function holdPortalTokenForRoute(next: string): string {
  token = next;
  return PORTAL_HELD_ROUTE;
}

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
