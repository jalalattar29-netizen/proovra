"use client";

import { useCallback, useEffect, useState } from "react";

import type { DepartmentProjection } from "@proovra/shared";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { apiFetch } from "../../../../lib/api";

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

  return (
    <div
      data-departments-page
      style={{
        padding: 20,
        maxWidth: 1320,
        margin: "0 auto",
        color: "#0f172a",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 22, marginTop: 0 }}>Departments</h1>
        <p style={{ color: "#475569", fontSize: 13, marginTop: 0 }}>
          Department isolation for visibility + governance separation.
        </p>
        <p><a href="/governance-platform" style={{ fontSize: 12 }}>← Back to Governance Platform</a></p>
      </header>

      <section
        data-department-create-form
        style={{
          background: "#fff",
          border: "1px solid rgba(15, 23, 42, 0.08)",
          borderRadius: 10,
          padding: 12,
          marginBottom: 12,
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
        <button
          type="button"
          data-department-create-submit
          disabled={busy || !orgId || !name || !slug}
          onClick={() => void create()}
          style={primaryButton}
        >
          Create
        </button>
      </section>

      <section style={{ background: "#fff", border: "1px solid rgba(15, 23, 42, 0.08)", borderRadius: 10, padding: 8, overflowX: "auto" }}>
        <table data-departments-table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#475569" }}>
              <th style={th}>Name</th>
              <th style={th}>Slug</th>
              <th style={th}>Organization</th>
              <th style={th}>State</th>
              <th style={th}>Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={5} style={{ ...td, color: "#475569" }}>No departments.</td></tr>
            ) : (
              rows.map((d) => (
                <tr key={d.id} data-department-row={d.id} data-department-state={d.state}>
                  <td style={td}>{d.name}</td>
                  <td style={td}><code>{d.slug}</code></td>
                  <td style={td}><code>{d.organizationId.slice(0, 8)}…</code></td>
                  <td style={td}>{d.state}</td>
                  <td style={td}>{new Date(d.createdAtUtc).toLocaleDateString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

const input = {
  padding: "6px 8px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 12,
  minWidth: 180,
} as const;
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
const th = { padding: "6px 8px", borderBottom: "1px solid #e2e8f0" } as const;
const td = { padding: "6px 8px", borderBottom: "1px solid #f1f5f9" } as const;
