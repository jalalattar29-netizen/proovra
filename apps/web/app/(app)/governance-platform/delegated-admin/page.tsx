"use client";

import { useCallback, useEffect, useState } from "react";

import {
  DELEGATED_ADMIN_TIERS,
  type DelegatedAdminGrantProjection,
} from "@proovra/shared";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { PageShell, PageHeader } from "../../../../components/ui/PageShell";
import { Button } from "../../../../components/ui/Button";
import { Badge } from "../../../../components/ui/Badge";
import { DataTable, type DataTableColumn } from "../../../../components/ui/DataTable";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { DelegatedAdminGrantForm } from "../../../../components/governance/DelegatedAdminGrantForm";
import { apiFetch } from "../../../../lib/api";
import { formatUserDate } from "../../../../lib/date";

export default function DelegatedAdminPage() {
  return (
    <PageRouteGate routeId="workspace.governance_platform">
      <Shell />
    </PageRouteGate>
  );
}

function Shell() {
  const [rows, setRows] = useState<ReadonlyArray<DelegatedAdminGrantProjection>>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const res = await apiFetch("/v1/governance/delegated-admin", { method: "GET" });
      setRows((res?.grants ?? []) as ReadonlyArray<DelegatedAdminGrantProjection>);
    } catch {
      setRows([]);
    } finally {
      setBusy(false);
    }
  }, []);

  const revoke = useCallback(async (grantId: string) => {
    setBusy(true);
    try {
      await apiFetch(`/v1/governance/delegated-admin/${grantId}/revoke`, { method: "POST" });
      await refresh();
    } catch {
      /* swallow */
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const columns: DataTableColumn<DelegatedAdminGrantProjection>[] = [
    {
      key: "grantee",
      header: "Grantee",
      render: (g) => (
        /*
          PHASE 13 (NEW-068) — ONE ATTRIBUTE NAME, ONE MEANING.

          This row used `data-delegated-admin-tier` for the tier a grant HOLDS,
          while `DelegatedAdminGrantForm` uses the identical name for the tier
          `<select>` an operator is CHOOSING. Both live on this page, so the
          moment the first grant appeared in the table the name resolved to two
          different kinds of element and any consumer addressing it became
          ambiguous — which is exactly what happened: selecting a tier failed
          with "resolved to 2 elements", so issuing a SECOND grant was
          impossible from the console once a first one existed.

          The row's attribute is renamed to be row-scoped. `data-delegated-
          admin-row` and `data-delegated-admin-state` are untouched, so the row
          is still addressable by identity and by state.
        */
        <span
          data-delegated-admin-row={g.id}
          data-delegated-admin-row-tier={g.tier}
          data-delegated-admin-state={g.state}
        >
          <code>{g.granteeUserId.slice(0, 8)}…</code>
        </span>
      ),
    },
    { key: "tier", header: "Tier", render: (g) => <Badge tone="governance">{g.tier}</Badge> },
    { key: "organization", header: "Organization", render: (g) => <code>{g.organizationId.slice(0, 8)}…</code> },
    {
      key: "department",
      header: "Department",
      render: (g) => (g.departmentId ? <code>{g.departmentId.slice(0, 8)}…</code> : "—"),
    },
    {
      key: "workspace",
      header: "Workspace",
      render: (g) => (g.workspaceId ? <code>{g.workspaceId.slice(0, 8)}…</code> : "—"),
    },
    { key: "state", header: "State", render: (g) => g.state },
    { key: "granted", header: "Granted", render: (g) => formatUserDate(g.grantedAtUtc) },
    {
      key: "expires",
      header: "Expires",
      render: (g) => (g.expiresAtUtc ? formatUserDate(g.expiresAtUtc) : "—"),
    },
  ];

  return (
    <PageShell
      data-delegated-admin-page
      header={
        <PageHeader
          eyebrow="Governance"
          title="Delegated Administration"
          subtitle={`Tiered grants enforced server-side. Tiers: ${DELEGATED_ADMIN_TIERS.join(", ")}.`}
          contextStrip={
            <a href="/governance-platform" style={{ fontSize: 12 }}>← Back to Governance Platform</a>
          }
          primaryAction={
            <Button
              variant="enterprise"
              data-delegated-admin-refresh
              disabled={busy}
              loading={busy}
              onClick={() => void refresh()}
            >
              {busy ? "Loading…" : "Refresh"}
            </Button>
          }
        />
      }
    >
      {/* PHASE 13 — POST /v1/governance/delegated-admin. The console could
          only revoke these grants; nothing in the product could issue one, so
          the tier ladder could never be bootstrapped past the implicit
          workspace-owner grant. */}
      <DelegatedAdminGrantForm onGranted={refresh} />

      <div data-delegated-admin-table>
        <DataTable<DelegatedAdminGrantProjection>
          ariaLabel="Delegated admin grants"
          columns={columns}
          rows={rows as DelegatedAdminGrantProjection[]}
          getRowId={(g) => g.id}
          loading={busy && rows.length === 0}
          emptyState={
            <EmptyState
              title="No delegated admins"
              purpose="Tiered delegated-administration grants for this organization appear here once they are issued."
            />
          }
          rowActions={(g) =>
            g.state === "ACTIVE" ? (
              <Button
                variant="destructive"
                size="sm"
                data-delegated-admin-revoke={g.id}
                onClick={() => void revoke(g.id)}
                disabled={busy}
              >
                Revoke
              </Button>
            ) : (
              <span>—</span>
            )
          }
        />
      </div>
    </PageShell>
  );
}
