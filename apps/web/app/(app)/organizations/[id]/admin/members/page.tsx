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
 */

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { PageRouteGate } from "../../../../../../components/navigation/PageRouteGate";
import { useConfirmAction } from "../../../../../../components/ui/ConfirmActionModal";
import { apiFetch, ApiError } from "../../../../../../lib/api";
import { formatUserDate, formatUserDateTime } from "../../../../../../lib/date";

type OrgRole =
  | "ORG_OWNER"
  | "ORG_ADMIN"
  | "ORG_SECURITY_ADMIN"
  | "ORG_BILLING_ADMIN"
  | "ORG_AUDITOR"
  | "ORG_MEMBER";

const ALL_ROLES: ReadonlyArray<OrgRole> = [
  "ORG_OWNER",
  "ORG_ADMIN",
  "ORG_SECURITY_ADMIN",
  "ORG_BILLING_ADMIN",
  "ORG_AUDITOR",
  "ORG_MEMBER",
];

const ROLE_RANK: Record<OrgRole, number> = {
  ORG_OWNER: 5,
  ORG_ADMIN: 4,
  ORG_SECURITY_ADMIN: 3,
  ORG_BILLING_ADMIN: 3,
  ORG_AUDITOR: 2,
  ORG_MEMBER: 1,
};

const ROLE_LABEL: Record<OrgRole, string> = {
  ORG_OWNER: "Owner",
  ORG_ADMIN: "Admin",
  ORG_SECURITY_ADMIN: "Security admin",
  ORG_BILLING_ADMIN: "Billing admin",
  ORG_AUDITOR: "Auditor",
  ORG_MEMBER: "Member",
};

interface OrgResponse {
  organizationId: string;
  name: string;
  callerRole: OrgRole;
}

interface MemberRow {
  membershipId: string;
  userId: string;
  email: string | null;
  displayName: string | null;
  role: OrgRole;
  memberSince: string;
}

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
}

interface InvitesResponse {
  organizationId: string;
  summary: { totalPending: number };
  invites: InviteRow[];
}

