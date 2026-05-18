"use client";

/**
 * Phase 11 — Security operations console.
 *
 * Authenticated OWNER/ADMIN visibility into:
 *   - file security scan counts
 *   - recent security events (mime mismatches, archive limits,
 *     executable uploads, webhook redirects, etc.)
 *   - whether malware scanning is feature-flag enabled
 *
 * NEVER exposes:
 *   - raw payloads, hashes, ciphertexts, signing secrets
 *   - scanner internals beyond the public summary field
 *   - data from another workspace
 *   - public-verify-side state
 *
 * Wording is deliberately operational: "flagged", "suspicious",
 * "scan pending", "blocked by policy" — never "virus free" or
 * "guaranteed safe".
 */

import { useEffect, useState } from "react";

import { apiFetch } from "../../../lib/api";

type Summary = {
  malwareScanningEnabled: boolean;
  scanCounts: {
    pending: number;
    clean: number;
    suspicious: number;
    failed: number;
    skipped: number;
  };
  eventCounts: {
    total: number;
    high: number;
    warning: number;
    info: number;
  };
  sinceDays: number;
};

type Scan = {
  id: string;
  evidenceId: string;
  teamId: string | null;
  status: string;
  scanner: string | null;
  signatureVersion: string | null;
  findingsSummary: string | null;
  scannedAtUtc: string | null;
  createdAt: string;
  updatedAt: string;
};

type Event = {
  id: string;
  teamId: string | null;
  eventType: string;
  severity: string;
  evidenceId: string | null;
  apiCredentialId: string | null;
  webhookEndpointId: string | null;
  details: unknown;
  createdAt: string;
};

