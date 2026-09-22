/**
 * ORGANIZATION INVITE ACCEPTANCE — pure projection.
 *
 * Ports the accept response of `POST /v1/org-invites/:token/accept`, read by
 * `apps/web/app/(app)/org-invites/[token]/accept/page.tsx`.
 *
 * A DIFFERENT family from the collaboration-group invite: different token
 * namespace, different endpoint, different outcome. Conflating the two would
 * send an organization token to the collaboration endpoint, which answers 404
 * by design — the user would be told their invitation was invalid when it was
 * merely sent to the wrong place.
 *
 * Pure: no React, no react-native, no fetch.
 */

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

export interface OrgInviteAccepted {
  organizationId: string | null;
  role: string | null;
  /**
   * Explicit workspace grants consumed by this accept.
   *
   * EMPTY IS MEANINGFUL: it marks a governance-only invite, which is why the
   * web stopped auto-redirecting when the list is non-empty. Treating absent
   * and empty the same is correct here — both mean "no workspace was granted".
   */
  assignedWorkspaceIds: string[];
  /** Present only when brand-new-owner enterprise provisioning ran. */
  setupRedirect: string | null;
  enterpriseWorkspaceId: string | null;
}

export function parseOrgInviteAccept(payload: unknown): OrgInviteAccepted {
  const d = obj(payload);
  return {
    organizationId: str(d.organizationId),
    role: str(d.role),
    assignedWorkspaceIds: Array.isArray(d.assignedWorkspaceIds)
      ? d.assignedWorkspaceIds.filter((x): x is string => typeof x === "string" && x.length > 0)
      : [],
    setupRedirect: str(d.setupRedirect),
    enterpriseWorkspaceId: str(d.enterpriseWorkspaceId),
  };
}

/** The canonical web path for this invite, for intent preservation. */
export function buildOrgInviteAcceptPath(token: string): string {
  return `/v1/org-invites/${encodeURIComponent(token)}/accept`;
}
