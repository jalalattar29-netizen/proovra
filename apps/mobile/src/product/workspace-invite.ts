/**
 * WORKSPACE INVITATION (T-15) — the native port of `apps/web/app/invite/[token]`.
 *
 * Workspace invitations are emailed as `/invite/<wsit_v1_…>` (email.service.ts
 * `inviteAcceptUrl`). Native's `/invite/[token]` only knew COLLABORATION-team
 * invitations, so a workspace invitation opened in the app was posted to the
 * collaboration endpoint and reported as invalid. The token SHAPE decides the
 * flow, exactly as the web does (`isWellFormedWorkspaceInviteToken`).
 *
 * READ, then act: `POST /v1/teams/invites/lookup {token}` describes the
 * invitation without consuming it; `POST /v1/teams/invites/:token/accept`
 * happens only when the reader presses Accept. The view is resolved by the
 * SAME `resolveInvitationView` the web renders (now in @proovra/shared).
 */
import {
  WORKSPACE_INVITATION_LOOKUP_STATES,
  isWorkspaceInvitationRefusalCode,
  type InvitationAction,
  type InvitationViewKind,
  type WorkspaceInvitationContext,
  type WorkspaceInvitationLookup,
  type WorkspaceInvitationRefusalCode,
} from "@proovra/shared";

export const WORKSPACE_INVITE_LOOKUP_PATH = "/v1/teams/invites/lookup";
export function buildWorkspaceInviteAcceptPath(token: string): string {
  return `/v1/teams/invites/${encodeURIComponent(token)}/accept`;
}

function o(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function s(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** The bounded lookup projection; an unrecognised state is treated as "not available". */
export function parseWorkspaceInviteLookup(payload: unknown): WorkspaceInvitationLookup | null {
  const d = o(payload);
  const state = s(d["state"]);
  if (!state || !(WORKSPACE_INVITATION_LOOKUP_STATES as readonly string[]).includes(state)) return null;
  const c = o(d["context"]);
  const context: WorkspaceInvitationContext | null =
    state === "PENDING" && s(c["workspaceName"])
      ? {
          workspaceName: s(c["workspaceName"]) as string,
          organizationName: s(c["organizationName"]),
          role: s(c["role"]) ?? "MEMBER",
          invitedEmailMasked: s(c["invitedEmailMasked"]) ?? "",
          expiresAtUtc: s(c["expiresAtUtc"]) ?? "",
        }
      : null;
  return { state: state as WorkspaceInvitationLookup["state"], context };
}

export function parseWorkspaceInviteAccept(payload: unknown): { alreadyMember: boolean } {
  return { alreadyMember: o(payload)["alreadyMember"] === true };
}

/** A 404 or INVITE_NOT_FOUND is a verdict; anything else is an interruption (web §19). */
export function isInviteNotFound(err: unknown): boolean {
  const e = o(err);
  return e["statusCode"] === 404 || e["code"] === "INVITE_NOT_FOUND";
}

export function inviteRefusalCode(err: unknown): WorkspaceInvitationRefusalCode | null {
  const code = s(o(err)["code"]);
  return code && isWorkspaceInvitationRefusalCode(code) ? (code as WorkspaceInvitationRefusalCode) : null;
}

/** `MEMBER` → `Member` (page.tsx formatRole). */
export function formatInviteRole(role: string): string {
  const cleaned = String(role ?? "").replace(/_/g, " ").trim();
  if (!cleaned) return "Member";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
}

/** The web page's COPY, verbatim (apps/web/app/invite/[token]/page.tsx:110-208). */
export const WORKSPACE_INVITE_COPY: Record<InvitationViewKind, { title: string; message: string }> = {
  loading: { title: "Checking this invitation", message: "One moment while we look up the details." },
  "ready-signed-out": {
    title: "You've been invited to join a workspace",
    message: "Sign in to accept this invitation. If you don't have an account yet, you can create one with the invited address.",
  },
  "ready-signed-in": { title: "You've been invited to join a workspace", message: "Review the details below, then accept to get access." },
  accepting: { title: "Accepting your invitation", message: "Setting up your access — this only takes a moment." },
  accepted: { title: "Invitation accepted", message: "You now have access to this workspace." },
  "already-member": {
    title: "You're already a member",
    message: "This invitation was already accepted with your account, and your access is active.",
  },
  "wrong-account": {
    title: "This invitation was sent to a different address",
    message: "You're signed in with another account. Sign in with the invited address to accept it.",
  },
  expired: {
    title: "This invitation has expired",
    message: "Invitations are valid for a limited time. Ask a workspace administrator to send you a new one.",
  },
  revoked: {
    title: "This invitation was revoked",
    message: "It can no longer be used. Contact the workspace administrator if you still need access.",
  },
  "already-used": {
    title: "This invitation has already been used",
    message: "Invitation links work once. If you need access, ask an administrator to send a new invitation.",
  },
  "not-accepting": {
    title: "This workspace isn't accepting new members",
    message:
      "The workspace is closed or its organization is inactive, so this invitation can't be completed. Contact the workspace administrator.",
  },
  capacity: {
    title: "This workspace has no seats available",
    message:
      "Every seat on the workspace's plan is in use, so this invitation can't be completed right now. A workspace administrator can free a seat or change the plan.",
  },
  unknown: {
    title: "This invitation link isn't available",
    message: "The link may be incorrect or no longer active. Ask an administrator for a new invitation.",
  },
  unreachable: {
    title: "We couldn't check this invitation",
    message: "Something interrupted the connection. Your invitation hasn't changed — try again in a moment.",
  },
};

/** The web's action labels (page.tsx toSystemAction). "Homepage" and "dashboard" are both Home on native. */
export const WORKSPACE_INVITE_ACTION_LABEL: Record<InvitationAction, string> = {
  accept: "Accept invitation",
  retry: "Try again",
  "sign-in": "Sign in to continue",
  "create-account": "Create account",
  "switch-account": "Sign in with another account",
  "open-workspace": "Open workspace",
  "go-dashboard": "Go to dashboard",
  "go-home": "Go to homepage",
};
