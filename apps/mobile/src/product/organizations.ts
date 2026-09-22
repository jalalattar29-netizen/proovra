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
  };
}

export interface OrgMember {
  id: string;
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
