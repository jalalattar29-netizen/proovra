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
 *   * Every refusal is surfaced inline: a 403 PERMISSION_REQUIRED says what
 *     is missing, the rest say why the decision or the read was refused, so
 *     a refused click never looks like nothing happened and a refused read
 *     never looks like an empty campaign.
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
import { apiFetch } from "../../../../../lib/api";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { formatUserDateTime } from "../../../../../lib/date";
import { permissionRequiredDetail } from "../../../../../lib/labels/governanceReviewLabels";

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
  const denied = denial !== null;

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
          {denial.denial === "PERMISSION_REQUIRED" ? <strong>Permission required: </strong> : null}
          {denial.message}
        </Card>
      ) : null}

      <div data-access-review-items-table hidden={denied && rows.length === 0}>
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

/** Why the API refused, in the reader's terms. */
const REFUSALS: Readonly<Record<string, string>> = {
  CAMPAIGN_NOT_FOUND: "This campaign does not exist in the current workspace.",
  CAMPAIGN_NOT_OPEN: "This campaign is not open, so it takes no decisions.",
  SELF_REVIEW_REFUSED: "You cannot decide your own access. Another reviewer has to decide this item.",
  GRANT_NOT_REVOCABLE: "This grant cannot be revoked from a review. Nothing was recorded.",
  GRANT_REVOKE_FAILED: "The grant could not be revoked, so the item stays pending.",
};

function handleError(err: unknown, setDenial: (v: DenialState) => void): void {
  const failure = err as { details?: Record<string, unknown> };
  const denial =
    failure?.details && typeof failure.details["denial"] === "string"
      ? (failure.details["denial"] as string)
      : "REFUSED";
  if (denial === "PERMISSION_REQUIRED") {
    setDenial({ denial, message: permissionRequiredDetail(readPermission(failure.details)) });
    return;
  }
  setDenial({
    denial,
    message:
      REFUSALS[denial] ??
      toSafeUserError(err, { message: "That could not be completed. Nothing was changed." }).message,
  });
}

function readPermission(details: Record<string, unknown> | undefined): string | null {
  return details && typeof details["permission"] === "string"
    ? (details["permission"] as string)
    : null;
}
