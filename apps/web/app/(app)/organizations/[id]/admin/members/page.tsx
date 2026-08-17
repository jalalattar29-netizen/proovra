"use client";
import { toSafeUserError } from "../../../../../../lib/feedback/toSafeUserError";

/**
 * Phase 8 — Org admin / Members tab.
 *
 * Read + mutate organization members and pending invites via the
 * canonical Phase A.1B REST endpoints:
 *
 *   - GET    /v1/orgs/:id/members
 *   - PATCH  /v1/orgs/:id/members/:membershipId   (ORG_ADMIN+)
 *   - DELETE /v1/orgs/:id/members/:membershipId   (ORG_ADMIN+)
 *   - POST   /v1/orgs/:id/members/:memberId/suspend  (ORG_ADMIN+, Phase 13)
 *   - POST   /v1/orgs/:id/members/:memberId/restore  (ORG_ADMIN+, Phase 13)
 *   - GET    /v1/orgs/:id/invites
 *   - POST   /v1/orgs/:id/invites                 (ORG_ADMIN+)
 *   - POST   /v1/orgs/:id/invites/:inviteId/resend
 *   - DELETE /v1/orgs/:id/invites/:inviteId
 *
 * Constitutional checks satisfied:
 *
 *   - Wrapped in <PageRouteGate routeId="account.organization-detail">.
 *   - Uses useConfirmAction (NO raw window.confirm) for destructive
 *     remove + revoke flows.
 *   - No platform-context workspace-fragment reads — apiFetch only.
 *   - Strong TypeScript types throughout.
 *   - Members manageable via canonical org endpoints (success criterion
 *     #2). API enforces role permissions; UI surfaces 403 honestly.
 *
 * Phase 7 (Enterprise UX): presentation migrated to the shared design
 * system (Card / Badge / Button). This tab renders INSIDE the org admin
 * layout shell (which owns the org title + tab bar), so it uses Card
 * groupings — not a second PageHeader — to avoid a duplicate <h1>. All
 * data reads/mutations, gating, confirm flows and testids are unchanged.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { PageRouteGate } from "../../../../../../components/navigation/PageRouteGate";
import { useConfirmAction } from "../../../../../../components/ui/ConfirmActionModal";
import { OrgMemberLifecycleControls } from "../../../../../../components/organizations/OrgMemberLifecycleControls";
import { apiFetch, ApiError } from "../../../../../../lib/api";
import { usePlatformContext } from "../../../../../../lib/platform-context";
import { formatUserDate, formatUserDateTime } from "../../../../../../lib/date";
import { SeatsCard } from "../_lib/SeatsCard";
import { Card } from "../../../../../../components/ui/Card";
import { Badge } from "../../../../../../components/ui/Badge";
import { Button } from "../../../../../../components/ui/Button";
import {
  ALL_ORG_ROLES as ALL_ROLES,
  ORG_ROLE_LABEL as ROLE_LABEL,
  canManageMembers,
  type OrgRole,
} from "../_lib/orgRoles";

interface OrgResponse {
  organizationId: string;
  name: string;
  callerRole: OrgRole;
}

/**
 * PHASE 13 §1 — NEW-031. The lifecycle fields are part of the roster contract
 * now. Before they were projected, this surface could not tell an ACTIVE member
 * from a SUSPENDED one, so both lifecycle buttons were offered on every row and
 * the server's 409 was the only way to find out which one applied.
 */
type OrgMembershipStatus = "ACTIVE" | "SUSPENDED" | "REVOKED";

interface MemberRow {
  membershipId: string;
  userId: string;
  email: string | null;
  displayName: string | null;
  role: OrgRole;
  memberSince: string;
  status: OrgMembershipStatus;
  statusChangedAtUtc: string | null;
  suspendedAtUtc: string | null;
  suspensionReason: string | null;
  revokedAtUtc: string | null;
  revocationReason: string | null;
}

const MEMBER_STATUS_LABEL: Record<OrgMembershipStatus, string> = {
  ACTIVE: "Active",
  SUSPENDED: "Suspended",
  REVOKED: "Revoked",
};

interface MembersResponse {
  organizationId: string;
  summary: { totalMembers: number };
  members: MemberRow[];
}

