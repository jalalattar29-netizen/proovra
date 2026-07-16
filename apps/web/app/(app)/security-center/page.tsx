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

import { toSafeUserError } from "../../../lib/feedback/toSafeUserError";
import { useEffect, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../../lib/api";
import { formatUserDate, formatUtcAuditDateTime } from "../../../lib/date";
import { useTeamId } from "../../../lib/platform-context";
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { useConfirmAction } from "../../../components/ui/ConfirmActionModal";
import { PageShell, PageHeader, PageSection } from "../../../components/ui/PageShell";
import { Card } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import {
  DataTable,
  type DataTableColumn,
} from "../../../components/ui/DataTable";
import { EmptyState } from "../../../components/ui/EmptyState";
import { StatusBadge } from "../../../components/ui/StatusBadge";
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
        setError(toSafeUserError(err, { message: "Could not load security data." }).message);
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
      alert(toSafeUserError(err, { message: "Policy change failed." }).message);
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
      alert(toSafeUserError(err, { message: "Revoke failed." }).message);
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
      alert(toSafeUserError(err, { message: "Revoke-all failed." }).message);
    } finally {
      setBusy(false);
    }
  }

  const deviceColumns: DataTableColumn<TrustedDevice>[] = [
    {
      key: "device",
      header: "Device",
      render: (d) => (
        <div>
          <div style={{ fontWeight: 600 }}>
            {d.uaPreview ?? "Unknown device"}{" "}
            <span style={chipStyle}>{d.userId.slice(0, 8)}…</span>
          </div>
          <div style={mutedStyle}>
            ip {d.ipPreview ?? "—"} · last seen{" "}
            {formatUtcAuditDateTime(d.lastSeenAtUtc)} · trusted until{" "}
            {formatUserDate(d.trustedUntilUtc)}
          </div>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      nowrap: true,
      render: (d) => <StatusBadge status={d.status} />,
    },
  ];

  const revocationColumns: DataTableColumn<RevokedSession>[] = [
    {
      key: "user",
      header: "User",
      render: (r) => (
        <div>
          <div style={{ fontWeight: 600 }}>
            {r.userId.slice(0, 8)}… <span style={chipStyle}>{r.scope}</span>
          </div>
          <div style={mutedStyle}>
            reason {r.reason} · at {formatUtcAuditDateTime(r.revokedAtUtc)}
          </div>
        </div>
      ),
    },
  ];

  return (
    <PageShell
      header={
        <PageHeader
          eyebrow="Security Center"
          title="Identity & Security"
          subtitle={
            <>
              Workspace identity operations: MFA policy, trusted devices,
              session revocations, MFA recovery approvals, and the current
              operator&apos;s risk snapshot. State is read in real time and
              never cached client-side beyond the page lifecycle. For personal
              account controls (password, your sessions, security events),
              open{" "}
              <Link href="/settings/security" style={linkStyle}>
                Account security
              </Link>
              .
            </>
          }
        />
      }
    >
      {error ? (
        <Card variant="status" tone="risk">
          {error}
        </Card>
      ) : null}

      {/* Phase IA-collapse — `PersonalSecuritySections` (password,
          sessions, security events) moved to `/settings/security`
          (route id `account.security`). This console is now purely
          workspace operator-facing. */}

      {!teamId ? (
        <EmptyState
          framed
          title="Switch to a workspace to use security center"
          purpose="Identity and security operations are scoped to a workspace. Open a workspace you administer to manage MFA policy, trusted devices, and session revocations."
        />
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

          <PageSection title="MFA policy">
            <Card variant="admin">
              {policy ? (
                <>
                  <p style={{ ...mutedStyle, marginTop: 0 }}>
                    Current level: <strong>{policy.level}</strong> · step-up TTL{" "}
                    {policy.stepUpTtlSeconds}s · trusted-device TTL{" "}
                    {policy.trustedDeviceTtlDays}d
                  </p>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {LEVELS.map((l) => (
                      <Button
                        key={l}
                        variant={policy.level === l ? "primary" : "secondary"}
                        size="sm"
                        disabled={busy || policy.level === l}
                        onClick={() => void changeLevel(l)}
                      >
                        {l}
                      </Button>
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
                <p style={{ ...mutedStyle, margin: 0 }}>Loading…</p>
              )}
            </Card>
          </PageSection>

          {/* R8.1.3 — operator's own MFA enrollment snapshot. Surfaces
              policy-vs-enrollment delta so an admin who turned on
              REQUIRED_FOR_ALL can see whether THEIR own account is
              actually compliant. */}
          <PageSection title="Your MFA enrollment">
            <Card
              variant={
                myMfa && !myMfa.hasMfa && policy && policy.level !== "OFF"
                  ? "status"
                  : "summary"
              }
              tone="pending"
              data-cc-mfa-enrollment-card
            >
              {myMfa ? (
                <>
                  <p style={{ ...mutedStyle, marginTop: 0 }}>
                    Active factors: <strong>{myMfa.activeFactors}</strong> ·
                    recovery codes remaining:{" "}
                    <strong>{myMfa.recoveryCodesRemaining}</strong>
                  </p>
                  {!myMfa.hasMfa && policy && policy.level !== "OFF" ? (
                    <p style={warnBoxStyle} data-cc-mfa-enrollment-warning>
                      This workspace requires MFA but you have no enrolled
                      factor. Enroll an authenticator to keep access to
                      sensitive operations.
                    </p>
                  ) : null}
                  {!myMfa.hasMfa ? (
                    <p style={{ ...mutedStyle, marginBottom: 0 }}>
                      Enroll an authenticator under{" "}
                      <Link
                        href="/settings/security"
                        style={{ color: "inherit", textDecoration: "underline" }}
                      >
                        Settings → Account security
                      </Link>{" "}
                      to satisfy organization policy.
                    </p>
                  ) : null}
                </>
              ) : (
                <p style={{ ...mutedStyle, margin: 0 }}>Loading…</p>
              )}
            </Card>
          </PageSection>

          {/* R8.1.4 — admin queue of pending lost-factor recovery
              requests for the active team. The API returns 403 for
              non-admins; the empty-list render path covers both the
              "no requests pending" AND the "not an admin" cases. */}
          {pendingRecoveryRequests.length > 0 ? (
            <PageSection title="Pending MFA recovery requests">
              <Card variant="status" tone="pending" data-cc-mfa-recovery-admin-card>
                <p style={{ ...mutedStyle, marginTop: 0 }}>
                  Members who have requested a lost-factor reset. Each approval
                  revokes the user's current MFA factors and forces them to
                  re-enroll on next login — it does NOT grant a session.
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
                          User{" "}
                          <span style={chipStyle}>{rq.userId.slice(0, 8)}…</span>
                        </div>
                        <div style={mutedStyle}>{rq.reason}</div>
                        <div style={mutedStyle}>
                          approvals {rq.approvalCount}/{rq.requiredApprovals} ·
                          expires {formatUtcAuditDateTime(rq.expiresAt)}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
                <p style={mutedStyle}>
                  Approve, reject, or audit each request from the dedicated
                  admin console.
                </p>
                <Link href="/security-center/mfa-recovery" data-cc-link="mfa-recovery-console">
                  <Button variant="primary" size="sm">
                    Open MFA recovery console →
                  </Button>
                </Link>
              </Card>
            </PageSection>
          ) : null}

          <PageSection title="My session risk">
            <Card
              variant="status"
              tone={
                myRisk
                  ? myRisk.level === "LOW"
                    ? "verified"
                    : myRisk.level === "MEDIUM"
                      ? "pending"
                      : "risk"
                  : "neutral"
              }
            >
              {myRisk ? (
                <div style={summaryRowStyle}>
                  <Stat label="Level" value={myRisk.level} />
                  <Stat label="Score" value={String(myRisk.score)} />
                  <Stat label="Signals" value={String(myRisk.signalCount)} />
                </div>
              ) : (
                <p style={{ ...mutedStyle, marginTop: 0 }}>Loading…</p>
              )}
              <p style={{ ...mutedStyle, marginBottom: 0 }}>
                Detailed signal kinds are visible to operators with access
                review permission only.
              </p>
            </Card>
          </PageSection>

          <PageSection title="Trusted devices">
            <DataTable<TrustedDevice>
              ariaLabel="Trusted devices"
              columns={deviceColumns}
              rows={devices ?? []}
              getRowId={(d) => d.id}
              loading={devices === null}
              rowActions={(d) =>
                d.status === "ACTIVE" ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={busy}
                    onClick={() => void revokeDevice(d.id)}
                  >
                    Revoke
                  </Button>
                ) : null
              }
              emptyState={
                <EmptyState
                  compact
                  title="No trusted devices recorded"
                  purpose="Devices that operators have marked trusted for step-up appear here. Revoke a device to force a fresh challenge on its next sign-in."
                />
              }
            />
          </PageSection>

          <PageSection title="Recent session revocations">
            <DataTable<RevokedSession>
              ariaLabel="Recent session revocations"
              columns={revocationColumns}
              rows={revocations ?? []}
              getRowId={(r) => r.id}
              loading={revocations === null}
              rowActions={(r) => (
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy}
                  onClick={() => void revokeAllForUser(r.userId)}
                >
                  Revoke all for user
                </Button>
              )}
              emptyState={
                <EmptyState
                  compact
                  title="No revocations recorded"
                  purpose="Operator-initiated session revocations for this workspace are logged here."
                />
              }
            />
          </PageSection>
        </>
      )}
    </PageShell>
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

const mutedStyle: React.CSSProperties = { fontSize: 13, color: "#64748b" };
// Phase IA-collapse — inline link to Account security home.
const linkStyle: React.CSSProperties = {
  color: "#0f172a",
  textDecoration: "underline",
  fontWeight: 600,
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
const warnBoxStyle: React.CSSProperties = {
  marginTop: 8,
  padding: 12,
  background: "#fffbeb",
  color: "#92400e",
  border: "1px solid #fcd34d",
  borderRadius: 8,
  fontSize: 13,
};
