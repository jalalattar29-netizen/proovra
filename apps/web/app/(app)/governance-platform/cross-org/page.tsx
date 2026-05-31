"use client";

import { useCallback, useEffect, useState } from "react";

import type { CrossOrgReviewGrantProjection } from "@proovra/shared";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { apiFetch } from "../../../../lib/api";

export default function CrossOrgPage() {
  return (
    <PageRouteGate routeId="workspace.governance_platform">
      <Shell />
    </PageRouteGate>
  );
}

function Shell() {
  const [rows, setRows] = useState<ReadonlyArray<CrossOrgReviewGrantProjection>>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const res = await apiFetch("/v1/governance/cross-org-review", { method: "GET" });
      setRows((res?.grants ?? []) as ReadonlyArray<CrossOrgReviewGrantProjection>);
    } catch {
      setRows([]);
    } finally {
      setBusy(false);
    }
  }, []);

  const decline = useCallback(async (id: string) => {
    setBusy(true);
    try {
      await apiFetch(`/v1/governance/cross-org-review/${id}/decline`, { method: "POST" });
      await refresh();
    } catch {
      /* swallow */
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const revoke = useCallback(async (id: string) => {
    setBusy(true);
    try {
      await apiFetch(`/v1/governance/cross-org-review/${id}/revoke`, { method: "POST" });
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
      data-cross-org-page
      style={{
        padding: 20,
        maxWidth: 1320,
        margin: "0 auto",
        color: "#0f172a",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 22, marginTop: 0 }}>Cross-Org Review</h1>
        <p style={{ color: "#475569", fontSize: 13, marginTop: 0 }}>
          Org-to-org review grants. Integrates with the existing External
          Reviewer Portal — bound by `externalReviewGrantId` on accept.
        </p>
        <p><a href="/governance-platform" style={{ fontSize: 12 }}>← Back to Governance Platform</a></p>
      </header>

      <button
        type="button"
        data-cross-org-refresh
        disabled={busy}
        onClick={() => void refresh()}
        style={primaryButton}
      >
        {busy ? "Loading…" : "Refresh"}
      </button>

      <section style={{ background: "#fff", border: "1px solid rgba(15, 23, 42, 0.08)", borderRadius: 10, padding: 8, marginTop: 12, overflowX: "auto" }}>
        <table data-cross-org-table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#475569" }}>
              <th style={th}>Invited org</th>
              <th style={th}>Inviting</th>
              <th style={th}>Scope</th>
              <th style={th}>State</th>
              <th style={th}>External grant</th>
              <th style={th}>Expires</th>
              <th style={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={7} style={{ ...td, color: "#475569" }}>No cross-org grants.</td></tr>
            ) : (
              rows.map((g) => (
                <tr key={g.id} data-cross-org-row={g.id} data-cross-org-state={g.state}>
                  <td style={td}><code>{g.invitedOrgSlug}</code></td>
                  <td style={td}><code>{g.invitingOrganizationId.slice(0, 8)}…</code></td>
                  <td style={td}>{g.scope.slice(0, 80)}{g.scope.length > 80 ? "…" : ""}</td>
                  <td style={td}><strong>{g.state}</strong></td>
                  <td style={td}>
                    {g.externalReviewGrantId ? <code>{g.externalReviewGrantId.slice(0, 8)}…</code> : "—"}
                  </td>
                  <td style={td}>{g.expiresAtUtc ? new Date(g.expiresAtUtc).toLocaleDateString() : "—"}</td>
                  <td style={td}>
                    {g.state === "INVITED" ? (
                      <button type="button" data-cross-org-decline={g.id} onClick={() => void decline(g.id)} style={secondaryButton}>Decline</button>
                    ) : null}
                    {g.state !== "REVOKED" && g.state !== "DECLINED" ? (
                      <button type="button" data-cross-org-revoke={g.id} onClick={() => void revoke(g.id)} style={{ ...secondaryButton, marginLeft: 6 }}>Revoke</button>
                    ) : null}
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
