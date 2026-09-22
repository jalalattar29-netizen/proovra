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
}

export function parseOrgDetail(payload: unknown): OrgDetail | null {
  const d = obj(obj(payload).organization ?? payload);
  const id = str(d.id);
  if (!id) return null;
  return {
    id,
    name: str(d.name),
    legalName: str(d.legalName),
    legalEmail: str(d.legalEmail),
    status: str(d.status),
    verificationState: str(d.verificationState),
    verifiedAtIso: str(d.verifiedAtUtc) ?? str(d.verifiedAt),
    timezone: str(d.timezone),
    createdAtIso: str(d.createdAt),
    // On the envelope, beside `organization`, not inside it.
    callerRole: str(obj(payload).callerRole) ?? str(d.callerRole),
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
      const id = str(m.id) ?? str(m.userId);
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
}

export function parseOrgWorkspaces(payload: unknown): OrgWorkspace[] {
  return rows(obj(payload).workspaces ?? obj(payload).teams ?? payload)
    .map((raw) => {
      const w = obj(raw);
      const id = str(w.id);
      if (!id) return null;
      return {
        id,
        name: str(w.name) ?? "Unnamed workspace",
        memberCount: num(w.memberCount),
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

