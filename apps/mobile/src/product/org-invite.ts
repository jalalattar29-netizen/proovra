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
  // An owed setup is not redirected to on the phone (orgSetupWebUrl): nothing moves on.
  if (n === 0) return r.setupRedirect ? `${base}.` : `${base}. Redirecting…`;
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
 * MOBILE-012 — a brand-new Enterprise owner's first-time setup (domains, single
 * sign-on, retention and the rest of `/organizations/:id/setup`) runs in the
 * web app, which is PROOVRA's Enterprise administration client. The phone used
 * to drop `setupRedirect` and land on the organization page, so an owner who
 * accepted on a phone was never told the setup was waiting. This is the web
 * address that setup is continued at, or null when none is owed (or the
 * server's path is not the setup route).
 */
export function orgSetupWebUrl(r: OrgInviteAccepted, webOrigin: string | null): string | null {
  const path = r.setupRedirect;
  if (!webOrigin || !path || !/^\/organizations\/[A-Za-z0-9-]+\/setup(\?[^#]*)?$/.test(path)) return null;
  return `${webOrigin}${path}`;
}

export const ORG_SETUP_ON_WEB_COPY =
  "Your organization's first-time setup — verified domains, single sign-on, retention and members — runs in the PROOVRA web app. Continue it there; everything you capture and review here works meanwhile.";

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

// =============================================================================
// PRO-072 — WHAT THE INVITATION GRANTS, BEFORE IT IS ACCEPTED
// =============================================================================

/**
 * The read the web acceptance page uses (POST, token in the body, public).
 * The screen used to say "This does NOT grant you access to workspace
 * evidence, cases, or reviewer queues" for every invitation, while accepting
 * wrote the invitation's workspace assignments, up to workspace ADMIN.
 */
export const ORG_INVITE_LOOKUP_PATH = "/v1/org-invites/lookup";

const LOOKUP_STATES = ["PENDING", "ACCEPTED", "REVOKED", "EXPIRED", "NOT_ACCEPTING_MEMBERS"] as const;
export type OrgInviteLookupState = (typeof LOOKUP_STATES)[number];

export interface OrgInviteLookupView {
  state: OrgInviteLookupState;
  organizationName: string | null;
  role: string | null;
  invitedEmailMasked: string | null;
  workspaces: Array<{ workspaceName: string; role: string }>;
}

/** The lookup body, or null when it is not one (the screen then makes no claim). */
export function parseOrgInviteLookup(payload: unknown): OrgInviteLookupView | null {
  const d = obj(payload);
  const state = str(d.state);
  if (!state || !(LOOKUP_STATES as readonly string[]).includes(state)) return null;
  const c = obj(d.context);
  const list = Array.isArray(c.workspaces) ? c.workspaces : [];
  return {
    state: state as OrgInviteLookupState,
    organizationName: str(c.organizationName),
    role: str(c.role),
    invitedEmailMasked: str(c.invitedEmailMasked),
    workspaces: list
      .map((w) => ({ workspaceName: str(obj(w).workspaceName), role: str(obj(w).role) }))
      .filter((w): w is { workspaceName: string; role: string } => Boolean(w.workspaceName && w.role)),
  };
}

const ORG_ROLE_WORD: Record<string, string> = {
  ORG_OWNER: "owner",
  ORG_ADMIN: "administrator",
  ORG_SECURITY_ADMIN: "security administrator",
  ORG_BILLING_ADMIN: "billing administrator",
  ORG_AUDITOR: "auditor",
  ORG_MEMBER: "member",
};

const WORKSPACE_ROLE_WORDS: Record<string, string> = {
  VIEWER: "Viewer: can open and read its evidence, cases and reports",
  MEMBER: "Member: can capture and work on its evidence and cases",
  ADMIN: "Admin: can manage the workspace, its members and its settings",
};

/**
 * The sentences the screen shows before Accept, and whether Accept is offered.
 * Same copy as the web page. A failed or unreadable lookup claims nothing
 * either way and still offers Accept (the accept itself says why it refuses).
 */
export function orgInviteGrantLines(view: OrgInviteLookupView | null): { lines: string[]; canAccept: boolean } {
  if (!view) {
    return {
      lines: [
        "We could not load the details of this invitation. Accepting adds you to the organization with the role the inviter chose, and to any workspaces the invitation names, at the role it names.",
      ],
      canAccept: true,
    };
  }
  if (view.state !== "PENDING") {
    const line =
      view.state === "ACCEPTED"
        ? "This invitation has already been accepted."
        : view.state === "REVOKED"
          ? "This invitation was revoked."
          : view.state === "EXPIRED"
            ? "This invitation has expired."
            : "This organization is not accepting new members right now.";
    return { lines: [line, "Ask an organization administrator to send a new invitation if you still need access."], canAccept: false };
  }
  const role = ORG_ROLE_WORD[view.role ?? ""] ?? "member";
  const org = view.organizationName ?? "the organization";
  const lines = [
    `Accepting adds you to ${org} as an organization ${role}.${view.invitedEmailMasked ? ` Invited address: ${view.invitedEmailMasked}.` : ""}`,
  ];
  if (view.workspaces.length === 0) {
    lines.push(
      "It gives you no workspace access. Evidence, cases and reviewer queues belong to workspaces, and an administrator can add you to one later.",
    );
  } else {
    lines.push(view.workspaces.length === 1 ? "It also gives you access to this workspace:" : `It also gives you access to these ${view.workspaces.length} workspaces:`);
    for (const w of view.workspaces) lines.push(`${w.workspaceName}: ${WORKSPACE_ROLE_WORDS[w.role] ?? w.role}`);
    lines.push("A workspace with no free seat cannot be granted; you will be told after accepting if that happens.");
  }
  return { lines, canAccept: true };
}
