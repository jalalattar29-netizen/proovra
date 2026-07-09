"use client";

import { useCallback, useEffect, useState } from "react";

import {
  GOVERNANCE_POLICY_KINDS,
  type GovernancePolicyProjection,
} from "@proovra/shared";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { PageShell, PageHeader } from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { Badge } from "../../../../components/ui/Badge";
import { DataTable, type DataTableColumn } from "../../../../components/ui/DataTable";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { apiFetch, ApiError } from "../../../../lib/api";
import { formatUserDate } from "../../../../lib/date";

type PermissionDenialState = {
  denial: string;
  tier: string;
} | null;

export default function PoliciesPage() {
  return (
    <PageRouteGate routeId="workspace.governance_platform">
      <Shell />
    </PageRouteGate>
  );
}

function Shell() {
  const [rows, setRows] = useState<ReadonlyArray<GovernancePolicyProjection>>([]);
  const [busy, setBusy] = useState(false);
  const [denial, setDenial] = useState<PermissionDenialState>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setDenial(null);
    try {
      const res = await apiFetch("/v1/governance/policies", { method: "GET" });
      setRows((res?.policies ?? []) as ReadonlyArray<GovernancePolicyProjection>);
    } catch (err) {
      setRows([]);
      applyDenial(err, setDenial);
    } finally {
      setBusy(false);
    }
  }, []);

  const activate = useCallback(async (id: string) => {
    setBusy(true);
    setDenial(null);
    try {
      await apiFetch(`/v1/governance/policies/${id}/activate`, { method: "POST" });
      await refresh();
    } catch (err) {
      applyDenial(err, setDenial);
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const deprecate = useCallback(async (id: string) => {
    setBusy(true);
    setDenial(null);
    try {
      await apiFetch(`/v1/governance/policies/${id}/deprecate`, { method: "POST" });
      await refresh();
    } catch (err) {
      applyDenial(err, setDenial);
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const columns: DataTableColumn<GovernancePolicyProjection>[] = [
    {
      key: "name",
      header: "Name",
      render: (p) => (
        <span
          data-governance-policy-row={p.id}
          data-governance-policy-state={p.state}
          data-governance-policy-kind={p.kind}
        >
          {p.name}
        </span>
      ),
    },
    { key: "kind", header: "Kind", render: (p) => <code>{p.kind}</code> },
    { key: "slug", header: "Slug", render: (p) => <code>{p.slug}</code> },
    {
      key: "state",
      header: "State",
      render: (p) => <Badge tone="governance">{p.state}</Badge>,
    },
    { key: "enforcementMode", header: "Enforcement", render: (p) => p.enforcementMode },
    { key: "version", header: "Version", render: (p) => `v${p.version}` },
    { key: "createdAtUtc", header: "Created", render: (p) => formatUserDate(p.createdAtUtc) },
  ];

  return (
    <PageShell
      data-governance-policies-page
      header={
        <PageHeader
          eyebrow="Governance"
          title="Governance Policies"
          subtitle={`Policy registry. Kinds: ${GOVERNANCE_POLICY_KINDS.join(", ")}. Inheritance + override + audit. Enforcement: BLOCK / WARN / AUDIT_ONLY.`}
          contextStrip={
            <a href="/governance-platform" style={{ fontSize: 12 }}>← Back to Governance Platform</a>
          }
          primaryAction={
            <Button
              variant="enterprise"
              data-governance-policies-refresh
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
      {denial ? (
        <Card
          variant="status"
          tone="risk"
          padding="compact"
          data-permission-denied={denial.denial}
        >
          <strong>Permission required:</strong> {denial.tier}
        </Card>
      ) : null}

      <div data-governance-policies-table>
        <DataTable<GovernancePolicyProjection>
          ariaLabel="Governance policies"
          columns={columns}
          rows={rows as GovernancePolicyProjection[]}
          getRowId={(p) => p.id}
          loading={busy && rows.length === 0}
          emptyState={
            <EmptyState
              title="No governance policies defined"
              purpose="Retention, access and compliance policies for this organization appear here once they are created."
            />
          }
          rowActions={(p) =>
            p.state === "DRAFT" ? (
              <Button
                variant="secondary"
                size="sm"
                data-governance-policy-activate={p.id}
                onClick={() => void activate(p.id)}
              >
                Activate
              </Button>
            ) : p.state === "ACTIVE" ? (
              <Button
                variant="secondary"
                size="sm"
                data-governance-policy-deprecate={p.id}
                onClick={() => void deprecate(p.id)}
              >
                Deprecate
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

function applyDenial(
  err: unknown,
  setDenial: (v: PermissionDenialState) => void,
): void {
  if (err instanceof ApiError) {
    const detailsDenial =
      err.details && typeof err.details["denial"] === "string"
        ? (err.details["denial"] as string)
        : null;
    const tier =
      err.details && typeof err.details["requiredTier"] === "string"
        ? (err.details["requiredTier"] as string)
        : "DELEGATED_ADMIN";
    if (err.statusCode === 403 && detailsDenial === "DELEGATED_ADMIN_REQUIRED") {
      setDenial({ denial: detailsDenial, tier });
      return;
    }
  }
  const generic = err as {
    code?: string;
    statusCode?: number;
    details?: Record<string, unknown>;
  };
  const detailsDenial =
    generic && generic.details && typeof generic.details["denial"] === "string"
      ? (generic.details["denial"] as string)
      : null;
  const tier =
    generic && generic.details && typeof generic.details["requiredTier"] === "string"
      ? (generic.details["requiredTier"] as string)
      : "DELEGATED_ADMIN";
  if (
    generic &&
    generic.statusCode === 403 &&
    detailsDenial === "DELEGATED_ADMIN_REQUIRED"
  ) {
    setDenial({ denial: detailsDenial, tier });
  }
}
