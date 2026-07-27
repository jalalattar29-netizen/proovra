/**
 * PROOVRA Phase 5 — Collaboration Team canonical vocabulary.
 *
 * The Collaboration Team is the constitutional Team primitive (see
 * docs/architecture/proovra-domain-model.md — "Team is a collaboration
 * sub-unit, NOT a workspace, NOT a tenant"). It lives inside a
 * workspace (PERSONAL or ORGANIZATION) and groups people for
 * collaboration purposes.
 *
 * This module defines the BOUNDED vocabularies that the backend
 * services + API routes + frontend pages all agree on:
 *
 *   - role: LEAD / ADMIN / MEMBER / VIEWER / EXTERNAL
 *   - status: ACTIVE / SUSPENDED / REMOVED (member); ACTIVE / ARCHIVED (team)
 *   - team_type: GENERAL / INVESTIGATION / LEGAL / REVIEW / COMPLIANCE
 *   - invite channel: EMAIL / SMS / LINK
 *   - invite status: PENDING / ACCEPTED / REVOKED / EXPIRED
 *   - delivery status: PENDING / SENT / DELIVERED / FAILED / BOUNCED
 *   - assignment status: OPEN / IN_PROGRESS / COMPLETED / REASSIGNED / CANCELLED
 *   - assignment priority: LOW / NORMAL / HIGH / URGENT
 *   - assignment target: CASE / EVIDENCE / REVIEW
 *   - activity event types (bounded, see below)
 *
 * Constitutional rules pinned by Phase R14:
 *
 *   1. Collaboration Team is NOT a workspace.
 *   2. Collaboration Team is NOT a tenant.
 *   3. Collaboration Team works in PERSONAL and ORGANIZATION workspaces.
 *   4. Personal users can create Collaboration Teams without an Organization.
 *   5. Collaboration Team does NOT own Evidence/Cases; it is assigned to them.
 */

// =============================================================================
// Team roles
// =============================================================================

export const COLLABORATION_TEAM_ROLES = [
  /** Leader — full team management, invite/remove, change roles, transfer leadership. */
  "LEAD",
  /** Admin — invite/remove, assign work, limited settings. */
  "ADMIN",
  /** Member — participate, accept assignments, comment, mention. */
  "MEMBER",
  /** Viewer — read-only. */
  "VIEWER",
  /** External — bounded, time-limited collaborator (guest path). */
  "EXTERNAL",
] as const;
export type CollaborationTeamRole = (typeof COLLABORATION_TEAM_ROLES)[number];

/** Roles that can manage the team (invite, remove, change roles). */
export const COLLABORATION_TEAM_MANAGE_ROLES: ReadonlyArray<CollaborationTeamRole> = [
  "LEAD",
  "ADMIN",
];

/** Roles that can assign work. */
export const COLLABORATION_TEAM_ASSIGN_ROLES: ReadonlyArray<CollaborationTeamRole> = [
  "LEAD",
  "ADMIN",
];

/** Roles that can transfer leadership. Only LEAD. */
export const COLLABORATION_TEAM_TRANSFER_LEAD_ROLES: ReadonlyArray<CollaborationTeamRole> = [
  "LEAD",
];

// =============================================================================
// Team status + member status
// =============================================================================

export const COLLABORATION_TEAM_STATUSES = ["ACTIVE", "ARCHIVED"] as const;
export type CollaborationTeamStatus =
  (typeof COLLABORATION_TEAM_STATUSES)[number];

export const COLLABORATION_TEAM_MEMBER_STATUSES = [
  "ACTIVE",
  "SUSPENDED",
  "REMOVED",
] as const;
export type CollaborationTeamMemberStatus =
  (typeof COLLABORATION_TEAM_MEMBER_STATUSES)[number];

// =============================================================================
// Team type / template
// =============================================================================

export const COLLABORATION_TEAM_TYPES = [
  "GENERAL",
  "INVESTIGATION",
  "LEGAL",
  "REVIEW",
  "COMPLIANCE",
] as const;
export type CollaborationTeamType = (typeof COLLABORATION_TEAM_TYPES)[number];

// =============================================================================
// Invite channel + status + delivery
// =============================================================================

