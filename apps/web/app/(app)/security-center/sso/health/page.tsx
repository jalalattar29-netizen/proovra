"use client";

/**
 * Phase P1.1 — SSO Health Dashboard.
 *
 * Workspace-scoped read of `/v1/sso/health` (P1.1 backend). Aggregates
 * recent SsoCallbackAttempt rows + SsoConnection state into a per-
 * connection health snapshot:
 *
 *   * Connection health: HEALTHY / DEGRADED / OUTAGE / DISABLED /
 *     UNCONFIGURED
 *   * Cert expiry band: ok / warning / expiring / expired
 *   * Failure-reason taxonomy (bounded set, no raw error strings)
 *   * Recommended action (operator-facing one-liner)
 *
 * Hard rules:
 *   * No raw assertions, no IP addresses, no IdP secrets in the UI.
 *   * Anti-enumeration 404 from backend covers non-admin callers.
 *   * Step-up gating is per-action (cert rotation lives on the main
 *     /security-center/sso page); this dashboard is read-only.
 */

import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { useTeamId } from "../../../../../lib/platform-context";
import { PageRouteGate } from "../../../../../components/navigation/PageRouteGate";
import { AccessGate } from "../../../../../components/access/AccessGate";
import {
  badgeStyle,
  cardStyle,
  errorBoxStyle,
  formatDateTime,
  ghostButtonStyle,
  headerRowStyle,
  mutedStyle,
  pageStyle,
  sectionTitleStyle,
  subtitleStyle,
  tableStyle,
  tdStyle,
  thStyle,
  titleStyle,
  TOKENS,
} from "../../../admin/identity/ui-tokens";

type SsoConnectionHealthStatus =
  | "HEALTHY"
  | "DEGRADED"
  | "OUTAGE"
  | "DISABLED"
  | "UNCONFIGURED";

type SsoFailureReason =
  | "invalid_signature"
  | "expired_certificate"
  | "audience_mismatch"
  | "acs_mismatch"
  | "missing_nameid"
  | "missing_email"
  | "clock_skew"
  | "replay_detected"
  | "idp_unreachable"
  | "metadata_invalid"
  | "unknown";

type CertExpiryBand = "ok" | "warning" | "expiring" | "expired";

type SsoConnectionHealth = {
  connectionId: string;
  provider: string;
  status: string;
  health: SsoConnectionHealthStatus;
  lastSuccessAtUtc: string | null;
  lastFailureAtUtc: string | null;
  consecutiveFailureCount: number;
  outageDetectedAtUtc: string | null;
  outageClearedAtUtc: string | null;
  cert: {
    fingerprint: string | null;
    notAfterUtc: string | null;
    expiryBand: CertExpiryBand;
    daysUntilExpiry: number | null;
  };
  attemptCounts: {
    last24h: { total: number; failed: number; replayed: number };
    last7d: { total: number; failed: number; replayed: number };
  };
  failureBreakdown: ReadonlyArray<{
    reason: SsoFailureReason;
    count24h: number;
    count7d: number;
  }>;
  recommendedAction: string | null;
};

type SsoHealthSnapshot = {
  teamId: string;
  generatedAtUtc: string;
  overallStatus: SsoConnectionHealthStatus;
  connections: ReadonlyArray<SsoConnectionHealth>;
};

