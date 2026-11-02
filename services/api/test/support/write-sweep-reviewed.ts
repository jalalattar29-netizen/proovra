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
  "PATCH /v1/users/me [removed-member]":
    "The response repeats the person's own stored workspace pointer. Nothing of that workspace is read.",
  "POST /v1/trust/subprocessors/seed [cross-tenant]":
    "Not a boundary: any member may ask for the canonical seed. The 500 is a unique conflict on the upsert in the caller's own workspace and wrote nothing of the victim's.",
};