export const COLLABORATION_TEAM_INVITE_CHANNELS = [
  "EMAIL",
  "SMS",
  "LINK",
] as const;
export type CollaborationTeamInviteChannel =
  (typeof COLLABORATION_TEAM_INVITE_CHANNELS)[number];

export const COLLABORATION_TEAM_INVITE_STATUSES = [
  "PENDING",
  "ACCEPTED",
  "REVOKED",
  "EXPIRED",
] as const;
export type CollaborationTeamInviteStatus =
  (typeof COLLABORATION_TEAM_INVITE_STATUSES)[number];

export const COLLABORATION_TEAM_DELIVERY_STATUSES = [
  "PENDING",
  "SENT",
  "DELIVERED",
  "FAILED",
  "BOUNCED",
] as const;
export type CollaborationTeamDeliveryStatus =
  (typeof COLLABORATION_TEAM_DELIVERY_STATUSES)[number];

// =============================================================================
// Assignment status + priority + target
// =============================================================================

export const COLLABORATION_TEAM_ASSIGNMENT_STATUSES = [
  "OPEN",
  "IN_PROGRESS",
  "COMPLETED",
  "REASSIGNED",
  "CANCELLED",
] as const;
export type CollaborationTeamAssignmentStatus =
  (typeof COLLABORATION_TEAM_ASSIGNMENT_STATUSES)[number];

export const COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES = [
  "LOW",
  "NORMAL",
  "HIGH",
  "URGENT",
] as const;
export type CollaborationTeamAssignmentPriority =
  (typeof COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES)[number];

export const COLLABORATION_TEAM_ASSIGNMENT_TARGETS = [
  "CASE",
  "EVIDENCE",
  "REVIEW",
] as const;
export type CollaborationTeamAssignmentTarget =
  (typeof COLLABORATION_TEAM_ASSIGNMENT_TARGETS)[number];

// =============================================================================
// Activity event types (bounded; pinned by R14 test)
// =============================================================================

export const COLLABORATION_TEAM_ACTIVITY_EVENT_TYPES = [
  "TEAM_CREATED",
  "TEAM_RENAMED",
  "TEAM_DESCRIPTION_CHANGED",
  "TEAM_TYPE_CHANGED",
  "TEAM_ARCHIVED",
  "TEAM_REOPENED",
  "MEMBER_INVITED",
  "INVITE_RESENT",
  "INVITE_REVOKED",
  "INVITE_ACCEPTED",
  "INVITE_EXPIRED",
  "MEMBER_ADDED",
  "MEMBER_SUSPENDED",
  "MEMBER_REINSTATED",
  "MEMBER_REMOVED",
  "MEMBER_ROLE_CHANGED",
  "LEAD_TRANSFERRED",
  "ASSIGNMENT_CREATED",
  "ASSIGNMENT_REASSIGNED",
  "ASSIGNMENT_COMPLETED",
  "ASSIGNMENT_CANCELLED",
  "ASSIGNMENT_PRIORITY_CHANGED",
  "ASSIGNMENT_DUE_CHANGED",
] as const;
export type CollaborationTeamActivityEventType =
  (typeof COLLABORATION_TEAM_ACTIVITY_EVENT_TYPES)[number];

// =============================================================================
// Plan limits (Phase 5 conservative defaults; enforced by service)
// =============================================================================

// PHASE 9 §9.6 corrected (2026-07-22) — the Teams limit table/type/accessor
// were RELOCATED to `@proovra/shared-billing` (zero-decision projections of
// the canonical PlanCapabilities). This package holds NO limit vocabulary and
// no longer depends on the billing package (layering restored). Import
// `CollaborationTeamPlanLimits` / `COLLABORATION_TEAM_PLAN_LIMITS` /
// `getCollaborationTeamPlanLimits` from `@proovra/shared-billing`.

// =============================================================================
// Permissions per role
// =============================================================================

export type CollaborationTeamPermission =
  | "team.read"
  | "team.update_settings"
  | "team.archive"
  | "team.transfer_lead"
  | "team.member.invite"
  | "team.member.remove"
  | "team.member.suspend"
  | "team.member.change_role"
  | "team.invite.revoke"
  | "team.invite.resend"
  | "team.assignment.create"
  | "team.assignment.reassign"
  | "team.assignment.complete"
  | "team.assignment.cancel"
  | "team.activity.read";

