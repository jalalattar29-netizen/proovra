"use client";

/**
 * PROOVRA Phase 2A — Coding Schemas admin surface.
 *
 * Workspace-anchored list of coding schemas with seed-defaults action.
 * Detail editing + new-schema authoring are linked from here; the
 * primary surface focuses on quick discovery + the one-click default
 * seed so reviewers can be productive within seconds of opening the
 * workspace.
 */

import { useCallback, useEffect, useState } from "react";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { apiFetch } from "../../../../lib/api";
import {
  seedDefaultSchemas,
  type CodingSchemaRow,
} from "../../../../lib/reviewer-workspace/reviewer-api";

export default function CodingSchemasPage() {
  return (
    <PageRouteGate routeId="workspace.coding_schemas">
      <SchemasShell />
    </PageRouteGate>
  );
}

function SchemasShell() {
  const [schemas, setSchemas] = useState<CodingSchemaRow[] | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await apiFetch("/v1/coding/schemas", { method: "GET" });
    setSchemas((res?.schemas ?? []) as CodingSchemaRow[]);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSeed = useCallback(async () => {
    setSeeding(true);
    try {
      const res = await seedDefaultSchemas();
      setBanner(
        `Seed complete: ${res.created} created, ${res.existing} already present.`,
      );
      await refresh();
    } finally {
      setSeeding(false);
    }
  }, [refresh]);

  return (
    <div
      data-coding-schemas-page
      style={{
        padding: 24,
        maxWidth: 1100,
        margin: "0 auto",
        color: "#0f172a",
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div>
          <h1 style={{ fontSize: 22, margin: 0 }}>Coding schemas</h1>
          <p style={{ margin: "4px 0", color: "#475569", fontSize: 13 }}>
            Structured review templates. Reviewers code against published
            schemas; legacy free-form notes remain available under the
            generic schema.
          </p>
        </div>
        <button
          type="button"
          onClick={onSeed}
          disabled={seeding}
          data-coding-seed-defaults
          style={primaryBtnStyle(seeding)}
        >
          {seeding ? "Seeding…" : "Seed 6 default schemas"}
        </button>
      </header>

      {banner ? (
        <div
          data-coding-seed-banner
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            background: "rgba(34, 197, 94, 0.08)",
            border: "1px solid rgba(34, 197, 94, 0.4)",
            marginBottom: 12,
            fontSize: 13,
          }}
        >
          {banner}
        </div>
      ) : null}

      {schemas === null ? (
        <div>Loading schemas…</div>
      ) : schemas.length === 0 ? (
        <div
          data-coding-schemas-empty
          style={{ padding: "16px 18px", color: "#475569", fontSize: 14 }}
        >
          No schemas yet. Use <em>Seed defaults</em> to install the 6
          pre-built schemas, or create a new schema via the API.
        </div>
      ) : (
        <table
          data-coding-schemas-table
          style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}
        >
          <thead>
            <tr style={{ textAlign: "left", color: "#475569" }}>
              <th style={th}>Label</th>
              <th style={th}>Category</th>
              <th style={th}>Version</th>
              <th style={th}>Status</th>
              <th style={th}>Fields</th>
            </tr>
          </thead>
          <tbody>
            {schemas.map((s) => (
              <tr key={s.id} data-coding-schema-row={s.id}>
                <td style={td}>
                  <strong>{s.label}</strong>
                  <div style={{ color: "#64748b", fontSize: 11 }}>{s.slug}</div>
                </td>
                <td style={td}>{s.category}</td>
                <td style={td}>v{s.version}</td>
                <td style={td}>
                  <code
                    style={{
                      padding: "1px 6px",
                      borderRadius: 4,
                      background: "#f1f5f9",
                      fontSize: 11,
                    }}
                  >
                    {s.status}
                  </code>
                </td>
                <td style={td}>{(s as unknown as { _count?: { fields: number } })._count?.fields ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const th = { padding: "8px 10px", borderBottom: "1px solid #e2e8f0" } as const;
const td = { padding: "8px 10px", borderBottom: "1px solid #f1f5f9" } as const;
function primaryBtnStyle(disabled: boolean) {
  return {
    padding: "9px 16px",
    borderRadius: 10,
    border: "1px solid #0f172a",
    background: disabled ? "#94a3b8" : "#0f172a",
    color: "#fafafa",
    fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
  } as const;
}