type Loadable<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "error"; message: string; status: number; requestId?: string };

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

  const refresh = useCallback(async () => {
    if (!orgId) return;
    setOrg({ kind: "loading" });
    setMembers({ kind: "loading" });
    setInvites({ kind: "loading" });
    const [o, m, i] = await Promise.all([
      fetchOne<OrgResponse>(`/v1/orgs/${orgId}`),
      fetchOne<MembersResponse>(`/v1/orgs/${orgId}/members`),
      fetchOne<InvitesResponse>(`/v1/orgs/${orgId}/invites`),
    ]);
    setOrg(o);
    setMembers(m);
    setInvites(i);
  }, [orgId, fetchOne]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const callerRole = org.kind === "ready" ? org.data.callerRole : null;
  const canMutate = callerRole !== null && ROLE_RANK[callerRole] >= ROLE_RANK.ORG_ADMIN;

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
    <section data-testid="org-admin-members" data-org-id={orgId}>
      {/* ------------------- INVITE FORM ------------------- */}
      <section
        data-section="invite-form"
        style={{
          padding: "1rem 1.1rem",
          border: "1px solid rgba(127,127,127,0.3)",
          borderRadius: 8,
          marginBottom: "1rem",
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16 }}>Invite a member</h2>
        <p style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
          ORG_ADMIN+ only. The invitee accepts via the returned token URL.
        </p>
        {!canMutate ? (
          <p data-state="forbidden" style={{ fontSize: 13, opacity: 0.8 }}>
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
              gap: 8,
              gridTemplateColumns: "1fr 200px 140px",
              alignItems: "end",
            }}
          >
            <label style={{ fontSize: 13 }}>
              Email
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                disabled={inviteFormBusy}
                required
                data-testid="invite-email-input"
                style={{
                  display: "block",
                  marginTop: 4,
                  width: "100%",
                  padding: "0.45rem 0.55rem",
                  border: "1px solid currentColor",
                  borderRadius: 4,
                  background: "transparent",
                  color: "inherit",
                  fontSize: 13,
                }}
              />
            </label>
            <label style={{ fontSize: 13 }}>
              Role
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as OrgRole)}
                disabled={inviteFormBusy}
                data-testid="invite-role-select"
                style={{
                  display: "block",
                  marginTop: 4,
                  width: "100%",
                  padding: "0.45rem 0.55rem",
                }}
              >
                {ALL_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              disabled={inviteFormBusy || !inviteEmail.trim()}
              data-testid="invite-submit"
              className="cc-quick-action"
              style={{
                padding: "0.5rem 1rem",
                fontSize: 13,
                fontWeight: 600,
                cursor: inviteFormBusy ? "not-allowed" : "pointer",
              }}
            >
              {inviteFormBusy ? "Sending…" : "Send invite"}
            </button>
          </form>
        )}
        {inviteFormError ? (
          <div
            role="alert"
            data-state="error"
            style={{
              marginTop: 8,
              padding: "0.45rem 0.6rem",
              border: "1px solid #d44",
              borderRadius: 4,
              fontSize: 13,
              background: "rgba(220,68,68,0.06)",
            }}
          >
            {inviteFormError}
          </div>
        ) : null}
        {issuedInviteToken ? (
          <div
            data-state="invite-token-issued"
            data-testid="invite-token-issued"
            style={{
              marginTop: 8,
              padding: "0.5rem 0.6rem",
              border: "1px dashed currentColor",
              borderRadius: 4,
              fontSize: 12,
              wordBreak: "break-all",
            }}
          >
            <strong>Invite token URL</strong> — share with the invitee:{" "}
            <code>/org-invites/{issuedInviteToken}/accept</code>
          </div>
        ) : null}
      </section>

      {/* ------------------- MEMBERS LIST ------------------- */}
      <section
        data-section="members-list"
        style={{
          padding: "1rem 1.1rem",
          border: "1px solid rgba(127,127,127,0.3)",
          borderRadius: 8,
          marginBottom: "1rem",
        }}
      >
        <header style={{ marginBottom: "0.5rem" }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Members</h2>
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>
            Org-level governance roles. Workspace-level access is workspace-scoped.
          </div>
        </header>
        {members.kind === "loading" ? (
          <div data-state="loading" style={{ fontSize: 13, opacity: 0.7 }}>
            Loading…
          </div>
        ) : members.kind === "error" ? (
          <div data-state="error" role="alert" style={{ fontSize: 13 }}>
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
              <li style={{ padding: "0.5rem 0", fontSize: 13, opacity: 0.75 }}>
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
                  style={{
                    padding: "0.5rem 0",
                    borderBottom: "1px solid rgba(127,127,127,0.18)",
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                    <div style={{ fontWeight: 500 }}>
                      {m.displayName ?? m.email ?? "(unnamed user)"}
                    </div>
                    {m.email ? (
                      <div style={{ fontSize: 12, opacity: 0.7 }}>{m.email}</div>
                    ) : null}
                    {err ? (
                      <div
                        role="alert"
                        style={{ marginTop: 4, fontSize: 12, color: "#d44" }}
                      >
                        {err}
                      </div>
                    ) : null}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {canMutate ? (
                      <select
                        data-testid={`member-role-select-${m.membershipId}`}
                        value={m.role}
                        disabled={busy}
                        onChange={(e) =>
                          void changeRole(m, e.target.value as OrgRole)
                        }
                        style={{ fontSize: 12 }}
                      >
                        {ALL_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span style={{ fontSize: 12, fontWeight: 600 }}>
                        {ROLE_LABEL[m.role]}
                      </span>
                    )}
                    <span style={{ fontSize: 12, opacity: 0.7 }}>
                      since {formatUserDate(m.memberSince)}
                    </span>
                    {canMutate ? (
                      <button
                        type="button"
                        data-testid={`member-remove-${m.membershipId}`}
                        disabled={busy}
                        onClick={() => void removeMember(m)}
                        style={{
                          border: "1px solid #d44",
                          borderRadius: 4,
                          padding: "0.2rem 0.55rem",
                          background: "transparent",
                          color: "inherit",
                          cursor: busy ? "not-allowed" : "pointer",
                          fontSize: 12,
                        }}
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ------------------- PENDING INVITES ------------------- */}
      <section
        data-section="pending-invites"
        style={{
          padding: "1rem 1.1rem",
          border: "1px solid rgba(127,127,127,0.3)",
          borderRadius: 8,
        }}
      >
        <header style={{ marginBottom: "0.5rem" }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Pending invites</h2>
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>
            Invites issued but not yet accepted, revoked, or expired.
          </div>
        </header>
        {invites.kind === "loading" ? (
          <div style={{ fontSize: 13, opacity: 0.7 }}>Loading…</div>
        ) : invites.kind === "error" ? (
          <div data-state="error" role="alert" style={{ fontSize: 13 }}>
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
                style={{ padding: "0.5rem 0", fontSize: 13, opacity: 0.75 }}
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
                  style={{
                    padding: "0.5rem 0",
                    borderBottom: "1px solid rgba(127,127,127,0.18)",
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                    <div style={{ fontWeight: 500 }}>{i.email}</div>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>
                      {ROLE_LABEL[i.role]} · expires{" "}
                      {formatUserDateTime(i.expiresAt)}
                      {i.resendCount > 0 ? ` · resent ${i.resendCount}×` : ""}
                    </div>
                    {err ? (
                      <div
                        role="alert"
                        style={{ marginTop: 4, fontSize: 12, color: "#d44" }}
                      >
                        {err}
                      </div>
                    ) : null}
                  </div>
                  {canMutate ? (
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        type="button"
                        data-testid={`invite-resend-${i.inviteId}`}
                        disabled={busy}
                        onClick={() => void resendInvite(i)}
                        className="cases-filter-chip"
                        style={{
                          cursor: busy ? "not-allowed" : "pointer",
                          fontSize: 12,
                        }}
                      >
                        Resend
                      </button>
                      <button
                        type="button"
                        data-testid={`invite-revoke-${i.inviteId}`}
                        disabled={busy}
                        onClick={() => void revokeInvite(i)}
                        style={{
                          border: "1px solid #d44",
                          borderRadius: 4,
                          padding: "0.2rem 0.55rem",
                          background: "transparent",
                          color: "inherit",
                          cursor: busy ? "not-allowed" : "pointer",
                          fontSize: 12,
                        }}
                      >
                        Revoke
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </section>
  );
}
