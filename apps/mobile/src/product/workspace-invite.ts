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
  type InvitationEntryBlock,
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

export function parseWorkspaceInviteAccept(payload: unknown): { alreadyMember: boolean; workspaceId: string | null } {
  const d = o(payload);
  return { alreadyMember: d["alreadyMember"] === true, workspaceId: s(d["workspaceId"]) };
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
  "identity-not-eligible": {
    title: "This account can't join this workspace",
    message:
      "Your organization manages where this account can work, and it doesn't allow personal workspaces like this one. Sign in with another account, or ask the person who invited you to use a different address.",
  },
  unknown: {
    title: "This invitation link isn't available",
    message: "The link may be incorrect or no longer active. Ask an administrator for a new invitation.",
  },
  unreachable: {
    title: "We couldn't check this invitation",
    message: "Something interrupted the connection. Your invitation hasn't changed — try again in a moment.",
  },
  // F-26e — the web page's copy for the settled refusals that used to read as "unreachable".
  "email-not-verified": {
    title: "Verify your email address first",
    message:
      "This invitation can be accepted once the address on your account is verified. We can send you a verification email; open it, then come back and accept.",
  },
  "membership-suspended": {
    title: "Your access to this workspace is suspended",
    message: "An invitation can't lift a suspension. Ask a workspace administrator to restore your access.",
  },
  superseded: {
    title: "This invitation is no longer valid for you",
    message: "It was sent before your access to this workspace ended. Ask a workspace administrator for a new invitation.",
  },
  "workspace-plan-inactive": {
    title: "This workspace can't add members right now",
    message:
      "The workspace's plan or contract isn't set up to admit new members at the moment. Your invitation stays valid until it expires — ask the workspace administrator to resolve it.",
  },
  "legal-acceptance-required": {
    title: "Accept the updated terms to continue",
    message: "Our terms have changed since you last accepted them. Review and accept them, then accept this invitation.",
  },
  "accepted-not-opened": {
    title: "Invitation accepted — the workspace didn't open",
    message: "You're now a member, but this workspace couldn't be opened with your current sign-in.",
  },
};

/** F-07 — why an accepted workspace did not open (the web page's ENTRY_BLOCK_MESSAGE). */
export const WORKSPACE_INVITE_ENTRY_BLOCK_MESSAGE: Record<InvitationEntryBlock, string> = {
  "sso-required":
    "This organization requires its single sign-on. Sign in again with “Sign in with your organization (SSO)”, then open this invitation once more to enter the workspace.",
  "sign-in-method":
    "This organization doesn't accept the way you signed in. Sign in with a method it allows, then open this invitation again.",
  "sign-in-again":
    "This organization needs a more recent sign-in. Sign in again, then open this invitation to enter the workspace.",
  "session-limit":
    "This organization limits how many sessions can be open at once. Sign out on another device, then try again.",
  unavailable:
    "The workspace can't be opened right now. Your membership is in place; contact the workspace administrator if this continues.",
  interrupted:
    "Something interrupted the connection while opening the workspace. Your membership is in place — try again.",
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
  "send-verification": "Send verification email",
  "review-terms": "Review the terms",
  "retry-open": "Try again",
};
