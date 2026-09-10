"use client";

/**
 * PHASE 12B — Member MFA lifecycle. Product surface for
 *
 *   GET  /v1/identity/mfa-admin/posture/:teamId/:userId
 *   POST /v1/identity/mfa-admin/factors/:teamId/:userId/:factorId/revoke
 *   POST /v1/identity/mfa-admin/factors/:teamId/:userId/require-reenrollment
 *   POST /v1/identity/mfa-admin/trusted-devices/:teamId/:userId/reset
 *
 * All four were registered with no consumer: a workspace could have a member
 * locked out of, or over-trusted by, their second factor and no operator had
 * a way to see or change it.
 *
 * TENANT SAFETY
 *   * The workspace comes from `lib/platform-context`. The `:teamId` in the
 *     path is that value — never typed by the operator — and the server
 *     independently AUTHORIZES it (a cross-Organization id is a concealed
 *     404, not a 403).
 *   * The `:userId` is picked from the server-projected member list
 *     (`GET /v1/identity/members?teamId=`). There is no free-text UUID field.
 *   * `useTenantGuard` drops any response that lands after a workspace
 *     switch.
 *
 * Every mutation is confirmed, step-up gated on the server, and followed by
 * a fresh read of the server projection. Nothing here renders a factor
 * secret, a TOTP seed, a recovery code, or a device fingerprint — the
 * projection does not contain them.
 */

import { useCallback, useEffect, useState } from "react";

import { describeClient } from "../../../../../lib/ui/describeClient";
import { apiFetch } from "../../../../../lib/api";
import { notifyApiError } from "../../../../../lib/feedback/notify";
import { useTeamId, useTenantGuard } from "../../../../../lib/platform-context";
import { useToast } from "../../../../../components/ui";
import { Badge } from "../../../../../components/ui/Badge";
import { Button } from "../../../../../components/ui/Button";
import { Card } from "../../../../../components/ui/Card";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import { DataTable, type DataTableColumn } from "../../../../../components/ui/DataTable";
import { EmptyState } from "../../../../../components/ui/EmptyState";
import { PageSection } from "../../../../../components/ui/PageShell";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../../components/identity-security/StepUpModal";
import { formatUserDateTime } from "../../../../../lib/date";
import {
  NoWorkspaceSelected,
  SectionDenied,
  SectionPlanGated,
  SectionDescription,
  SectionError,
  SectionLoading,
  classifyError,
  sectionInputStyle,
  sectionLabelStyle,
  sectionMuted,
  type SectionState,
} from "./section-state";

type Member = {
  teamMemberId: string;
  userId: string;
  role: string;
  status: string;
};

type Posture = {
  posture: {
    userId: string;
    activeFactorCount: number;
    recoveryCodesRemaining: number;
    lastUsedAt: string | null;
    enrollmentRequired: boolean;
    pendingRecoveryRequestId: string | null;
  };
  factors: Array<{
    id: string;
    kind: string;
    status: string;
    label: string;
    createdAt: string;
    lastUsedAt: string | null;
  }>;
  trustedDevices: Array<{
    id: string;
    userId: string;
    uaPreview: string | null;
    ipPreview: string | null;
    status: string;
    trustedUntilUtc: string;
    lastSeenAtUtc: string;
  }>;
};

function when(value: string | null): string {
  return value ? formatUserDateTime(value) : "—";
}

