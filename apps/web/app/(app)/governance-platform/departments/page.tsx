"use client";

import { useCallback, useEffect, useState } from "react";

import type { DepartmentProjection } from "@proovra/shared";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { PageShell, PageHeader, PageSection } from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { DataTable, type DataTableColumn } from "../../../../components/ui/DataTable";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { apiFetch } from "../../../../lib/api";
import { formatUserDate } from "../../../../lib/date";

export default function DepartmentsPage() {
  return (
    <PageRouteGate routeId="workspace.governance_platform">
      <Shell />
    </PageRouteGate>
  );
}

function Shell() {
  const [rows, setRows] = useState<ReadonlyArray<DepartmentProjection>>([]);
  const [busy, setBusy] = useState(false);
  const [orgId, setOrgId] = useState("");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const res = await apiFetch("/v1/governance/departments", { method: "GET" });
      setRows((res?.departments ?? []) as ReadonlyArray<DepartmentProjection>);
    } catch {
      setRows([]);
    } finally {
      setBusy(false);
    }
  }, []);

  const create = useCallback(async () => {
    setBusy(true);
    try {
      await apiFetch("/v1/governance/departments", {
        method: "POST",
        body: JSON.stringify({ organizationId: orgId, name, slug }),
        headers: { "content-type": "application/json" },
      });
      setName("");
      setSlug("");
      await refresh();
    } catch {
      /* swallow */
    } finally {
      setBusy(false);
    }
  }, [orgId, name, slug, refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const columns: DataTableColumn<DepartmentProjection>[] = [
    {
      key: "name",
      header: "Name",
      render: (d) => (
        <span data-department-row={d.id} data-department-state={d.state}>
          {d.name}
        </span>
      ),
    },
    { key: "slug", header: "Slug", render: (d) => <code>{d.slug}</code> },
    { key: "organization", header: "Organization", render: (d) => <code>{d.organizationId.slice(0, 8)}…</code> },
    { key: "state", header: "State", render: (d) => d.state },
    { key: "created", header: "Created", render: (d) => formatUserDate(d.createdAtUtc) },
  ];

  return (
    <PageShell
      data-departments-page
      header={
        <PageHeader
          eyebrow="Governance"
          title="Departments"
          subtitle="Department isolation for visibility + governance separation."
          contextStrip={
            <a href="/governance-platform" style={{ fontSize: 12 }}>← Back to Governance Platform</a>
          }
        />
      }
    >
      <PageSection title="Create department">
        <Card variant="admin" padding="compact" data-department-create-form>
          <div
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <input
              data-department-org-id
              placeholder="Organization UUID"
              value={orgId}
              onChange={(e) => setOrgId(e.target.value)}
              style={input}
            />
            <input
              data-department-name
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={input}
            />
            <input
              data-department-slug
              placeholder="slug (lowercase)"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              style={input}
            />
            <Button
              variant="enterprise"
              data-department-create-submit
              disabled={busy || !orgId || !name || !slug}
              onClick={() => void create()}
            >
              Create
            </Button>
          </div>
        </Card>
      </PageSection>

      <PageSection title="Departments">
        <div data-departments-table>
          <DataTable<DepartmentProjection>
            ariaLabel="Departments"
            columns={columns}
            rows={rows as DepartmentProjection[]}
            getRowId={(d) => d.id}
            loading={busy && rows.length === 0}
            emptyState={
              <EmptyState
                title="No departments"
                purpose="Departments isolate visibility and governance within an organization. Create one above to get started."
              />
            }
          />
        </div>
      </PageSection>
    </PageShell>
  );
}

const input = {
  padding: "6px 8px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 12,
  minWidth: 180,
} as const;
