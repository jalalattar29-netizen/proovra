"use client";

/**
 * PHASE 12B — Concurrent-session policy impact. Product surface for
 *
 *   GET /v1/identity-security/session-policy-impact?teamId
 *
 * The organization security policy carries a concurrent-session limit, an
 * absolute session age and an idle timeout, but nothing showed what those
 * settings actually DO to the live inventory: an operator could set a limit
 * of 2 and never learn that six members were sitting on five sessions each.
 *
 * THE CLIENT COMPUTES NOTHING. `overLimit` and `excessSessionCount` are
 * decided by the server against the authoritative policy row; this section
 * only renders them. The workspace comes from `lib/platform-context`.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../../lib/api";
import { useTeamId, useTenantGuard } from "../../../../../../lib/platform-context";
import { Badge } from "../../../../../../components/ui/Badge";
import { Button } from "../../../../../../components/ui/Button";
import { Card } from "../../../../../../components/ui/Card";
import {
  DataTable,
  type DataTableColumn,
} from "../../../../../../components/ui/DataTable";
import { EmptyState } from "../../../../../../components/ui/EmptyState";
import { PageSection } from "../../../../../../components/ui/PageShell";
import {
  NoWorkspaceSelected,
  SectionDenied,
  SectionPlanGated,
  SectionError,
  SectionLoading,
  classifyError,
  sectionMuted,
  type SectionState,
} from "../../../security/_sections/section-state";
import { shortId } from "../../_sections/identity-admin-shared";

type ImpactRow = {
  userId: string;
  role: string;
  activeSessionCount: number;
  overLimit: boolean;
  excessSessionCount: number;
};

type ImpactEnvelope = {
  policy: {
    policyProvisioned: boolean;
    policyVersion: number;
    concurrentSessionLimit: number | null;
    maxSessionAgeSeconds: number | null;
    idleTimeoutSeconds: number | null;
    stepUpIntervalSeconds: number | null;
  };
  membersOverLimit: number;
  impact: ImpactRow[];
};

function seconds(value: number | null): string {
  if (value === null) return "not set";
  if (value % 3600 === 0) return `${value / 3600} h`;
  if (value % 60 === 0) return `${value / 60} min`;
  return `${value} s`;
}

export function SessionPolicyImpactSection() {
  const teamId = useTeamId();
  const { stamp, isStale } = useTenantGuard();
  const [state, setState] = useState<SectionState<ImpactEnvelope>>({ kind: "loading" });

  const load = useCallback(async () => {
    if (!teamId) return;
    setState({ kind: "loading" });
    const captured = stamp();
    try {
      const res = (await apiFetch(
        `/v1/identity-security/session-policy-impact?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      )) as ImpactEnvelope | null;
      if (isStale(captured)) return;
      if (!res?.policy) {
        setState({
          kind: "error",
          message: "The server did not return a session-policy projection.",
        });
        return;
      }
      setState({ kind: "ready", data: res });
    } catch (err) {
      if (isStale(captured)) return;
      setState(
        classifyError<ImpactEnvelope>(
          err,
          "We couldn't load the session-policy impact.",
        ),
      );
    }
  }, [teamId, stamp, isStale]);

  useEffect(() => {
    void load();
  }, [load]);

  const description =
    "What this organization's session limits mean in practice right now. Every judgement below — whether a member is over the concurrent-session limit and by how much — is made on the server against the authoritative policy row.";

  if (!teamId) {
    return (
      <PageSection title="Session policy impact" description={description}>
        <NoWorkspaceSelected purpose="Switch to a workspace to see how its session limits apply." />
      </PageSection>
    );
  }
  if (state.kind === "loading") {
    return (
      <PageSection title="Session policy impact" description={description}>
        <SectionLoading label="Comparing live sessions against the policy…" />
      </PageSection>
    );
  }
  if (state.kind === "denied") {
    return (
      <PageSection title="Session policy impact" description={description}>
        <SectionDenied message={state.message} />
      </PageSection>
    );
  }
  if (state.kind === "plan_gated") {
    return (
      <PageSection title="Session policy impact" description={description}>
        <SectionPlanGated
            message={state.message}
            feature={state.feature}
            upgradeCta={state.upgradeCta}
          />
      </PageSection>
    );
  }
  if (state.kind === "error") {
    return (
      <PageSection title="Session policy impact" description={description}>
        <SectionError message={state.message} onRetry={() => void load()} />
      </PageSection>
    );
  }

  const { policy, membersOverLimit, impact } = state.data;

  const columns: DataTableColumn<ImpactRow>[] = [
    {
      key: "user",
      header: "Member",
      render: (r) => (
        <code className="adm-mono" title={r.userId}>
          {shortId(r.userId)}
        </code>
      ),
    },
    { key: "role", header: "Role", render: (r) => <Badge tone="neutral">{r.role}</Badge> },
    {
      key: "count",
      header: "Live sessions",
      nowrap: true,
      render: (r) => <span style={{ fontSize: 13 }}>{r.activeSessionCount}</span>,
    },
    {
      key: "verdict",
      header: "Against the limit",
      render: (r) =>
        r.overLimit ? (
          <Badge tone="risk">
            {r.excessSessionCount} over the limit
          </Badge>
        ) : (
          <Badge tone="verified">within the limit</Badge>
        ),
    },
  ];

  return (
    <PageSection
      title="Session policy impact"
      description={description}
      data-session-policy-impact
      action={
        <Button variant="secondary" onClick={() => void load()}>
          Refresh
        </Button>
      }
    >
      <Card padding="comfortable" style={{ marginBottom: 12 }}>
        {!policy.policyProvisioned ? (
          <p style={{ margin: 0, fontSize: 13 }}>
            This organization has no security-policy row yet, so no session limits
            apply. Provision one from the security policy editor to start
            constraining sessions.
          </p>
        ) : (
          <>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Badge tone="neutral">policy version {policy.policyVersion}</Badge>
              <Badge
                tone={policy.concurrentSessionLimit === null ? "neutral" : "info"}
              >
                Concurrent limit:{" "}
                {policy.concurrentSessionLimit === null
                  ? "not set"
                  : policy.concurrentSessionLimit}
              </Badge>
              <Badge tone="neutral">
                Max session age: {seconds(policy.maxSessionAgeSeconds)}
              </Badge>
              <Badge tone="neutral">
                Idle timeout: {seconds(policy.idleTimeoutSeconds)}
              </Badge>
              <Badge tone="neutral">
                Step-up interval: {seconds(policy.stepUpIntervalSeconds)}
              </Badge>
              <Badge tone={membersOverLimit > 0 ? "risk" : "verified"}>
                {membersOverLimit} member{membersOverLimit === 1 ? "" : "s"} over the
                limit
              </Badge>
            </div>
            {policy.concurrentSessionLimit === null ? (
              <p style={{ ...sectionMuted, margin: "8px 0 0" }}>
                No concurrent-session limit is configured, so no member can be over
                it. The counts below are still the live inventory.
              </p>
            ) : null}
          </>
        )}
      </Card>

      <DataTable
        columns={columns}
        rows={impact}
        getRowId={(r) => r.userId}
        ariaLabel="Session policy impact per member"
        emptyState={
          <EmptyState variant="inline"
            title="No active members"
            purpose="This workspace has no active members, so there is nothing for the session limits to apply to."
          />
        }
      />
    </PageSection>
  );
}

export default SessionPolicyImpactSection;