interface InviteRow {
  inviteId: string;
  email: string;
  role: OrgRole;
  invitedByUserId: string;
  expiresAt: string;
  lastResentAt: string | null;
  resendCount: number;
  createdAt: string;
  /** Macro-Wave A2 — durable email-delivery state for this invite.
   *  Safe projection only (never a token or accept URL). */
  delivery: {
    deliveryId: string;
    status: "PENDING" | "SENT" | "FAILED" | "CANCELLED";
    attempts: number;
    lastError: string | null;
  } | null;
}

/** Plain-language label + tone for the invite email-delivery state. */
const DELIVERY_LABEL: Record<
  NonNullable<InviteRow["delivery"]>["status"],
  { label: string; color: string }
> = {
  PENDING: { label: "Email queued", color: "var(--ink-muted, #94a3b8)" },
  SENT: { label: "Email sent", color: "var(--status-ok-fg, #166534)" },
  FAILED: { label: "Email failed", color: "var(--status-risk-fg, #991b1b)" },
  CANCELLED: { label: "Email cancelled", color: "var(--ink-muted, #94a3b8)" },
};

interface InvitesResponse {
  organizationId: string;
  summary: { totalPending: number };
  invites: InviteRow[];
}

type Loadable<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "error"; message: string; status: number; requestId?: string };

// ---------------------------------------------------------------------------
// Shared presentational tokens.
// ---------------------------------------------------------------------------

const subtleText = {
  fontSize: 12.5,
  color: "var(--ink-muted, #94a3b8)",
} as const;

const listRow = {
  padding: "10px 0",
  borderBottom: "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
  display: "flex",
  alignItems: "center",
  gap: 12,
  flexWrap: "wrap" as const,
};

const fieldInput = {
  display: "block",
  marginTop: 4,
  width: "100%",
  minHeight: 40,
  padding: "0 12px",
  fontSize: 13.5,
  color: "var(--ink-primary, #0f172a)",
  background: "var(--surface-card, #ffffff)",
  border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
  borderRadius: "var(--radius-md, 8px)",
  outline: "none",
} as const;

const errorBox = {
  marginTop: 8,
  padding: "8px 12px",
  border: "1px solid var(--status-risk-border, #fecaca)",
  background: "var(--status-risk-bg, #fef2f2)",
  color: "var(--status-risk-fg, #991b1b)",
  borderRadius: 8,
  fontSize: 13,
} as const;

export default function OrganizationAdminMembersPage() {
  return (
    <PageRouteGate routeId="account.organization-detail">
      <MembersTab />
    </PageRouteGate>
  );
}

