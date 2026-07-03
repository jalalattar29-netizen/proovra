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

  return (
    <div
      data-access-review-items-page
      style={{
        padding: 20,
        maxWidth: 1320,
        margin: "0 auto",
        color: "#0f172a",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 22, marginTop: 0 }}>Access Review · Items</h1>
        <p style={{ color: "#475569", fontSize: 13, marginTop: 0 }}>
          Per-item review decisions. Decisions are append-only.
          REVOKED additionally triggers grant revocation server-side.
        </p>
        <p>
          <a
            href="/governance-platform/access-reviews"
            style={{ fontSize: 12 }}
          >
            ← Back to Access Reviews
          </a>{" "}
          · <code style={{ fontSize: 11 }}>campaign={campaignId}</code>
        </p>
      </header>

      {denial ? (
        <div
          data-access-review-items-denial={denial.denial}
          style={{
            padding: 10,
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            borderRadius: 8,
            fontSize: 12,
            marginBottom: 10,
          }}
        >
          <strong>Permission required:</strong> {denial.message}
        </div>
      ) : null}

      <button
        type="button"
        data-access-review-items-refresh
        disabled={busy}
        onClick={() => void refresh()}
        style={primaryButton}
      >
        {busy ? "Loading…" : "Refresh"}
      </button>

      <section
        style={{
          background: "#fff",
          border: "1px solid rgba(15, 23, 42, 0.08)",
          borderRadius: 10,
          padding: 8,
          marginTop: 12,
          overflowX: "auto",
        }}
      >
        <table
          data-access-review-items-table
          style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}
        >
          <thead>
            <tr style={{ textAlign: "left", color: "#475569" }}>
              <th style={th}>Subject</th>
              <th style={th}>Grant</th>
              <th style={th}>Decision</th>
              <th style={th}>Reviewed</th>
              <th style={th}>Decide</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ ...td, color: "#475569" }}>
                  No items in this campaign.
                </td>
              </tr>
            ) : (
              rows.map((item) => (
                <tr
                  key={item.id}
                  data-access-review-item-row={item.id}
                  data-access-review-item-state={item.decision}
                  data-access-review-item-subject={item.subjectUserId}
                >
                  <td style={td}>
                    <code title={item.subjectUserId}>
                      {item.subjectUserId.slice(0, 8)}
                    </code>
                  </td>
                  <td style={td}>
                    <code>{item.grantRef}</code>
                  </td>
                  <td style={td}>
                    <DecisionBadge decision={item.decision} />
                  </td>
                  <td style={td}>
                    {item.reviewedAtUtc
                      ? formatUserDateTime(item.reviewedAtUtc)
                      : "—"}
                  </td>
                  <td style={td}>
                    <div
                      style={{ display: "flex", gap: 6, flexWrap: "wrap" }}
                      data-access-review-item-decide={item.id}
                    >
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void decide(item.id, "APPROVED")}
                        style={decideButton("#16a34a")}
                        data-access-review-item-decision-button="APPROVED"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void decide(item.id, "REVOKED")}
                        style={decideButton("#dc2626")}
                        data-access-review-item-decision-button="REVOKED"
                      >
                        Revoke
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void decide(item.id, "ESCALATED")}
                        style={decideButton("#b45309")}
                        data-access-review-item-decision-button="ESCALATED"
                      >
                        Escalate
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function DecisionBadge({ decision }: { decision: AccessReviewItemDecision }) {
  const palette: Record<
    AccessReviewItemDecision,
    { bg: string; fg: string; border: string }
  > = {
    PENDING: { bg: "#f1f5f9", fg: "#475569", border: "#cbd5e1" },
    APPROVED: { bg: "#dcfce7", fg: "#166534", border: "#86efac" },
    REVOKED: { bg: "#fee2e2", fg: "#991b1b", border: "#fca5a5" },
    ESCALATED: { bg: "#fef3c7", fg: "#92400e", border: "#fcd34d" },
  };
  const c = palette[decision];
  return (
    <span
      data-access-review-item-decision-badge={decision}
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 700,
        background: c.bg,
        color: c.fg,
        border: `1px solid ${c.border}`,
      }}
    >
      {decision}
    </span>
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

const primaryButton = {
  padding: "6px 12px",
  border: "1px solid #0f172a",
  background: "#0f172a",
  color: "#fafafa",
  fontWeight: 600,
  fontSize: 12,
  borderRadius: 8,
  cursor: "pointer",
} as const;

function decideButton(color: string) {
  return {
    padding: "4px 8px",
    border: `1px solid ${color}`,
    background: "#fff",
    color,
    fontWeight: 700,
    fontSize: 11,
    borderRadius: 6,
    cursor: "pointer",
  } as const;
}

const th = { padding: "6px 8px", borderBottom: "1px solid #e2e8f0" } as const;
const td = { padding: "6px 8px", borderBottom: "1px solid #f1f5f9" } as const;