export function MfaMemberPostureSection() {
  const teamId = useTeamId();
  const { stamp, isStale } = useTenantGuard();
  const { addToast } = useToast();
  const { confirm } = useConfirmAction();
  const stepUp = useStepUpAction({ teamId });

  const [members, setMembers] = useState<SectionState<Member[]>>({ kind: "loading" });
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [posture, setPosture] = useState<SectionState<Posture> | null>(null);
  const [reason, setReason] = useState("Security operations review");
  const [busy, setBusy] = useState<string | null>(null);

  const loadMembers = useCallback(async () => {
    if (!teamId) return;
    setMembers({ kind: "loading" });
    const captured = stamp();
    try {
      const res = (await apiFetch(
        `/v1/identity/members?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      )) as { members?: Member[] } | null;
      if (isStale(captured)) return;
      const rows = (res?.members ?? []).filter((m) => m.status === "ACTIVE");
      setMembers({ kind: "ready", data: rows });
    } catch (err) {
      if (isStale(captured)) return;
      setMembers(classifyError<Member[]>(err, "We couldn't load the member list."));
    }
  }, [teamId, stamp, isStale]);

  const loadPosture = useCallback(
    async (userId: string) => {
      if (!teamId) return;
      setPosture({ kind: "loading" });
      const captured = stamp();
      try {
        const res = (await apiFetch(
          `/v1/identity/mfa-admin/posture/${encodeURIComponent(teamId)}/${encodeURIComponent(userId)}`,
          { method: "GET" },
        )) as Posture | null;
        if (isStale(captured)) return;
        if (!res?.posture) {
          setPosture({
            kind: "error",
            message: "The server did not return an MFA posture for that member.",
          });
          return;
        }
        setPosture({ kind: "ready", data: res });
      } catch (err) {
        if (isStale(captured)) return;
        setPosture(
          classifyError<Posture>(err, "We couldn't read that member's MFA posture."),
        );
      }
    },
    [teamId, stamp, isStale],
  );

  // Workspace switch clears the selection so a member from workspace A can
  // never be shown under workspace B's heading.
  useEffect(() => {
    setSelectedUserId(null);
    setPosture(null);
    void loadMembers();
  }, [loadMembers]);

  useEffect(() => {
    if (selectedUserId) void loadPosture(selectedUserId);
  }, [selectedUserId, loadPosture]);

  const runMutation = useCallback(
    async (opts: {
      key: string;
      path: string;
      body: Record<string, unknown>;
      confirmTitle: string;
      confirmDescription: string;
      confirmLabel: string;
      successMessage: string;
      failureMessage: string;
    }) => {
      if (!teamId || !selectedUserId) return;
      const ok = await confirm({
        title: opts.confirmTitle,
        description: opts.confirmDescription,
        confirmLabel: opts.confirmLabel,
        tone: "danger",
        testId: opts.key,
      });
      if (!ok) return;
      const captured = stamp();
      setBusy(opts.key);
      try {
        await stepUp.runStepUpAction(async (headers) =>
          apiFetch(opts.path, {
            method: "POST",
            headers: { "content-type": "application/json", ...(headers ?? {}) },
            body: JSON.stringify(opts.body),
          }),
        );
        if (isStale(captured)) return;
        addToast(opts.successMessage, "success");
        // Reload from the server projection — never patch local state.
        await loadPosture(selectedUserId);
      } catch (err) {
        if (isStale(captured)) return;
        const code = ((err as { code?: string }).code ?? "").toUpperCase();
        if (code === "STEP_UP_CANCEL") return;
        notifyApiError(addToast, err, { message: opts.failureMessage });
      } finally {
        setBusy(null);
      }
    },
    [teamId, selectedUserId, confirm, stepUp, stamp, isStale, addToast, loadPosture],
  );

  const description = (
    <SectionDescription text="Read and reset a single member's second-factor state. Nothing on this panel exposes a factor secret, an authenticator seed, a recovery code, or a device fingerprint — those never leave the server. Revoking factors only forces the member through enrollment on their next sign-in; it never lets an administrator sign in as them." />
  );

  if (!teamId) {
    return (
      <PageSection title="Member MFA lifecycle" description={description}>
        <NoWorkspaceSelected purpose="Switch to a workspace to administer its members' second factors." />
      </PageSection>
    );
  }

  if (members.kind === "loading") {
    return (
      <PageSection title="Member MFA lifecycle" description={description}>
        <SectionLoading label="Reading the workspace member list…" />
      </PageSection>
    );
  }
  if (members.kind === "denied") {
    return (
      <PageSection title="Member MFA lifecycle" description={description}>
        <SectionDenied message={members.message} />
      </PageSection>
    );
  }
  if (members.kind === "plan_gated") {
    return (
      <PageSection title="Member MFA lifecycle" description={description}>
        <SectionPlanGated
            message={members.message}
            feature={members.feature}
            upgradeCta={members.upgradeCta}
          />
      </PageSection>
    );
  }
  if (members.kind === "error") {
    return (
      <PageSection title="Member MFA lifecycle" description={description}>
        <SectionError message={members.message} onRetry={() => void loadMembers()} />
      </PageSection>
    );
  }

  const factorColumns: DataTableColumn<Posture["factors"][number]>[] = [
    {
      key: "label",
      header: "Factor",
      render: (f) => (
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, overflowWrap: "anywhere" }}>
            {f.label}
          </div>
          <div style={sectionMuted}>{f.kind}</div>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (f) => (
        <Badge tone={f.status === "ACTIVE" ? "verified" : "neutral"}>{f.status}</Badge>
      ),
    },
    {
      key: "created",
      header: "Enrolled",
      nowrap: true,
      render: (f) => <span style={sectionMuted}>{when(f.createdAt)}</span>,
    },
    {
      key: "used",
      header: "Last used",
      nowrap: true,
      render: (f) => <span style={sectionMuted}>{when(f.lastUsedAt)}</span>,
    },
  ];

  const deviceColumns: DataTableColumn<Posture["trustedDevices"][number]>[] = [
    {
      key: "device",
      header: "Device",
      render: (d) => (
        <div style={{ fontSize: 12 }}>
          <div title={d.uaPreview ?? undefined}>
            {describeClient(d.uaPreview) ?? "Unrecognised client"}
          </div>
          <div style={sectionMuted}>{d.ipPreview ?? "no network preview"}</div>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (d) => (
        <Badge tone={d.status === "ACTIVE" ? "verified" : "neutral"}>{d.status}</Badge>
      ),
    },
    {
      key: "until",
      header: "Trusted until",
      nowrap: true,
      render: (d) => <span style={sectionMuted}>{when(d.trustedUntilUtc)}</span>,
    },
    {
      key: "seen",
      header: "Last seen",
      nowrap: true,
      render: (d) => <span style={sectionMuted}>{when(d.lastSeenAtUtc)}</span>,
    },
  ];

  return (
    <PageSection
      title="Member MFA lifecycle"
      description={description}
      data-mfa-member-posture
    >
      <Card padding="comfortable" style={{ marginBottom: 14 }}>
        <div
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          }}
        >
          <label>
            <span style={sectionLabelStyle}>Member</span>
            <select
              value={selectedUserId ?? ""}
              onChange={(e) => setSelectedUserId(e.target.value || null)}
              style={sectionInputStyle}
              data-mfa-member-select
            >
              <option value="">Select a member…</option>
              {members.data.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.role} · {m.userId.slice(0, 8)}…
                </option>
              ))}
            </select>
            <span style={{ ...sectionMuted, display: "block", marginTop: 4 }}>
              Members are read from this workspace&apos;s server-projected roster.
            </span>
          </label>
          <label>
            <span style={sectionLabelStyle}>Reason (recorded in the audit log)</span>
            <input
              type="text"
              value={reason}
              maxLength={120}
              onChange={(e) => setReason(e.target.value)}
              style={sectionInputStyle}
            />
          </label>
        </div>
      </Card>

      {members.data.length === 0 ? (
        <EmptyState variant="inline"
          framed
          title="No active members"
          purpose="This workspace has no active members to administer."
        />
      ) : null}

      {!selectedUserId ? (
        <Card padding="comfortable">
          <p style={{ margin: 0, fontSize: 13, color: "var(--ink-muted)" }}>
            Select a member above to read their factor and trusted-device state.
          </p>
        </Card>
      ) : posture === null || posture.kind === "loading" ? (
        <SectionLoading label="Reading that member's MFA posture…" />
      ) : posture.kind === "denied" ? (
        <SectionDenied
          message={posture.message}
          hint="Either you are not an owner or admin of this workspace, or that member is not part of it. This is a refusal, not an empty posture."
        />
      ) : posture.kind === "plan_gated" ? (
        <SectionPlanGated
          message={posture.message}
          feature={posture.feature}
          upgradeCta={posture.upgradeCta}
        />
      ) : posture.kind === "error" ? (
        <SectionError
          message={posture.message}
          onRetry={() => void loadPosture(selectedUserId)}
        />
      ) : (
        <>
          <Card padding="comfortable" style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Badge
                tone={posture.data.posture.activeFactorCount > 0 ? "verified" : "risk"}
              >
                {posture.data.posture.activeFactorCount} active factor
                {posture.data.posture.activeFactorCount === 1 ? "" : "s"}
              </Badge>
              <Badge
                tone={
                  posture.data.posture.recoveryCodesRemaining > 0 ? "neutral" : "pending"
                }
              >
                {posture.data.posture.recoveryCodesRemaining} recovery codes left
              </Badge>
              <Badge tone={posture.data.posture.enrollmentRequired ? "pending" : "neutral"}>
                {posture.data.posture.enrollmentRequired
                  ? "Enrollment required"
                  : "Enrolled"}
              </Badge>
              {posture.data.posture.pendingRecoveryRequestId ? (
                <Badge tone="pending">Recovery request in flight</Badge>
              ) : null}
              <Badge tone="neutral">
                Last factor use: {when(posture.data.posture.lastUsedAt)}
              </Badge>
            </div>
            <div
              style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}
            >
              <Button
                variant="destructive"
                size="sm"
                loading={busy === "mfa-require-reenrollment"}
                disabled={busy !== null || reason.trim().length < 3}
                onClick={() =>
                  void runMutation({
                    key: "mfa-require-reenrollment",
                    path: `/v1/identity/mfa-admin/factors/${encodeURIComponent(
                      teamId,
                    )}/${encodeURIComponent(selectedUserId)}/require-reenrollment`,
                    body: { reason: reason.trim() },
                    confirmTitle: "Require this member to enrol again?",
                    confirmDescription:
                      "Every active factor for this member is revoked. They keep their account and their data; on their next sign-in they must enrol a new authenticator. This does not let anyone sign in as them.",
                    confirmLabel: "Require re-enrollment",
                    successMessage: "Re-enrollment required.",
                    failureMessage: "We couldn't require re-enrollment.",
                  })
                }
              >
                Require re-enrollment
              </Button>
              <Button
                variant="destructive"
                size="sm"
                loading={busy === "mfa-reset-trusted-devices"}
                disabled={busy !== null || reason.trim().length < 3}
                onClick={() =>
                  void runMutation({
                    key: "mfa-reset-trusted-devices",
                    path: `/v1/identity/mfa-admin/trusted-devices/${encodeURIComponent(
                      teamId,
                    )}/${encodeURIComponent(selectedUserId)}/reset`,
                    body: { reason: reason.trim() },
                    confirmTitle: "Reset every trusted device for this member?",
                    confirmDescription:
                      "All devices this member had marked as trusted stop being trusted. They will be asked for their second factor on each device again.",
                    confirmLabel: "Reset trusted devices",
                    successMessage: "Trusted devices reset.",
                    failureMessage: "We couldn't reset the trusted devices.",
                  })
                }
              >
                Reset trusted devices
              </Button>
            </div>
          </Card>

          <h3 style={{ fontSize: 13, fontWeight: 700, margin: "0 0 8px" }}>Factors</h3>
          <DataTable
            columns={factorColumns}
            rows={posture.data.factors}
            getRowId={(f) => f.id}
            ariaLabel="Member MFA factors"
            emptyState={
              <EmptyState variant="inline"
                title="No factors enrolled"
                purpose="This member has never enrolled an authenticator. They will be prompted to enrol if the policy requires it."
              />
            }
            rowActions={(f) =>
              f.status === "ACTIVE" ? (
                <Button
                  variant="destructive"
                  size="sm"
                  loading={busy === `mfa-revoke-factor-${f.id}`}
                  disabled={busy !== null || reason.trim().length < 3}
                  onClick={() =>
                    void runMutation({
                      key: `mfa-revoke-factor-${f.id}`,
                      path: `/v1/identity/mfa-admin/factors/${encodeURIComponent(
                        teamId,
                      )}/${encodeURIComponent(selectedUserId)}/${encodeURIComponent(
                        f.id,
                      )}/revoke`,
                      body: { reason: reason.trim() },
                      confirmTitle: "Revoke this factor?",
                      confirmDescription:
                        "This one authenticator stops working for the member. The factor row is kept as revoked so the audit trail survives. If it is their only factor they will have to enrol again.",
                      confirmLabel: "Revoke factor",
                      successMessage: "Factor revoked.",
                      failureMessage: "We couldn't revoke that factor.",
                    })
                  }
                >
                  Revoke
                </Button>
              ) : null
            }
          />

          <h3 style={{ fontSize: 13, fontWeight: 700, margin: "20px 0 8px" }}>
            Trusted devices
          </h3>
          <DataTable
            columns={deviceColumns}
            rows={posture.data.trustedDevices}
            getRowId={(d) => d.id}
            ariaLabel="Member trusted devices"
            emptyState={
              <EmptyState variant="inline"
                title="No trusted devices"
                purpose="This member has no trusted devices, so they are asked for their second factor every time the policy requires one."
              />
            }
          />
        </>
      )}

      <StepUpModal control={stepUp} />
    </PageSection>
  );
}

export default MfaMemberPostureSection;
