/**
 * A1-06 — THE REVIEWED CLASSIFICATION OF WRITE ROUTES AGAINST THE TERMS GATE.
 *
 * `legal-acceptance-gate.ts` refuses every session-authenticated write with the
 * shared 428 `LEGAL_REACCEPT_REQUIRED` until the current terms are accepted.
 * This file is the ONLY place a write may be let through without them, and it
 * also records the write routes that never reach the gate because no signed-in
 * person is behind them. `test/legal-acceptance-gate.integration.test.ts`
 * enumerates the live route table and fails when a write route is neither
 * refused for a stale user nor classified here, or is classified here and
 * refused anyway.
 *
 * Patterns are matched against `METHOD /route/pattern` with every path
 * parameter written `:p` (`/v1/evidence/:id` and `/v1/evidence/:evidenceId`
 * are one route to this table). The `/v1/workspaces` alias is rewritten to
 * `/v1/teams` before routing, so it is covered by the `/v1/teams` rows.
 *
 * WHY EACH CATEGORY IS OPEN (product decision A1-06):
 *   CONSENT       recording the acceptance (or cookie choice) itself; gating it
 *                 would make the prompt unanswerable.
 *   SESSION       finishing sign-in, choosing the workspace a session acts in,
 *                 and the step-up/MFA ceremony other preserved flows need.
 *   ACCOUNT       the person's own account, credentials, recovery and privacy
 *                 settings ("essential recovery and account/privacy paths").
 *   PRIVACY       account / workspace closure and data export, and their cancel
 *                 ("deletion/export ... accessible through their existing flows").
 *   CANCELLATION  ending something already bought or started: subscription and
 *                 add-on cancel, an abandoned checkout or payment, a discarded
 *                 capture draft or upload, deleting a record through its
 *                 existing retention-governed flow. Adds nothing.
 *   IN_FLIGHT     completing or re-reading a checkout the person started while
 *                 their terms were current (the start is gated): the provider
 *                 already holds their approval, and the return must not strand
 *                 a payment. Webhooks settle independently of this.
 *   REVOCATION    withdrawing a share, link, grant, invitation, key, device,
 *                 session or membership. Only ever reduces access; creates nothing.
 *   BACKGROUND    automatic, non-substantive writes a client sends without a
 *                 person acting (presence, read markers, telemetry, link
 *                 resolution). Gating them would re-open the prompt on a timer.
 *   RETIRED       answers 410/404 to everyone; there is nothing to protect.
 *
 * ACTOR MODEL (documented decision):
 *   - Extension token (`scope: capture.direct`): a delegated token OF THE
 *     PERSON, through `requireAuth`, so the person's own acceptance is required
 *     (as capture-trust already required). Revoking it is REVOCATION.
 *   - Support context: the support actor writes as themselves, so THEIR
 *     acceptance is required; leaving / revoking the context is REVOCATION.
 *   - API keys (`/v1/integrations/api/*`): a key acts in its creator's name
 *     and ends with their authority: removal and suspension revoke it (A2-10),
 *     and a demotion that takes the key permission away revokes it at the role
 *     change or at its next use (B3A-F-002); expiry of the creator's access
 *     window does not (A2-26). The creator's TERMS acceptance is required when
 *     the key is MINTED or rotated (session writes, gated); each machine call
 *     is not re-checked against the creator's terms, or a terms update would
 *     silently break every integration. Classified NON_SESSION (API_KEY).
 *   - Anonymous intake contributors and external portal reviewers hold a link
 *     or portal token, not a PROOVRA account: there is no user whose terms
 *     could be owed. The link/grant was created by a gated session write.
 *   - SCIM, cron/internal secrets, provider webhooks and public Verify are
 *     machine or public routes: no session, no person, not gated.
 */

export type LegalExemptionCategory =
  | "CONSENT"
  | "SESSION"
  | "ACCOUNT"
  | "PRIVACY"
  | "CANCELLATION"
  | "IN_FLIGHT"
  | "REVOCATION"
  | "BACKGROUND"
  | "RETIRED";