const ROLE_PERMISSIONS: Record<
  CollaborationTeamRole,
  ReadonlyArray<CollaborationTeamPermission>
> = {
  LEAD: [
    "team.read",
    "team.update_settings",
    "team.archive",
    "team.transfer_lead",
    "team.member.invite",
    "team.member.remove",
    "team.member.suspend",
    "team.member.change_role",
    "team.invite.revoke",
    "team.invite.resend",
    "team.assignment.create",
    "team.assignment.reassign",
    "team.assignment.complete",
    "team.assignment.cancel",
    "team.activity.read",
  ],
  ADMIN: [
    "team.read",
    "team.update_settings",
    "team.member.invite",
    "team.member.remove",
    "team.member.suspend",
    "team.invite.revoke",
    "team.invite.resend",
    "team.assignment.create",
    "team.assignment.reassign",
    "team.assignment.complete",
    "team.assignment.cancel",
    "team.activity.read",
  ],
  MEMBER: [
    "team.read",
    "team.assignment.complete",
    "team.activity.read",
  ],
  VIEWER: ["team.read", "team.activity.read"],
  EXTERNAL: ["team.read"],
};

export function collaborationTeamRoleHasPermission(
  role: CollaborationTeamRole | null | undefined,
  permission: CollaborationTeamPermission,
): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function listCollaborationTeamRolePermissions(
  role: CollaborationTeamRole,
): ReadonlyArray<CollaborationTeamPermission> {
  return ROLE_PERMISSIONS[role];
}

// =============================================================================
// Invite token shape (raw token format used in URLs + SMS)
// =============================================================================

/**
 * The raw invite token shipped to the user. Format:
 *   `ctit_v1_<base32 random>` — `ctit` = Collaboration Team Invite Token.
 *
 * Tokens are 256-bit random (32 bytes) base32-encoded. Persisted as
 * sha256(token) — the raw value is NEVER stored.
 */
export const COLLABORATION_TEAM_INVITE_TOKEN_PREFIX = "ctit_v1_";
export const COLLABORATION_TEAM_INVITE_TOKEN_RANDOM_BYTES = 32;

export function isWellFormedCollaborationTeamInviteToken(
  token: string | null | undefined,
): boolean {
  if (!token || typeof token !== "string") return false;
  if (!token.startsWith(COLLABORATION_TEAM_INVITE_TOKEN_PREFIX)) return false;
  const body = token.slice(COLLABORATION_TEAM_INVITE_TOKEN_PREFIX.length);
  // Base32 random — 256 bits → 52 chars (no padding). Allow a small
  // range for encoding-impl variance (no padding vs `=`).
  return /^[A-Z2-7]{40,64}$/.test(body);
}

// =============================================================================
// SMS body renderer for collaboration-team invites
// =============================================================================

/**
 * Build the SMS body for a collaboration-team invite. Bounded at
 * ~280 chars. The body never includes raw tokens — only the secure
 * accept URL (which carries the token in the URL fragment / query
 * controlled by the caller).
 */
// =============================================================================
// Phase 7 — Collaboration Completion vocabulary (additive)
// =============================================================================

/** Comment target categories. Bounded for safety. */
export const COLLABORATION_TEAM_COMMENT_TARGETS = [
  "TEAM",
  "ASSIGNMENT",
  "CASE",
  "EVIDENCE",
  "REVIEW",
] as const;
export type CollaborationTeamCommentTarget =
  (typeof COLLABORATION_TEAM_COMMENT_TARGETS)[number];

export const COLLABORATION_TEAM_COMMENT_STATUSES = [
  "ACTIVE",
  "EDITED",
  "DELETED",
] as const;
export type CollaborationTeamCommentStatus =
  (typeof COLLABORATION_TEAM_COMMENT_STATUSES)[number];

