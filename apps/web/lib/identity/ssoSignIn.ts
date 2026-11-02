/**
 * Two facts about SSO sign-in the web app has to state correctly.
 *
 * The SAML and OIDC endpoints live on the API host. The web host has no `/v1`
 * routes, so a URL built from the browser origin 404s in the IdP (IDENT-004).
 *
 * A failed sign-in comes back to `/login` with a reason code, sanitised by the
 * API. Nothing read those codes, so every failure looked like nothing happened
 * (IDENT-003).
 */

export function samlSpMetadataUrl(apiBase: string, connectionId: string): string {
  return `${apiBase}/v1/auth/saml/metadata/${encodeURIComponent(connectionId)}`;
}

export function samlAcsUrl(apiBase: string): string {
  return `${apiBase}/v1/auth/saml/acs`;
}

export function samlLoginUrl(apiBase: string, connectionId: string): string {
  return `${apiBase}/v1/auth/saml/${encodeURIComponent(connectionId)}/login`;
}

const SIGN_IN_FAILURES: ReadonlyArray<[RegExp, string]> = [
  [/browser_mismatch/, "This sign-in was started in a different browser. Start it again here."],
  [/(state_expired|_expired$)/, "That sign-in took too long. Start it again."],
  [/(state_replayed|_replayed$)/, "That sign-in link has already been used. Start it again."],
  [/seat_limit_reached/, "Your organization has no seats left. Ask your administrator."],
  [/seat_contention/, "Your organization is busy adding people. Try again in a moment."],
  [/(account_link_denied|managed_identity_conflict)/, "This account cannot be linked to your organization's sign-in. Ask your administrator."],
  [/(email_domain_not_allowed|domain_not_verified)/, "Your organization's sign-in does not accept this email address."],
  [/(jit_disabled|not_provisioned)/, "You have not been added to this organization yet. Ask your administrator."],
  [/(connection_unavailable|connection_inactive|not_configured|connection_revoked)/, "Your organization's sign-in is not available right now. Ask your administrator."],
  [/(concurrent|session_limit)/, "You have reached your organization's limit of active sessions. Sign out elsewhere and try again."],
];

/** Null when the page was not reached from a failed SSO sign-in. */
export function ssoSignInFailureMessage(params: {
  get(name: string): string | null;
}): string | null {
  const code = params.get("sso_error") ?? params.get("saml_error");
  if (!code) return null;
  for (const [pattern, message] of SIGN_IN_FAILURES) {
    if (pattern.test(code)) return message;
  }
  return "Your organization's sign-in could not be completed. Try again, or ask your administrator.";
}