export type NonSessionCategory =
  | "CREDENTIAL_CEREMONY"
  | "PROVIDER_CALLBACK"
  | "MACHINE"
  | "PUBLIC_ANONYMOUS"
  | "ANONYMOUS_INTAKE"
  | "EXTERNAL_PORTAL"
  | "API_KEY"
  | "SCIM";

export type LegalExemption = { category: LegalExemptionCategory };

const P = ":p";

/** Writes a signed-in person may make without the current terms. */
export const SESSION_WRITE_EXEMPTIONS: Readonly<Record<LegalExemptionCategory, readonly string[]>> = {
  CONSENT: ["POST /v1/users/legal-acceptance", "POST /v1/users/cookie-consent"],
  SESSION: [
    "POST /v1/auth/mfa/enrollment/complete",
    "POST /v1/platform/context/switch-workspace",
    "POST /v1/identity-security/step-up/start",
    "POST /v1/identity-security/step-up/check",
    "POST /v1/identity/mfa/challenge/verify",
  ],
  ACCOUNT: [
    "PATCH /v1/users/me",
    "POST /v1/users/me/password/change",
    "POST /v1/identity/password",
    "POST /v1/identity-security/password",
    "POST /v1/identity/mfa/enroll/start",
    "POST /v1/identity/mfa/enroll/verify",
    `DELETE /v1/identity/mfa/factors/${P}`,
    "POST /v1/identity/mfa/recovery-codes/regenerate",
    // B1-F-014 (free-audit 0ea0): FILING a recovery request is the essential
    // path its cancel and resend already were — a person locked out of their
    // second factor must not first be asked to accept new terms (A1-06).
    "POST /v1/identity/mfa-admin/recovery-requests",
    `POST /v1/identity/mfa/recovery-requests/${P}/cancel`,
    `POST /v1/identity/mfa/recovery-requests/${P}/resend-email`,
    "POST /v1/identity-security/passkeys/registration/options",
    "POST /v1/identity-security/passkeys/registration/verify",
    `DELETE /v1/identity-security/passkeys/${P}`,
    "POST /v1/identity-security/contact-factors/enroll/start",
    "POST /v1/identity-security/contact-factors/enroll/verify",
    "POST /v1/identity-security/devices/trust",
    "POST /v1/identity/links/apple",
    "POST /v1/identity/links/google",
    `DELETE /v1/identity/links/${P}`,
    "PUT /v1/me/notification-preferences",
    "PUT /v1/me/notification-schedule",
  ],
  PRIVACY: [
    "POST /v1/identity/account-closure",
    `POST /v1/identity/account-closure/${P}/cancel`,
    "POST /v1/identity/data-export",
    `POST /v1/identity/data-export/${P}/download`,
    `POST /v1/teams/${P}/closure`,
    `POST /v1/teams/${P}/closure/${P}/cancel`,
    `POST /v1/orgs/${P}/closure`,
    `POST /v1/orgs/${P}/closure/${P}/cancel`,
    `POST /v1/orgs/${P}/data-export`,
    `POST /v1/orgs/${P}/data-export/${P}/links`,
    `POST /v1/orgs/${P}/data-export/${P}/manifest`,
  ],
  CANCELLATION: [
    "POST /v1/billing/subscription/cancel",
    "POST /v1/billing/storage-addons/cancel",
    `POST /v1/billing/accounts/${P}/${P}/retry-storage-cancellation`,
    `POST /v1/billing/accounts/${P}/${P}/checkout-attempts/${P}/abandon`,
    `POST /v1/billing/accounts/${P}/${P}/payments/${P}/cancel`,
    `POST /v1/billing/accounts/${P}/${P}/payments/${P}/abandon`,
    "POST /v1/billing/checkout/paypal/returns/canceled",
    // AUD-52: withdrawing one's own unsealed draft adds nothing.
    `POST /v1/capture/direct-sessions/${P}/discard`,
    `DELETE /v1/capture/sessions/${P}`,
    `POST /v1/uploads/sessions/${P}/abort`,
    `POST /v1/uploads/sessions/${P}/multipart/abort`,
    // Deletion through the record's existing (retention / legal-hold governed) flow.
    `DELETE /v1/evidence/${P}`,
    // R1-F-08 (free-audit 0ea0): cancelling or closing an evidence request
    // ends it and revokes its live intake links, the same reduction the
    // direct link revoke (REVOCATION) already makes. Adds nothing.
    `POST /v1/evidence-requests/${P}/cancel`,
    `POST /v1/evidence-requests/${P}/close`,
    // B6-F-50 (free-audit 0ea0): stopping one's own running batch job ends
    // work already started; it adds nothing.
    `POST /v1/batch-analysis/${P}/cancel`,
  ],
  IN_FLIGHT: [
    `POST /v1/billing/accounts/${P}/${P}/reconcile`,
    `POST /v1/billing/accounts/${P}/${P}/checkout-attempts/${P}/recheck`,
    `POST /v1/billing/accounts/${P}/${P}/payments/${P}/recheck`,
    "POST /v1/billing/checkout/paypal/pending/resolve",
    `POST /v1/billing/checkout/paypal/subscriptions/${P}/confirm`,
    `POST /v1/billing/credits/checkout/paypal/${P}/capture`,
  ],
  REVOCATION: [
    "POST /v1/oauth/extension/revoke",
    `DELETE /v1/users/me/sessions/${P}`,
    `POST /v1/identity-security/my-sessions/${P}/revoke`,
    "POST /v1/identity-security/my-sessions/revoke-others",
    "POST /v1/identity-security/sessions/revoke",
    "POST /v1/identity-security/sessions/revoke-all",
    `POST /v1/identity-security/contact-factors/${P}/revoke`,
    `POST /v1/identity-security/devices/${P}/revoke`,
    `POST /v1/capture/devices/${P}/revoke`,
    `POST /v1/teams/${P}/leave`,
    `POST /v1/orgs/${P}/leave`,
    `POST /v1/evidence/${P}/verify-links/${P}/revoke`,
    `POST /v1/evidence/${P}/verify-links/legacy/revoke`,
    `POST /v1/evidence/${P}/verification-access/withdraw`,
    `POST /v1/integrations/api-keys/${P}/revoke`,
    `POST /v1/integrations/webhooks/${P}/disable`,
    `POST /v1/integrations/webhooks/endpoints/${P}/deactivate`,
    `POST /v1/automation/webhooks/${P}/disable`,
    `POST /v1/identity/service-accounts/${P}/disable`,
    `POST /v1/external-review/grants/${P}/revoke`,
    `POST /v1/external-review/invitations/${P}/revoke`,
    "POST /v1/external-review/invitations/bulk/revoke",
    `POST /v1/external-review/invitations/${P}/sessions/revoke`,
    `POST /v1/exchange/packages/${P}/revoke`,
    `POST /v1/exchange/chain-transfers/${P}/revoke`,
    `POST /v1/workflow/intake-links/${P}/revoke`,
    `POST /v1/identity/contributor-sessions/${P}/revoke`,
    `POST /v1/identity/members/${P}/revoke`,
    `POST /v1/identity/mfa-admin/factors/${P}/${P}/${P}/revoke`,
    `POST /v1/governance/cross-org-review/${P}/revoke`,
    `POST /v1/governance/delegated-admin/${P}/revoke`,
    `POST /v1/governance/departments/memberships/${P}/revoke`,
    `DELETE /v1/teams/${P}/invites/${P}`,
    `DELETE /v1/teams/${P}/members/${P}`,
    `DELETE /v1/teams/${P}/external-grants/${P}`,
    `DELETE /v1/orgs/${P}/invites/${P}`,
    `DELETE /v1/orgs/${P}/members/${P}`,
    `DELETE /v1/cases/${P}/access/${P}`,
    `DELETE /v1/cases/${P}/team-access/${P}`,
    `DELETE /v1/collaboration-teams/${P}/members/${P}`,
    `PATCH /v1/collaboration-teams/${P}/guests/${P}/revoke`,
    `POST /v1/collaboration-teams/${P}/invites/${P}/revoke`,
    "POST /v1/support-access/revoke",
    "POST /v1/break-glass/revoke",
    "POST /v1/break-glass/emergency/sessions/revoke",
    "POST /v1/admin/identity/emergency-revoke",
    `POST /v1/admin/identity/sessions/${P}/revoke`,
    `POST /v1/admin/identity/sessions/user/${P}/revoke-all`,
    `POST /v1/admin/identity/scim/tokens/${P}/revoke`,
  ],
  BACKGROUND: [
    "POST /v1/me/presence/heartbeat",
    `POST /v1/collaboration/threads/${P}/mark-mentions-read`,
    // B2B-F-13 (free-audit 0ea0): the inbox read markers are the same kind of
    // write as the mention read marker above (a client marks an item read when
    // it is opened from the bell). Archive / snooze stay gated: a person acts.
    `POST /v1/me/inbox/items/${P}/read`,
    `POST /v1/me/inbox/items/${P}/unread`,
    "POST /v1/me/inbox/mark-all-read",
    "POST /v1/ops/upload-telemetry",
    "POST /v1/deep-link/resolve",
  ],
  // `app.all` 410 notices (enterprise.routes.ts), every write method.
  RETIRED: ["POST", "PUT", "PATCH", "DELETE"].flatMap((m) => [`${m} /v1/api-keys`, `${m} /v1/api-keys/*`]),
};