function healthBadge(h: SsoConnectionHealthStatus) {
  if (h === "HEALTHY")
    return badgeStyle({ bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" });
  if (h === "DEGRADED")
    return badgeStyle({ bg: "#fef3c7", fg: "#78350f", border: "#fde68a" });
  if (h === "OUTAGE")
    return badgeStyle({ bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" });
  if (h === "DISABLED")
    return badgeStyle({ bg: "#f1f5f9", fg: "#475569", border: "#cbd5e1" });
  return badgeStyle({ bg: "#eef2ff", fg: "#3730a3", border: "#c7d2fe" });
}

function certBadge(band: CertExpiryBand) {
  if (band === "ok")
    return badgeStyle({ bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" });
  if (band === "warning")
    return badgeStyle({ bg: "#fef3c7", fg: "#78350f", border: "#fde68a" });
  if (band === "expiring")
    return badgeStyle({ bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" });
  return badgeStyle({ bg: "#fef2f2", fg: "#7f1d1d", border: "#fca5a5" });
}

export default function SsoHealthPage() {
  return (
    <PageRouteGate routeId="workspace.security_center">
      <SsoHealthContent />
    </PageRouteGate>
  );
}

function SsoHealthContent() {
  const teamId = useTeamId();
  const [snapshot, setSnapshot] = useState<SsoHealthSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    if (!teamId) return;
    setLoading(true);
    setError(null);
    apiFetch(`/v1/sso/health?teamId=${encodeURIComponent(teamId)}`, {
      method: "GET",
    })
      .then((r: { snapshot: SsoHealthSnapshot }) => setSnapshot(r.snapshot))
      .catch((err: { message?: string }) =>
        setError(toSafeUserError(err, { message: "Could not load SSO health." }).message),
      )
      .finally(() => setLoading(false));
  }, [teamId]);

  useEffect(() => {
    load();
  }, [load]);

  if (!teamId) {
    return (
      <main style={pageStyle}>
        <AccessGate
          kind="WORKSPACE_REQUIRED"
          surface="SSO Health"
          headline="Switch to a team workspace to view SSO health"
          reason="SSO health is per-workspace. Open a team workspace you administer to diagnose connection health."
          actions={[
            { label: "Open team workspaces", href: "/workspaces", variant: "primary" },
          ]}
          testid="sso-health-access-gate-no-workspace"
        />
      </main>
    );
  }

  return (
    <main style={pageStyle}>
      <header style={headerRowStyle}>
        <div>
          <h1 style={titleStyle}>SSO Health</h1>
          <p style={subtitleStyle}>
            Diagnostic snapshot of each configured SSO connection.
            Bounded failure-reason taxonomy + cert expiry projections +
            recommended remediation action per connection. Aggregates
            from the last 24h and 7d of callback attempts.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            type="button"
            style={ghostButtonStyle}
            onClick={load}
            disabled={loading}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      {snapshot ? (
        <>
          <section style={{ ...cardStyle, marginTop: 16 }}>
            <div
              style={{
                display: "flex",
                gap: 32,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <div>
                <div style={mutedStyle}>Overall status</div>
                <div style={{ marginTop: 4 }}>
                  <span style={healthBadge(snapshot.overallStatus)}>
                    {snapshot.overallStatus}
                  </span>
                </div>
              </div>
              <div>
                <div style={mutedStyle}>Connections</div>
                <div style={{ fontSize: 20, fontWeight: 700 }}>
                  {snapshot.connections.length}
                </div>
              </div>
              <div>
                <div style={mutedStyle}>Generated</div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>
                  {formatDateTime(snapshot.generatedAtUtc)}
                </div>
              </div>
            </div>
          </section>

          {snapshot.connections.length === 0 ? (
            <section
              style={{
                ...cardStyle,
                marginTop: 12,
                padding: 24,
                textAlign: "center",
              }}
            >
              <p style={mutedStyle}>
                No SSO connections configured. Configure SAML or OIDC on the{" "}
                <a
                  href="/security-center/sso"
                  style={{ color: TOKENS.link, textDecoration: "underline" }}
                >
                  SSO Admin
                </a>{" "}
                page.
              </p>
            </section>
          ) : (
            snapshot.connections.map((c) => (
              <section key={c.connectionId} style={{ ...cardStyle, marginTop: 12 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    flexWrap: "wrap",
                    gap: 16,
                  }}
                >
                  <div>
                    <h3 style={{ margin: 0, fontSize: 15 }}>
                      {c.provider}{" "}
                      <span style={{ ...mutedStyle, fontWeight: 400 }}>
                        ({c.connectionId.slice(0, 8)}…)
                      </span>
                    </h3>
                    <div style={{ marginTop: 6, display: "flex", gap: 6 }}>
                      <span style={healthBadge(c.health)}>{c.health}</span>
                      <span style={certBadge(c.cert.expiryBand)}>
                        cert: {c.cert.expiryBand}
                        {c.cert.daysUntilExpiry !== null
                          ? ` · ${c.cert.daysUntilExpiry}d`
                          : ""}
                      </span>
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ ...mutedStyle, fontSize: 11 }}>
                      Last success
                    </div>
                    <div style={{ fontSize: 12 }}>
                      {formatDateTime(c.lastSuccessAtUtc)}
                    </div>
                    <div style={{ ...mutedStyle, fontSize: 11, marginTop: 4 }}>
                      Last failure
                    </div>
                    <div style={{ fontSize: 12 }}>
                      {formatDateTime(c.lastFailureAtUtc)}
                    </div>
                  </div>
                </div>

                {c.recommendedAction ? (
                  <div
                    style={{
                      marginTop: 10,
                      padding: 10,
                      background: "#fef3c7",
                      border: "1px solid #fde68a",
                      borderRadius: 6,
                      fontSize: 12,
                      color: "#78350f",
                    }}
                  >
                    <strong>Recommended action:</strong> {c.recommendedAction}
                  </div>
                ) : null}

                <div style={{ marginTop: 12 }}>
                  <h4 style={sectionTitleStyle}>Attempt counts</h4>
                  <table style={tableStyle}>
                    <thead>
                      <tr>
                        <th style={thStyle}>Window</th>
                        <th style={thStyle}>Total</th>
                        <th style={thStyle}>Failed</th>
                        <th style={thStyle}>Replayed</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td style={tdStyle}>Last 24h</td>
                        <td style={tdStyle}>{c.attemptCounts.last24h.total}</td>
                        <td style={tdStyle}>
                          {c.attemptCounts.last24h.failed}
                        </td>
                        <td style={tdStyle}>
                          {c.attemptCounts.last24h.replayed}
                        </td>
                      </tr>
                      <tr>
                        <td style={tdStyle}>Last 7d</td>
                        <td style={tdStyle}>{c.attemptCounts.last7d.total}</td>
                        <td style={tdStyle}>
                          {c.attemptCounts.last7d.failed}
                        </td>
                        <td style={tdStyle}>
                          {c.attemptCounts.last7d.replayed}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                {c.failureBreakdown.length > 0 ? (
                  <div style={{ marginTop: 12 }}>
                    <h4 style={sectionTitleStyle}>Failure breakdown</h4>
                    <table style={tableStyle}>
                      <thead>
                        <tr>
                          <th style={thStyle}>Reason</th>
                          <th style={thStyle}>24h</th>
                          <th style={thStyle}>7d</th>
                        </tr>
                      </thead>
                      <tbody>
                        {c.failureBreakdown.map((b) => (
                          <tr key={b.reason}>
                            <td style={tdStyle}>
                              <code
                                style={{
                                  fontFamily: "monospace",
                                  fontSize: 12,
                                }}
                              >
                                {b.reason}
                              </code>
                            </td>
                            <td style={tdStyle}>{b.count24h}</td>
                            <td style={tdStyle}>{b.count7d}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </section>
            ))
          )}
        </>
      ) : loading ? (
        <p style={{ ...mutedStyle, marginTop: 16 }}>Loading SSO health…</p>
      ) : null}
    </main>
  );
}
