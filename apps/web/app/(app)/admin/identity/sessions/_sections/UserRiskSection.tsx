"use client";

/**
 * PHASE 12B — Member risk projection. Product surface for
 *
 *   GET /v1/identity-security/risk/user/:id?teamId
 *
 * The endpoint was registered with no consumer, so the risk signals that
 * decide whether a step-up is demanded — or whether an action is blocked
 * outright — were invisible to the operator deciding what to do about a
 * suspicious session.
 *
 * TENANT SAFETY: the member is chosen from the server-projected roster
 * (`GET /v1/identity/members?teamId=`), never typed as a UUID, and the
 * server independently verifies that the member belongs to the authorized
 * workspace — a stranger's id is a concealed 404, so this surface cannot be
 * used to probe for user ids.
 *
 * The score, the level and the signal reasons are all computed server-side.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../../lib/api";
import { useTeamId, useTenantGuard } from "../../../../../../lib/platform-context";
import { Badge, type BadgeTone } from "../../../../../../components/ui/Badge";
import { Card } from "../../../../../../components/ui/Card";
import {
  DataTable,
  type DataTableColumn,
} from "../../../../../../components/ui/DataTable";
import { EmptyState } from "../../../../../../components/ui/EmptyState";
import { PageSection } from "../../../../../../components/ui/PageShell";
import { formatUserDateTime } from "../../../../../../lib/date";
import {
  NoWorkspaceSelected,
  SectionDenied,
  SectionPlanGated,
  SectionError,
  SectionLoading,
  classifyError,
  sectionInputStyle,
  sectionLabelStyle,
  sectionMuted,
  type SectionState,
} from "../../../security/_sections/section-state";

type Member = { userId: string; role: string; status: string };

type RiskSignal = {
  kind: string;
  reason: string;
  observedAtUtc: string;
  expiresAtUtc: string | null;
};

type RiskSnapshot = {
  userId: string;
  level: string;
  score: number;
  signals: RiskSignal[];
};

function levelTone(level: string): BadgeTone {
  const v = level.toUpperCase();
  if (v === "CRITICAL" || v === "HIGH") return "risk";
  if (v === "MEDIUM") return "pending";
  return "verified";
}

export function UserRiskSection() {
  const teamId = useTeamId();
  const { stamp, isStale } = useTenantGuard();
  const [members, setMembers] = useState<SectionState<Member[]>>({ kind: "loading" });
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SectionState<RiskSnapshot> | null>(null);

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
      setMembers({
        kind: "ready",
        data: (res?.members ?? []).filter((m) => m.status === "ACTIVE"),
      });
    } catch (err) {
      if (isStale(captured)) return;
      setMembers(classifyError<Member[]>(err, "We couldn't load the member list."));
    }
  }, [teamId, stamp, isStale]);

  const loadSnapshot = useCallback(
    async (userId: string) => {
      if (!teamId) return;
      setSnapshot({ kind: "loading" });
      const captured = stamp();
      try {
        const res = (await apiFetch(
          `/v1/identity-security/risk/user/${encodeURIComponent(
            userId,
          )}?teamId=${encodeURIComponent(teamId)}`,
          { method: "GET" },
        )) as { snapshot?: RiskSnapshot } | null;
        if (isStale(captured)) return;
        if (!res?.snapshot) {
          setSnapshot({
            kind: "error",
            message: "The server did not return a risk projection for that member.",
          });
          return;
        }
        setSnapshot({ kind: "ready", data: res.snapshot });
      } catch (err) {
        if (isStale(captured)) return;
        setSnapshot(
          classifyError<RiskSnapshot>(err, "We couldn't read that member's risk."),
        );
      }
    },
    [teamId, stamp, isStale],
  );

  useEffect(() => {
    setSelectedUserId(null);
    setSnapshot(null);
    void loadMembers();
  }, [loadMembers]);

  useEffect(() => {
    if (selectedUserId) void loadSnapshot(selectedUserId);
  }, [selectedUserId, loadSnapshot]);

  const description =
    "The risk the server currently assigns to a member in this workspace, and the signals behind it. A HIGH or CRITICAL level is what makes the platform demand a step-up — or refuse a sensitive action outright. The score and every reason below are computed on the server; nothing here is inferred in the browser.";

  if (!teamId) {
    return (
      <PageSection title="Member risk" description={description}>
        <NoWorkspaceSelected purpose="Switch to a workspace to read its members' risk projections." />
      </PageSection>
    );
  }
  if (members.kind === "loading") {
    return (
      <PageSection title="Member risk" description={description}>
        <SectionLoading label="Reading the member list…" />
      </PageSection>
    );
  }
  if (members.kind === "denied") {
    return (
      <PageSection title="Member risk" description={description}>
        <SectionDenied message={members.message} />
      </PageSection>
    );
  }
  if (members.kind === "plan_gated") {
    return (
      <PageSection title="Member risk" description={description}>
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
      <PageSection title="Member risk" description={description}>
        <SectionError message={members.message} onRetry={() => void loadMembers()} />
      </PageSection>
    );
  }

  const signalColumns: DataTableColumn<RiskSignal>[] = [
    {
      key: "kind",
      header: "Signal",
      render: (s) => <span style={{ fontSize: 12.5, fontWeight: 600 }}>{s.kind}</span>,
    },
    {
      key: "reason",
      header: "Why it fired",
      render: (s) => (
        <span style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>{s.reason}</span>
      ),
    },
    {
      key: "observed",
      header: "Observed",
      nowrap: true,
      render: (s) => (
        <span style={sectionMuted}>{formatUserDateTime(s.observedAtUtc)}</span>
      ),
    },
    {
      key: "expires",
      header: "Expires",
      nowrap: true,
      render: (s) => (
        <span style={sectionMuted}>
          {s.expiresAtUtc ? formatUserDateTime(s.expiresAtUtc) : "does not expire"}
        </span>
      ),
    },
  ];

  return (
    <PageSection title="Member risk" description={description} data-user-risk-section>
      <Card padding="comfortable" style={{ marginBottom: 12 }}>
        <label style={{ maxWidth: 320, display: "block" }}>
          <span style={sectionLabelStyle}>Member</span>
          <select
            value={selectedUserId ?? ""}
            onChange={(e) => setSelectedUserId(e.target.value || null)}
            style={sectionInputStyle}
            data-user-risk-member-select
          >
            <option value="">Select a member…</option>
            {members.data.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.role} · {m.userId.slice(0, 8)}…
              </option>
            ))}
          </select>
          <span style={{ ...sectionMuted, display: "block", marginTop: 4 }}>
            Only members of this workspace are listed, and only they can be read.
          </span>
        </label>
      </Card>

      {!selectedUserId ? (
        <Card padding="comfortable">
          <p style={{ margin: 0, fontSize: 13, color: "var(--ink-muted)" }}>
            Select a member to read the risk the server currently assigns to them.
          </p>
        </Card>
      ) : snapshot === null || snapshot.kind === "loading" ? (
        <SectionLoading label="Reading the risk projection…" />
      ) : snapshot.kind === "denied" ? (
        <SectionDenied
          message={snapshot.message}
          hint="Either you lack access-review authority in this workspace, or that member is not part of it. This is a refusal, not a clean risk score."
        />
      ) : snapshot.kind === "plan_gated" ? (
        <SectionPlanGated
          message={snapshot.message}
          feature={snapshot.feature}
          upgradeCta={snapshot.upgradeCta}
        />
      ) : snapshot.kind === "error" ? (
        <SectionError
          message={snapshot.message}
          onRetry={() => void loadSnapshot(selectedUserId)}
        />
      ) : (
        <>
          <Card padding="comfortable" style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Badge tone={levelTone(snapshot.data.level)}>
                Risk level: {snapshot.data.level}
              </Badge>
              <Badge tone="neutral">Score: {snapshot.data.score}</Badge>
              <Badge tone="neutral">
                {snapshot.data.signals.length} active signal
                {snapshot.data.signals.length === 1 ? "" : "s"}
              </Badge>
            </div>
          </Card>
          <DataTable
            columns={signalColumns}
            rows={snapshot.data.signals}
            getRowId={(s, i) => `${s.kind}-${i}`}
            ariaLabel="Member risk signals"
            emptyState={
              <EmptyState variant="inline"
                title="No active risk signals"
                purpose="Nothing is currently raising this member's risk. Signals expire on their own, so an empty list can also mean earlier signals have aged out."
              />
            }
          />
        </>
      )}
    </PageSection>
  );
}

export default UserRiskSection;
