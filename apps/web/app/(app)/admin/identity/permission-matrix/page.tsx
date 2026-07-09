"use client";

/**
 * Phase 26 — Permission Matrix admin page.
 *
 * Operator-facing "what can this member do here?" inspector. For each
 * canonical permission, shows the outcome (ALLOW / DENY / STEP_UP /
 * NOT_APPLICABLE) and the SOURCE (role default, capability grant,
 * delegated scope, etc.). Backed by RBAC engine's
 * `buildPermissionSnapshot`.
 */

import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { useCallback, useMemo, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { useTeamId } from "../../../../../lib/platform-context";
import {
  errorBoxStyle,
  inputStyle,
  mutedStyle,
  statusBadgeStyle,
  TOKENS,
} from "../ui-tokens";
import { PageShell, PageHeader, PageSection } from "../../../../../components/ui/PageShell";
import { Card } from "../../../../../components/ui/Card";
import { Button } from "../../../../../components/ui/Button";
import { FilterBar } from "../../../../../components/ui/FilterBar";
import { EmptyState } from "../../../../../components/ui/EmptyState";
import { DataTable, type DataTableColumn } from "../../../../../components/ui/DataTable";

type Outcome = "ALLOW" | "DENY" | "STEP_UP_REQUIRED" | "NOT_APPLICABLE";

type PermissionRow = {
  permission: string;
  outcome: Outcome;
  source: string;
  sourceLabel: string;
  reason: string;
};

type Snapshot = {
  teamId: string;
  userId: string;
  canonicalRole: string;
  status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  permissions: PermissionRow[];
  capabilityGrantCount: number;
  delegatedScopeCount: number;
  temporaryElevationCount: number;
  computedAtUtc: string;
};

export default function PermissionMatrixPage() {
  const teamId = useTeamId();
  const [subjectUserId, setSubjectUserId] = useState<string>("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("");
  const [outcomeFilter, setOutcomeFilter] = useState<Outcome | "">("");

  
const load = useCallback(async () => {
    if (!teamId || !subjectUserId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(
        `/v1/admin/identity/permission-matrix?teamId=${encodeURIComponent(
          teamId,
        )}&subjectUserId=${encodeURIComponent(subjectUserId)}`,
        { method: "GET" },
      );
      setSnapshot(res.snapshot as Snapshot);
    } catch (err) {
      setError(
        toSafeUserError(err, { message: "Could not load snapshot." }).message,
      );
      setSnapshot(null);
    } finally {
      setBusy(false);
    }
  }, [teamId, subjectUserId]);

  const filtered = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.permissions.filter((p) => {
      if (outcomeFilter && p.outcome !== outcomeFilter) return false;
      if (filter && !p.permission.toLowerCase().includes(filter.toLowerCase()))
        return false;
      return true;
    });
  }, [snapshot, filter, outcomeFilter]);

  if (!teamId) {
    return (
      <PageShell header={<PageHeader eyebrow="Identity operations" title="Permission Matrix" />}>
        <EmptyState
          framed
          title="No workspace selected"
          purpose="Switch to a workspace to inspect a member's effective permissions."
        />
      </PageShell>
    );
  }

  const columns: DataTableColumn<PermissionRow>[] = [
    {
      key: "permission",
      header: "Permission",
      render: (r) => (
        <span
          style={{
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            fontSize: 12,
          }}
        >
          {r.permission}
        </span>
      ),
    },
    {
      key: "outcome",
      header: "Outcome",
      render: (r) => (
        <span style={statusBadgeStyle(r.outcome)}>
          {r.outcome.toLowerCase().replace("_", " ")}
        </span>
      ),
    },
    {
      key: "source",
      header: "Source",
      render: (r) => <span style={mutedStyle}>{r.sourceLabel}</span>,
    },
    {
      key: "reason",
      header: "Reason",
      render: (r) => <span style={mutedStyle}>{r.reason}</span>,
    },
  ];

  return (
    <PageShell
      header={
        <PageHeader
          eyebrow="Identity operations"
          title="Permission Matrix"
          subtitle="For each canonical permission, shows the outcome plus the source (role default, capability grant, delegated scope, temporary elevation, or workspace policy)."
        />
      }
    >
      <PageSection title="Inspect a member">
        <Card variant="admin" padding="comfortable">
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              style={{ ...inputStyle, maxWidth: 360 }}
              placeholder="Member user id (UUID)"
              value={subjectUserId}
              onChange={(e) => setSubjectUserId(e.target.value.trim())}
            />
            <Button
              variant="enterprise"
              onClick={load}
              loading={busy}
              disabled={busy || !subjectUserId}
            >
              {busy ? "Loading…" : "Inspect"}
            </Button>
          </div>
        </Card>
      </PageSection>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      {snapshot ? (
        <>
          <PageSection>
            <Card variant="summary" padding="comfortable">
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <KV k="Member" v={snapshot.userId} mono />
                <KV k="Canonical role" v={snapshot.canonicalRole} />
                <KV k="Status" v={snapshot.status} />
                <KV
                  k="Capability grants"
                  v={String(snapshot.capabilityGrantCount)}
                />
                <KV
                  k="Delegated scopes"
                  v={String(snapshot.delegatedScopeCount)}
                />
                <KV
                  k="Temp elevations"
                  v={String(snapshot.temporaryElevationCount)}
                />
              </div>
            </Card>
          </PageSection>

          <PageSection>
            <FilterBar
              actions={
                <>
                  <span style={mutedStyle}>
                    {filtered.length} / {snapshot.permissions.length} permissions
                  </span>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setFilter("");
                      setOutcomeFilter("");
                    }}
                  >
                    Clear
                  </Button>
                </>
              }
            >
              <FilterBar.Search
                value={filter}
                onChange={setFilter}
                label="Filter by permission name"
                placeholder="Filter by permission name…"
              />
              <FilterBar.Select
                label="Outcome"
                value={outcomeFilter}
                onChange={(v) => setOutcomeFilter(v as Outcome | "")}
                options={[
                  { value: "", label: "All outcomes" },
                  { value: "ALLOW", label: "Allow" },
                  { value: "DENY", label: "Deny" },
                  { value: "STEP_UP_REQUIRED", label: "Step-up required" },
                  { value: "NOT_APPLICABLE", label: "Not applicable" },
                ]}
              />
            </FilterBar>
            <div style={{ marginTop: 12 }}>
              <DataTable
                columns={columns}
                rows={filtered}
                getRowId={(r) => r.permission}
                ariaLabel="Permission matrix"
                emptyState={
                  <EmptyState
                    title="No permissions match"
                    purpose="Adjust the permission-name filter or outcome filter to see entries."
                  />
                }
              />
            </div>
          </PageSection>
        </>
      ) : null}
    </PageShell>
  );
}

function KV({
  k,
  v,
  mono,
}: {
  k: string;
  v: string;
  mono?: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 10, color: TOKENS.inkSubtle, textTransform: "uppercase" }}>
        {k}
      </span>
      <span
        style={{
          fontSize: 13,
          fontWeight: 600,
          ...(mono
            ? {
                fontFamily:
                  "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                fontSize: 12,
              }
            : {}),
        }}
      >
        {v}
      </span>
    </div>
  );
}
