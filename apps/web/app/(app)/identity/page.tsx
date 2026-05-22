"use client";

/**
 * Phase 17 — Identity & Access operations console.
 *
 * Workspace-internal view of members + access lifecycle + service
 * accounts + access review queue + org security policy. Dense,
 * operations-centric — NOT a customer-facing settings page.
 *
 * Wording: never claim "MFA enforced", "SSO enforced", or "compliant".
 * The page surfaces operator intent + posture, not enforcement claims.
 */

import { useEffect, useState } from "react";

import { apiFetch } from "../../../lib/api";
import { useTeamId } from "../../../lib/platform-context";

type MemberStatus = "ACTIVE" | "SUSPENDED" | "REVOKED";
type Role = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

type Member = {
  teamMemberId: string;
  userId: string;
  role: Role;
  status: MemberStatus;
  accessGrantedAtUtc: string | null;
  accessExpiresAtUtc: string | null;
  suspendedAtUtc: string | null;
  revokedAtUtc: string | null;
  lastSeenAtUtc: string | null;
  capabilityGrants: Array<{
    id: string;
    permission: string;
    expiresAtUtc: string | null;
    revokedAtUtc: string | null;
    grantedAtUtc: string;
  }>;
  delegatedAdminScopes: Array<{
    id: string;
    scopeKind: string;
    expiresAtUtc: string | null;
    revokedAtUtc: string | null;
    grantedAtUtc: string;
  }>;
};

type ServiceAccount = {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  status: string;
  expiresAtUtc: string | null;
  disabledAtUtc: string | null;
  rotationRequired: boolean;
  ipAllowlist: string[];
  environment: string | null;
  lastUsedAtUtc: string | null;
};

type AccessReview = {
  id: string;
  kind: string;
  status: string;
  subjectKind: string;
  subjectUserId: string | null;
  subjectApiCredentialId: string | null;
  initiatedAtUtc: string;
  completedAtUtc: string | null;
};

type OrgPolicy = {
  mfaRequiredFlag: boolean;
  allowedEmailDomains: string[];
  restrictedIpRanges: string[];
  reviewerSessionTimeoutSeconds: number | null;
  contributorSessionTimeoutSeconds: number | null;
  ssoReadyFlag: boolean;
  scimReadyFlag: boolean;
  notes: string | null;
};

