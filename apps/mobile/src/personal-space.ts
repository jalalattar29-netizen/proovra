/**
 * PHASE 10 CLOSURE — FIX 3 (2026-07-23) — mobile mirror of the web
 * personal-space gate (apps/web/lib/platform-context/personalSpaceGate.ts).
 *
 * Reads ONLY the server-projected `personalSpaceAllowed` boolean returned
 * by GET /v1/platform/context (the same canonical envelope field web
 * consumes — see services/api/src/services/platform-context/types.ts).
 * This module NEVER re-derives identityMode / ssoRequired / managed-status
 * / any other policy signal — it is a pure projection. The server remains
 * the sole authority: every personal-scope mutation (POST /v1/evidence,
 * /v1/evidence/:id/parts, /v1/evidence/:id/complete) is independently
 * enforced there regardless of what this module decides to render.
 *
 * The citizen-capture mobile app has no workspace switcher and no concept
 * of an "Organization workspace" target — unlike web, there is no
 * alternative context to heal into. When Personal Space is disallowed the
 * ONLY honest client behavior is to block capture and explain why; NEVER a
 * silent Personal fallback.
 */

export type MobilePlatformContextEnvelope = {
  personalSpaceAllowed?: boolean;
};

/**
 * True iff Personal Space is currently disallowed for this identity.
 * Absent/undefined `personalSpaceAllowed` defaults to allowed (`true`,
 * legacy/STANDARD behavior) — the server only ever sets it to `false`
 * explicitly for a managed identity; never inferred client-side.
 */
export function isPersonalSpaceDisallowed(
  envelope: MobilePlatformContextEnvelope | null | undefined
): boolean {
  return envelope?.personalSpaceAllowed === false;
}

export const PERSONAL_SPACE_UNAVAILABLE_TITLE = "Personal Space unavailable";

export const PERSONAL_SPACE_UNAVAILABLE_MESSAGE =
  "Personal Space is unavailable under managed Organization policy. Your existing evidence is preserved and untouched. Ask your organization administrator to assign you a workspace to continue capturing.";

/**
 * PHASE 10 CLOSURE FIX 3 (2026-07-23) — mobile mirror of the web dirty-work
 * guard (usePersonalSpaceGate). The citizen-capture app has no workspace
 * switcher, so there is no automatic switch to block — but a policy flip to
 * disallowed WHILE a capture session is active must NOT rip the in-progress
 * local draft off the screen. Behavior E: preserve the local draft safely;
 * never a silent fallback.
 *
 *   - loading           → never block (fail open on the initial fetch).
 *   - allowed           → never block.
 *   - hasActiveDraft    → never block: the operator keeps their staged
 *                          items and can finish (the server independently
 *                          rejects a disallowed finalize with a real 403)
 *                          or discard. The draft is preserved, not lost.
 *   - otherwise         → block the FRESH (empty) capture surface with the
 *                          bounded unavailable explanation.
 */
export function shouldBlockMobileCapture(input: {
  loading: boolean;
  allowed: boolean;
  hasActiveDraft: boolean;
}): boolean {
  if (input.loading) return false;
  if (input.allowed) return false;
  if (input.hasActiveDraft) return false;
  return true;
}
