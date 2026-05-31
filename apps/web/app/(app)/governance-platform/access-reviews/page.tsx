"use client";

import { useCallback, useEffect, useState } from "react";

import {
  ACCESS_REVIEW_CAMPAIGN_KINDS,
  type AccessReviewCampaignProjection,
} from "@proovra/shared";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { apiFetch } from "../../../../lib/api";

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

  return (
    <div
      data-access-reviews-page
      style={{
        padding: 20,
        maxWidth: 1320,
        margin: "0 auto",
        color: "#0f172a",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 22, marginTop: 0 }}>Access Reviews</h1>
        <p style={{ color: "#475569", fontSize: 13, marginTop: 0 }}>
          Campaign kinds: {ACCESS_REVIEW_CAMPAIGN_KINDS.join(", ")}. Decisions
          are append-only.
        </p>
        <p><a href="/governance-platform" style={{ fontSize: 12 }}>← Back to Governance Platform</a></p>
      </header>

      <button
        type="button"
        data-access-reviews-refresh
        disabled={busy}
        onClick={() => void refresh()}
        style={primaryButton}
      >
        {busy ? "Loading…" : "Refresh"}
      </button>

      <section style={{ background: "#fff", border: "1px solid rgba(15, 23, 42, 0.08)", borderRadius: 10, padding: 8, marginTop: 12, overflowX: "auto" }}>
        <table data-access-reviews-campaigns-table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#475569" }}>
              <th style={th}>Name</th>
              <th style={th}>Kind</th>
              <th style={th}>State</th>
              <th style={th}>Scheduled</th>
              <th style={th}>Total</th>
              <th style={th}>Pending</th>
              <th style={th}>Approved</th>
              <th style={th}>Revoked</th>
              <th style={th}>Escalated</th>
              <th style={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={10} style={{ ...td, color: "#475569" }}>No campaigns.</td></tr>
            ) : (
              rows.map((c) => (
                <tr key={c.id} data-access-review-campaign-row={c.id} data-access-review-campaign-state={c.state} data-access-review-campaign-kind={c.kind}>
                  <td style={td}>{c.name}</td>
                  <td style={td}><code>{c.kind}</code></td>
                  <td style={td}><strong>{c.state}</strong></td>
                  <td style={td}>{new Date(c.scheduledStartUtc).toLocaleDateString()} → {new Date(c.scheduledEndUtc).toLocaleDateString()}</td>
                  <td style={td}>{c.totalItems}</td>
                  <td style={td}>{c.pendingItems}</td>
                  <td style={td}>{c.approvedItems}</td>
                  <td style={td}>{c.revokedItems}</td>
                  <td style={td}>{c.escalatedItems}</td>
                  <td style={td}>
                    {c.state === "DRAFT" ? (
                      <button type="button" data-access-review-campaign-open={c.id} onClick={() => void openCampaign(c.id)} style={secondaryButton}>Open</button>
                    ) : c.state === "OPEN" ? (
                      <button type="button" data-access-review-campaign-close={c.id} onClick={() => void closeCampaign(c.id)} style={secondaryButton}>Close</button>
                    ) : "—"}
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
const secondaryButton = {
  padding: "4px 8px",
  border: "1px solid #0f172a",
  background: "#fff",
  color: "#0f172a",
  fontWeight: 600,
  fontSize: 11,
  borderRadius: 6,
  cursor: "pointer",
} as const;
const th = { padding: "6px 8px", borderBottom: "1px solid #e2e8f0" } as const;
const td = { padding: "6px 8px", borderBottom: "1px solid #f1f5f9" } as const;
