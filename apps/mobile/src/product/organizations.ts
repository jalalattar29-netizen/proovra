/**
 * ORGANIZATIONS — pure projections for the org governance surface.
 *
 * Ports `apps/web/app/(app)/organizations/page.tsx` over `GET /v1/me/orgs` and
 * `apps/web/app/(app)/organizations/[id]/page.tsx` over `GET /v1/orgs/:id`,
 * `/members`, `/workspaces` and `/invites`.
 *
 * ===========================================================================
 * WHAT THE LIST DELIBERATELY DOES NOT CONTAIN
 * ===========================================================================
 * The endpoint filters on `organization: { kind: "CUSTOMER" }` and
 * `status: "ACTIVE"`, and the route says why in its own comments:
 *
 *   - the internal 1:1 bootstrap container every workspace owns is NOT a
 *     customer organization and must never surface as one on any product
 *     surface. Counting those containers is precisely what made the word
 *     "Organizations" look reasonable for as long as it did;
 *   - "the caller's Organization list is a list of places they may enter. A
 *     suspended or revoked membership must not appear and then refuse on
 *     arrival."
 *
 * Both filters are the SERVER'S. This module does not re-apply them and must
 * not: a client-side filter over a server-filtered list is a second authority
 * that will disagree the moment either changes.
 *
 * A member count is a SEAT count — revoked members occupy no seat — and the
 * pending-invite count includes only invitations that are still actionable.
 * Both come from the server for the same reason.
 *
 * Pure: no React, no react-native, no fetch.
 */
import type { ProovraStatusTone } from "@proovra/ui";

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export const MY_ORGS_PATH = "/v1/me/orgs";

export function buildOrgPath(orgId: string): string {
  return `/v1/orgs/${encodeURIComponent(orgId)}`;
}

export function buildOrgMembersPath(orgId: string): string {
  return `${buildOrgPath(orgId)}/members`;
}

export function buildOrgWorkspacesPath(orgId: string): string {
  return `${buildOrgPath(orgId)}/workspaces`;
}

export function buildOrgInvitesPath(orgId: string): string {
  return `${buildOrgPath(orgId)}/invites`;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export interface OrgSummary {
  organizationId: string;
  name: string;
  status: string;
  role: string;
  /** A SEAT count: revoked members occupy no seat, so they are not in it. */
  memberCount: number;
  workspaceCount: number;
  /** Only invitations still actionable — not accepted, revoked or expired. */
  pendingInviteCount: number;
  memberSinceIso: string | null;
}

export function parseMyOrgs(payload: unknown): OrgSummary[] {
  return rows(obj(payload).orgs)
    .map((raw) => {
      const o = obj(raw);
      const organizationId = str(o.organizationId);
      if (!organizationId) return null;
      return {
        organizationId,
        name: str(o.name) ?? "Unnamed organization",
        status: str(o.status) ?? "",
        role: str(o.role) ?? "",
        memberCount: num(o.memberCount) ?? 0,
        workspaceCount: num(o.workspaceCount) ?? 0,
        pendingInviteCount: num(o.pendingInviteCount) ?? 0,
        memberSinceIso: str(o.memberSince),
      };
    })
    .filter((o): o is OrgSummary => o !== null);
}

/**
 * The total the server states, not the length of the list.
 *
 * They should agree, and if they ever do not, the number a governance surface
 * shows should be the one the server computed — a mismatch is a signal, not
 * something to paper over by counting rows.
 */
export function parseMyOrgsTotal(payload: unknown): number | null {
  return num(obj(obj(payload).summary).totalOrgs);
}

export interface OrgDetail {
  id: string | null;
  name: string | null;
  legalName: string | null;
  legalEmail: string | null;
  status: string | null;
  verificationState: string | null;
  verifiedAtIso: string | null;
  timezone: string | null;
  address: string | null;
  logoUrl: string | null;
  createdAtIso: string | null;
  /**
   * The caller's OWN role in this organization.
   *
   * The endpoint returns it (`callerRole`) and the projection used to drop
   * it, which left the screen unable to tell an owner from a member — and so
   * unable to offer, or withhold, anything role-gated. It is the server's
   * answer to "who are you here", not an inference from the member list.
   */
  callerRole: string | null;
  /** The server's `summary` counts (null when absent). */
  memberCount: number | null;
  workspaceCount: number | null;
  pendingInviteCount: number | null;
}

export function parseOrgDetail(payload: unknown): OrgDetail | null {
  // GET /v1/orgs/:id sends a FLAT object keyed `organizationId`
  // (organizations.routes.ts). This read `organization.id` / `id`, neither of
  // which the server sends, so every organization rendered as "not available".
  const d = obj(obj(payload).organization ?? payload);
  const id = str(d.organizationId) ?? str(d.id);
  if (!id) return null;
  const summary = obj(obj(payload).summary);
  const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    id,
    name: str(d.name),
    legalName: str(d.legalName),
    legalEmail: str(d.legalEmail),
    status: str(d.status),
    verificationState: str(d.verificationState),
    verifiedAtIso: str(d.verifiedAtUtc) ?? str(d.verifiedAt),
    timezone: str(d.timezone),
    address: str(d.address),
    logoUrl: str(d.logoUrl),
    createdAtIso: str(d.createdAt),
    // On the envelope, beside `organization`, not inside it.
    callerRole: str(obj(payload).callerRole) ?? str(d.callerRole),
    memberCount: count(summary.memberCount),
    workspaceCount: count(summary.workspaceCount),
    pendingInviteCount: count(summary.pendingInviteCount),
  };
}

