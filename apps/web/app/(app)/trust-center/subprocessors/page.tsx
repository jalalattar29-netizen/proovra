"use client";

/**
 * Phase 4A — Subprocessor registry surface.
 */

import { useCallback, useEffect, useState } from "react";

import type { SubprocessorProjection } from "@proovra/shared";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { apiFetch } from "../../../../lib/api";

export default function SubprocessorsPage() {
  return (
    <PageRouteGate routeId="workspace.trust">
      <Shell />
    </PageRouteGate>
  );
}

function Shell() {
  const [rows, setRows] = useState<ReadonlyArray<SubprocessorProjection>>([]);
  const [reason, setReason] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function degradedMessage(code: string) {
    switch (code) {
      case "SCHEMA_NOT_READY":
        return "The Subprocessor Registry is temporarily degraded because the required backend schema is not ready yet.";
      case "DB_UNAVAILABLE":
        return "The Subprocessor Registry is temporarily degraded because the database is unavailable.";
      case "SUBPROCESSOR_AUTO_SEED_FAILED":
        return "The Subprocessor Registry is temporarily degraded because the canonical vendor seed could not be prepared.";
      case "SUBPROCESSOR_READ_FAILED":
      default:
        return "The Subprocessor Registry is temporarily degraded because subprocessors could not be loaded safely.";
    }
  }

  const refresh = useCallback(async () => {
    setBusy(true);
    setFailed(null);
    try {
      const res = await apiFetch("/v1/trust/subprocessors", { method: "GET" });
      if ((res as { degraded?: boolean } | null)?.degraded) {
        setRows([]);
        setReason(
          String(
            (res as { reason?: string | null } | null)?.reason ??
              "SUBPROCESSOR_READ_FAILED",
          ),
        );
        return;
      }
      setReason(null);
      setRows((res?.subprocessors ?? []) as ReadonlyArray<SubprocessorProjection>);
    } catch {
      setRows([]);
      setReason(null);
      setFailed("Subprocessors could not be loaded. Press Refresh to try again.");
    } finally {
      setBusy(false);
    }
  }, []);

  const seedDefaults = useCallback(async () => {
    setBusy(true);
    setFailed(null);
    try {
      await apiFetch("/v1/trust/subprocessors/seed", { method: "POST" });
      await refresh();
    } catch {
      setFailed("The canonical subprocessor seed could not be applied.");
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div
      data-subprocessors-page
      style={{
        padding: 20,
        maxWidth: 1320,
        margin: "0 auto",
        color: "#0f172a",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 22, marginTop: 0 }}>Subprocessor Registry</h1>
        <p style={{ color: "#475569", fontSize: 13, marginTop: 0 }}>
          Authoritative list of vendors that may process customer data.
          Every entry is versioned; every change writes an audit row.
        </p>
        <p>
          <a href="/trust" style={{ fontSize: 12 }}>
            ← Back to Trust Center
          </a>
        </p>
      </header>

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button
          type="button"
          data-subprocessors-refresh
          onClick={() => void refresh()}
          disabled={busy}
          style={primaryButton}
        >
          {busy ? "Loading…" : "Refresh"}
        </button>
        <button
          type="button"
          data-subprocessors-seed
          onClick={() => void seedDefaults()}
          disabled={busy}
          style={secondaryButton}
        >
          Re-seed defaults
        </button>
      </div>

      <section style={{ background: "#fff", border: "1px solid rgba(15, 23, 42, 0.08)", borderRadius: 10, padding: 8, overflowX: "auto" }}>
        {reason ? (
          <div
            data-subprocessors-phase="degraded"
            data-subprocessors-reason={reason}
            style={{
              marginBottom: 8,
              padding: 12,
              background: "rgba(148, 163, 184, 0.10)",
              border: "1px solid rgba(148, 163, 184, 0.28)",
              borderRadius: 8,
              color: "#334155",
              fontSize: 12,
              display: "grid",
              gap: 6,
            }}
          >
            <div>{degradedMessage(reason)}</div>
            <div>
              Reason: <code>{reason}</code>
            </div>
          </div>
        ) : null}
        {failed ? (
          <div
            data-subprocessors-phase="error"
            style={{
              marginBottom: 8,
              padding: 12,
              background: "rgba(185, 28, 28, 0.06)",
              border: "1px solid rgba(185, 28, 28, 0.20)",
              borderRadius: 8,
              color: "#7f1d1d",
              fontSize: 12,
            }}
          >
            {failed}
          </div>
        ) : null}
        <table data-subprocessors-table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#475569" }}>
              <th style={th}>Name</th>
              <th style={th}>Vendor</th>
              <th style={th}>Purpose</th>
              <th style={th}>Region</th>
              <th style={th}>Data categories</th>
              <th style={th}>State</th>
              <th style={th}>Version</th>
              <th style={th}>Effective</th>
              <th style={th}>Docs</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !reason && !failed ? (
              <tr><td colSpan={9} style={{ ...td, color: "#475569" }}>No subprocessors registered.</td></tr>
            ) : (
              rows.map((r) => (
                <tr
                  key={r.id}
                  data-subprocessor-row={r.slug}
                  data-subprocessor-state={r.state}
                >
                  <td style={td}>{r.name}</td>
                  <td style={td}>{r.vendor}</td>
                  <td style={td}>{r.purpose}</td>
                  <td style={td}>{r.region}</td>
                  <td style={td}>
                    {r.dataCategories.map((c) => (
                      <code key={c} style={{ marginRight: 4 }}>{c}</code>
                    ))}
                  </td>
                  <td style={td}><strong>{r.state}</strong></td>
                  <td style={td}>v{r.version}</td>
                  <td style={td}>{new Date(r.effectiveAtUtc).toLocaleDateString()}</td>
                  <td style={td}>
                    {r.documentationUrl ? (
                      <a href={r.documentationUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>
                        link
                      </a>
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
  padding: "6px 12px",
  border: "1px solid #cbd5e1",
  background: "#fff",
  color: "#0f172a",
  fontWeight: 600,
  fontSize: 12,
  borderRadius: 8,
  cursor: "pointer",
} as const;
const th = { padding: "6px 8px", borderBottom: "1px solid #e2e8f0" } as const;
const td = { padding: "6px 8px", borderBottom: "1px solid #f1f5f9" } as const;
