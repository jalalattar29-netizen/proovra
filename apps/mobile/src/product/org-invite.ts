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


/**
 * T-14 — the granted workspace's NAME for the "Open …" control, from the
 * platform envelope's contextOptions (web org-invites accept workspaceName).
 */
export function grantedWorkspaceName(envelope: unknown, workspaceId: string): string {
  const orgs = Array.isArray(obj(obj(envelope).contextOptions).organizations) ? (obj(obj(envelope).contextOptions).organizations as unknown[]) : [];
  for (const org of orgs) {
    const wss = Array.isArray(obj(org).workspaces) ? (obj(org).workspaces as unknown[]) : [];
    for (const ws of wss) {
      if (str(obj(ws).workspaceId) === workspaceId) return str(obj(ws).workspaceName) ?? "Workspace";
    }
  }
  return "Workspace";
}

/** A role enum as words ("ORG_MEMBER" → "org member"). */
function roleWords(role: string | null): string | null {
  return role ? role.replace(/_/g, " ").toLowerCase() : null;
}

/**
 * The success sentence (org-invites accept page.tsx:229-238): the role, and how
 * many workspaces came with it. A governance-only accept says it is about to
 * move on, because it does.
 */
export function acceptedHeadline(r: OrgInviteAccepted): string {
  const role = roleWords(r.role);
  const base = role ? `You are now ${/^[aeiou]/.test(role) ? "an" : "a"} ${role} of the organization` : "You joined the organization";
  const n = r.assignedWorkspaceIds.length;
  if (n === 0) return `${base}. Redirecting…`;
  return n === 1 ? `${base} with access to one workspace.` : `${base} with access to ${n} workspaces.`;
}

/**
 * Where "Open organization" (and the governance-only auto-landing) goes.
 *
 * The web honours `setupRedirect` — `/organizations/:id/setup`, the ENTERPRISE
 * setup wizard (enterprise-provisioning.service.ts:987) — which has no native
 * route; native lands on the organization itself, whose page is where that
 * setup is reached from. Null when the server named no organization.
 */
export function orgInviteLanding(r: OrgInviteAccepted): string | null {
  return r.organizationId ? `/organizations/${encodeURIComponent(r.organizationId)}` : null;
}

/**
 * The refusal reason, by status (accept page.tsx:283-289), matching
 * organizations.routes.ts:1065-1086 — 410 revoked / accepted / expired /
 * closed, 404 unknown token, anything else (403 email mismatch, 409) generic.
 */
export function orgInviteFailureMessage(status: number): string {
  if (status === 410) return "This invite is expired, revoked, or already accepted. Ask an organization administrator to send a new one.";
  if (status === 404) return "Invite not found — the link may be incorrect. Ask an organization administrator for a new invitation.";
  return "The invite couldn't be accepted. Ask an organization administrator for a new invitation.";
}