/** Only the owner may transfer ownership or close the organization. */
export function isOrgOwner(org: OrgDetail): boolean {
  return (org.callerRole ?? "").toUpperCase() === "ORG_OWNER";
}

export interface OrgMember {
  /** The MEMBERSHIP id — what member mutations address. */
  id: string;
  /**
   * The USER id — what ownership transfer addresses.
   *
   * These are two different identifiers and the projection used to collapse
   * them (`str(m.id) ?? str(m.userId)`), so a transfer built from a member row
   * would have sent a membership id as `targetUserId` and been refused as
   * `target_not_member` — a refusal naming the right rule for the wrong reason.
   * Null when the server sent only a membership.
   */
  userId: string | null;
  displayName: string;
  email: string | null;
  role: string;
  status: string;
}

export function parseOrgMembers(payload: unknown): OrgMember[] {
  return rows(obj(payload).members ?? payload)
    .map((raw) => {
      const m = obj(raw);
      // The MEMBERSHIP id is `membershipId` on the wire (organizations.routes.ts);
      // `id` is not sent, so this fell back to the user id.
      const id = str(m.membershipId) ?? str(m.id) ?? str(m.userId);
      if (!id) return null;
      const user = obj(m.user);
      const email = str(user.email) ?? str(m.email);
      return {
        id,
        userId: str(m.userId),
        displayName: str(user.displayName) ?? str(m.displayName) ?? email ?? "Unnamed member",
        email,
        role: str(m.role) ?? "",
        status: str(m.status) ?? "ACTIVE",
      };
    })
    .filter((m): m is OrgMember => m !== null);
}

export interface OrgWorkspace {
  id: string;
  name: string;
  memberCount: number | null;
  isPersonal: boolean;
  createdAtIso: string | null;
  /** Present only when the caller may see billing (ORG_ADMIN+ / ORG_BILLING_ADMIN). */
  billing: { plan: string; status: string; includedSeats: number | null; overSeatLimit: boolean } | null;
}

