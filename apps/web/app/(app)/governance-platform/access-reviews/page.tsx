"use client";

import { useCallback, useEffect, useState } from "react";

import {
  ACCESS_REVIEW_CAMPAIGN_KINDS,
  type AccessReviewCampaignProjection,
  type AccessReviewItemProjection,
} from "@proovra/shared";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { PageShell, PageHeader, PageSection } from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { Badge } from "../../../../components/ui/Badge";
import { DataTable, type DataTableColumn } from "../../../../components/ui/DataTable";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { FilterBar } from "../../../../components/ui/FilterBar";
import { apiFetch } from "../../../../lib/api";
import { formatUserDate } from "../../../../lib/date";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useTenantGuard } from "../../../../lib/platform-context";

/**
 * PHASE 12B CLUSTER 10 — bounded read-failure state. Replaces the prior
 * `catch { setRows([]) }` swallow, which rendered an authorization denial
 * and a genuinely empty campaign list identically — an operator could not
 * tell "you may not see this" from "there is nothing to see".
 */
type ReadFailure = { kind: "denied" | "error"; message: string };

function classifyReadFailure(err: unknown): ReadFailure {
  const e = err as { statusCode?: number };
  if (e?.statusCode === 403 || e?.statusCode === 404) {
    return {
      kind: "denied",
      message:
        "You do not have the governance permission required to read access reviews in the current workspace.",
    };
  }
  return {
    kind: "error",
    message: toSafeUserError(err, {
      message: "Unable to load access reviews.",
    }).message,
  };
}