/** Mention types resolved by the comment parser. */
export const COLLABORATION_TEAM_MENTION_TYPES = [
  /** A specific workspace user looked up by email handle. */
  "USER",
  /** Every active team member. */
  "TEAM",
  /** Every active LEAD on the team. */
  "LEAD",
] as const;
export type CollaborationTeamMentionType =
  (typeof COLLABORATION_TEAM_MENTION_TYPES)[number];

/** Bounded notification types for the team in-app inbox. */
export const COLLABORATION_TEAM_NOTIFICATION_TYPES = [
  "MENTION_IN_COMMENT",
  "ASSIGNMENT_ASSIGNED",
  "ASSIGNMENT_DUE_SOON",
  "ASSIGNMENT_COMPLETED",
  "INVITE_ACCEPTED",
  "ROLE_CHANGED",
  "MEMBER_ADDED",
  "MEMBER_REMOVED",
  "GUEST_ACCEPTED",
  "ACCESS_REVIEW_OPENED",
] as const;
export type CollaborationTeamNotificationType =
  (typeof COLLABORATION_TEAM_NOTIFICATION_TYPES)[number];

export const COLLABORATION_TEAM_DIGEST_MODES = [
  "INSTANT",
  "DAILY",
  "MUTED",
] as const;
export type CollaborationTeamDigestMode =
  (typeof COLLABORATION_TEAM_DIGEST_MODES)[number];

/** Guest lifecycle status. */
export const COLLABORATION_TEAM_GUEST_STATUSES = [
  "PENDING",
  "ACCEPTED",
  "REVOKED",
  "EXPIRED",
] as const;
export type CollaborationTeamGuestStatus =
  (typeof COLLABORATION_TEAM_GUEST_STATUSES)[number];

/** Access review lifecycle status. */
export const COLLABORATION_TEAM_ACCESS_REVIEW_STATUSES = [
  "OPEN",
  "COMPLETED",
  "CANCELLED",
] as const;
export type CollaborationTeamAccessReviewStatus =
  (typeof COLLABORATION_TEAM_ACCESS_REVIEW_STATUSES)[number];

export const COLLABORATION_TEAM_ACCESS_REVIEW_DECISIONS = [
  "PENDING",
  "KEEP",
  "REMOVE",
  "CHANGE_ROLE",
] as const;
export type CollaborationTeamAccessReviewDecision =
  (typeof COLLABORATION_TEAM_ACCESS_REVIEW_DECISIONS)[number];

// =============================================================================
// Mention parser — handle extraction + canonical tokens
// =============================================================================

const MENTION_HANDLE_RE = /(^|[\s(\[{])@([a-zA-Z0-9._-]{1,80})(?=$|[\s.,:;!?)\]}\n])/g;
/** Bounded special mention tokens recognised by the team mention parser. */
export const COLLABORATION_TEAM_SPECIAL_MENTIONS = [
  "team",
  "lead",
] as const;
export type CollaborationTeamSpecialMention =
  (typeof COLLABORATION_TEAM_SPECIAL_MENTIONS)[number];

/**
 * Parse the raw set of `@handle` tokens out of a comment body. Returns a
 * deduplicated array of lowercase handles. `@team` and `@lead` (special
 * mentions) are returned alongside user handles; the service layer
 * decides how to fan out each kind.
 *
 * This is intentionally narrow — handles must be 1-80 chars matching
 * `[a-zA-Z0-9._-]`. No HTML, no URLs, no @@chains.
 */
