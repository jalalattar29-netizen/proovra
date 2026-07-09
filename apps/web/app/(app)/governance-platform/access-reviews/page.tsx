"use client";

import { useCallback, useEffect, useState } from "react";

import {
  ACCESS_REVIEW_CAMPAIGN_KINDS,
  type AccessReviewCampaignProjection,
} from "@proovra/shared";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { PageShell, PageHeader } from "../../../../components/ui/PageShell";
import { Button } from "../../../../components/ui/Button";
import { Badge } from "../../../../components/ui/Badge";
import { DataTable, type DataTableColumn } from "../../../../components/ui/DataTable";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { apiFetch } from "../../../../lib/api";
import { formatUserDate } from "../../../../lib/date";

export default function AccessReviewsPage() {
  return (
    <PageRouteGate routeId="workspace.governance_platform">
      <Shell />
    </PageRouteGate>
  );
}

function Shell() {
  const [rows, setRows] = useState<ReadonlyArray<AccessReviewCampaignProjection>>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const res = await apiFetch("/v1/governance/access-reviews/campaigns", { method: "GET" });
      setRows((res?.campaigns ?? []) as ReadonlyArray<AccessReviewCampaignProjection>);
    } catch {
      setRows([]);
    } finally {
      setBusy(false);
    }
  }, []);

  const openCampaign = useCallback(async (id: string) => {
    setBusy(true);
    try {
      await apiFetch(`/v1/governance/access-reviews/campaigns/${id}/open`, { method: "POST" });
      await refresh();
    } catch {
      /* swallow */
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const closeCampaign = useCallback(async (id: string) => {
    setBusy(true);
    try {
      await apiFetch(`/v1/governance/access-reviews/campaigns/${id}/close`, { method: "POST" });
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

  const columns: DataTableColumn<AccessReviewCampaignProjection>[] = [
    {
      key: "name",
      header: "Name",
      render: (c) => (
        <span
          data-access-review-campaign-row={c.id}
          data-access-review-campaign-state={c.state}
          data-access-review-campaign-kind={c.kind}
        >
          {c.name}
        </span>
      ),
    },
    { key: "kind", header: "Kind", render: (c) => <code>{c.kind}</code> },
    { key: "state", header: "State", render: (c) => <Badge tone="governance">{c.state}</Badge> },
    {
      key: "scheduled",
      header: "Scheduled",
      render: (c) => `${formatUserDate(c.scheduledStartUtc)} → ${formatUserDate(c.scheduledEndUtc)}`,
    },
    { key: "totalItems", header: "Total", render: (c) => c.totalItems },
    { key: "pendingItems", header: "Pending", render: (c) => c.pendingItems },
    { key: "approvedItems", header: "Approved", render: (c) => c.approvedItems },
    { key: "revokedItems", header: "Revoked", render: (c) => c.revokedItems },
    { key: "escalatedItems", header: "Escalated", render: (c) => c.escalatedItems },
  ];

  return (
    <PageShell
      data-access-reviews-page
      header={
        <PageHeader
          eyebrow="Governance"
          title="Access Reviews"
          subtitle={`Campaign kinds: ${ACCESS_REVIEW_CAMPAIGN_KINDS.join(", ")}. Decisions are append-only.`}
          contextStrip={
            <a href="/governance-platform" style={{ fontSize: 12 }}>← Back to Governance Platform</a>
          }
          primaryAction={
            <Button
              variant="enterprise"
              data-access-reviews-refresh
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
      <div data-access-reviews-campaigns-table>
        <DataTable<AccessReviewCampaignProjection>
          ariaLabel="Access review campaigns"
          columns={columns}
          rows={rows as AccessReviewCampaignProjection[]}
          getRowId={(c) => c.id}
          loading={busy && rows.length === 0}
          emptyState={
            <EmptyState
              title="No access-review campaigns"
              purpose="Recurring and ad-hoc access-review campaigns for this organization appear here once they are scheduled."
            />
          }
          rowActions={(c) =>
            c.state === "DRAFT" ? (
              <Button
                variant="secondary"
                size="sm"
                data-access-review-campaign-open={c.id}
                onClick={() => void openCampaign(c.id)}
              >
                Open
              </Button>
            ) : c.state === "OPEN" ? (
              <Button
                variant="secondary"
                size="sm"
                data-access-review-campaign-close={c.id}
                onClick={() => void closeCampaign(c.id)}
              >
                Close
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
