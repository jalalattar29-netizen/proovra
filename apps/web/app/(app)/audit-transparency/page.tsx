"use client";

/**
 * PROOVRA Phase 3B — Audit & Transparency Center.
 *
 * Bounded federated timeline across every audit-producing surface
 * (provider usage, corrections, redaction activity, policy audit,
 * video timeline, portal access). Operators + auditors filter by
 * bounded category + period.
 *
 * Hard rules:
 *   * NEVER PII. Bounded category vocabulary.
 *   * Reads through `/v1/audit-transparency`.
 *   * Capped at 500 rows per request.
 */

import { useCallback, useEffect, useState } from "react";

import {
  AUDIT_TRANSPARENCY_CATEGORIES,
  type AuditTransparencyCategory,
  type AuditTransparencyEntry,
} from "@proovra/shared";

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { apiFetch } from "../../../lib/api";

export default function AuditTransparencyCenterPage() {
  return (
    <PageRouteGate routeId="workspace.audit_transparency">
      <AuditTransparencyShell />
    </PageRouteGate>
  );
}

function AuditTransparencyShell() {
  const [entries, setEntries] = useState<AuditTransparencyEntry[]>([]);
  const [category, setCategory] = useState<
    AuditTransparencyCategory | "ALL"
  >("ALL");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const url =
        category === "ALL"
          ? "/v1/audit-transparency?limit=200"
          : `/v1/audit-transparency?category=${category}&limit=200`;
      const res = await apiFetch(url, { method: "GET" });
      setEntries((res?.entries ?? []) as AuditTransparencyEntry[]);
    } catch {
      setEntries([]);
    } finally {
      setBusy(false);
    }
  }, [category]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div
      data-audit-transparency-center
      style={{
        padding: 20,
        maxWidth: 1320,
        margin: "0 auto",
        color: "#0f172a",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 22, marginTop: 0 }}>
          Audit & Transparency Center
        </h1>
        <p style={{ color: "#475569", fontSize: 13, marginTop: 0 }}>
          Federated audit timeline across PROOVRA's bounded activity
          tables. Bounded counts + bounded ids only — NEVER PII.
        </p>
      </header>

      <div
        data-audit-transparency-filter-bar
        style={{
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
          marginBottom: 12,
          padding: 8,
          background: "#fff",
          border: "1px solid rgba(15, 23, 42, 0.08)",
          borderRadius: 8,
        }}
      >
        <label style={{ fontSize: 11, color: "#475569" }}>
          Category
          <select
            data-audit-transparency-category
            value={category}
            onChange={(e) =>
              setCategory(
                e.target.value as AuditTransparencyCategory | "ALL",
              )
            }
            style={{
              marginLeft: 4,
              padding: "3px 6px",
              borderRadius: 6,
              border: "1px solid #cbd5e1",
              fontSize: 11,
            }}
          >
            <option value="ALL">All</option>
            {AUDIT_TRANSPARENCY_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          data-audit-transparency-refresh
          onClick={() => void refresh()}
          style={primaryButton}
          disabled={busy}
        >
          {busy ? "Loading…" : "Refresh"}
        </button>
      </div>

      <section
        data-audit-transparency-table-wrap
        style={{
          background: "#fff",
          border: "1px solid rgba(15, 23, 42, 0.08)",
          borderRadius: 10,
          padding: 8,
          overflowX: "auto",
        }}
      >
        <table
          data-audit-transparency-table
          style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}
        >
          <thead>
            <tr style={{ textAlign: "left", color: "#475569" }}>
              <th style={th}>When</th>
              <th style={th}>Category</th>
              <th style={th}>Code</th>
              <th style={th}>Label</th>
              <th style={th}>Failure reason</th>
              <th style={th}>Source</th>
              <th style={th}>Actor</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ ...td, color: "#475569" }}>
                  No activity in the selected window.
                </td>
              </tr>
            ) : (
              entries.map((e, idx) => {
                const failureReason =
                  (e.payload as Record<string, unknown> | null)?.failureReason ??
                  (e.payload as Record<string, unknown> | null)?.reason ??
                  null;
                return (
                  <tr
                    key={`${e.occurredAtUtc}:${e.code}:${idx}`}
                    data-audit-transparency-row={e.code}
                    data-audit-transparency-category-row={e.category}
                  >
                    <td style={td}>
                      {new Date(e.occurredAtUtc).toLocaleString()}
                    </td>
                    <td style={td}>
                      <code>{e.category}</code>
                    </td>
                    <td style={td}>
                      <code>{e.code}</code>
                    </td>
                    <td style={td}>{e.label}</td>
                    <td style={td} data-audit-transparency-failure-reason={String(failureReason ?? "")}>
                      {failureReason ? (
                        <code style={{ color: "#b91c1c" }}>
                          {String(failureReason).slice(0, 60)}
                        </code>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td style={td}>
                      <code>{e.sourceService}</code>
                    </td>
                    <td style={td}>
                      {e.actorUserId ? (
                        <code>{e.actorUserId.slice(0, 8)}…</code>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })
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
const th = { padding: "6px 8px", borderBottom: "1px solid #e2e8f0" } as const;
const td = { padding: "6px 8px", borderBottom: "1px solid #f1f5f9" } as const;