export default function IdentityPage() {
  const teamId = useTeamId();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [serviceAccounts, setServiceAccounts] = useState<ServiceAccount[] | null>(
    null,
  );
  const [reviews, setReviews] = useState<AccessReview[] | null>(null);
  const [policy, setPolicy] = useState<OrgPolicy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  
  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    const qs = `?teamId=${encodeURIComponent(teamId)}`;
    Promise.all([
      apiFetch(`/v1/identity/members${qs}`, { method: "GET" }),
      apiFetch(`/v1/identity/service-accounts${qs}`, { method: "GET" }).catch(
        () => ({ serviceAccounts: [] }),
      ),
      apiFetch(`/v1/identity/access-reviews${qs}`, { method: "GET" }).catch(
        () => ({ accessReviews: [] }),
      ),
      apiFetch(`/v1/identity/policy${qs}`, { method: "GET" }).catch(() => ({
        policy: null,
      })),
    ])
      .then(
        ([m, s, r, p]: [
          { members: Member[] },
          { serviceAccounts: ServiceAccount[] },
          { accessReviews: AccessReview[] },
          { policy: OrgPolicy | null },
        ]) => {
          if (cancelled) return;
          setMembers(m.members ?? []);
          setServiceAccounts(s.serviceAccounts ?? []);
          setReviews(r.accessReviews ?? []);
          setPolicy(p.policy);
          setError(null);
        },
      )
      .catch((err: { message?: string }) => {
        if (cancelled) return;
        setError(err?.message ?? "Could not load identity data.");
      });
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  async function memberAction(
    action: "suspend" | "restore" | "revoke",
    teamMemberId: string,
  ) {
    if (!teamId) return;
    const needsReason = action === "suspend" || action === "revoke";
    const reason = needsReason
      ? window.prompt(`Reason for ${action} (internal only)`)
      : null;
    if (needsReason && (!reason || reason.trim().length === 0)) return;
    setBusy(true);
    try {
      await apiFetch(
        `/v1/identity/members/${teamMemberId}/${action}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ teamId, reason: reason ?? undefined }),
        },
      );
      // Reload members.
      const fresh: { members: Member[] } = await apiFetch(
        `/v1/identity/members?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      );
      setMembers(fresh.members ?? []);
    } catch (err) {
      alert((err as { message?: string })?.message ?? "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  async function regenerateReviews() {
    if (!teamId) return;
    setBusy(true);
    try {
      const res: { created: number } = await apiFetch(
        "/v1/identity/access-reviews/regenerate",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ teamId }),
        },
      );
      const fresh: { accessReviews: AccessReview[] } = await apiFetch(
        `/v1/identity/access-reviews?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      );
      setReviews(fresh.accessReviews ?? []);
      alert(`Generated ${res.created} new access review(s).`);
    } catch (err) {
      alert((err as { message?: string })?.message ?? "Regeneration failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={pageStyle}>
      <header>
        <h1 style={titleStyle}>Identity &amp; Access</h1>
        <p style={mutedStyle}>
          Workspace member lifecycle, capability grants, delegated
          administration, service-account hardening, contributor session
          governance, and the access review queue. Phase 17 surfaces are
          workspace-internal and never appear on public verify.
        </p>
      </header>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      {!teamId ? (
        <p style={mutedStyle}>Switch to a workspace to use identity.</p>
      ) : (
        <>
          <section style={cardStyle}>
            <h2 style={sectionTitleStyle}>Org security policy</h2>
            {policy ? (
              <div style={policyGridStyle}>
                <Stat
                  label="MFA required (intent)"
                  value={policy.mfaRequiredFlag ? "Yes" : "No"}
                />
                <Stat
                  label="SSO ready (intent)"
                  value={policy.ssoReadyFlag ? "Yes" : "No"}
                />
                <Stat
                  label="SCIM ready (intent)"
                  value={policy.scimReadyFlag ? "Yes" : "No"}
                />
                <Stat
                  label="Allowed domains"
                  value={String(policy.allowedEmailDomains.length)}
                />
                <Stat
                  label="Restricted CIDRs"
                  value={String(policy.restrictedIpRanges.length)}
                />
                <Stat
                  label="Reviewer timeout (s)"
                  value={
                    policy.reviewerSessionTimeoutSeconds === null
                      ? "—"
                      : String(policy.reviewerSessionTimeoutSeconds)
                  }
                />
              </div>
            ) : (
              <p style={mutedStyle}>Loading…</p>
            )}
            <p style={mutedStyle}>
              MFA / SSO / SCIM flags are stored as posture intent only;
              the platform does not enforce a protocol challenge in this
              phase. Domain and CIDR allowlists ARE enforced.
            </p>
          </section>

          <section style={cardStyle}>
            <h2 style={sectionTitleStyle}>Members</h2>
            {members === null ? (
              <p style={mutedStyle}>Loading…</p>
            ) : members.length === 0 ? (
              <p style={mutedStyle}>No members.</p>
            ) : (
              <ul style={listStyle}>
                {members.map((m) => (
                  <li key={m.teamMemberId} style={rowStyle}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>
                        {m.userId.slice(0, 8)}… · {m.role}
                      </div>
                      <div style={mutedStyle}>
                        last seen{" "}
                        {m.lastSeenAtUtc
                          ? new Date(m.lastSeenAtUtc).toLocaleString()
                          : "never"}
                        {m.accessExpiresAtUtc
                          ? ` · expires ${new Date(m.accessExpiresAtUtc).toLocaleDateString()}`
                          : ""}
                        {m.capabilityGrants.length > 0
                          ? ` · ${m.capabilityGrants.length} capability grant${m.capabilityGrants.length === 1 ? "" : "s"}`
                          : ""}
                        {m.delegatedAdminScopes.length > 0
                          ? ` · ${m.delegatedAdminScopes.length} delegated scope${m.delegatedAdminScopes.length === 1 ? "" : "s"}`
                          : ""}
                      </div>
                    </div>
                    <span style={statusBadgeStyle(m.status)}>{m.status}</span>
                    {m.role !== "OWNER" ? (
                      <div style={{ display: "flex", gap: 4 }}>
                        {m.status === "ACTIVE" ? (
                          <button
                            type="button"
                            style={secondaryButtonStyle}
                            disabled={busy}
                            onClick={() =>
                              memberAction("suspend", m.teamMemberId)
                            }
                          >
                            Suspend
                          </button>
                        ) : m.status === "SUSPENDED" ? (
                          <button
                            type="button"
                            style={secondaryButtonStyle}
                            disabled={busy}
                            onClick={() =>
                              memberAction("restore", m.teamMemberId)
                            }
                          >
                            Restore
                          </button>
                        ) : null}
                        {m.status !== "REVOKED" ? (
                          <button
                            type="button"
                            style={dangerButtonStyle}
                            disabled={busy}
                            onClick={() =>
                              memberAction("revoke", m.teamMemberId)
                            }
                          >
                            Revoke
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section style={cardStyle}>
            <h2 style={sectionTitleStyle}>Service accounts</h2>
            {serviceAccounts === null ? (
              <p style={mutedStyle}>Loading…</p>
            ) : serviceAccounts.length === 0 ? (
              <p style={mutedStyle}>No service accounts.</p>
            ) : (
              <ul style={listStyle}>
                {serviceAccounts.map((s) => (
                  <li key={s.id} style={rowStyle}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>
                        {s.name}{" "}
                        {s.environment ? (
                          <span style={visibilityBadgeStyle}>
                            {s.environment}
                          </span>
                        ) : null}
                      </div>
                      <div style={mutedStyle}>
                        {s.keyPrefix} ·{" "}
                        last used{" "}
                        {s.lastUsedAtUtc
                          ? new Date(s.lastUsedAtUtc).toLocaleString()
                          : "never"}
                        {s.expiresAtUtc
                          ? ` · expires ${new Date(s.expiresAtUtc).toLocaleDateString()}`
                          : ""}
                        {s.ipAllowlist.length > 0
                          ? ` · ip-restricted (${s.ipAllowlist.length})`
                          : ""}
                        {s.rotationRequired ? " · rotation required" : ""}
                      </div>
                    </div>
                    <span style={statusBadgeStyle(serviceStatus(s))}>
                      {serviceStatus(s)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p style={mutedStyle}>
              Edit hardening (expiry, IP allowlist, rotation flag,
              environment label) via the REST API in this phase. UI
              controls land in a follow-up.
            </p>
          </section>

          <section style={cardStyle}>
            <div style={cardHeaderStyle}>
              <h2 style={sectionTitleStyle}>Access review queue</h2>
              <button
                type="button"
                style={primaryButtonStyle}
                disabled={busy}
                onClick={() => void regenerateReviews()}
              >
                Regenerate queue
              </button>
            </div>
            {reviews === null ? (
              <p style={mutedStyle}>Loading…</p>
            ) : reviews.length === 0 ? (
              <p style={mutedStyle}>
                No access reviews pending. Click &ldquo;Regenerate&rdquo;
                to scan for stale members, unused service accounts, and
                expiring temporary access.
              </p>
            ) : (
              <ul style={listStyle}>
                {reviews.map((r) => (
                  <li key={r.id} style={rowStyle}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>{r.kind}</div>
                      <div style={mutedStyle}>
                        {r.subjectKind}
                        {r.subjectUserId
                          ? ` · user ${r.subjectUserId.slice(0, 8)}…`
                          : ""}
                        {r.subjectApiCredentialId
                          ? ` · service-account ${r.subjectApiCredentialId.slice(0, 8)}…`
                          : ""}
                        {" · initiated "}
                        {new Date(r.initiatedAtUtc).toLocaleDateString()}
                      </div>
                    </div>
                    <span style={statusBadgeStyle(r.status)}>{r.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}

function serviceStatus(s: ServiceAccount): string {
  if (s.status === "REVOKED") return "REVOKED";
  if (s.disabledAtUtc) return "DISABLED";
  if (s.expiresAtUtc && new Date(s.expiresAtUtc).getTime() <= Date.now())
    return "EXPIRED";
  return "ACTIVE";
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={statStyle}>
      <div style={{ fontSize: 20, fontWeight: 700, color: "#0f172a" }}>
        {value}
      </div>
      <div style={mutedStyle}>{label}</div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------------

const pageStyle: React.CSSProperties = {
  maxWidth: 1040,
  margin: "0 auto",
  padding: "32px 24px",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  color: "#0f172a",
};
const titleStyle: React.CSSProperties = {
  fontSize: 24,
  fontWeight: 700,
  marginBottom: 4,
};
const sectionTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  marginBottom: 12,
};
const mutedStyle: React.CSSProperties = { fontSize: 13, color: "#64748b" };
const cardStyle: React.CSSProperties = {
  marginTop: 24,
  padding: 20,
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  background: "#fff",
};
const cardHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 8,
  marginBottom: 12,
};
const policyGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
  gap: 12,
  marginBottom: 12,
};
const statStyle: React.CSSProperties = {
  padding: 12,
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
};
const listStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
};
const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 8px",
  borderBottom: "1px solid #e2e8f0",
};
const errorBoxStyle: React.CSSProperties = {
  marginTop: 12,
  padding: 12,
  background: "#fef2f2",
  color: "#7f1d1d",
  border: "1px solid #fecaca",
  borderRadius: 8,
  fontSize: 14,
};
const primaryButtonStyle: React.CSSProperties = {
  padding: "6px 14px",
  fontWeight: 600,
  color: "#fff",
  background: "#0f172a",
  border: 0,
  borderRadius: 8,
  cursor: "pointer",
  fontSize: 13,
};
const secondaryButtonStyle: React.CSSProperties = {
  padding: "4px 10px",
  fontWeight: 500,
  color: "#0f172a",
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
};
const dangerButtonStyle: React.CSSProperties = {
  padding: "4px 10px",
  fontWeight: 500,
  color: "#7f1d1d",
  background: "#fef2f2",
  border: "1px solid #fecaca",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
};
const visibilityBadgeStyle: React.CSSProperties = {
  padding: "2px 6px",
  fontSize: 10,
  fontWeight: 600,
  borderRadius: 999,
  background: "#eff6ff",
  color: "#1e40af",
  border: "1px solid #93c5fd",
  marginLeft: 6,
};

function statusBadgeStyle(status: string): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: "4px 10px",
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 999,
    border: "1px solid",
    whiteSpace: "nowrap",
  };
  if (
    status === "ACTIVE" ||
    status === "COMPLETED_KEEP" ||
    status === "COMPLETED_NO_ACTION"
  ) {
    return {
      ...base,
      background: "#f0fdf4",
      borderColor: "#86efac",
      color: "#166534",
    };
  }
  if (
    status === "SUSPENDED" ||
    status === "DISABLED" ||
    status === "IN_PROGRESS"
  ) {
    return {
      ...base,
      background: "#fffbeb",
      borderColor: "#fcd34d",
      color: "#92400e",
    };
  }
  if (
    status === "REVOKED" ||
    status === "EXPIRED" ||
    status === "COMPLETED_REVOKED" ||
    status === "COMPLETED_SUSPENDED"
  ) {
    return {
      ...base,
      background: "#fef2f2",
      borderColor: "#fecaca",
      color: "#7f1d1d",
    };
  }
  return {
    ...base,
    background: "#eff6ff",
    borderColor: "#93c5fd",
    color: "#1e40af",
  };
}