export default function SecurityPage() {
  const [teamId, setTeamId] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [events, setEvents] = useState<Event[] | null>(null);
  const [scans, setScans] = useState<Scan[] | null>(null);
  const [severity, setSeverity] = useState<"" | "INFO" | "WARNING" | "HIGH">(
    "",
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/v1/users/me", { method: "GET" })
      .then((res: { user?: { currentWorkspaceId?: string | null } }) => {
        if (cancelled) return;
        setTeamId(res?.user?.currentWorkspaceId ?? null);
      })
      .catch(() => setTeamId(null));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    Promise.all([
      apiFetch(
        `/v1/security/summary?teamId=${encodeURIComponent(teamId)}&sinceDays=30`,
        { method: "GET" },
      ),
      apiFetch(
        `/v1/security/events?teamId=${encodeURIComponent(teamId)}${severity ? `&severity=${severity}` : ""}&limit=100`,
        { method: "GET" },
      ),
      apiFetch(
        `/v1/security/scans?teamId=${encodeURIComponent(teamId)}&limit=50`,
        { method: "GET" },
      ),
    ])
      .then(
        ([s, e, sc]: [
          Summary,
          { events: Event[] },
          { scans: Scan[] },
        ]) => {
          if (cancelled) return;
          setSummary(s);
          setEvents(e.events ?? []);
          setScans(sc.scans ?? []);
          setError(null);
        },
      )
      .catch((err: { message?: string }) => {
        if (cancelled) return;
        setError(err?.message ?? "Could not load security data.");
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, severity]);

  return (
    <main style={pageStyle}>
      <header>
        <h1 style={titleStyle}>Security operations</h1>
        <p style={mutedStyle}>
          Internal-only view of file security scans and abuse / anomaly
          signals from this workspace. Counts reflect the last 30 days.
          These signals are operational hints — they are not authenticity
          claims and are never surfaced on public verify.
        </p>
      </header>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      {!teamId ? (
        <p style={mutedStyle}>Switch to a workspace to view security data.</p>
      ) : summary === null ? (
        <p style={mutedStyle}>Loading…</p>
      ) : (
        <>
          <section style={cardStyle}>
            <h2 style={sectionTitleStyle}>Scanner status</h2>
            <p style={mutedStyle}>
              File scanning is{" "}
              <strong>
                {summary.malwareScanningEnabled
                  ? "enabled"
                  : "disabled (feature flag off)"}
              </strong>
              . When disabled, no scan rows are written. When enabled
              without a real scanner, scans are marked SKIPPED with a
              clear summary; uploads are not blocked by this state.
            </p>
            <div style={summaryGridStyle}>
              <Stat label="Pending" value={String(summary.scanCounts.pending)} />
              <Stat label="Clean" value={String(summary.scanCounts.clean)} />
              <Stat
                label="Suspicious"
                value={String(summary.scanCounts.suspicious)}
                tone={summary.scanCounts.suspicious > 0 ? "warn" : "neutral"}
              />
              <Stat label="Failed" value={String(summary.scanCounts.failed)} />
              <Stat label="Skipped" value={String(summary.scanCounts.skipped)} />
            </div>
          </section>

          <section style={cardStyle}>
            <h2 style={sectionTitleStyle}>Security event volume</h2>
            <div style={summaryGridStyle}>
              <Stat label="Total" value={String(summary.eventCounts.total)} />
              <Stat
                label="High"
                value={String(summary.eventCounts.high)}
                tone={summary.eventCounts.high > 0 ? "warn" : "neutral"}
              />
              <Stat
                label="Warning"
                value={String(summary.eventCounts.warning)}
              />
              <Stat label="Info" value={String(summary.eventCounts.info)} />
            </div>
          </section>

          <section style={cardStyle}>
            <div style={cardHeaderStyle}>
              <h2 style={sectionTitleStyle}>Recent security events</h2>
              <select
                value={severity}
                onChange={(e) =>
                  setSeverity(
                    e.target.value as "" | "INFO" | "WARNING" | "HIGH",
                  )
                }
                style={selectStyle}
              >
                <option value="">All severities</option>
                <option value="HIGH">High</option>
                <option value="WARNING">Warning</option>
                <option value="INFO">Info</option>
              </select>
            </div>
            {events === null ? (
              <p style={mutedStyle}>Loading…</p>
            ) : events.length === 0 ? (
              <p style={mutedStyle}>No events in the selected scope.</p>
            ) : (
              <ul style={listStyle}>
                {events.map((e) => (
                  <li key={e.id} style={rowStyle}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>{e.eventType}</div>
                      <div style={mutedStyle}>
                        {new Date(e.createdAt).toLocaleString()}
                        {e.evidenceId ? ` · evidence ${e.evidenceId.slice(0, 8)}…` : ""}
                        {e.apiCredentialId ? ` · cred ${e.apiCredentialId.slice(0, 8)}…` : ""}
                        {e.webhookEndpointId ? ` · hook ${e.webhookEndpointId.slice(0, 8)}…` : ""}
                      </div>
                    </div>
                    <span style={severityBadgeStyle(e.severity)}>
                      {e.severity}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section style={cardStyle}>
            <h2 style={sectionTitleStyle}>Recent file security scans</h2>
            {scans === null ? (
              <p style={mutedStyle}>Loading…</p>
            ) : scans.length === 0 ? (
              <p style={mutedStyle}>No scan rows recorded.</p>
            ) : (
              <ul style={listStyle}>
                {scans.map((s) => (
                  <li key={s.id} style={rowStyle}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>
                        Evidence {s.evidenceId.slice(0, 8)}…
                      </div>
                      <div style={mutedStyle}>
                        scanner {s.scanner ?? "—"}
                        {s.findingsSummary ? ` · ${s.findingsSummary}` : ""}
                        {s.scannedAtUtc
                          ? ` · scanned ${new Date(s.scannedAtUtc).toLocaleString()}`
                          : ""}
                      </div>
                    </div>
                    <span style={scanStatusBadgeStyle(s.status)}>
                      {s.status}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "warn";
}) {
  return (
    <div style={statStyle}>
      <div
        style={{
          fontSize: 22,
          fontWeight: 700,
          color: tone === "warn" ? "#b45309" : "#0f172a",
        }}
      >
        {value}
      </div>
      <div style={mutedStyle}>{label}</div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------------

const pageStyle: React.CSSProperties = {
  maxWidth: 920,
  margin: "0 auto",
  padding: "32px 24px",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  color: "#0f172a",
};
const titleStyle: React.CSSProperties = {
  fontSize: 24,
  fontWeight: 700,
  marginBottom: 4,
};
const sectionTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  marginBottom: 12,
};
const mutedStyle: React.CSSProperties = { fontSize: 13, color: "#64748b" };
const cardStyle: React.CSSProperties = {
  marginTop: 24,
  padding: 20,
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  background: "#fff",
};
const cardHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 12,
};
const summaryGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
  gap: 12,
};
const statStyle: React.CSSProperties = {
  padding: 12,
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
};
const listStyle: React.CSSProperties = { listStyle: "none", padding: 0, margin: 0 };
const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 0",
  borderBottom: "1px solid #e2e8f0",
};
const errorBoxStyle: React.CSSProperties = {
  marginTop: 12,
  padding: 12,
  background: "#fef2f2",
  color: "#7f1d1d",
  border: "1px solid #fecaca",
  borderRadius: 8,
  fontSize: 14,
};
const selectStyle: React.CSSProperties = {
  padding: "6px 12px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 13,
  background: "#fff",
  color: "#0f172a",
};

function severityBadgeStyle(severity: string): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: "4px 10px",
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 999,
    border: "1px solid",
  };
  if (severity === "HIGH") {
    return {
      ...base,
      background: "#fef2f2",
      borderColor: "#fca5a5",
      color: "#991b1b",
    };
  }
  if (severity === "WARNING") {
    return {
      ...base,
      background: "#fffbeb",
      borderColor: "#fcd34d",
      color: "#92400e",
    };
  }
  return {
    ...base,
    background: "#f1f5f9",
    borderColor: "#cbd5e1",
    color: "#475569",
  };
}

function scanStatusBadgeStyle(status: string): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: "4px 10px",
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 999,
    border: "1px solid",
  };
  if (status === "SUSPICIOUS") {
    return {
      ...base,
      background: "#fef2f2",
      borderColor: "#fca5a5",
      color: "#991b1b",
    };
  }
  if (status === "FAILED") {
    return {
      ...base,
      background: "#fffbeb",
      borderColor: "#fcd34d",
      color: "#92400e",
    };
  }
  if (status === "CLEAN") {
    return {
      ...base,
      background: "#f0fdf4",
      borderColor: "#86efac",
      color: "#166534",
    };
  }
  return {
    ...base,
    background: "#f1f5f9",
    borderColor: "#cbd5e1",
    color: "#475569",
  };
}
