"use client";

/**
 * Phase 2.7X Stage 3+4 — Organization runtime: detail page.
 *
 * Stage 3 (read): GET /v1/orgs/:id, /members, /workspaces.
 * Stage 4 (mutations): invite, role change, remove, audit timeline.
 *
 * Hard rules:
 *   - NO evidence data, NO case data, NO reviewer data.
 *   - Workspaces section shows ONLY id+name+isPersonal+created — no counts.
 *   - Member mutations require the caller to be at least ORG_ADMIN.
 *     The caller's role is returned by GET /v1/orgs/:id as `callerRole`.
 *   - The audit timeline is gated server-side at ORG_AUDITOR+; the
 *     UI mirrors that with a placeholder for ORG_MEMBER.
 *   - No fake analytics, no scores, no governance "AI". Just the
 *     operational facts the API actually owns.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

import { apiFetch } from "../../../../lib/api";

type OrgRole =
  | "ORG_OWNER"
  | "ORG_ADMIN"
  | "ORG_SECURITY_ADMIN"
  | "ORG_BILLING_ADMIN"
  | "ORG_AUDITOR"
  | "ORG_MEMBER";

const ROLE_RANK: Record<OrgRole, number> = {
  ORG_OWNER: 5,
  ORG_ADMIN: 4,
  ORG_SECURITY_ADMIN: 3,
  ORG_BILLING_ADMIN: 3,
  ORG_AUDITOR: 2,
  ORG_MEMBER: 1,
};

const ROLE_LABELS: Record<OrgRole, string> = {
  ORG_OWNER: "Owner",
  ORG_ADMIN: "Admin",
  ORG_SECURITY_ADMIN: "Security admin",
  ORG_BILLING_ADMIN: "Billing admin",
  ORG_AUDITOR: "Auditor",
  ORG_MEMBER: "Member",
};

const ALL_ROLES: OrgRole[] = [
  "ORG_OWNER",
  "ORG_ADMIN",
  "ORG_SECURITY_ADMIN",
  "ORG_BILLING_ADMIN",
  "ORG_AUDITOR",
  "ORG_MEMBER",
];

type OrgResponse = {
  organizationId: string;
  name: string;
  legalName: string | null;
  legalEmail: string | null;
  status: "ACTIVE" | "SUSPENDED" | "ARCHIVED";
  billingOwnerUserId: string | null;
  verificationState: string | null;
  verifiedAtUtc: string | null;
  createdAt: string;
  updatedAt: string;
  callerRole: OrgRole;
  summary: { memberCount: number; workspaceCount: number };
};

type MembersResponse = {
  organizationId: string;
  summary: { totalMembers: number };
  members: Array<{
    membershipId: string;
    userId: string;
    email: string | null;
    displayName: string | null;
    role: OrgRole;
    memberSince: string;
  }>;
};

type WorkspacesResponse = {
  organizationId: string;
  summary: { totalWorkspaces: number };
  workspaces: Array<{
    workspaceId: string;
    name: string;
    isPersonal: boolean;
    createdAt: string;
  }>;
};

type AuditResponse = {
  organizationId: string;
  summary: {
    totalEvents: number;
    nextCursor?: string | null;
    appliedTake?: number;
    appliedEventTypeFilter?: string[] | null;
  };
  events: Array<{
    id: string;
    actorUserId: string | null;
    actorEmail: string | null;
    actorDisplayName: string | null;
    eventType: string;
    targetType: string;
    targetId: string | null;
    metadata: unknown;
    createdAt: string;
  }>;
};

type PendingInvitesResponse = {
  organizationId: string;
  summary: { totalPending: number };
  invites: Array<{
    inviteId: string;
    email: string;
    role: OrgRole;
    invitedByUserId: string;
    expiresAt: string;
    lastResentAt: string | null;
    resendCount: number;
    createdAt: string;
  }>;
};

type Loadable<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "error"; message: string; status: number };

export default function OrganizationDetailPage() {
  const params = useParams<{ id: string }>();
  const orgId = params?.id ?? "";

  const [org, setOrg] = useState<Loadable<OrgResponse>>({ kind: "loading" });
  const [members, setMembers] = useState<Loadable<MembersResponse>>({
    kind: "loading",
  });
  const [workspaces, setWorkspaces] = useState<Loadable<WorkspacesResponse>>({
    kind: "loading",
  });
  const [audit, setAudit] = useState<Loadable<AuditResponse>>({
    kind: "loading",
  });
  // Stage 5 — pending invites + per-invite busy state.
  const [pendingInvites, setPendingInvites] = useState<
    Loadable<PendingInvitesResponse>
  >({ kind: "loading" });
  const [inviteBusyMap, setInviteBusyMap] = useState<Record<string, boolean>>({});
  const [inviteRowError, setInviteRowError] = useState<Record<string, string>>(
    {},
  );

  // Stage 4 — invite modal state.
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<OrgRole>("ORG_MEMBER");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [lastInviteToken, setLastInviteToken] = useState<string | null>(null);

  // Stage 4 — per-row busy markers for role-change / remove.
  const [memberBusy, setMemberBusy] = useState<Record<string, boolean>>({});
  const [memberError, setMemberError] = useState<Record<string, string>>({});

  const safeFetch = useCallback(
    async <T,>(path: string): Promise<Loadable<T>> => {
      try {
        const res = await apiFetch(path);
        const data = (await res.json()) as T;
        return { kind: "ready", data };
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Failed to load.";
        const status =
          typeof (err as { statusCode?: number }).statusCode === "number"
            ? ((err as { statusCode: number }).statusCode)
            : 0;
        return { kind: "error", message, status };
      }
    },
    [],
  );

  const fetchAll = useCallback(async () => {
    if (!orgId) return;
    setOrg({ kind: "loading" });
    setMembers({ kind: "loading" });
    setWorkspaces({ kind: "loading" });
    setAudit({ kind: "loading" });
    setPendingInvites({ kind: "loading" });

    const [o, m, w, a, p] = await Promise.all([
      safeFetch<OrgResponse>(`/v1/orgs/${orgId}`),
      safeFetch<MembersResponse>(`/v1/orgs/${orgId}/members`),
      safeFetch<WorkspacesResponse>(`/v1/orgs/${orgId}/workspaces`),
      safeFetch<AuditResponse>(`/v1/orgs/${orgId}/audit-events`),
      safeFetch<PendingInvitesResponse>(`/v1/orgs/${orgId}/invites`),
    ]);
    setOrg(o);
    setMembers(m);
    setWorkspaces(w);
    setAudit(a);
    setPendingInvites(p);
  }, [orgId, safeFetch]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const callerRole: OrgRole | null =
    org.kind === "ready" ? org.data.callerRole : null;
  const canMutate =
    callerRole !== null && ROLE_RANK[callerRole] >= ROLE_RANK.ORG_ADMIN;

  const submitInvite = useCallback(async () => {
    const email = inviteEmail.trim();
    if (!email) {
      setInviteError("Email is required.");
      return;
    }
    setInviteBusy(true);
    setInviteError(null);
    try {
      const res = await apiFetch(`/v1/orgs/${orgId}/invites`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, role: inviteRole }),
      });
      const data = (await res.json()) as { token: string };
      setLastInviteToken(data.token);
      setInviteEmail("");
      await fetchAll();
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to send invite.";
      setInviteError(message);
    } finally {
      setInviteBusy(false);
    }
  }, [inviteEmail, inviteRole, orgId, fetchAll]);

  const changeRole = useCallback(
    async (membershipId: string, newRole: OrgRole) => {
      setMemberBusy((s) => ({ ...s, [membershipId]: true }));
      setMemberError((s) => ({ ...s, [membershipId]: "" }));
      try {
        await apiFetch(`/v1/orgs/${orgId}/members/${membershipId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: newRole }),
        });
        await fetchAll();
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Failed to change role.";
        setMemberError((s) => ({ ...s, [membershipId]: message }));
      } finally {
        setMemberBusy((s) => ({ ...s, [membershipId]: false }));
      }
    },
    [orgId, fetchAll],
  );

  const removeMember = useCallback(
    async (membershipId: string) => {
      setMemberBusy((s) => ({ ...s, [membershipId]: true }));
      setMemberError((s) => ({ ...s, [membershipId]: "" }));
      try {
        await apiFetch(`/v1/orgs/${orgId}/members/${membershipId}`, {
          method: "DELETE",
        });
        await fetchAll();
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Failed to remove member.";
        setMemberError((s) => ({ ...s, [membershipId]: message }));
      } finally {
        setMemberBusy((s) => ({ ...s, [membershipId]: false }));
      }
    },
    [orgId, fetchAll],
  );

  // Stage 5 — revoke / resend invite handlers.
  const revokeInvite = useCallback(
    async (inviteId: string) => {
      setInviteBusyMap((s) => ({ ...s, [inviteId]: true }));
      setInviteRowError((s) => ({ ...s, [inviteId]: "" }));
      try {
        await apiFetch(`/v1/orgs/${orgId}/invites/${inviteId}`, {
          method: "DELETE",
        });
        await fetchAll();
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Failed to revoke invite.";
        setInviteRowError((s) => ({ ...s, [inviteId]: message }));
      } finally {
        setInviteBusyMap((s) => ({ ...s, [inviteId]: false }));
      }
    },
    [orgId, fetchAll],
  );

  const resendInvite = useCallback(
    async (inviteId: string) => {
      setInviteBusyMap((s) => ({ ...s, [inviteId]: true }));
      setInviteRowError((s) => ({ ...s, [inviteId]: "" }));
      try {
        await apiFetch(`/v1/orgs/${orgId}/invites/${inviteId}/resend`, {
          method: "POST",
        });
        await fetchAll();
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Failed to resend invite.";
        setInviteRowError((s) => ({ ...s, [inviteId]: message }));
      } finally {
        setInviteBusyMap((s) => ({ ...s, [inviteId]: false }));
      }
    },
    [orgId, fetchAll],
  );

  return (
    <main
      style={{ padding: "1.5rem", maxWidth: 880 }}
      data-phase-2-7x-organization-detail
      data-org-id={orgId}
    >
      <div style={{ marginBottom: "1rem" }}>
        <Link href="/organizations">← Back to organizations</Link>
      </div>

      {/* --- header / org meta --- */}
      {org.kind === "loading" && (
        <div data-section="org-meta" data-state="loading" style={{ opacity: 0.7 }}>
          Loading organization…
        </div>
      )}

      {org.kind === "error" && (
        <div
          data-section="org-meta"
          data-state="error"
          role="alert"
          style={{
            padding: "1rem",
            border: "1px solid #d44",
            borderRadius: 6,
            background: "rgba(220,68,68,0.06)",
          }}
        >
          <strong>Couldn’t load organization.</strong>
          <div style={{ fontSize: 13, marginTop: 4 }}>
            {org.status === 403
              ? "You don’t have access to this organization."
              : `${org.status ? `HTTP ${org.status}: ` : ""}${org.message}`}
          </div>
        </div>
      )}

      {org.kind === "ready" && (
        <header
          data-section="org-meta"
          data-state="ready"
          style={{ marginBottom: "1.5rem" }}
        >
          <div style={{ fontSize: 12, opacity: 0.7 }}>
            Phase 2.7X Stage 4 — governance + mutations
          </div>
          <h1 style={{ margin: "0.25rem 0" }}>{org.data.name}</h1>
          <div style={{ fontSize: 13, opacity: 0.85 }}>
            Status: <strong>{org.data.status}</strong> · Your role:{" "}
            <strong>{ROLE_LABELS[org.data.callerRole]}</strong> ·{" "}
            {org.data.summary.memberCount} member
            {org.data.summary.memberCount === 1 ? "" : "s"} ·{" "}
            {org.data.summary.workspaceCount} workspace
            {org.data.summary.workspaceCount === 1 ? "" : "s"}
          </div>
        </header>
      )}

      {/* --- members --- */}
      <section data-section="org-members" style={{ marginBottom: "2rem" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "0.5rem",
          }}
        >
          <h2 style={{ margin: 0 }}>Members</h2>
          {canMutate && (
            <button
              type="button"
              data-action="open-invite"
              onClick={() => {
                setInviteError(null);
                setLastInviteToken(null);
                setInviteOpen(true);
              }}
              style={{
                padding: "0.4rem 0.7rem",
                border: "1px solid currentColor",
                borderRadius: 4,
                fontSize: 13,
              }}
            >
              + Invite member
            </button>
          )}
        </div>
        {members.kind === "loading" && (
          <div data-state="loading" style={{ opacity: 0.7 }}>
            Loading members…
          </div>
        )}
        {members.kind === "error" && (
          <div data-state="error" style={{ fontSize: 13, opacity: 0.8 }}>
            {members.status === 403
              ? "You don’t have access to the member list."
              : "Couldn’t load members."}
          </div>
        )}
        {members.kind === "ready" && (
          <ul
            data-state="ready"
            data-total-members={members.data.summary.totalMembers}
            style={{ listStyle: "none", padding: 0, margin: 0 }}
          >
            {members.data.members.map((m) => {
              const isCaller =
                org.kind === "ready" &&
                m.userId ===
                  // The API doesn't echo caller userId; we infer "self"
                  // by comparing callerRole === m.role AND treating the
                  // first matching row as self. Safer: derive from
                  // billingOwnerUserId when caller is ORG_OWNER.
                  (org.data.callerRole === "ORG_OWNER"
                    ? org.data.billingOwnerUserId
                    : "");
              const busy = !!memberBusy[m.membershipId];
              const err = memberError[m.membershipId];
              return (
                <li
                  key={m.membershipId}
                  data-membership-id={m.membershipId}
                  data-member-role={m.role}
                  style={{
                    padding: "0.5rem 0.75rem",
                    borderBottom: "1px solid rgba(127,127,127,0.2)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 12,
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 500 }}>
                        {m.displayName || m.email || "(unnamed user)"}
                      </div>
                      {m.email && (
                        <div style={{ fontSize: 12, opacity: 0.7 }}>
                          {m.email}
                        </div>
                      )}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        fontSize: 12,
                      }}
                    >
                      {canMutate && !isCaller ? (
                        <select
                          data-action="change-role"
                          value={m.role}
                          disabled={busy}
                          onChange={(e) =>
                            void changeRole(
                              m.membershipId,
                              e.target.value as OrgRole,
                            )
                          }
                        >
                          {ALL_ROLES.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABELS[r]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span data-role-label>{ROLE_LABELS[m.role]}</span>
                      )}
                      <span style={{ opacity: 0.75 }}>
                        since{" "}
                        {new Date(m.memberSince).toLocaleDateString()}
                      </span>
                      {canMutate && !isCaller && (
                        <button
                          type="button"
                          data-action="remove-member"
                          disabled={busy}
                          onClick={() => void removeMember(m.membershipId)}
                          style={{
                            border: "1px solid #d44",
                            borderRadius: 4,
                            padding: "0.2rem 0.5rem",
                            background: "transparent",
                          }}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                  {err && (
                    <div
                      role="alert"
                      data-state="error"
                      style={{
                        marginTop: 4,
                        fontSize: 12,
                        color: "#d44",
                      }}
                    >
                      {err}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* --- invite modal --- */}
      {inviteOpen && (
        <div
          role="dialog"
          aria-modal="true"
          data-modal="invite-member"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget && !inviteBusy)
              setInviteOpen(false);
          }}
        >
          <form
            data-form="invite-member"
            onSubmit={(e) => {
              e.preventDefault();
              void submitInvite();
            }}
            style={{
              background: "var(--bg, #fff)",
              color: "var(--fg, #000)",
              padding: "1.25rem",
              borderRadius: 6,
              minWidth: 360,
              maxWidth: 480,
              boxShadow: "0 8px 30px rgba(0,0,0,0.4)",
            }}
          >
            <h2 style={{ margin: "0 0 0.5rem" }}>Invite member</h2>
            <p style={{ fontSize: 13, opacity: 0.85, marginTop: 0 }}>
              The invitee accepts via the returned invite token. Stage 4 does
              not send email automatically — share the token with them.
            </p>
            <label
              style={{ display: "block", fontSize: 13, marginBottom: 6 }}
            >
              Email
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                required
                disabled={inviteBusy}
                data-input="invite-email"
                style={{
                  display: "block",
                  width: "100%",
                  marginTop: 4,
                  padding: "0.4rem 0.5rem",
                  border: "1px solid currentColor",
                  borderRadius: 4,
                  background: "transparent",
                  color: "inherit",
                }}
              />
            </label>
            <label
              style={{ display: "block", fontSize: 13, marginBottom: 8 }}
            >
              Role
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as OrgRole)}
                disabled={inviteBusy}
                data-input="invite-role"
                style={{
                  display: "block",
                  marginTop: 4,
                  padding: "0.3rem 0.4rem",
                }}
              >
                {ALL_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </label>
            {inviteError && (
              <div
                role="alert"
                data-state="error"
                style={{
                  padding: "0.4rem 0.6rem",
                  border: "1px solid #d44",
                  borderRadius: 4,
                  fontSize: 13,
                  marginBottom: 8,
                }}
              >
                {inviteError}
              </div>
            )}
            {lastInviteToken && (
              <div
                data-state="invite-token-issued"
                style={{
                  padding: "0.4rem 0.6rem",
                  border: "1px dashed currentColor",
                  borderRadius: 4,
                  fontSize: 12,
                  marginBottom: 8,
                  wordBreak: "break-all",
                }}
              >
                <strong>Invite token</strong> — share with the invitee.
                They open <code>/org-invites/{lastInviteToken}/accept</code>:
                <div style={{ marginTop: 4 }}>
                  <code>{lastInviteToken}</code>
                </div>
              </div>
            )}
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
              }}
            >
              <button
                type="button"
                onClick={() => setInviteOpen(false)}
                disabled={inviteBusy}
                data-action="cancel-invite"
              >
                Close
              </button>
              <button
                type="submit"
                disabled={inviteBusy || !inviteEmail.trim()}
                data-action="submit-invite"
              >
                {inviteBusy ? "Sending…" : "Send invite"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* --- pending invites (Stage 5) --- */}
      <section data-section="org-pending-invites" style={{ marginBottom: "2rem" }}>
        <h2 style={{ margin: "0 0 0.5rem" }}>Pending invites</h2>
        <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 0.5rem" }}>
          Invites sent but not yet accepted, revoked, or expired.
        </p>
        {pendingInvites.kind === "loading" && (
          <div data-state="loading" style={{ opacity: 0.7 }}>
            Loading pending invites…
          </div>
        )}
        {pendingInvites.kind === "error" && (
          <div data-state="error" style={{ fontSize: 13, opacity: 0.8 }}>
            {pendingInvites.status === 403
              ? "Pending-invite visibility requires admin access."
              : "Couldn’t load pending invites."}
          </div>
        )}
        {pendingInvites.kind === "ready" && (
          <ul
            data-state="ready"
            data-total-pending={pendingInvites.data.summary.totalPending}
            style={{ listStyle: "none", padding: 0, margin: 0 }}
          >
            {pendingInvites.data.invites.length === 0 && (
              <li style={{ opacity: 0.75, fontSize: 13 }}>
                No pending invites.
              </li>
            )}
            {pendingInvites.data.invites.map((i) => {
              const busy = !!inviteBusyMap[i.inviteId];
              const err = inviteRowError[i.inviteId];
              return (
                <li
                  key={i.inviteId}
                  data-invite-id={i.inviteId}
                  data-invite-role={i.role}
                  style={{
                    padding: "0.5rem 0.75rem",
                    borderBottom: "1px solid rgba(127,127,127,0.2)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 12,
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 500 }}>{i.email}</div>
                      <div style={{ fontSize: 12, opacity: 0.7 }}>
                        {ROLE_LABELS[i.role]} · expires{" "}
                        {new Date(i.expiresAt).toLocaleString()}
                        {i.resendCount > 0 ? ` · resent ${i.resendCount}×` : ""}
                      </div>
                    </div>
                    {canMutate && (
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          type="button"
                          data-action="resend-invite"
                          disabled={busy}
                          onClick={() => void resendInvite(i.inviteId)}
                          style={{
                            border: "1px solid currentColor",
                            borderRadius: 4,
                            padding: "0.2rem 0.5rem",
                            fontSize: 12,
                          }}
                        >
                          Resend
                        </button>
                        <button
                          type="button"
                          data-action="revoke-invite"
                          disabled={busy}
                          onClick={() => void revokeInvite(i.inviteId)}
                          style={{
                            border: "1px solid #d44",
                            borderRadius: 4,
                            padding: "0.2rem 0.5rem",
                            fontSize: 12,
                            background: "transparent",
                          }}
                        >
                          Revoke
                        </button>
                      </div>
                    )}
                  </div>
                  {err && (
                    <div
                      role="alert"
                      data-state="error"
                      style={{ marginTop: 4, fontSize: 12, color: "#d44" }}
                    >
                      {err}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* --- workspaces --- */}
      <section data-section="org-workspaces" style={{ marginBottom: "2rem" }}>
        <h2 style={{ margin: "0 0 0.5rem" }}>Workspaces</h2>
        <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 0.5rem" }}>
          Operational evidence, cases, and reviewer queues live inside each
          workspace. Open a workspace to manage its contents — your
          workspace-level role still controls access there.
        </p>
        {workspaces.kind === "loading" && (
          <div data-state="loading" style={{ opacity: 0.7 }}>
            Loading workspaces…
          </div>
        )}
        {workspaces.kind === "error" && (
          <div data-state="error" style={{ fontSize: 13, opacity: 0.8 }}>
            {workspaces.status === 403
              ? "You don’t have access to the workspace list."
              : "Couldn’t load workspaces."}
          </div>
        )}
        {workspaces.kind === "ready" && (
          <ul
            data-state="ready"
            data-total-workspaces={workspaces.data.summary.totalWorkspaces}
            style={{ listStyle: "none", padding: 0, margin: 0 }}
          >
            {workspaces.data.workspaces.length === 0 && (
              <li style={{ opacity: 0.75, fontSize: 13 }}>
                No workspaces bound to this organization.
              </li>
            )}
            {workspaces.data.workspaces.map((w) => (
              <li
                key={w.workspaceId}
                style={{
                  padding: "0.5rem 0.75rem",
                  borderBottom: "1px solid rgba(127,127,127,0.2)",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <div>
                  <div style={{ fontWeight: 500 }}>
                    {w.name}
                    {w.isPersonal ? (
                      <span
                        style={{
                          marginLeft: 6,
                          padding: "1px 6px",
                          borderRadius: 4,
                          fontSize: 11,
                          background: "rgba(127,127,127,0.18)",
                        }}
                      >
                        personal
                      </span>
                    ) : null}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.7 }}>
                    Created {new Date(w.createdAt).toLocaleDateString()}
                  </div>
                </div>
                <Link
                  href={`/teams/${w.workspaceId}`}
                  style={{
                    padding: "0.3rem 0.6rem",
                    border: "1px solid currentColor",
                    borderRadius: 4,
                    textDecoration: "none",
                    fontSize: 13,
                  }}
                  data-action="open-workspace"
                  data-workspace-id={w.workspaceId}
                >
                  Open workspace
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* --- audit timeline --- */}
      <section data-section="org-audit">
        <h2 style={{ margin: "0 0 0.5rem" }}>Audit timeline</h2>
        <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 0.5rem" }}>
          Organization governance events. Latest 50. Requires the auditor
          role or higher.
        </p>
        {audit.kind === "loading" && (
          <div data-state="loading" style={{ opacity: 0.7 }}>
            Loading audit events…
          </div>
        )}
        {audit.kind === "error" && (
          <div data-state="error" style={{ fontSize: 13, opacity: 0.8 }}>
            {audit.status === 403
              ? "You don’t have access to the audit timeline."
              : "Couldn’t load audit events."}
          </div>
        )}
        {audit.kind === "ready" && (
          <ul
            data-state="ready"
            data-total-events={audit.data.summary.totalEvents}
            style={{ listStyle: "none", padding: 0, margin: 0 }}
          >
            {audit.data.events.length === 0 && (
              <li style={{ opacity: 0.75, fontSize: 13 }}>
                No audit events yet.
              </li>
            )}
            {audit.data.events.map((e) => (
              <li
                key={e.id}
                data-audit-event-type={e.eventType}
                style={{
                  padding: "0.4rem 0.6rem",
                  borderBottom: "1px solid rgba(127,127,127,0.2)",
                  fontSize: 13,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <div>
                    <strong>{e.eventType}</strong>{" "}
                    <span style={{ opacity: 0.7 }}>
                      ({e.targetType}
                      {e.targetId ? ` ${e.targetId.slice(0, 8)}…` : ""})
                    </span>
                  </div>
                  <div style={{ opacity: 0.75, fontSize: 12 }}>
                    {new Date(e.createdAt).toLocaleString()}
                  </div>
                </div>
                <div style={{ fontSize: 12, opacity: 0.75 }}>
                  by{" "}
                  {e.actorDisplayName ||
                    e.actorEmail ||
                    e.actorUserId ||
                    "(unknown)"}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