/**
 * B5A-F-12 (free-audit 0ea0) — routes whose exemption depends on WHAT the
 * request does. The bulk evidence route carries substantive actions (add to
 * case, archive, restore...) and two A1-06 keeps open: moving records to the
 * trash (single-record DELETE is already CANCELLATION) and exporting their
 * metadata ("deletion/export ... accessible through their existing flows").
 * Only those two actions pass; every other body, and an unparsable one, is
 * gated. The route key also stays gated in the enumeration (its default body
 * is refused).
 */
export const BODY_CONDITIONAL_EXEMPTIONS: Readonly<
  Record<string, { category: LegalExemptionCategory; admits: (body: unknown) => boolean }>
> = {
  "POST /v1/evidence/bulk": {
    category: "PRIVACY",
    admits: (body) => {
      const action = (body as { action?: unknown } | null | undefined)?.action;
      return action === "TRASH" || action === "EXPORT_METADATA_CSV";
    },
  },
};

/**
 * Write routes that never reach `requireAuth`: no signed-in person is behind
 * them, so there are no terms to owe. Recorded so the enumeration test can tell
 * "not gated by design" from "forgotten". Regexes over the normalised key.
 */
export const NON_SESSION_WRITE_ROUTES: Readonly<Record<NonSessionCategory, readonly RegExp[]>> = {
  // Signing in, registering, recovering, and the hand-offs between them.
  CREDENTIAL_CEREMONY: [
    /^POST \/v1\/auth\/(apple|google|logout|oauth\/nonce|sso\/discover|sso\/native\/exchange|saml\/acs)$/,
    /^POST \/v1\/auth\/email\/(login|register|resend-verification|verify)$/,
    /^POST \/v1\/auth\/password-reset\/(request|confirm)$/,
    /^POST \/v1\/auth\/mfa\/(methods|send-code|verify|passkey-handoff\/options|passkey-handoff\/answer)$/,
    /^POST \/v1\/oauth\/extension\/token$/,
    /^POST \/v1\/identity-security\/step-up\/handoff\/(idp\/begin|passkey|passkey\/options)$/,
    /^POST \/v1\/identity\/mfa\/recovery-requests\/(:p\/verify-email|analytics\/page-viewed)$/,
    /^POST \/v1\/(teams\/invites|org-invites)\/lookup$/,
  ],
  // Signed by the provider; settle whatever the person's terms say.
  PROVIDER_CALLBACK: [/^POST \/webhooks\/(stripe|paypal)$/, /^POST \/v1\/communications\/webhooks\/twilio\/(inbound|status)$/],
  // Cron / internal-service / reconcile secrets.
  MACHINE: [
    /^POST \/v1\/internal\//,
    /^POST \/v1\/_test\/rate-limit\/reset$/,
    /^POST \/v1\/uploads\/sessions\/:p\/parts\/:p\/verified$/,
    /^POST \/v1\/(automation\/runs\/process|communications\/process-retries|governance\/reconcile-retention)$/,
    /^POST \/v1\/integrations\/(process-secret-cleanup|process-webhook-retries|webhooks\/cleanup-deliveries)$/,
    /^POST \/v1\/notifications\/(process-retries|run-digests|run-reminders)$/,
    /^POST \/v1\/(ops\/reconcile|org-invite-deliveries\/process|reliability\/reconcile)$/,
    /^POST \/v1\/(review-operations\/reconcile-slas|reviewer-ops\/reconcile)$/,
  ],
  PUBLIC_ANONYMOUS: [/^POST \/v1\/(contact-sales|demo-requests|analytics\/track)$/],
  ANONYMOUS_INTAKE: [/^(POST|PATCH) \/v1\/external-intake\/:p\//, /^POST \/v1\/intake\/citizen\//],
  EXTERNAL_PORTAL: [/^POST \/v1\/portal\//, /^POST \/v1\/external-review\/access\/:p$/],
  API_KEY: [/^POST \/v1\/integrations\/api\//],
  SCIM: [/^(POST|PATCH|PUT|DELETE) \/v2\/scim\//],
};

/** `/v1/evidence/:id|:evidenceId/x` and `/v1/evidence/:evidenceId/x` -> `/v1/evidence/:p/x`. */
export function normalizeLegalRouteKey(method: string, routePattern: string): string {
  const path = routePattern
    .split("?")[0]
    .replace(/:[A-Za-z0-9_]+(\([^)]*\))?(\|:[A-Za-z0-9_]+(\([^)]*\))?)*/g, P)
    .replace(/(.)\/$/, "$1");
  return `${method.toUpperCase()} ${path}`;
}

const EXEMPT_BY_KEY: ReadonlyMap<string, LegalExemptionCategory> = new Map(
  (Object.entries(SESSION_WRITE_EXEMPTIONS) as Array<[LegalExemptionCategory, readonly string[]]>).flatMap(
    ([category, keys]) => keys.map((key) => [key, category] as const),
  ),
);

export function legalAcceptanceExemptionFor(
  method: string,
  routePattern: string,
  /** The parsed request body, for the few routes whose exemption depends on the action (B5A-F-12). */
  body?: unknown,
): LegalExemption | null {
  const key = normalizeLegalRouteKey(method, routePattern);
  const category = EXEMPT_BY_KEY.get(key);
  if (category) return { category };
  const conditional = BODY_CONDITIONAL_EXEMPTIONS[key];
  if (conditional && body !== undefined && conditional.admits(body)) return { category: conditional.category };
  return null;
}

export function nonSessionWriteCategoryFor(method: string, routePattern: string): NonSessionCategory | null {
  const key = normalizeLegalRouteKey(method, routePattern);
  for (const [category, patterns] of Object.entries(NON_SESSION_WRITE_ROUTES) as Array<
    [NonSessionCategory, readonly RegExp[]]
  >) {
    if (patterns.some((p) => p.test(key))) return category;
  }
  return null;
}
