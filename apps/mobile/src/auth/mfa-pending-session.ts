/**
 * PRO-NA-08 — THE MFA CHALLENGE TOKEN, FOR THE LENGTH OF A SIGN-IN.
 *
 * A sign-in that needs a second factor answers with a short-lived pending
 * token. It lived in the /mfa route params — navigation state, which reaches
 * logs and crash breadcrumbs — against the app's own rule for the enrolment
 * token (mfa-enrollment-session.ts). It is held here, in memory only: losing it
 * (a process restart mid-challenge) costs a sign-in, and the screen says so.
 */
let pending: string | null = null;

export function holdMfaPending(token: string): void {
  pending = token;
}

export function currentMfaPending(): string | null {
  return pending;
}

export function endMfaPending(): void {
  pending = null;
}