function MembersTab() {
  const params = useParams<{ id: string }>();
  const orgId = params?.id ?? "";
  const { confirm } = useConfirmAction();
  // The suspend/restore routes refuse self-action with a 409; the canonical
  // envelope is the only identity source used here (no parallel /me fetch).
  const currentUserId = usePlatformContext().envelope?.user?.id ?? "";

  const [org, setOrg] = useState<Loadable<OrgResponse>>({ kind: "loading" });
  const [members, setMembers] = useState<Loadable<MembersResponse>>({
    kind: "loading",
  });
  const [invites, setInvites] = useState<Loadable<InvitesResponse>>({
    kind: "loading",
  });

  const [memberBusy, setMemberBusy] = useState<Record<string, boolean>>({});
  const [memberError, setMemberError] = useState<Record<string, string>>({});
  const [inviteBusy, setInviteBusy] = useState<Record<string, boolean>>({});
  const [inviteError, setInviteError] = useState<Record<string, string>>({});

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<OrgRole>("ORG_MEMBER");
  const [inviteFormBusy, setInviteFormBusy] = useState(false);
  const [inviteFormError, setInviteFormError] = useState<string | null>(null);
  const [issuedInviteToken, setIssuedInviteToken] = useState<string | null>(null);

  const fetchOne = useCallback(async function fetchOne<T>(
    path: string,
  ): Promise<Loadable<T>> {
    try {
      const data = (await apiFetch(path)) as T;
      return { kind: "ready", data };
    } catch (err) {
      if (err instanceof ApiError) {
        // Sanitize the rendered message (no raw backend passthrough); keep
        // status for the 403 branch and requestId for support reference.
        return {
          kind: "error",
          message: toSafeUserError(err, { message: "Failed to load." }).message,
          status: err.statusCode ?? 0,
          requestId: err.requestId,
        };
      }
      const message = toSafeUserError(err, { message: "Failed to load." }).message;
      return { kind: "error", message, status: 0 };
    }
  }, []);

  /**
   * PHASE 13 (NEW-064) — REVALIDATE WITHOUT UNMOUNTING WHAT ALREADY RENDERED.
   *
   * Identical defect and identical fix to `organizations/[id]/page.tsx`. The
   * roster renders only while `members.kind === "ready"`, and `refresh` is the
   * `onChanged` callback `OrgMemberLifecycleControls` calls after a SUCCESSFUL
   * suspend / restore / revoke — a control that announces the outcome from its
   * own `role="status"` region inside the row it just changed.
   *
   * Resetting to `loading` therefore tore that region down before a screen
   * reader could read it: the roster round-trip left the user with a silently
   * changed membership. Keeping the previous `ready` data while revalidating
   * preserves the announcement (and stops the roster flashing a skeleton on
   * every transition). A section that has never loaded still shows its loading
   * state.
   */
  const revalidate = useCallback(
    <T,>(prev: Loadable<T>): Loadable<T> =>
      prev.kind === "ready" ? prev : { kind: "loading" },
    [],
  );

  const refresh = useCallback(async () => {
    if (!orgId) return;
    setOrg(revalidate);
    setMembers(revalidate);
    setInvites(revalidate);
    const [o, m, i] = await Promise.all([
      fetchOne<OrgResponse>(`/v1/orgs/${orgId}`),
      fetchOne<MembersResponse>(`/v1/orgs/${orgId}/members`),
      fetchOne<InvitesResponse>(`/v1/orgs/${orgId}/invites`),
    ]);
    setOrg(o);
    setMembers(m);
    setInvites(i);
  }, [orgId, fetchOne, revalidate]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const callerRole = org.kind === "ready" ? org.data.callerRole : null;
  const canMutate = callerRole !== null && canManageMembers(callerRole);

  const sendInvite = useCallback(async () => {
    const email = inviteEmail.trim();
    if (!email) {
      setInviteFormError("Email is required.");
      return;
    }
    setInviteFormBusy(true);
    setInviteFormError(null);
    setIssuedInviteToken(null);
    try {
      const data = (await apiFetch(`/v1/orgs/${orgId}/invites`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, role: inviteRole }),
      })) as { token: string };
      setIssuedInviteToken(data.token);
      setInviteEmail("");
      await refresh();
    } catch (err) {
      setInviteFormError(
        toSafeUserError(err, { message: "Failed to send invite." }).message,
      );
    } finally {
      setInviteFormBusy(false);
    }
  }, [inviteEmail, inviteRole, orgId, refresh]);

  const changeRole = useCallback(
    async (m: MemberRow, newRole: OrgRole) => {
      if (m.role === newRole) return;
      setMemberBusy((s) => ({ ...s, [m.membershipId]: true }));
      setMemberError((s) => ({ ...s, [m.membershipId]: "" }));
      try {
        await apiFetch(`/v1/orgs/${orgId}/members/${m.membershipId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: newRole }),
        });
        await refresh();
      } catch (err) {
        const message = toSafeUserError(err, {
          message: "Failed to change role.",
        }).message;
        setMemberError((s) => ({ ...s, [m.membershipId]: message }));
      } finally {
        setMemberBusy((s) => ({ ...s, [m.membershipId]: false }));
      }
    },
    [orgId, refresh],
  );

  const removeMember = useCallback(
    async (m: MemberRow) => {
      const ok = await confirm({
        title: "Remove organization member?",
        description: (
          <span>
            <strong>{m.displayName ?? m.email ?? "this member"}</strong>{" "}
            will be removed from the organization. Their workspace-level
            access remains workspace-scoped and is not affected by this
            change.
          </span>
        ),
        confirmLabel: "Remove member",
        cancelLabel: "Keep",
        tone: "danger",
        testId: `confirm-remove-member-${m.membershipId}`,
      });
      if (!ok) return;
      setMemberBusy((s) => ({ ...s, [m.membershipId]: true }));
      setMemberError((s) => ({ ...s, [m.membershipId]: "" }));
      try {
        await apiFetch(`/v1/orgs/${orgId}/members/${m.membershipId}`, {
          method: "DELETE",
        });
        await refresh();
      } catch (err) {
        const message = toSafeUserError(err, {
          message: "Failed to remove member.",
        }).message;
        setMemberError((s) => ({ ...s, [m.membershipId]: message }));
      } finally {
        setMemberBusy((s) => ({ ...s, [m.membershipId]: false }));
      }
    },
    [orgId, refresh, confirm],
  );

  const resendInvite = useCallback(
    async (i: InviteRow) => {
      setInviteBusy((s) => ({ ...s, [i.inviteId]: true }));
      setInviteError((s) => ({ ...s, [i.inviteId]: "" }));
      try {
        await apiFetch(`/v1/orgs/${orgId}/invites/${i.inviteId}/resend`, {
          method: "POST",
        });
        await refresh();
      } catch (err) {
        const message = toSafeUserError(err, {
          message: "Failed to resend invite.",
        }).message;
        setInviteError((s) => ({ ...s, [i.inviteId]: message }));
      } finally {
        setInviteBusy((s) => ({ ...s, [i.inviteId]: false }));
      }
    },
    [orgId, refresh],
  );

  const revokeInvite = useCallback(
    async (i: InviteRow) => {
      const ok = await confirm({
        title: "Revoke pending invite?",
        description: (
          <span>
            The invite for <strong>{i.email}</strong> will be immediately
            revoked. The invite token will stop being accepted.
          </span>
        ),
        confirmLabel: "Revoke invite",
        cancelLabel: "Keep invite",
        tone: "warning",
        testId: `confirm-revoke-invite-${i.inviteId}`,
      });
      if (!ok) return;
      setInviteBusy((s) => ({ ...s, [i.inviteId]: true }));
      setInviteError((s) => ({ ...s, [i.inviteId]: "" }));
      try {
        await apiFetch(`/v1/orgs/${orgId}/invites/${i.inviteId}`, {
          method: "DELETE",
        });
        await refresh();
      } catch (err) {
        const message = toSafeUserError(err, {
          message: "Failed to revoke invite.",
        }).message;
        setInviteError((s) => ({ ...s, [i.inviteId]: message }));
      } finally {
        setInviteBusy((s) => ({ ...s, [i.inviteId]: false }));
      }
    },
    [orgId, refresh, confirm],
  );

  return (
    <section
      data-testid="org-admin-members"
      data-org-id={orgId}
      style={{ display: "flex", flexDirection: "column", gap: 16 }}
    >
      {/* ------------------- ACCESS SUMMARY + ROLES LINK ------------------- */}
      <Card
        variant="admin"
        padding="compact"
        data-section="members-access-summary"
        data-testid="members-access-summary"
        style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 12 }}
      >
        <div style={{ fontSize: 13, color: "var(--ink-secondary, #475569)", flex: "1 1 auto", minWidth: 0 }}>
          {org.kind === "ready" ? (
            <>
              Your access:{" "}
              <strong data-testid="members-caller-role">
                {ROLE_LABEL[org.data.callerRole]}
              </strong>
              {" — "}
              {canMutate
                ? "you can invite members and change org roles."
                : "read-only. Ask an organization admin to make changes."}
            </>
          ) : (
            "Org-level governance roles. Workspace access is workspace-scoped."
          )}
        </div>
        <Link
          href={`/organizations/${orgId}/admin/roles`}
          data-testid="members-roles-reference-link"
          style={{ textDecoration: "none", flexShrink: 0 }}
        >
          <Button variant="secondary" size="sm">
            Roles &amp; permissions reference →
          </Button>
        </Link>
      </Card>

      {/* ------------------- SEATS ------------------- */}
      <SeatsCard orgId={orgId} />

      {/* ------------------- INVITE FORM ------------------- */}
      <Card
        variant="summary"
        data-section="invite-form"
        title="Invite a member"
        subtitle="ORG_ADMIN+ only. The invitee accepts via the returned token URL."
      >
        {!canMutate ? (
          <p data-state="forbidden" style={{ fontSize: 13, color: "var(--ink-secondary, #475569)", margin: 0 }}>
            You don't have permission to issue invites. Ask an organization
            admin.
          </p>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void sendInvite();
            }}
            style={{
              display: "grid",
              gap: 10,
              gridTemplateColumns: "1fr 200px 150px",
              alignItems: "end",
            }}
          >
            <label style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-secondary, #475569)" }}>
              Email
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                disabled={inviteFormBusy}
                required
                data-testid="invite-email-input"
                style={fieldInput}
              />
            </label>
            <label style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-secondary, #475569)" }}>
              Role
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as OrgRole)}
                disabled={inviteFormBusy}
                data-testid="invite-role-select"
                style={{ ...fieldInput, cursor: "pointer" }}
              >
                {ALL_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            </label>
            <Button
              type="submit"
              variant="primary"
              disabled={inviteFormBusy || !inviteEmail.trim()}
              loading={inviteFormBusy}
              data-testid="invite-submit"
            >
              {inviteFormBusy ? "Sending…" : "Send invite"}
            </Button>
          </form>
        )}
        {inviteFormError ? (
          <div role="alert" data-state="error" style={errorBox}>
            {inviteFormError}
          </div>
        ) : null}
        {issuedInviteToken ? (
          <div
            data-state="invite-token-issued"
            data-testid="invite-token-issued"
            style={{
              marginTop: 10,
              padding: "10px 12px",
              border: "1px dashed var(--border-strong, rgba(15,23,42,0.14))",
              borderRadius: 8,
              fontSize: 12,
              wordBreak: "break-all",
              color: "var(--ink-secondary, #475569)",
            }}
          >
            <strong>Invite token URL</strong> — share with the invitee:{" "}
            <code>/org-invites/{issuedInviteToken}/accept</code>
          </div>
        ) : null}
      </Card>

      {/* ------------------- MEMBERS LIST ------------------- */}
      <Card
        variant="summary"
        data-section="members-list"
        title="Members"
        subtitle="Org-level governance roles. Workspace-level access is workspace-scoped. SSO / SCIM source, MFA state, and last-login are managed per-workspace in Identity and are not exposed on the org member list."
      >
        {members.kind === "loading" ? (
          <div data-state="loading" style={subtleText}>
            Loading…
          </div>
        ) : members.kind === "error" ? (
          <div data-state="error" role="alert" style={{ fontSize: 13, color: "var(--ink-secondary, #475569)" }}>
            {members.status === 403
              ? "You don't have access to the member list."
              : members.message}
          </div>
        ) : (
          <ul
            data-testid="members-list"
            data-total-members={members.data.summary.totalMembers}
            style={{ listStyle: "none", padding: 0, margin: 0 }}
          >
            {members.data.members.length === 0 ? (
              <li style={{ padding: "8px 0", ...subtleText }}>
                No members yet.
              </li>
            ) : null}
            {members.data.members.map((m) => {
              const busy = !!memberBusy[m.membershipId];
              const err = memberError[m.membershipId];
              return (
                <li
                  key={m.membershipId}
                  data-membership-id={m.membershipId}
                  data-member-role={m.role}
                  style={listRow}
                >
                  <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                    <div style={{ fontWeight: 600 }}>
                      {m.displayName ?? m.email ?? "(unnamed user)"}
                    </div>
                    {m.email ? (
                      <div style={subtleText}>{m.email}</div>
                    ) : null}
                    {err ? (
                      <div role="alert" style={{ marginTop: 4, fontSize: 12, color: "var(--status-risk-fg, #991b1b)" }}>
                        {err}
                      </div>
                    ) : null}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    {canMutate ? (
                      <select
                        data-testid={`member-role-select-${m.membershipId}`}
                        value={m.role}
                        disabled={busy}
                        onChange={(e) =>
                          void changeRole(m, e.target.value as OrgRole)
                        }
                        style={{
                          minHeight: 34,
                          padding: "0 10px",
                          fontSize: 12.5,
                          border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
                          borderRadius: 8,
                          background: "var(--surface-card, #ffffff)",
                          color: "var(--ink-primary, #0f172a)",
                          cursor: busy ? "not-allowed" : "pointer",
                        }}
                      >
                        {ALL_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Badge tone="neutral" subtle>
                        {ROLE_LABEL[m.role]}
                      </Badge>
                    )}
                    <span style={subtleText}>
                      since {formatUserDate(m.memberSince)}
                    </span>
                    {/* The membership's own lifecycle state, rendered as text
                        (never colour alone) so it is legible to a screen
                        reader and to anyone who cannot distinguish the hues. */}
                    <Badge
                      tone={
                        m.status === "ACTIVE"
                          ? "verified"
                          : m.status === "SUSPENDED"
                            ? "pending"
                            : "risk"
                      }
                      dot
                      data-testid={`member-status-${m.membershipId}`}
                      data-member-status={m.status}
                    >
                      {MEMBER_STATUS_LABEL[m.status]}
                    </Badge>
                    {canMutate ? (
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        data-testid={`member-remove-${m.membershipId}`}
                        disabled={busy}
                        onClick={() => void removeMember(m)}
                      >
                        Remove
                      </Button>
                    ) : null}
                    {/* Phase 13 — the reversible half: suspend / restore.
                        The row's real status decides which leg is offered. */}
                    <OrgMemberLifecycleControls
                      orgId={orgId}
                      membershipId={m.membershipId}
                      memberLabel={m.displayName ?? m.email ?? "this member"}
                      canManage={canMutate}
                      isSelf={m.userId === currentUserId}
                      status={m.status}
                      suspendedAtUtc={m.suspendedAtUtc}
                      suspensionReason={m.suspensionReason}
                      revokedAtUtc={m.revokedAtUtc}
                      revocationReason={m.revocationReason}
                      onChanged={refresh}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* ------------------- PENDING INVITES ------------------- */}
      <Card
        variant="summary"
        data-section="pending-invites"
        title="Pending invites"
        subtitle="Invites issued but not yet accepted, revoked, or expired."
      >
        {invites.kind === "loading" ? (
          <div style={subtleText}>Loading…</div>
        ) : invites.kind === "error" ? (
          <div data-state="error" role="alert" style={{ fontSize: 13, color: "var(--ink-secondary, #475569)" }}>
            {invites.status === 403
              ? "Admin access required to view pending invites."
              : invites.message}
          </div>
        ) : (
          <ul
            data-testid="invites-list"
            data-total-pending={invites.data.summary.totalPending}
            style={{ listStyle: "none", padding: 0, margin: 0 }}
          >
            {invites.data.invites.length === 0 ? (
              <li
                data-empty-state="no-pending-invites"
                style={{ padding: "8px 0", ...subtleText }}
              >
                No pending invites.
              </li>
            ) : null}
            {invites.data.invites.map((i) => {
              const busy = !!inviteBusy[i.inviteId];
              const err = inviteError[i.inviteId];
              return (
                <li
                  key={i.inviteId}
                  data-invite-id={i.inviteId}
                  data-invite-role={i.role}
                  style={listRow}
                >
                  <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                    <div style={{ fontWeight: 600 }}>{i.email}</div>
                    <div style={subtleText}>
                      {ROLE_LABEL[i.role]} · expires{" "}
                      {formatUserDateTime(i.expiresAt)}
                      {i.resendCount > 0 ? ` · resent ${i.resendCount}×` : ""}
                    </div>
                    {i.delivery ? (
                      <div
                        data-delivery-status={i.delivery.status}
                        style={{
                          marginTop: 2,
                          fontSize: 12,
                          color: DELIVERY_LABEL[i.delivery.status].color,
                        }}
                      >
                        {DELIVERY_LABEL[i.delivery.status].label}
                        {i.delivery.attempts > 1
                          ? ` · ${i.delivery.attempts} attempts`
                          : ""}
                        {i.delivery.status === "FAILED"
                          ? " — use Resend to retry with a fresh link"
                          : ""}
                      </div>
                    ) : null}
                    {err ? (
                      <div role="alert" style={{ marginTop: 4, fontSize: 12, color: "var(--status-risk-fg, #991b1b)" }}>
                        {err}
                      </div>
                    ) : null}
                  </div>
                  {canMutate ? (
                    <div style={{ display: "flex", gap: 8 }}>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        data-testid={`invite-resend-${i.inviteId}`}
                        disabled={busy}
                        onClick={() => void resendInvite(i)}
                      >
                        Resend
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        data-testid={`invite-revoke-${i.inviteId}`}
                        disabled={busy}
                        onClick={() => void revokeInvite(i)}
                      >
                        Revoke
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </section>
  );
}
