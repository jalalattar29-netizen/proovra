"use client";

/**
 * Phase 19 — Security Center.
 *
 * Workspace-internal operator console for:
 *   - MFA policy (read + change)
 *   - the current operator's risk snapshot
 *   - trusted devices (list + revoke)
 *   - recent session revocations
 *
 * Wording: operational only. We say "step-up required", "session
 * restricted", "device revoked". We never say "certified", "fraud
 * proof", or "impossible to bypass".
 */

import { useEffect, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../../lib/api";
import { formatUserDate, formatUtcAuditDateTime } from "../../../lib/date";
import { useTeamId } from "../../../lib/platform-context";
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { useConfirmAction } from "../../../components/ui/ConfirmActionModal";
// Phase IA-collapse — `PersonalSecuritySections` (password, my sessions,
// security events) moved to the new Account Security home at
// `/settings/security` (route id `account.security`). This page is now
// the workspace operator-facing Identity & Security console — MFA
// policy, trusted devices, session revocations, MFA recovery
// approvals. The component file remains in place because the new
// Account Security page imports it from here.
import {
  AccessAnomaliesCard,
  OrgHealthSnapshotCard,
} from "../../../components/hidden-feature-panels/HiddenFeaturePanels";

type MfaPolicyLevel =
  | "OFF"
  | "ADMINS_ONLY"
  | "REVIEWERS_AND_ABOVE"
  | "ALL_MEMBERS"
  | "HIGH_RISK_ONLY";

type Policy = {
  teamId: string;
  level: MfaPolicyLevel;
  stepUpTtlSeconds: number;
  trustedDeviceTtlDays: number;
  mfaRequiredFlag: boolean;
  ssoReadyFlag: boolean;
  scimReadyFlag: boolean;
};

type CurrentUserRequirement = {
  required: boolean;
  reason: "off" | "role_in_policy" | "risk_high" | "action_force" | "fail_closed";
  policyLevel: MfaPolicyLevel;
};

type TrustedDevice = {
  id: string;
  userId: string;
  uaPreview: string | null;
  ipPreview: string | null;
  status: "ACTIVE" | "REVOKED";
  trustedUntilUtc: string;
  firstSeenAtUtc: string;
  lastSeenAtUtc: string;
  revokedAtUtc: string | null;
};

type RevokedSession = {
  id: string;
  userId: string;
  scope: "SINGLE_SESSION" | "ALL_FOR_USER";
  reason: string;
  revokedAtUtc: string;
  revokedByUserId: string | null;
};

type RiskSnapshot = {
  level: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  score: number;
  signalCount: number;
};

const LEVELS: MfaPolicyLevel[] = [
  "OFF",
  "ADMINS_ONLY",
  "REVIEWERS_AND_ABOVE",
  "ALL_MEMBERS",
  "HIGH_RISK_ONLY",
];

// Phase 38.10 — wrap in canonical PageRouteGate.
export default function SecurityCenterPage() {
  return (
    <PageRouteGate routeId="workspace.security_center">
      <SecurityCenterPageInner />
    </PageRouteGate>
  );
}

function SecurityCenterPageInner() {
  const teamId = useTeamId();
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [requirement, setRequirement] = useState<CurrentUserRequirement | null>(
    null,
  );
  const [devices, setDevices] = useState<TrustedDevice[] | null>(null);
  const [revocations, setRevocations] = useState<RevokedSession[] | null>(null);
  const [myRisk, setMyRisk] = useState<RiskSnapshot | null>(null);
  // R8.1.3 — per-user MFA enrollment status. Sourced from the
  // canonical orchestrator's read-only `/v1/identity/mfa/factors`.
  const [myMfa, setMyMfa] = useState<{
    hasMfa: boolean;
    activeFactors: number;
    recoveryCodesRemaining: number;
  } | null>(null);
  // R8.1.4 — admin view of pending lost-factor recovery requests
  // for the active team. Empty list when there are none OR when the
  // operator isn't an admin of the team (the API returns 403).
  const [pendingRecoveryRequests, setPendingRecoveryRequests] = useState<
    ReadonlyArray<{
      id: string;
      userId: string;
      reason: string;
      requiredApprovals: number;
      approvalCount: number;
      expiresAt: string;
      createdAt: string;
    }>
  >([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm } = useConfirmAction();

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    const qs = `?teamId=${encodeURIComponent(teamId)}`;
    Promise.all([
      apiFetch(`/v1/identity-security/mfa-policy${qs}`, { method: "GET" }),
      apiFetch(`/v1/identity-security/devices${qs}`, { method: "GET" }).catch(
        () => ({ devices: [] }),
      ),
      apiFetch(`/v1/identity-security/sessions${qs}`, { method: "GET" }).catch(
        () => ({ revoked: [] }),
      ),
      apiFetch(`/v1/identity-security/risk/me${qs}`, { method: "GET" }).catch(
        () => null,
      ),
      // R8.1.3 — current operator's MFA enrollment snapshot.
      apiFetch(`/v1/identity/mfa/factors`, { method: "GET" }).catch(
        () => null,
      ),
      // R8.1.4 — admin queue of lost-factor recovery requests for
      // the active team. The endpoint enforces OWNER/ADMIN scope
      // and returns 403 for non-admins; we treat 403 as "empty list".
      apiFetch(
        `/v1/identity/mfa-admin/recovery-requests/${encodeURIComponent(
          teamId,
        )}`,
        { method: "GET" },
      ).catch(() => ({ requests: [] })),
    ])
      .then(
        ([p, d, s, r, mfa, rec]: [
          { policy: Policy; currentUserRequirement: CurrentUserRequirement },
          { devices: TrustedDevice[] },
          { revoked: RevokedSession[] },
          RiskSnapshot | null,
          {
            hasMfa: boolean;
            factors: ReadonlyArray<{ status: string }>;
            recoveryCodesRemaining: number;
          } | null,
          {
            requests?: ReadonlyArray<{
              id: string;
              userId: string;
              reason: string;
              requiredApprovals: number;
              approvalCount: number;
              expiresAt: string;
              createdAt: string;
            }>;
          },
        ]) => {
          if (cancelled) return;
          setPolicy(p.policy);
          setRequirement(p.currentUserRequirement);
          setDevices(d.devices ?? []);
          setRevocations(s.revoked ?? []);
          setMyRisk(r);
          if (mfa) {
            setMyMfa({
              hasMfa: mfa.hasMfa,
              activeFactors: mfa.factors.filter((f) => f.status === "ACTIVE")
                .length,
              recoveryCodesRemaining: mfa.recoveryCodesRemaining,
            });
          } else {
            setMyMfa(null);
          }
          setPendingRecoveryRequests(rec.requests ?? []);
          setError(null);
        },
      )
      .catch((err: { message?: string }) => {
        if (cancelled) return;
        setError(err?.message ?? "Could not load security data.");
      });
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  async function changeLevel(level: MfaPolicyLevel) {
    if (!teamId) return;
    setBusy(true);
    try {
      // MFA policy change is itself a sensitive action; without a
      // step-up challenge the API returns 401 STEP_UP_REQUIRED. The
      // UI surfaces that here.
      const res: { policy?: Policy; error?: { code?: string } } = await apiFetch(
        "/v1/identity-security/mfa-policy",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ teamId, level }),
        },
      );
      if (res.error && res.error.code === "STEP_UP_REQUIRED") {
        alert(
          "Step-up verification required to change MFA policy. Start a step-up challenge from the operator menu and retry.",
        );
        return;
      }
      if (res.policy) setPolicy(res.policy);
    } catch (err) {
      alert((err as { message?: string })?.message ?? "Policy change failed.");
    } finally {
      setBusy(false);
    }
  }

  async function revokeDevice(deviceId: string) {
    if (!teamId) return;
    const reason = window.prompt("Reason for revoking this device (internal only)");
    if (!reason || reason.trim().length === 0) return;
    setBusy(true);
    try {
      await apiFetch(`/v1/identity-security/devices/${deviceId}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId, reason }),
      });
      const fresh: { devices: TrustedDevice[] } = await apiFetch(
        `/v1/identity-security/devices?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      );
      setDevices(fresh.devices ?? []);
    } catch (err) {
      alert((err as { message?: string })?.message ?? "Revoke failed.");
    } finally {
      setBusy(false);
    }
  }

  async function revokeAllForUser(userId: string) {
    if (!teamId) return;
    const ok = await confirm({
      title: "Revoke ALL active sessions for this user?",
      description:
        "The user will be signed out from every device. They can sign back in if their account is otherwise active.",
      confirmLabel: "Revoke all sessions",
      tone: "danger",
      testId: "security-center-revoke-all-for-user",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await apiFetch("/v1/identity-security/sessions/revoke-all", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId, userId, reason: "OPERATOR_REVOKED" }),
      });
      const fresh: { revoked: RevokedSession[] } = await apiFetch(
        `/v1/identity-security/sessions?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      );
      setRevocations(fresh.revoked ?? []);
    } catch (err) {
      alert((err as { message?: string })?.message ?? "Revoke-all failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={pageStyle}>
      <header>
        <h1 style={titleStyle}>Identity &amp; Security</h1>
        <p style={mutedStyle}>
          Workspace identity operations: MFA policy, trusted devices,
          session revocations, MFA recovery approvals, and the current
          operator&apos;s risk snapshot. State is read in real time and
          never cached client-side beyond the page lifecycle. For
          personal account controls (password, your sessions, security
          events), open{" "}
          <Link href="/settings/security" style={linkStyle}>
            Account security
          </Link>
          .
        </p>
      </header>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      {/* Phase IA-collapse — `PersonalSecuritySections` (password,
          sessions, security events) moved to `/settings/security`
          (route id `account.security`). This console is now purely
          workspace operator-facing. */}

      {!teamId ? (
        <p style={mutedStyle}>Switch to a workspace to use security center.</p>
      ) : (
        <>
          {/* Phase Final-Hidden-Feature-Surfacing — AccessAnomaly card.
              Workspace anomaly detector output (OPEN + ACKNOWLEDGED)
              read from the canonical service via the thin
              `/v1/security-center/access-anomalies` route. */}
          <AccessAnomaliesCard teamId={teamId} />

          {/* Phase Final-Hidden-Feature-Surfacing — workspace health
              snapshot. Reads the latest OrganizationalHealthSnapshot
              row via the new `/v1/dashboard/org-health` route. */}
          <OrgHealthSnapshotCard teamId={teamId} />

          <section style={cardStyle}>
            <h2 style={sectionTitleStyle}>MFA policy</h2>
            {policy ? (
              <>
                <p style={mutedStyle}>
                  Current level: <strong>{policy.level}</strong> · step-up TTL{" "}
                  {policy.stepUpTtlSeconds}s · trusted-device TTL{" "}
                  {policy.trustedDeviceTtlDays}d
                </p>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {LEVELS.map((l) => (
                    <button
                      key={l}
                      type="button"
                      disabled={busy || policy.level === l}
                      style={
                        policy.level === l ? primaryButtonStyle : secondaryButtonStyle
                      }
                      onClick={() => void changeLevel(l)}
                    >
                      {l}
                    </button>
                  ))}
                </div>
                {requirement?.required ? (
                  <p style={warnBoxStyle}>
                    Step-up verification is currently required for your role
                    ({requirement.reason}).
                  </p>
                ) : null}
              </>
            ) : (
              <p style={mutedStyle}>Loading…</p>
            )}
          </section>

          {/* R8.1.3 — operator's own MFA enrollment snapshot. Surfaces
              policy-vs-enrollment delta so an admin who turned on
              REQUIRED_FOR_ALL can see whether THEIR own account is
              actually compliant. */}
          <section
            style={cardStyle}
            data-cc-mfa-enrollment-card
          >
            <h2 style={sectionTitleStyle}>Your MFA enrollment</h2>
            {myMfa ? (
              <>
                <p style={mutedStyle}>
                  Active factors: <strong>{myMfa.activeFactors}</strong>{" "}
                  · recovery codes remaining:{" "}
                  <strong>{myMfa.recoveryCodesRemaining}</strong>
                </p>
                {!myMfa.hasMfa &&
                policy &&
                policy.level !== "OFF" ? (
                  <p style={warnBoxStyle} data-cc-mfa-enrollment-warning>
                    This workspace requires MFA but you have no
                    enrolled factor. Enroll an authenticator to keep
                    access to sensitive operations.
                  </p>
                ) : null}
                {!myMfa.hasMfa ? (
                  <p style={mutedStyle}>
                    Enroll an authenticator from the operator menu
                    (Account → Two-factor) to satisfy organization
                    policy.
                  </p>
                ) : null}
              </>
            ) : (
              <p style={mutedStyle}>Loading…</p>
            )}
          </section>

          {/* R8.1.4 — admin queue of pending lost-factor recovery
              requests for the active team. The API returns 403 for
              non-admins; the empty-list render path covers both the
              "no requests pending" AND the "not an admin" cases. */}
          {pendingRecoveryRequests.length > 0 ? (
            <section
              style={cardStyle}
              data-cc-mfa-recovery-admin-card
            >
              <h2 style={sectionTitleStyle}>
                Pending MFA recovery requests
              </h2>
              <p style={mutedStyle}>
                Members who have requested a lost-factor reset. Each
                approval revokes the user's current MFA factors and
                forces them to re-enroll on next login — it does NOT
                grant a session.
              </p>
              <ul style={listStyle}>
                {pendingRecoveryRequests.map((rq) => (
                  <li
                    key={rq.id}
                    style={rowStyle}
                    data-cc-mfa-recovery-request-row
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>
                        User <span style={chipStyle}>{rq.userId.slice(0, 8)}…</span>
                      </div>
                      <div style={mutedStyle}>
                        {rq.reason}
                      </div>
                      <div style={mutedStyle}>
                        approvals {rq.approvalCount}/{rq.requiredApprovals} ·
                        expires{" "}
                        {formatUtcAuditDateTime(rq.expiresAt)}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
              <p style={mutedStyle}>
                Approve, reject, or audit each request from the
                dedicated admin console.
              </p>
              <p>
                <Link
                  href="/security-center/mfa-recovery"
                  data-cc-link="mfa-recovery-console"
                  style={{
                    display: "inline-block",
                    padding: "8px 14px",
                    fontWeight: 600,
                    color: "#fff",
                    background: "#0f172a",
                    border: 0,
                    borderRadius: 8,
                    textDecoration: "none",
                    fontSize: 13,
                  }}
                >
                  Open MFA recovery console →
                </Link>
              </p>
            </section>
          ) : null}

          <section style={cardStyle}>
            <h2 style={sectionTitleStyle}>My session risk</h2>
            {myRisk ? (
              <div style={summaryRowStyle}>
                <Stat label="Level" value={myRisk.level} />
                <Stat label="Score" value={String(myRisk.score)} />
                <Stat label="Signals" value={String(myRisk.signalCount)} />
              </div>
            ) : (
              <p style={mutedStyle}>Loading…</p>
            )}
            <p style={mutedStyle}>
              Detailed signal kinds are visible to operators with access
              review permission only.
            </p>
          </section>

          <section style={cardStyle}>
            <h2 style={sectionTitleStyle}>Trusted devices</h2>
            {devices === null ? (
              <p style={mutedStyle}>Loading…</p>
            ) : devices.length === 0 ? (
              <p style={mutedStyle}>No trusted devices recorded.</p>
            ) : (
              <ul style={listStyle}>
                {devices.map((d) => (
                  <li key={d.id} style={rowStyle}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>
                        {d.uaPreview ?? "Unknown device"}{" "}
                        <span style={chipStyle}>{d.userId.slice(0, 8)}…</span>
                      </div>
                      <div style={mutedStyle}>
                        ip {d.ipPreview ?? "—"} · last seen{" "}
                        {formatUtcAuditDateTime(d.lastSeenAtUtc)} ·
                        trusted until{" "}
                        {formatUserDate(d.trustedUntilUtc)}
                      </div>
                    </div>
                    <span style={statusBadgeStyle(d.status)}>{d.status}</span>
                    {d.status === "ACTIVE" ? (
                      <button
                        type="button"
                        style={dangerButtonStyle}
                        disabled={busy}
                        onClick={() => void revokeDevice(d.id)}
                      >
                        Revoke
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section style={cardStyle}>
            <h2 style={sectionTitleStyle}>Recent session revocations</h2>
            {revocations === null ? (
              <p style={mutedStyle}>Loading…</p>
            ) : revocations.length === 0 ? (
              <p style={mutedStyle}>No revocations recorded.</p>
            ) : (
              <ul style={listStyle}>
                {revocations.map((r) => (
                  <li key={r.id} style={rowStyle}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>
                        {r.userId.slice(0, 8)}… <span style={chipStyle}>{r.scope}</span>
                      </div>
                      <div style={mutedStyle}>
                        reason {r.reason} · at{" "}
                        {formatUtcAuditDateTime(r.revokedAtUtc)}
                      </div>
                    </div>
                    <button
                      type="button"
                      style={dangerButtonStyle}
                      disabled={busy}
                      onClick={() => void revokeAllForUser(r.userId)}
                    >
                      Revoke all for user
                    </button>
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
// Phase IA-collapse — inline link to Account security home.
const linkStyle: React.CSSProperties = {
  color: "#0f172a",
  textDecoration: "underline",
  fontWeight: 600,
};
const cardStyle: React.CSSProperties = {
  marginTop: 24,
  padding: 20,
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  background: "#fff",
};
const summaryRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
  gap: 12,
  marginBottom: 12,
};
const statStyle: React.CSSProperties = {
  padding: 10,
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
const chipStyle: React.CSSProperties = {
  padding: "2px 6px",
  fontSize: 10,
  fontWeight: 600,
  borderRadius: 999,
  background: "#eff6ff",
  color: "#1e40af",
  border: "1px solid #93c5fd",
  marginLeft: 6,
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
const warnBoxStyle: React.CSSProperties = {
  marginTop: 8,
  padding: 12,
  background: "#fffbeb",
  color: "#92400e",
  border: "1px solid #fcd34d",
  borderRadius: 8,
  fontSize: 13,
};
const primaryButtonStyle: React.CSSProperties = {
  padding: "6px 14px",
  fontWeight: 600,
  color: "#fff",
  background: "#0f172a",
  border: 0,
  borderRadius: 8,
  cursor: "pointer",
  fontSize: 12,
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

function statusBadgeStyle(status: string): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: "4px 10px",
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 999,
    border: "1px solid",
    whiteSpace: "nowrap",
  };
  if (status === "ACTIVE") {
    return { ...base, background: "#f0fdf4", borderColor: "#86efac", color: "#166534" };
  }
  if (status === "REVOKED") {
    return { ...base, background: "#fef2f2", borderColor: "#fecaca", color: "#7f1d1d" };
  }
  return { ...base, background: "#eff6ff", borderColor: "#93c5fd", color: "#1e40af" };
}