export function parseOrgWorkspaces(payload: unknown): OrgWorkspace[] {
  return rows(obj(payload).workspaces ?? obj(payload).teams ?? payload)
    .map((raw) => {
      const w = obj(raw);
      // GET /v1/orgs/:id/workspaces sends `workspaceId` (organizations.routes.ts).
      // Reading only `id` dropped EVERY row, so an organization with workspaces
      // was reported as having none.
      const id = str(w.workspaceId) ?? str(w.id);
      if (!id) return null;
      const b = obj(w.billing);
      return {
        id,
        name: str(w.name) ?? "Unnamed workspace",
        memberCount: num(w.memberCount),
        isPersonal: w.isPersonal === true,
        createdAtIso: str(w.createdAt),
        billing: str(b.plan)
          ? { plan: str(b.plan) as string, status: str(b.status) ?? "", includedSeats: num(b.includedSeats), overSeatLimit: b.overSeatLimit === true }
          : null,
      };
    })
    .filter((w): w is OrgWorkspace => w !== null);
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export function orgStatusTone(status: string): ProovraStatusTone {
  switch (status.toUpperCase()) {
    case "ACTIVE":
      return "verified";
    case "SUSPENDED":
    case "CLOSED":
      return "risk";
    case "PENDING":
    case "PENDING_VERIFICATION":
      return "pending";
    default:
      return "neutral";
  }
}

export function orgRoleLabel(role: string): string {
  const s = role.replace(/^ORG_/, "").replace(/_/g, " ").toLowerCase();
  return s.length === 0 ? "Member" : s.charAt(0).toUpperCase() + s.slice(1);
}

/** Does this role administer the organization? Mirrors the server's gate. */
export function isOrgAdminRole(role: string): boolean {
  const r = role.toUpperCase();
  return r === "ORG_OWNER" || r === "ORG_ADMIN";
}

/**
 * A one-line governance summary for a row.
 *
 * Pending invitations are named only when there are any: "0 pending" is noise
 * on a list whose job is to show what needs attention.
 */
export function orgSummaryLine(org: OrgSummary): string {
  const parts = [
    `${org.memberCount} member${org.memberCount === 1 ? "" : "s"}`,
    `${org.workspaceCount} workspace${org.workspaceCount === 1 ? "" : "s"}`,
  ];
  if (org.pendingInviteCount > 0) {
    parts.push(`${org.pendingInviteCount} pending invitation${org.pendingInviteCount === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Audit events
// ---------------------------------------------------------------------------
//
// GET /v1/orgs/:id/audit-events?take=&cursor=&eventType=
// ORG_AUDITOR and above. This is the organization's own record of what was
// done to it, and it is the surface a governance tenant exists for.

export function buildOrgAuditPath(
  orgId: string,
  options: { take?: number; cursor?: string | null } = {},
): string {
  const p = new URLSearchParams({ take: String(options.take ?? 50) });
  if (options.cursor) p.set("cursor", options.cursor);
  return `/v1/orgs/${encodeURIComponent(orgId)}/audit-events?${p.toString()}`;
}

export interface OrgAuditEvent {
  id: string;
  eventType: string;
  /** Who did it, as a person rather than an id, when the server named them. */
  actorLabel: string | null;
  targetType: string | null;
  targetId: string | null;
  occurredAtIso: string | null;
}

export interface OrgAuditPage {
  events: OrgAuditEvent[];
  nextCursor: string | null;
  totalEvents: number | null;
}

export function parseOrgAuditPage(payload: unknown): OrgAuditPage {
  const d = obj(payload);
  const summary = obj(d.summary);
  return {
    events: rows(d.events)
      .map((raw) => {
        const e = obj(raw);
        const id = str(e.id);
        if (!id) return null;
        return {
          id,
          eventType: str(e.eventType) ?? "unknown",
          // An actor id alone tells a reader nothing. When the server resolved
          // a name or an email it is used; when it did not, the field is null
          // and the surface says "system" rather than printing a raw uuid as
          // if it were a person.
          actorLabel: str(e.actorDisplayName) ?? str(e.actorEmail),
          targetType: str(e.targetType),
          targetId: str(e.targetId),
          occurredAtIso: str(e.createdAt),
        };
      })
      .filter((e): e is OrgAuditEvent => e !== null),
    nextCursor: str(summary.nextCursor) ?? str(d.nextCursor),
    totalEvents: num(summary.totalEvents),
  };
}

/** An event type as a sentence, without inventing detail the record lacks. */
export function auditEventLabel(eventType: string): string {
  const s = eventType.replace(/[._]/g, " ").trim();
  return s.length === 0 ? "Event" : s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Lifecycle: leaving, ownership transfer, closure
// ---------------------------------------------------------------------------
//
// These were previously absent from Native with the note that "a phone-sized
// version of a one-way door is not a smaller feature but a worse one". That is
// a claim about the affordance, and the product does not support it: the web
// builds real confirmation around each of these, Native has the same
// confirmation primitive, and the actual safety in all three lives on the
// SERVER — the owner check, the typed phrase, the cooling-off period and the
// step-up proof are enforced there and cannot be weakened by the client.
//
// What the client must not do is state any of that safety itself. Every figure
// below — the phrase, the cooling-off days, the blockers — is read from the
// endpoint. A client that believed in its own phrase and the route rejected it
// would make closure impossible with no explanation the user could act on.

export function buildOrgLeavePath(orgId: string): string {
  return `/v1/orgs/${encodeURIComponent(orgId)}/leave`;
}

export function buildOrgTransferPath(orgId: string): string {
  return `/v1/orgs/${encodeURIComponent(orgId)}/transfer-ownership`;
}

export function buildOrgClosurePath(orgId: string): string {
  return `/v1/orgs/${encodeURIComponent(orgId)}/closure`;
}

export function buildOrgClosureCancelPath(orgId: string, requestId: string): string {
  return `${buildOrgClosurePath(orgId)}/${encodeURIComponent(requestId)}/cancel`;
}

// The closure contract is IDENTICAL for an organization and a workspace —
// same fields, same owner-only gate, same server-validated phrase, same
// cooling-off period — so it lives ONCE, in `./closure`, and neither this
// module nor `workspace-people` re-exports it. Two copies of a projection
// that decides whether a destructive action is OFFERED is exactly the code
// that drifts, and a re-export is how a copy starts.
//
// A surface that closes something imports `./closure` directly.

export function transferTargets(members: OrgMember[]): OrgMember[] {
  return members.filter(
    (m) =>
      m.role.toUpperCase() !== "ORG_OWNER" &&
      m.status.toUpperCase() === "ACTIVE" &&
      m.userId !== null,
  );
}

/**
 * The refusals these three routes raise, said in the words of what happened.
 *
 * `owner_required` and `target_not_member` are not generic failures: one means
 * the caller is no longer the owner, the other that the person they chose has
 * left. A single "could not transfer ownership" hides both.
 */
export function orgLifecycleFailureMessage(err: unknown, fallback: string): string | null {
  const e = obj(err);
  const code = str(obj(obj(e.body).error).code) ?? str(e.code);
  switch (code) {
    // POST /leave by the owner (organizations.routes.ts): the server's own sentence.
    case "OWNERSHIP_TRANSFER_REQUIRED":
      return (
        str(obj(obj(e.body).error).message) ??
        "You are the organization owner. Transfer ownership or close the organization before leaving."
      );
    case "owner_required":
      return "Only the organization owner can do this.";
    case "target_not_member":
      return "That person is no longer a member of this organization.";
    case "transfer_to_self":
      return "You already own this organization.";
    case "closure_blocked":
      return "Closure is blocked. Resolve the listed items and try again.";
    case "confirmation_mismatch":
      return "The confirmation phrase does not match.";
    case "closure_request_active":
      return "A closure request for this organization is already open.";
    default:
      return fallback;
  }
}


const PLAN_LABEL: Readonly<Record<string, string>> = { FREE: "Free", PAYG: "Pay as you go", PRO: "Pro", TEAM: "Team", ENTERPRISE: "Enterprise" };
/** identityOrgLabels.planLabel. */
export function orgPlanLabel(plan: string): string {
  return PLAN_LABEL[plan] ?? plan;
}
const BILLING_STATUS_LABEL: Readonly<Record<string, string>> = { INACTIVE: "Inactive", ACTIVE: "Active", PAST_DUE: "Payment failed", CANCELED: "Cancelled" };
/** identityOrgLabels.workspaceBillingStatusLabel. */
export function orgWorkspaceBillingStatusLabel(status: string): string {
  return BILLING_STATUS_LABEL[status] ?? status;
}

// ---------------------------------------------------------------------------
// T-14 — organization Settings (web organizations/[id]/page.tsx, PATCH /v1/orgs/:id)
// ---------------------------------------------------------------------------

const ORG_ROLE_RANK: Readonly<Record<string, number>> = {
  ORG_OWNER: 5,
  ORG_ADMIN: 4,
  ORG_SECURITY_ADMIN: 3,
  ORG_BILLING_ADMIN: 3,
  ORG_AUDITOR: 2,
  ORG_MEMBER: 1,
};
/** ORG_ADMIN+ may change the identity metadata; the route enforces the same minRole. */
export function canEditOrgSettings(org: OrgDetail): boolean {
  return (ORG_ROLE_RANK[(org.callerRole ?? "").toUpperCase()] ?? 0) >= ORG_ROLE_RANK.ORG_ADMIN;
}

export interface OrgSettingsDraft {
  name: string;
  legalName: string;
  legalEmail: string;
  address: string;
  timezone: string;
  logoUrl: string;
}
export function orgSettingsDraft(org: OrgDetail): OrgSettingsDraft {
  return {
    name: org.name ?? "",
    legalName: org.legalName ?? "",
    legalEmail: org.legalEmail ?? "",
    address: org.address ?? "",
    timezone: org.timezone ?? "",
    logoUrl: org.logoUrl ?? "",
  };
}
/** The web's body: name trimmed, every optional field null when blank. */
export function buildOrgSettingsBody(d: OrgSettingsDraft) {
  const orNull = (v: string) => (v.trim() === "" ? null : v.trim());
  return {
    name: d.name.trim(),
    legalName: orNull(d.legalName),
    legalEmail: orNull(d.legalEmail),
    address: orNull(d.address),
    timezone: orNull(d.timezone),
    logoUrl: orNull(d.logoUrl),
  };
}
export const ORG_SETTINGS_COPY = {
  title: "Settings",
  subtitle: "Identity metadata. ORG_ADMIN+ required.",
  forbidden: "You don’t have permission to change settings. Ask an organization admin.",
  nameRequired: "Name is required.",
  failed: "Failed to save settings.",
  save: "Save settings",
  saving: "Saving…",
} as const;

// ---------------------------------------------------------------------------
// T-14 — organization workspace suspend / resume (web OrgWorkspaceLifecycleControls)
//   POST /v1/orgs/:id/workspaces/:teamId/{suspend|resume}, body {}
//   200 { suspend: { membersSuspended } } | { resume: { membersReactivated } }
//   403 admin_required · 404 not bound · 409 not an organization workspace
// ---------------------------------------------------------------------------

export type OrgWorkspaceAction = "suspend" | "resume";

export function buildOrgWorkspaceLifecyclePath(orgId: string, workspaceId: string, action: OrgWorkspaceAction): string {
  return `/v1/orgs/${encodeURIComponent(orgId)}/workspaces/${encodeURIComponent(workspaceId)}/${action}`;
}

/** The denial bodies carry no message, so the STATUS is the signal — the web's copy per status. */
export function orgWorkspaceLifecycleDenial(status: number | null, action: OrgWorkspaceAction, fallback: string | null): string {
  if (status === 403) return "You don't have permission to change this workspace. Organization admins and owners can suspend and resume workspaces.";
  if (status === 404) return "This workspace is no longer bound to this organization. The list has been reloaded.";
  if (status === 409) return "Only organization workspaces can be suspended here. Personal spaces and individually owned workspaces are governed by their owner.";
  return fallback ?? (action === "suspend" ? "Could not suspend this workspace. Nothing was changed." : "Could not resume this workspace. Nothing was changed.");
}

export function orgWorkspaceLifecycleNotice(action: OrgWorkspaceAction, workspaceName: string, payload: unknown): string {
  if (action === "suspend") {
    const n = obj(obj(payload).suspend).membersSuspended;
    const c = typeof n === "number" ? n : 0;
    return `${workspaceName} is suspended. ${c} member${c === 1 ? "" : "s"} lost access and webhook delivery is paused. Evidence and audit history are untouched.`;
  }
  const n = obj(obj(payload).resume).membersReactivated;
  const c = typeof n === "number" ? n : 0;
  return `${workspaceName} is active again. ${c} member${c === 1 ? "" : "s"} regained access; webhooks stay disabled until you re-enable them.`;
}

export const ORG_SUSPEND_CONSEQUENCE = (name: string) =>
  `Suspend ${name}? Every active member loses access, anyone working in it is returned to their personal space, and webhook delivery pauses. Evidence, cases and audit history are not deleted, and Resume brings the members back.`;

// ---------------------------------------------------------------------------
// Detail overview (web organizations/[id]/page.tsx — the four overview tiles,
// the members summary and the lifecycle card copy)
// ---------------------------------------------------------------------------

const ORG_ROLE_ORDER = ["ORG_OWNER", "ORG_ADMIN", "ORG_SECURITY_ADMIN", "ORG_BILLING_ADMIN", "ORG_AUDITOR", "ORG_MEMBER"] as const;

/** The web's `roleTallyShort`: "1 Owner · 2 Member", roles in rank order, zero counts omitted. */
export function orgRoleTally(members: ReadonlyArray<{ role: string }>): string {
  const counts = new Map<string, number>();
  for (const m of members) counts.set(m.role.toUpperCase(), (counts.get(m.role.toUpperCase()) ?? 0) + 1);
  const parts = ORG_ROLE_ORDER.filter((r) => (counts.get(r) ?? 0) > 0).map((r) => `${counts.get(r)} ${orgRoleLabel(r)}`);
  return parts.length === 0 ? "—" : parts.join(" · ");
}

/**
 * `callerCanSeeBilling` from GET /v1/orgs/:id/workspaces
 * (organizations.routes.ts: true for ORG_OWNER / ORG_ADMIN / ORG_BILLING_ADMIN).
 * The per-row `billing` object is present only when it is true.
 */
export function parseOrgWorkspacesCanSeeBilling(payload: unknown): boolean {
  return obj(payload).callerCanSeeBilling === true;
}

/** `summary.totalPending` from GET /v1/orgs/:id/invites (ORG_ADMIN+). */
export function parseOrgPendingInviteTotal(payload: unknown): number | null {
  return num(obj(obj(payload).summary).totalPending);
}

/** The web's `billingTileSummary`: the dominant plan, or "Mixed plans", plus the over-seat count. */
export function orgBillingTileSummary(workspaces: ReadonlyArray<OrgWorkspace>): string {
  const plans = new Map<string, number>();
  let over = 0;
  for (const w of workspaces) {
    if (!w.billing) continue;
    plans.set(w.billing.plan, (plans.get(w.billing.plan) ?? 0) + 1);
    if (w.billing.overSeatLimit) over += 1;
  }
  if (plans.size === 0) return "—";
  const suffix = over > 0 ? ` · ${over} over seat limit` : "";
  if (plans.size === 1) {
    const [plan, count] = [...plans.entries()][0] as [string, number];
    return `${count}× ${plan}${suffix}`;
  }
  return `Mixed plans${suffix}`;
}

/**
 * The audit event count. `summary.totalEvents` is the length of the page the
 * route returned (organizations.routes.ts: `totalEvents: trimmedEvents.length`),
 * not the organization's total, so a page with a next cursor is "N+" rather
 * than a total the server never computed.
 */
export function orgAuditCountLabel(count: number, hasMore: boolean): string {
  return `${count}${hasMore ? "+" : ""} event${count === 1 && !hasMore ? "" : "s"}`;
}

const ORG_CLOSURE_STATUS_LABEL: Readonly<Record<string, string>> = {
  BLOCKED: "Blocked — action needed",
  COOLING_OFF: "Scheduled — cancellation window open",
  SCHEDULED: "Scheduled",
  PROCESSING: "Closing…",
  COMPLETED: "Closed",
  CANCELLED: "Cancelled",
  FAILED: "Failed",
};
/** The web's ORG_CLOSURE_STATUS_LABEL, falling back to the status as words. */
export function orgClosureStatusLabel(status: string): string {
  return ORG_CLOSURE_STATUS_LABEL[status] ?? auditEventLabel(status.toLowerCase());
}

export const ORG_DETAIL_COPY = {
  eyebrow: "Organization · Governance",
  subtitle:
    "Governance and identity tenant — members, roles, invites, audit timeline, and legal metadata. Workspace evidence access is managed separately.",
  allOrgs: "← All organizations",
  workspaceAdmin: "Workspace admin →",
  leave: "Leave organization",
  leaveConsequence:
    "You will immediately lose access to this organization and its workspaces. Your past activity remains attributed to you in the organization's audit records. An owner or admin must re-invite you to return.",
  leaveOwnerRequired:
    "You are the organization owner. Transfer ownership or close the organization before leaving.",
  leaveFailed: "Could not leave the organization. Please try again.",
  membersTitle: "Members & invites",
  membersSubtitle:
    "Managing members, roles, and pending invites moved to the Admin console — one canonical surface for member governance.",
  workspacesSubtitle:
    "Operational evidence, cases, and reviewer queues live inside each workspace. Org-level membership does not grant workspace access — that is workspace-scoped.",
  workspacesEmptyTitle: "No workspaces bound to this organization.",
  workspacesEmptyPurpose:
    "Workspaces hold this organization’s evidence, cases, and reviewer queues. Bind one in Workspace administration to start capturing.",
  openWorkspaceAdmin: "Open Workspace administration →",
  auditSubtitle:
    "Organization governance events, newest first. Requires ORG_AUDITOR or higher.",
  auditorOnly: "Requires ORG_AUDITOR or higher.",
  lifecycleTitle: "Organization lifecycle",
  lifecycleSubtitle:
    "Owner-only, verified lifecycle actions. Non-owner members leave from the page header; owners must transfer ownership (or close the organization) first.",
  ownerOnlyNote:
    "Ownership transfer and organization closure are available to the organization owner only. To leave this organization, use Leave organization in the page header.",
  transferLead: "The new owner must already be a member. You become an admin; the organization is never left without an owner.",
  transferNoTargets: "No other members yet — invite a member before transferring ownership.",
  closureLead: (days: number) =>
    `Archives the organization after a ${days}-day cancellation window. Workspace access and machine credentials are revoked; evidence is never deleted by closure — it stays governed by retention and legal-hold rules.`,
  keep: "Keep the organization",
} as const;

/** The web list page's copy (organizations/page.tsx). */
export const ORG_LIST_COPY = {
  eyebrow: "Account · Organizations",
  subtitle:
    "Organizations are the governance + billing tenant. Members, invites, and audit live here. Operational work — evidence, cases, reviewer queues — continues to live inside each workspace.",
  loadFailed: "Couldn’t load organizations.",
  emptyTitle: "You’re not a member of any organization yet.",
  // The web's first bullet ("Create an organization to become its ORG_OWNER")
  // describes the self-service creation that page's own header retired; the
  // provisioning truth is said instead.
  emptyBullets: [
    "Enterprise organizations are provisioned as part of a PROOVRA Enterprise agreement.",
    "Accept an invite token if an organization administrator shared one with you.",
    "For workspace-level operations (evidence, cases, reviewers), open Workspace administration.",
  ],
  footer:
    "Looking for evidence, cases, reviewer queues, or per-workspace billing? Those are workspace-scoped. Open the relevant workspace from Workspace administration.",
} as const;
