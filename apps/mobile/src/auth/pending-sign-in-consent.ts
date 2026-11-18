/**
 * PRO-NA-05 — THE CONSENT TICKED ON THIS DEVICE, CARRIED TO THE SESSION.
 *
 * The register and sign-in screens collect the Terms / Privacy / Cookies
 * consent as a checkbox; it is recorded (`legalAcceptedSource`) once a session
 * exists. Two paths reach the session on another screen and used to drop it:
 *
 *   - a sign-in that needs its second factor (`/mfa` completes it);
 *   - an email registration, completed by the verification link
 *     (`/verify-email` completes it).
 *
 * The consent is held here, in memory only, bound to what it was ticked for
 * (the pending second-factor token, or the registered address). It is never a
 * credential, never persisted and never in route params; losing it (an app
 * restart) only means the acceptance screen asks again, which is honest.
 */

type Held =
  | { kind: "mfa"; pendingToken: string; source: string }
  | { kind: "register"; email: string; source: string; atMs: number };

let held: Held | null = null;

const REGISTER_TTL_MS = 24 * 60 * 60 * 1000;

/** A sign-in with a ticked consent is continuing at the second-factor screen. */
export function holdConsentForMfa(pendingToken: string, source: string | undefined): void {
  held = source && pendingToken ? { kind: "mfa", pendingToken, source } : null;
}

/** The consent ticked for THIS pending second-factor sign-in, once. */
export function takeConsentForMfa(pendingToken: string): string | undefined {
  if (held?.kind === "mfa" && held.pendingToken === pendingToken) {
    const { source } = held;
    held = null;
    return source;
  }
  return undefined;
}

/** An email registration made on this device with the box ticked. */
export function holdConsentForRegistration(email: string): void {
  const e = email.trim().toLowerCase();
  held = e ? { kind: "register", email: e, source: "register", atMs: Date.now() } : null;
}

/** The registration consent for the account the verification link signed in, once. */
export function takeConsentForRegistration(email: string | null | undefined): string | undefined {
  if (
    held?.kind === "register" &&
    email &&
    held.email === email.trim().toLowerCase() &&
    Date.now() - held.atMs <= REGISTER_TTL_MS
  ) {
    held = null;
    return "register";
  }
  return undefined;
}
