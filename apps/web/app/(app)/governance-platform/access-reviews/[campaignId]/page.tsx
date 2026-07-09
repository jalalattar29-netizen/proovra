"use client";

/**
 * Phase 4A Enterprise Closure — Access Review per-item decision UI.
 *
 * Lists every AccessReviewItem in a campaign and lets a delegated
 * admin record APPROVED / REVOKED / ESCALATED. Decisions are
 * append-only on the server; REVOKED additionally triggers grant
 * revocation in the propagation engine.
 *
 * Hard rules:
 *   * Bounded decision vocabulary (PENDING / APPROVED / REVOKED /
 *     ESCALATED) — matches `AccessReviewItemDecision`.
 *   * 403 + denial=DELEGATED_ADMIN_REQUIRED is surfaced inline so the
 *     operator knows the route is gated, not broken.
 *   * Subject user id truncated to 8 chars for screen density;
 *     the full id is on the row's data-* anchor for tests + dev tools.
 */

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";

import type {
  AccessReviewItemDecision,
  AccessReviewItemProjection,
} from "@proovra/shared";

import { PageRouteGate } from "../../../../../components/navigation/PageRouteGate";
import { PageShell, PageHeader } from "../../../../../components/ui/PageShell";
import { Card } from "../../../../../components/ui/Card";
import { Button } from "../../../../../components/ui/Button";
import { Badge, type BadgeTone } from "../../../../../components/ui/Badge";
import { DataTable, type DataTableColumn } from "../../../../../components/ui/DataTable";
import { EmptyState } from "../../../../../components/ui/EmptyState";
import { apiFetch, ApiError } from "../../../../../lib/api";
import { formatUserDateTime } from "../../../../../lib/date";

type DenialState = {
  denial: string;
  message: string;
} | null;

export default function AccessReviewCampaignDetailPage() {
  return (
    <PageRouteGate routeId="workspace.governance_platform">
      <Shell />
    </PageRouteGate>
  );
}

function Shell() {
  const params = useParams<{ campaignId: string }>();
  const campaignId = params?.campaignId ?? "";

  const [rows, setRows] = useState<ReadonlyArray<AccessReviewItemProjection>>(
    [],
  );
  const [busy, setBusy] = useState(false);
  const [denial, setDenial] = useState<DenialState>(null);

  const refresh = useCallback(async () => {
    if (!campaignId) return;
    setBusy(true);
    setDenial(null);
    try {
      const res = await apiFetch(
        `/v1/governance/access-reviews/campaigns/${campaignId}/items`,
        { method: "GET" },
      );
      setRows(
        (res?.items ?? []) as ReadonlyArray<AccessReviewItemProjection>,
      );
    } catch (err) {
      setRows([]);
      handleError(err, setDenial);
    } finally {
      setBusy(false);
    }
  }, [campaignId]);

  const decide = useCallback(
    async (itemId: string, decision: AccessReviewItemDecision) => {
      setBusy(true);
      setDenial(null);
      try {
        await apiFetch(
          `/v1/governance/access-reviews/items/${itemId}/decision`,
          {
            method: "POST",
            body: JSON.stringify({ decision }),
          },
        );
        await refresh();
      } catch (err) {
        handleError(err, setDenial);
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const columns: DataTableColumn<AccessReviewItemProjection>[] = [
    {
      key: "subject",
      header: "Subject",
      render: (item) => (
        <span
          data-access-review-item-row={item.id}
          data-access-review-item-state={item.decision}
          data-access-review-item-subject={item.subjectUserId}
        >
          <code title={item.subjectUserId}>{item.subjectUserId.slice(0, 8)}</code>
        </span>
      ),
    },
    { key: "grant", header: "Grant", render: (item) => <code>{item.grantRef}</code> },
    {
      key: "decision",
      header: "Decision",
      render: (item) => <DecisionBadge decision={item.decision} />,
    },
    {
      key: "reviewed",
      header: "Reviewed",
      render: (item) =>
        item.reviewedAtUtc ? formatUserDateTime(item.reviewedAtUtc) : "—",
    },
    {
      key: "decide",
      header: "Decide",
      render: (item) => (
        <div
          style={{ display: "flex", gap: 6, flexWrap: "wrap" }}
          data-access-review-item-decide={item.id}
        >
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => void decide(item.id, "APPROVED")}
            data-access-review-item-decision-button="APPROVED"
          >
            Approve
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={() => void decide(item.id, "REVOKED")}
            data-access-review-item-decision-button="REVOKED"
          >
            Revoke
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => void decide(item.id, "ESCALATED")}
            data-access-review-item-decision-button="ESCALATED"
          >
            Escalate
          </Button>
        </div>
      ),
    },
  ];

  return (
    <PageShell
      data-access-review-items-page
      header={
        <PageHeader
          eyebrow="Governance"
          title="Access Review · Items"
          subtitle="Per-item review decisions. Decisions are append-only. REVOKED additionally triggers grant revocation server-side."
          contextStrip={
            <span style={{ fontSize: 12 }}>
              <a href="/governance-platform/access-reviews" style={{ fontSize: 12 }}>
                ← Back to Access Reviews
              </a>{" "}
              · <code style={{ fontSize: 11 }}>campaign={campaignId}</code>
            </span>
          }
          primaryAction={
            <Button
              variant="enterprise"
              data-access-review-items-refresh
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
          data-access-review-items-denial={denial.denial}
        >
          <strong>Permission required:</strong> {denial.message}
        </Card>
      ) : null}

      <div data-access-review-items-table>
        <DataTable<AccessReviewItemProjection>
          ariaLabel="Access review items"
          columns={columns}
          rows={rows as AccessReviewItemProjection[]}
          getRowId={(item) => item.id}
          loading={busy && rows.length === 0}
          emptyState={
            <EmptyState
              title="No access-review items in this campaign"
              purpose="Every access grant in scope for this campaign appears here for an approve / revoke / escalate decision."
            />
          }
        />
      </div>
    </PageShell>
  );
}

function DecisionBadge({ decision }: { decision: AccessReviewItemDecision }) {
  const tone: Record<AccessReviewItemDecision, BadgeTone> = {
    PENDING: "neutral",
    APPROVED: "verified",
    REVOKED: "risk",
    ESCALATED: "pending",
  };
  return (
    <Badge tone={tone[decision]} data-access-review-item-decision-badge={decision}>
      {decision}
    </Badge>
  );
}

function handleError(err: unknown, setDenial: (v: DenialState) => void): void {
  if (err instanceof ApiError) {
    const detailsDenial =
      err.details && typeof err.details["denial"] === "string"
        ? (err.details["denial"] as string)
        : null;
    if (err.statusCode === 403 && detailsDenial === "DELEGATED_ADMIN_REQUIRED") {
      setDenial({
        denial: detailsDenial,
        message: "DELEGATED_ADMIN tier (or higher) required for this action.",
      });
      return;
    }
  }
  // Generic shape used by apiFetch fallback.
  const generic = err as { code?: string; statusCode?: number; details?: Record<string, unknown> };
  const detailsDenial =
    generic && generic.details && typeof generic.details["denial"] === "string"
      ? (generic.details["denial"] as string)
      : null;
  if (generic && generic.statusCode === 403 && detailsDenial === "DELEGATED_ADMIN_REQUIRED") {
    setDenial({
      denial: detailsDenial,
      message: "DELEGATED_ADMIN tier (or higher) required for this action.",
    });
  }
}
