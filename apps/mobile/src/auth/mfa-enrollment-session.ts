/**
 * THE ENROLMENT TOKEN, FOR THE LENGTH OF A SIGN-IN.
 *
 * A sign-in refused for a missing factor answers with a short-lived token that
 * reaches only the enrolment routes (MOBILE-007). It lives here, in memory, and
 * nowhere else:
 *
 *   - not in SecureStore or AsyncStorage: it is not a session, and a person who
 *     has not finished signing in has nothing that should survive a restart;
 *   - not in route params: those are navigation state, and they reach logs and
 *     crash breadcrumbs.
 *
 * Losing it costs a sign-in, which is the correct price: the screen then says so.
 */
import type { LoginMode } from "./use-auth-flow";

export interface MfaEnrollmentHold {
  token: string;
  mode: LoginMode;
  /** The server's own lifetime; absent means the server decides alone. */
  expiresInSeconds?: number | null;
  /** The consent ticked on the sign-in screen, recorded once a session exists. */
  legalAcceptedSource?: string;
}

interface Held extends MfaEnrollmentHold {
  expiresAtMs: number | null;
}

let held: Held | null = null;

function expiryFrom(seconds: number | null | undefined): number | null {
  return typeof seconds === "number" ? Date.now() + seconds * 1000 : null;
}

export function holdMfaEnrollment(hold: MfaEnrollmentHold): void {
  held = { ...hold, expiresAtMs: expiryFrom(hold.expiresInSeconds) };
}

/** The live token, or null. An expired one is dropped here rather than sent. */
export function currentMfaEnrollment(): MfaEnrollmentHold | null {
  if (held && held.expiresAtMs !== null && Date.now() >= held.expiresAtMs) held = null;
  return held;
}

/** `enroll/verify` answers with a new token proving the factor; only that one can finish. */
export function replaceMfaEnrollmentToken(token: string): void {
  if (held) held = { ...held, token, expiresAtMs: expiryFrom(held.expiresInSeconds) };
}

export function endMfaEnrollment(): void {
  held = null;
}
