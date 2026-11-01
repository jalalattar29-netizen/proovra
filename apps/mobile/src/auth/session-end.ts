/**
 * WHEN A SESSION HAS ACTUALLY ENDED (MOBILE-008).
 *
 * The server refuses with 401 for more than one reason, and most of them leave the
 * session alive: a step-up challenge, a privileged action that needs a fresher
 * sign-in, a wrong password, a workspace this session may not enter. Treating
 * every 401 as an ended session would sign people out in the middle of a
 * confirmation. So this reads only the codes `requireAuth` itself answers with.
 *
 * Pure: no React, no react-native, no fetch.
 */

/** What `requireAuth` and `authorize` send when the token no longer stands. */
const SESSION_ENDED_CODES: ReadonlySet<string> = new Set(["UNAUTHORIZED", "TOKEN_EXPIRED", "unauthenticated"]);

export type SessionEndReason = "expired" | "ended" | "organization_policy" | "organization_sso";

export function sessionEndReason(input: {
  status: number;
  code: string | undefined;
  details: Record<string, unknown> | undefined;
}): SessionEndReason | null {
  if (input.status !== 401 || !input.code || !SESSION_ENDED_CODES.has(input.code)) return null;
  const reason = input.details?.["reason"];
  if (input.code === "TOKEN_EXPIRED" || reason === "session_expired") return "expired";
  if (reason === "reauthentication_required") {
    return requiresOrganizationSso(input.details?.["policy"]) ? "organization_sso" : "organization_policy";
  }
  return "ended";
}

/** The reasons an organization's login policy refuses a method (enterprise-security-policy.policy.ts). */
export function requiresOrganizationSso(reason: unknown): boolean {
  return (
    reason === "mandatory_sso_required" ||
    reason === "sso_connection_unbound" ||
    reason === "sso_connection_wrong_organization"
  );
}

/**
 * The app has no single sign-on entry (MOBILE-002), so this says so rather than
 * sending the person round a sign-in that will be refused again.
 */
export const ORGANIZATION_SSO_NOTICE =
  "This organization requires its single sign-on, which the PROOVRA app does not offer. Sign in through your organization in a web browser.";

/**
 * A switch refused by the target organization's rules, in words the member can
 * act on. The refusal's own sentence says they are not a member, which is true of
 * nobody who reaches this branch. Null for every other failure.
 */
export function workspaceSwitchRefusal(err: unknown): string | null {
  const e = (err ?? {}) as { code?: unknown; body?: { reason?: unknown } };
  const reason = e.body?.reason;
  if (e.code === "workspace_membership_required" && requiresOrganizationSso(reason)) return ORGANIZATION_SSO_NOTICE;
  if (e.code === "workspace_membership_required" && reason === "auth_method_not_allowed") {
    return "This organization does not accept the way you signed in. Sign in with a method it allows, then switch.";
  }
  if (e.code === "session_policy_reauth_required") {
    return "This organization needs a more recent sign-in. Sign out and sign in again, then switch.";
  }
  return null;
}

export const SESSION_END_NOTICE: Readonly<Record<SessionEndReason, string>> = {
  expired: "Your session expired. Please sign in again.",
  ended: "You were signed out. This session was ended from another device or by your organization.",
  organization_policy: "Your organization's security policy no longer accepts this sign-in. Please sign in again.",
  organization_sso: ORGANIZATION_SSO_NOTICE,
};
