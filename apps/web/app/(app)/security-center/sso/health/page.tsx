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
import { PageShell, PageHeader, PageSection } from "../../../../../components/ui/PageShell";
import { Card } from "../../../../../components/ui/Card";
import { Button } from "../../../../../components/ui/Button";
import { Badge, type BadgeTone } from "../../../../../components/ui/Badge";
import {
  DataTable,
  type DataTableColumn,
} from "../../../../../components/ui/DataTable";
import { EmptyState } from "../../../../../components/ui/EmptyState";
import {
  formatDateTime,
  mutedStyle,
  sectionTitleStyle,
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

function healthTone(h: SsoConnectionHealthStatus): BadgeTone {
  if (h === "HEALTHY") return "verified";
  if (h === "DEGRADED") return "pending";
  if (h === "OUTAGE") return "risk";
  if (h === "DISABLED") return "neutral";
  return "governance";
}

function certTone(band: CertExpiryBand): BadgeTone {
  if (band === "ok") return "verified";
  if (band === "warning") return "pending";
  return "risk";
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
      <PageShell
        header={
          <PageHeader
            eyebrow="Security Center · SSO"
            title="SSO Health"
            subtitle="Diagnostic snapshot of each configured SSO connection."
          />
        }
      >
        <AccessGate
          kind="WORKSPACE_REQUIRED"
          surface="SSO Health"
          headline="Switch to a workspace to view SSO health"
          reason="SSO health is per-workspace. Open a workspace you administer to diagnose connection health."
          actions={[
            { label: "Open workspaces", href: "/workspaces", variant: "primary" },
          ]}
          testid="sso-health-access-gate-no-workspace"
        />
      </PageShell>
    );
  }

  const attemptColumns: DataTableColumn<{
    window: string;
    total: number;
    failed: number;
    replayed: number;
  }>[] = [
    { key: "window", header: "Window" },
    { key: "total", header: "Total", align: "right" },
    { key: "failed", header: "Failed", align: "right" },
    { key: "replayed", header: "Replayed", align: "right" },
  ];

  const failureColumns: DataTableColumn<{
    reason: SsoFailureReason;
    count24h: number;
    count7d: number;
  }>[] = [
    {
      key: "reason",
      header: "Reason",
      render: (b) => (
        <code style={{ fontFamily: "monospace", fontSize: 12 }}>{b.reason}</code>
      ),
    },
    { key: "count24h", header: "24h", align: "right" },
    { key: "count7d", header: "7d", align: "right" },
  ];

  return (
    <PageShell
      header={
        <PageHeader
          eyebrow="Security Center · SSO"
          title="SSO Health"
          subtitle="Diagnostic snapshot of each configured SSO connection. Bounded failure-reason taxonomy + cert expiry projections + recommended remediation action per connection. Aggregates from the last 24h and 7d of callback attempts."
          secondaryActions={
            <Button
              variant="secondary"
              size="sm"
              onClick={load}
              loading={loading}
              disabled={loading}
            >
              {loading ? "Refreshing…" : "Refresh"}
            </Button>
          }
        />
      }
    >
      {error ? (
        <Card variant="status" tone="risk">
          {error}
        </Card>
      ) : null}

      {snapshot ? (
        <>
          <Card variant="summary">
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
                  <Badge tone={healthTone(snapshot.overallStatus)}>
                    {snapshot.overallStatus}
                  </Badge>
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
          </Card>

          {snapshot.connections.length === 0 ? (
            <EmptyState
              framed
              title="No SSO connection configured"
              purpose="Configure a SAML or OIDC connection to start collecting health telemetry for this workspace."
              action={
                <a
                  href="/security-center/sso"
                  style={{ color: TOKENS.link, textDecoration: "none" }}
                >
                  <Button variant="secondary" size="sm">
                    Configure SSO →
                  </Button>
                </a>
              }
            />
          ) : (
            snapshot.connections.map((c) => (
              <Card key={c.connectionId} variant="summary">
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
                      <Badge tone={healthTone(c.health)}>{c.health}</Badge>
                      <Badge tone={certTone(c.cert.expiryBand)}>
                        cert: {c.cert.expiryBand}
                        {c.cert.daysUntilExpiry !== null
                          ? ` · ${c.cert.daysUntilExpiry}d`
                          : ""}
                      </Badge>
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
                  <DataTable
                    ariaLabel="Attempt counts"
                    columns={attemptColumns}
                    rows={[
                      {
                        window: "Last 24h",
                        total: c.attemptCounts.last24h.total,
                        failed: c.attemptCounts.last24h.failed,
                        replayed: c.attemptCounts.last24h.replayed,
                      },
                      {
                        window: "Last 7d",
                        total: c.attemptCounts.last7d.total,
                        failed: c.attemptCounts.last7d.failed,
                        replayed: c.attemptCounts.last7d.replayed,
                      },
                    ]}
                    getRowId={(r) => r.window}
                  />
                </div>

                {c.failureBreakdown.length > 0 ? (
                  <div style={{ marginTop: 12 }}>
                    <h4 style={sectionTitleStyle}>Failure breakdown</h4>
                    <DataTable
                      ariaLabel="Failure breakdown"
                      columns={failureColumns}
                      rows={[...c.failureBreakdown]}
                      getRowId={(b) => b.reason}
                    />
                  </div>
                ) : null}
              </Card>
            ))
          )}
        </>
      ) : loading ? (
        <PageSection>
          <p style={{ ...mutedStyle, marginTop: 16 }}>Loading SSO health…</p>
        </PageSection>
      ) : null}
    </PageShell>
  );
}
