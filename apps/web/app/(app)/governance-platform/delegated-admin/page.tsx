"use client";

import { useCallback, useEffect, useState } from "react";

import {
  DELEGATED_ADMIN_TIERS,
  type DelegatedAdminGrantProjection,
} from "@proovra/shared";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { apiFetch } from "../../../../lib/api";

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

  return (
    <div
      data-delegated-admin-page
      style={{
        padding: 20,
        maxWidth: 1320,
        margin: "0 auto",
        color: "#0f172a",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 22, marginTop: 0 }}>Delegated Administration</h1>
        <p style={{ color: "#475569", fontSize: 13, marginTop: 0 }}>
          Tiered grants enforced server-side. Tiers: {DELEGATED_ADMIN_TIERS.join(", ")}.
        </p>
        <p><a href="/governance-platform" style={{ fontSize: 12 }}>← Back to Governance Platform</a></p>
      </header>

      <button
        type="button"
        data-delegated-admin-refresh
        disabled={busy}
        onClick={() => void refresh()}
        style={primaryButton}
      >
        {busy ? "Loading…" : "Refresh"}
      </button>

      <section style={{ background: "#fff", border: "1px solid rgba(15, 23, 42, 0.08)", borderRadius: 10, padding: 8, marginTop: 12, overflowX: "auto" }}>
        <table data-delegated-admin-table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#475569" }}>
              <th style={th}>Grantee</th>
              <th style={th}>Tier</th>
              <th style={th}>Organization</th>
              <th style={th}>Department</th>
              <th style={th}>Workspace</th>
              <th style={th}>State</th>
              <th style={th}>Granted</th>
              <th style={th}>Expires</th>
              <th style={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={9} style={{ ...td, color: "#475569" }}>No grants.</td></tr>
            ) : (
              rows.map((g) => (
                <tr key={g.id} data-delegated-admin-row={g.id} data-delegated-admin-tier={g.tier} data-delegated-admin-state={g.state}>
                  <td style={td}><code>{g.granteeUserId.slice(0, 8)}…</code></td>
                  <td style={td}><strong>{g.tier}</strong></td>
                  <td style={td}><code>{g.organizationId.slice(0, 8)}…</code></td>
                  <td style={td}>{g.departmentId ? <code>{g.departmentId.slice(0, 8)}…</code> : "—"}</td>
                  <td style={td}>{g.workspaceId ? <code>{g.workspaceId.slice(0, 8)}…</code> : "—"}</td>
                  <td style={td}>{g.state}</td>
                  <td style={td}>{new Date(g.grantedAtUtc).toLocaleDateString()}</td>
                  <td style={td}>{g.expiresAtUtc ? new Date(g.expiresAtUtc).toLocaleDateString() : "—"}</td>
                  <td style={td}>
                    {g.state === "ACTIVE" ? (
                      <button
                        type="button"
                        data-delegated-admin-revoke={g.id}
                        onClick={() => void revoke(g.id)}
                        disabled={busy}
                        style={secondaryButton}
                      >
                        Revoke
                      </button>
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
  border: "1px solid #b91c1c",
  background: "#fff",
  color: "#b91c1c",
  fontWeight: 600,
  fontSize: 11,
  borderRadius: 6,
  cursor: "pointer",
} as const;
const th = { padding: "6px 8px", borderBottom: "1px solid #e2e8f0" } as const;
const td = { padding: "6px 8px", borderBottom: "1px solid #f1f5f9" } as const;