export function parseCollaborationTeamMentionHandles(
  body: string | null | undefined,
): ReadonlyArray<string> {
  if (!body || typeof body !== "string") return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(MENTION_HANDLE_RE)) {
    const raw = m[2]?.toLowerCase();
    if (!raw) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

export function isSpecialCollaborationTeamMention(
  handle: string,
): handle is CollaborationTeamSpecialMention {
  return (COLLABORATION_TEAM_SPECIAL_MENTIONS as ReadonlyArray<string>).includes(
    handle.toLowerCase(),
  );
}

// =============================================================================
// Comment body sanitiser (Phase 7)
// =============================================================================

const MAX_COMMENT_LENGTH = 4000;

/**
 * Sanitise a comment body for storage:
 *
 *   - Trim whitespace at boundaries.
 *   - Collapse 3+ consecutive newlines to 2.
 *   - Reject if empty after trim.
 *   - Truncate to `MAX_COMMENT_LENGTH`.
 *   - DO NOT strip mention tokens — they are required for the parser.
 *
 * HTML/JS injection prevention is the responsibility of the renderer —
 * the body is plain text and must be rendered with escaping, never via
 * `dangerouslySetInnerHTML`.
 */
export function sanitiseCollaborationTeamCommentBody(
  raw: string,
): { ok: true; body: string } | { ok: false; reason: string } {
  if (typeof raw !== "string")
    return { ok: false, reason: "Body must be a string." };
  const trimmed = raw.trim().replace(/\n{3,}/g, "\n\n");
  if (trimmed.length === 0)
    return { ok: false, reason: "Comment body is required." };
  if (trimmed.length > MAX_COMMENT_LENGTH)
    return {
      ok: false,
      reason: `Comment body max ${MAX_COMMENT_LENGTH} chars.`,
    };
  return { ok: true, body: trimmed };
}

// =============================================================================
// Display-fragment helper — safe user projection for the team directory
// =============================================================================

/**
 * Bounded, audit-safe user projection used in member lists, activity
 * actor display, mentions autocomplete, and the notification panel.
 *
 * NEVER include sensitive fields here. The `email` field is shown ONLY
 * when the viewer is also a workspace member (which all team viewers
 * are by construction). For external guests / public payloads, render
 * the masked `emailMasked` instead.
 */
export type CollaborationTeamUserDirectoryEntry = {
  userId: string;
  displayName: string;
  initials: string;
  avatarUrl: string | null;
  /** Present for workspace-member viewers; null for guest viewers. */
  email: string | null;
  /** Always populated; "j***@example.com" for safe public display. */
  emailMasked: string | null;
};

/**
 * Build a safe directory entry from a raw User-table row + viewer
 * privilege flag.
 *
 *   - `viewerIsWorkspaceMember = true` ⇒ include full email.
 *   - `viewerIsWorkspaceMember = false` ⇒ email is null; emailMasked
 *     is the masked form.
 */
export function buildCollaborationTeamUserDirectoryEntry(
  user: {
    id: string;
    email: string | null;
    displayName: string | null;
    firstName: string | null;
    lastName: string | null;
    avatarUrl: string | null;
  },
  opts: { viewerIsWorkspaceMember: boolean },
): CollaborationTeamUserDirectoryEntry {
  const displayName =
    user.displayName ||
    [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
    user.email?.split("@")[0] ||
    "Team member";
  const initials = computeInitials(displayName, user.email);
  return {
    userId: user.id,
    displayName,
    initials,
    avatarUrl: user.avatarUrl,
    email: opts.viewerIsWorkspaceMember ? (user.email ?? null) : null,
    emailMasked: maskEmailForDirectory(user.email),
  };
}

function computeInitials(displayName: string, email: string | null): string {
  const parts = displayName.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0]![0] + parts[1]![0]).toUpperCase();
  }
  if (parts.length === 1 && parts[0]!.length >= 2) {
    return parts[0]!.slice(0, 2).toUpperCase();
  }
  if (email) return email.slice(0, 2).toUpperCase();
  return "??";
}

function maskEmailForDirectory(email: string | null): string | null {
  if (!email) return null;
  const idx = email.indexOf("@");
  if (idx <= 0) return "***";
  const head = email[0];
  const tail = email.slice(idx);
  return `${head}***${tail}`;
}

// =============================================================================
// Pre-existing renderCollaborationTeamInvitationSmsBody continues below
// =============================================================================

export function renderCollaborationTeamInvitationSmsBody(input: {
  teamName: string;
  workspaceName: string;
  inviterDisplay: string;
  acceptUrl: string;
}): string {
  const trim = (s: string, n: number) =>
    s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`;
  const teamName = trim(input.teamName ?? "Team", 40);
  const workspaceName = trim(input.workspaceName ?? "Workspace", 40);
  const inviter = trim(input.inviterDisplay ?? "A teammate", 40);
  const body = `${inviter} invited you to join the "${teamName}" team in ${workspaceName} on Proovra. Accept: ${input.acceptUrl} Reply STOP to opt out.`;
  return body.slice(0, 320);
}