/** Deterministic page sizes. The escalated listing caps at 500. */
const ESCALATED_PAGE_SIZES = [50, 100, 250, 500] as const;

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
  const [failure, setFailure] = useState<ReadFailure | null>(null);
  const [loaded, setLoaded] = useState(false);

  // PHASE 12B CLUSTER 10 — every read below captures the tenant generation
  // before awaiting and drops the response if the operator switched
  // workspace mid-flight.
  const { stamp, isStale } = useTenantGuard();

  // --- Escalated access-review items --------------------------------------
  const [escalated, setEscalated] = useState<
    ReadonlyArray<AccessReviewItemProjection> | null
  >(null);
  const [escalatedFailure, setEscalatedFailure] = useState<ReadFailure | null>(
    null,
  );
  const [escalatedLimit, setEscalatedLimit] = useState<number>(
    ESCALATED_PAGE_SIZES[0],
  );

  const refresh = useCallback(async () => {
    const captured = stamp();
    setBusy(true);
    setFailure(null);
    try {
      const res = await apiFetch("/v1/governance/access-reviews/campaigns", { method: "GET" });
      if (isStale(captured)) return;
      setRows((res?.campaigns ?? []) as ReadonlyArray<AccessReviewCampaignProjection>);
      setLoaded(true);
    } catch (err) {
      if (isStale(captured)) return;
      setRows([]);
      setLoaded(true);
      setFailure(classifyReadFailure(err));
    } finally {
      if (!isStale(captured)) setBusy(false);
    }
  }, [stamp, isStale]);

  const loadEscalated = useCallback(async () => {
    const captured = stamp();
    setEscalated(null);
    setEscalatedFailure(null);
    try {
      const res: { items: ReadonlyArray<AccessReviewItemProjection> } =
        await apiFetch(
          `/v1/governance/access-reviews/escalated?limit=${escalatedLimit}`,
          { method: "GET" },
        );
      if (isStale(captured)) return;
      setEscalated(res.items ?? []);
    } catch (err) {
      if (isStale(captured)) return;
      setEscalated([]);
      setEscalatedFailure(classifyReadFailure(err));
    }
  }, [escalatedLimit, stamp, isStale]);

  const openCampaign = useCallback(async (id: string) => {
    setBusy(true);
    setFailure(null);
    try {
      await apiFetch(`/v1/governance/access-reviews/campaigns/${id}/open`, { method: "POST" });
      await refresh();
      await loadEscalated();
    } catch (err) {
      setFailure(classifyReadFailure(err));
    } finally {
      setBusy(false);
    }
  }, [refresh, loadEscalated]);

  const closeCampaign = useCallback(async (id: string) => {
    setBusy(true);
    setFailure(null);
    try {
      await apiFetch(`/v1/governance/access-reviews/campaigns/${id}/close`, { method: "POST" });
      await refresh();
      await loadEscalated();
    } catch (err) {
      setFailure(classifyReadFailure(err));
    } finally {
      setBusy(false);
    }
  }, [refresh, loadEscalated]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void loadEscalated();
  }, [loadEscalated]);

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

  // PHASE 12B CLUSTER 10 — escalated-item columns. `grantRef` is the bounded
  // reference the campaign recorded (e.g. `delegated_admin:<id>`); `notes` is
  // the reviewer's own operator-readable note. Nothing here carries
  // privileged legal reasoning, and the queue is read-only — re-deciding an
  // escalated item happens on the campaign it belongs to.
  const escalatedColumns: DataTableColumn<AccessReviewItemProjection>[] = [
    {
      key: "subject",
      header: "Subject",
      render: (i) => (
        <code data-escalated-item-row={i.id}>{i.subjectUserId.slice(0, 8)}…</code>
      ),
    },
    { key: "grantRef", header: "Grant", render: (i) => <code>{i.grantRef}</code> },
    {
      key: "campaign",
      header: "Campaign",
      render: (i) => <code>{i.campaignId.slice(0, 8)}…</code>,
    },
    {
      key: "decision",
      header: "Decision",
      render: (i) => <Badge tone="risk">{i.decision}</Badge>,
    },
    {
      key: "reviewer",
      header: "Reviewer",
      render: (i) =>
        i.reviewerUserId ? (
          <code>{i.reviewerUserId.slice(0, 8)}…</code>
        ) : (
          <span style={mutedStyle}>—</span>
        ),
    },
    {
      key: "reviewedAt",
      header: "Escalated",
      render: (i) =>
        i.reviewedAtUtc ? (
          formatUserDate(i.reviewedAtUtc)
        ) : (
          <span style={mutedStyle}>—</span>
        ),
    },
    {
      key: "notes",
      header: "Note",
      render: (i) =>
        i.notes ? (
          <span style={{ fontSize: 12 }}>{i.notes}</span>
        ) : (
          <span style={mutedStyle}>—</span>
        ),
    },
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
      {failure ? (
        <Card
          variant="status"
          tone="risk"
          padding="compact"
          data-access-reviews-failure={failure.kind}
        >
          {failure.message}
        </Card>
      ) : null}

      <div data-access-reviews-campaigns-table>
        <DataTable<AccessReviewCampaignProjection>
          ariaLabel="Access review campaigns"
          columns={columns}
          rows={rows as AccessReviewCampaignProjection[]}
          getRowId={(c) => c.id}
          loading={!loaded}
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

      {/* PHASE 12B CLUSTER 10 — escalated items triage queue. Items a
          reviewer could not decide, newest escalation first. Read-only:
          the decision itself is recorded on the owning campaign. */}
      <PageSection
        title="Escalated items"
        action={
          <FilterBar>
            <FilterBar.Select
              label="Page size"
              showLabel
              value={String(escalatedLimit)}
              onChange={(v) => setEscalatedLimit(Number(v))}
              options={ESCALATED_PAGE_SIZES.map((n) => ({
                value: String(n),
                label: `${n} rows`,
              }))}
            />
          </FilterBar>
        }
      >
        <p style={{ ...mutedStyle, marginTop: 0 }}>
          Every access-review item currently flagged ESCALATED across all
          campaigns in this organization. An escalation means the reviewer
          declined to approve or revoke the grant themselves and handed it to a
          governance owner.
        </p>
        {escalatedFailure ? (
          <Card
            variant="status"
            tone="risk"
            padding="compact"
            data-escalated-items-failure={escalatedFailure.kind}
          >
            {escalatedFailure.message}
          </Card>
        ) : (
          <div data-escalated-items-table>
            <DataTable<AccessReviewItemProjection>
              ariaLabel="Escalated access-review items"
              columns={escalatedColumns}
              rows={(escalated ?? []) as AccessReviewItemProjection[]}
              getRowId={(i) => i.id}
              loading={!escalated}
              emptyState={
                <EmptyState
                  title="No escalated items"
                  purpose="No access-review item is awaiting a governance owner's decision."
                />
              }
            />
          </div>
        )}
      </PageSection>
    </PageShell>
  );
}

const mutedStyle: React.CSSProperties = { fontSize: 12, color: "#64748b" };
