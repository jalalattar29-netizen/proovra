/**
 * Attack results a person read and accepted, each with the reason. Keyed by route
 * and variant, so a new route or a new variant is never excused by an old entry.
 */
export const reviewKey = (route: string, variant: string): string => `${route} [${variant}]`;

const OWN_ROW = "The viewer's own personal row, in a workspace they belong to. It is theirs to write.";

export const REVIEWED_ATTACK_RESULTS: Record<string, string> = {
  "POST /v1/ops/saved-views [viewer]": OWN_ROW,
  "POST /v1/search/saved-views [viewer]": OWN_ROW,
  "POST /v1/siu/saved-views [viewer]": OWN_ROW,
  "PUT /v1/me/notification-preferences [viewer]": OWN_ROW,
  "POST /v1/teams/:p/leave [viewer]": "A member leaving their own workspace.",
  "POST /v1/identity/mfa-admin/recovery-requests [viewer]":
    "A person opening a recovery request for their own factor, by design open to any member.",
  "POST /v1/exchange/deliveries/:p/download [viewer]":
    "VIEWER holds evidence.download_package and the route records that the download happened.",
  "POST /v1/ops/workspace-reconcile [viewer]":
    "Deliberate: the operations.view floor, documented on the route. It re-reads what the caller may read.",
  "PUT /v1/me/notification-schedule [viewer]": OWN_ROW,
  "POST /v1/external-review/access/:p [anonymous]":
    "The capability is the path: whoever holds the victim's token is its reviewer. The anonymous request is that holder, and it opens the grant it names.",
  "POST /v1/identity/mfa/recovery-requests/:p/verify-email [anonymous]":
    "The emailed token is the credential, and it names its own request. The anonymous request holds the victim's token, so it is that person.",
  "POST /v1/identity/password [viewer]": "A person adding a password to their own account.",
  "POST /v1/identity-security/contact-factors/enroll/start [viewer]": "A person enrolling their own phone as a factor.",
  "POST /v1/communications/verify/start [viewer]":
    "Gated on identity.member.read by the route. The attempt is a row of the workspace. Reported as a question: may any member text any number?",
  "POST /v1/exchange/chain-transfers [mixed-body]":
    "The foreign field is toOrganizationId, the recipient, which is another organization by definition. The evidence field is refused separately.",
  "POST /v1/ops/bulk-actions [cross-tenant]":
    "The run is the attacker's own and records the requested id as skipped. Nothing of the victim's is touched.",
  "POST /v1/ops/bulk-actions [mixed-body]":
    "The run is the attacker's own and records the requested id as skipped. Nothing of the victim's is touched.",
  "POST /v1/ops/bulk-actions [bulk-array]":
    "The run is the attacker's own. Its own incident succeeds, the victim's is recorded as skipped.",
  "PATCH /v1/users/me [removed-member]":
    "The response repeats the person's own stored workspace pointer. Nothing of that workspace is read.",
};
