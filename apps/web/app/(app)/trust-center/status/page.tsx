"use client";

/**
 * Phase 4A — Status Page.
 */

import { useCallback, useEffect, useState } from "react";

import type { StatusPageProjection } from "@proovra/shared";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { apiFetch } from "../../../../lib/api";

export default function StatusPage() {
  return (
    <PageRouteGate routeId="workspace.trust_center">
      <Shell />
    </PageRouteGate>
  );
}

function Shell() {
  const [status, setStatus] = useState<StatusPageProjection | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const res = await apiFetch("/v1/trust/status", { method: "GET" });
      setStatus((res?.status ?? null) as StatusPageProjection | null);
    } catch {
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div
      data-status-page
      style={{
        padding: 20,
        maxWidth: 1320,
        margin: "0 auto",
        color: "#0f172a",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 22, marginTop: 0 }}>Status Page</h1>
        <p style={{ color: "#475569", fontSize: 13, marginTop: 0 }}>
          Operational health across PROOVRA components.
          {status ? (
            <>
              {" "}Upstream: <code>{status.upstreamProvider}</code>
            </>
          ) : null}
        </p>
        <p>
          <a href="/trust-center" style={{ fontSize: 12 }}>← Back to Trust Center</a>
        </p>
      </header>

      <div style={{ marginBottom: 12 }}>
        <button
          type="button"
          data-status-refresh
          onClick={() => void refresh()}
          disabled={busy}
          style={{
            padding: "6px 12px",
            border: "1px solid #0f172a",
            background: "#0f172a",
            color: "#fafafa",
            fontWeight: 600,
            fontSize: 12,
            borderRadius: 8,
            cursor: "pointer",
          }}
        >
          {busy ? "Loading…" : "Refresh"}
        </button>
      </div>

      {status ? (
        <>
          <div
            data-status-overall
            data-status-overall-health={status.overallHealth}
            style={{
              padding: 12,
              background: overallBg(status.overallHealth),
              border: "1px solid rgba(15, 23, 42, 0.08)",
              borderRadius: 10,
              marginBottom: 12,
            }}
          >
            <strong style={{ fontSize: 14 }}>Overall health: {status.overallHealth}</strong>
          </div>

          <section data-status-components style={{ marginBottom: 12 }}>
            <h2 style={{ fontSize: 14 }}>Components</h2>
            <table style={tableStyle}>
              <thead>
                <tr style={{ textAlign: "left", color: "#475569" }}>
                  <th style={th}>Component</th>
                  <th style={th}>Health</th>
                  <th style={th}>Description</th>
                  <th style={th}>Source</th>
                  <th style={th}>Updated</th>
                </tr>
              </thead>
              <tbody>
                {status.components.map((c) => (
                  <tr key={c.key} data-status-component={c.key} data-status-component-health={c.health}>
                    <td style={td}>{c.label}</td>
                    <td style={td}><strong>{c.health}</strong></td>
                    <td style={td}>{c.description}</td>
                    <td style={td}><code>{c.upstreamSource}</code></td>
                    <td style={td}>{new Date(c.lastUpdatedUtc).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section data-status-active-incidents style={{ marginBottom: 12 }}>
            <h2 style={{ fontSize: 14 }}>Active incidents · {status.activeIncidents.length}</h2>
            <IncidentList incidents={status.activeIncidents} />
          </section>

          <section data-status-recent-incidents style={{ marginBottom: 12 }}>
            <h2 style={{ fontSize: 14 }}>Resolved incidents · {status.recentIncidents.length}</h2>
            <IncidentList incidents={status.recentIncidents} />
          </section>

          <section data-status-maintenance style={{ marginBottom: 12 }}>
            <h2 style={{ fontSize: 14 }}>Maintenance windows · {status.maintenanceWindows.length}</h2>
            {status.maintenanceWindows.length === 0 ? (
              <p style={{ color: "#475569", fontSize: 12 }}>None scheduled.</p>
            ) : (
              <table style={tableStyle}>
                <thead>
                  <tr style={{ textAlign: "left", color: "#475569" }}>
                    <th style={th}>Title</th>
                    <th style={th}>Components</th>
                    <th style={th}>Start</th>
                    <th style={th}>End</th>
                    <th style={th}>State</th>
                  </tr>
                </thead>
                <tbody>
                  {status.maintenanceWindows.map((w) => (
                    <tr key={w.id} data-maintenance-window={w.id}>
                      <td style={td}>{w.title}</td>
                      <td style={td}>{w.componentKeys.join(", ")}</td>
                      <td style={td}>{new Date(w.startsAtUtc).toLocaleString()}</td>
                      <td style={td}>{new Date(w.endsAtUtc).toLocaleString()}</td>
                      <td style={td}>{w.state}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <footer
            data-status-limitations
            style={{
              marginTop: 12,
              padding: 10,
              background: "rgba(15, 23, 42, 0.04)",
              border: "1px dashed rgba(15, 23, 42, 0.18)",
              borderRadius: 8,
              fontSize: 11,
              color: "#475569",
            }}
          >
            <strong style={{ color: "#0f172a" }}>Limitations</strong>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
              {status.limitations.map((l) => (
                <li key={l}><code>{l}</code></li>
              ))}
            </ul>
          </footer>
        </>
      ) : (
        <p style={{ color: "#475569" }}>Loading status…</p>
      )}
    </div>
  );
}

function IncidentList({
  incidents,
}: {
  incidents: StatusPageProjection["activeIncidents"];
}) {
  if (incidents.length === 0)
    return <p style={{ color: "#475569", fontSize: 12 }}>None.</p>;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {incidents.map((i) => (
        <article
          key={i.id}
          data-status-incident={i.id}
          data-status-incident-state={i.state}
          data-status-incident-severity={i.severity}
          style={{
            background: "#fff",
            border: "1px solid rgba(15, 23, 42, 0.08)",
            borderRadius: 8,
            padding: 10,
          }}
        >
          <header style={{ display: "flex", justifyContent: "space-between" }}>
            <strong style={{ fontSize: 14 }}>{i.title}</strong>
            <small>
              <code>{i.severity}</code> · <code>{i.state}</code>
            </small>
          </header>
          <p style={{ fontSize: 11, color: "#475569" }}>
            Components: {i.componentKeys.join(", ")} · Started{" "}
            {new Date(i.startedAtUtc).toLocaleString()}
            {i.resolvedAtUtc ? (
              <> · Resolved {new Date(i.resolvedAtUtc).toLocaleString()}</>
            ) : null}
          </p>
          {i.updates.length > 0 ? (
            <ul style={{ marginTop: 6, paddingLeft: 18 }}>
              {i.updates.map((u) => (
                <li key={u.id} style={{ fontSize: 12 }}>
                  <code>{u.state}</code> · {new Date(u.createdAtUtc).toLocaleString()} —{" "}
                  {u.body}
                </li>
              ))}
            </ul>
          ) : null}
          {i.postmortemUrl ? (
            <p style={{ marginTop: 6 }}>
              <a href={i.postmortemUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>
                Postmortem
              </a>
            </p>
          ) : null}
        </article>
      ))}
    </div>
  );
}

function overallBg(h: string): string {
  if (h === "OPERATIONAL") return "rgba(21, 128, 61, 0.10)";
  if (h === "DEGRADED" || h === "MAINTENANCE") return "rgba(161, 98, 7, 0.10)";
  if (h === "PARTIAL_OUTAGE" || h === "MAJOR_OUTAGE") return "rgba(185, 28, 28, 0.10)";
  return "rgba(15, 23, 42, 0.04)";
}

const tableStyle = { width: "100%", borderCollapse: "collapse" as const, fontSize: 12 };
const th = { padding: "6px 8px", borderBottom: "1px solid #e2e8f0" } as const;
const td = { padding: "6px 8px", borderBottom: "1px solid #f1f5f9" } as const;
