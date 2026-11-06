/**
 * PRO-115 / MOBILE-03 — the contributor's own open intake session, per link.
 *
 * The server resumes an intake session only when the reopen presents it back
 * in `x-proovra-intake-session` (UC-WEB-003). Without it every reopen — a
 * remount, a return from the background, a second tap on the link — opened a
 * new session and dropped the identity, consent and files already given.
 *
 * Held in MEMORY, like every other intake and portal credential on this device
 * (src/portal/portal-session.ts): the web keeps it in per-tab sessionStorage,
 * and the device equivalent is the running app. Nothing is written to disk,
 * so nothing of a contributor's visit is left for the phone's owner or the
 * next account.
 *
 * The resumed parts ride along so the capture step shows the files the server
 * already holds and numbers new ones after them.
 */
import type { ResumedIntakePart } from "../product/external-intake";

type Held = { sessionId: string; parts: ResumedIntakePart[] };

const held = new Map<string, Held>();

export function heldIntakeSession(token: string): string | null {
  return held.get(token)?.sessionId ?? null;
}

export function holdIntakeSession(token: string, sessionId: string, parts: ResumedIntakePart[]): void {
  held.set(token, { sessionId, parts });
}

/** The files the server holds for this link's session, as last reported. */
export function heldIntakeParts(token: string, sessionId: string): ResumedIntakePart[] {
  const h = held.get(token);
  return h && h.sessionId === sessionId ? h.parts : [];
}

/** A submitted, expired or refused session is not resumed again. */
export function releaseIntakeSession(token: string): void {
  held.delete(token);
}
