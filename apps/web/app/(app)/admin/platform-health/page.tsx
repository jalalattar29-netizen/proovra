"use client";

/**
 * PROOVRA Platform Admin — Platform Health & Service Status.
 *
 * READ-ONLY operator surface at /admin/platform-health. Wrapped in the
 * `platform.admin` PageRouteGate (CR0). Renders:
 *   - service-status cards with honest severity colors, CONNECTED from
 *     GET /v1/admin/platform-health (which itself connects the existing
 *     mature health services — nothing here re-implements health logic),
 *   - a live "Now" panel (active sessions, uploads in progress, jobs
 *     pending, open incidents, recent logins / audit events),
 *   - honest "Not connected" / "Not measured" / "Unknown" states — a
 *     service is NEVER shown green without a real signal, and no
 *     availability-duration figure is fabricated.
 *
 * No hero, no legacy classes, no secrets. Errors surface via
 * toSafeUserError (the only sanctioned display path).
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import {
  PageShell,
  PageHeader,
  PageSection,
} from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import { Badge } from "../../../../components/ui/Badge";
import type { BadgeTone } from "../../../../components/ui/Badge";
import { Button } from "../../../../components/ui/Button";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { formatUserDateTime } from "../../../../lib/date";

type ServiceStatus =
  | "healthy"
  | "degraded"
  | "critical"
  | "stale"
  | "unavailable"
  | "unknown"
  | "not_connected";

interface ServiceStatusRow {
  key: string;
  label: string;
  status: ServiceStatus;
  lastCheckedAtUtc: string;
  lastSuccessAtUtc?: string | null;
  lastError?: string | null;
  latencyMs?: number | null;
  detail?: string | null;
}

interface NowMetric {
  value: number | null;
  reason?: string | null;
}

interface PlatformNow {
  generatedAtUtc: string;
  activeSessions: NowMetric;
  uploadsInProgress: NowMetric;
  jobsPending: NowMetric;
  openIncidents: NowMetric;
  recentLogins: NowMetric;
  recentAuditEvents: NowMetric;
  queueTelemetryAgeSeconds: NowMetric;
}

interface PlatformHealth {
  generatedAtUtc: string;
  services: ServiceStatusRow[];
  now: PlatformNow;
}

const INK_MUTED = "var(--ink-muted, #94a3b8)";
const INK_SECONDARY = "var(--ink-secondary, #475569)";
const INK_PRIMARY = "var(--ink-primary, #0f172a)";

/**
 * Honest status → tone + human label. `healthy` is green ONLY here;
 * `unknown` / `not_connected` are neutral (never green), `critical` is
 * risk (red), `degraded` is amber/pending.
 */
function statusPresentation(status: ServiceStatus): {
  tone: BadgeTone;
  label: string;
} {
  switch (status) {
    case "healthy":
      return { tone: "verified", label: "Healthy" };
    case "degraded":
      return { tone: "pending", label: "Degraded" };
    case "critical":
      return { tone: "risk", label: "Critical" };
    case "not_connected":
      return { tone: "neutral", label: "Not connected" };
    // Neither is green. "Stale" means we have a reading and it is old;
    // "Unavailable" means the source could not be read at all. An operator
    // chases a stopped worker for the first and a broken query for the second.
    case "stale":
      return { tone: "pending", label: "Stale" };
    case "unavailable":
      return { tone: "neutral", label: "Unavailable" };
    case "unknown":
    default:
      return { tone: "neutral", label: "Not measured" };
  }
}

function cardTone(status: ServiceStatus): "verified" | "risk" | "neutral" {
  if (status === "healthy") return "verified";
  if (status === "critical") return "risk";
  // stale is not an outage, but it is never green either.
  // degraded / unknown / not_connected are non-green, non-red neutrals.
  return "neutral";
}

function ServiceCard({ row }: { row: ServiceStatusRow }) {
  const { tone, label } = statusPresentation(row.status);
  return (
    <Card variant="status" tone={cardTone(row.status)} padding="comfortable">
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 650, color: INK_PRIMARY }}>{row.label}</div>
          <div style={{ marginTop: 2, fontSize: 11, color: INK_MUTED }}>
            Checked {formatUserDateTime(row.lastCheckedAtUtc)}
          </div>
        </div>
        <Badge tone={tone} dot>
          {label}
        </Badge>
      </div>
      {row.detail ? (
        <div
          style={{
            marginTop: 10,
            fontSize: 12.5,
            lineHeight: 1.5,
            color: INK_SECONDARY,
            overflowWrap: "anywhere",
          }}
        >
          {row.detail}
        </div>
      ) : null}
      {row.lastError ? (
        <div
          style={{
            marginTop: 8,
            fontSize: 12,
            lineHeight: 1.5,
            color: INK_MUTED,
            overflowWrap: "anywhere",
          }}
        >
          {row.lastError}
        </div>
      ) : null}
      {row.lastSuccessAtUtc ? (
        <div style={{ marginTop: 8, fontSize: 11, color: INK_MUTED }}>
          Last success {formatUserDateTime(row.lastSuccessAtUtc)}
        </div>
      ) : null}
    </Card>
  );
}

function NowTile({
  label,
  metric,
  suffix,
}: {
  label: string;
  metric: NowMetric | undefined;
  suffix?: string;
}) {
  const measured = metric != null && metric.value != null;
  return (
    <Card variant="summary" padding="comfortable" style={{ minWidth: 0 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: INK_MUTED,
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 12,
          fontSize: measured ? 30 : 15,
          fontWeight: measured ? 750 : 600,
          lineHeight: 1.1,
          letterSpacing: "-0.02em",
          color: measured ? INK_PRIMARY : INK_MUTED,
        }}
      >
        {measured
          ? `${new Intl.NumberFormat().format(metric!.value as number)}${
              suffix ? ` ${suffix}` : ""
            }`
          : "Not measured"}
      </div>
      {!measured && metric?.reason ? (
        <div style={{ marginTop: 8, fontSize: 12, color: INK_MUTED }}>
          {metric.reason}
        </div>
      ) : null}
    </Card>
  );
}

const SERVICE_GRID: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
  gap: 16,
};

const NOW_GRID: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
  gap: 16,
};

function AdminPlatformHealthPage() {
  const [data, setData] = useState<PlatformHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch("/v1/admin/platform-health", { method: "GET" });
      setData((res ?? null) as PlatformHealth | null);
      setError(null);
    } catch (err) {
      setError(
        toSafeUserError(err, {
          message: "We couldn't load platform health.",
        }).message,
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const now = data?.now ?? null;

  return (
    <PageShell
      width="full"
      header={
        <PageHeader
          eyebrow="Platform admin"
          title="Platform Health & Service Status"
          subtitle="Read-only, platform-wide health. Every service row is a real probe result from an existing health service — a service is only shown healthy when a live signal proves it. Providers with no live probe read 'Not measured', never a fabricated green. No secrets, and no availability figures are estimated."
          primaryAction={
            <Button variant="secondary" onClick={() => void load()}>
              Refresh
            </Button>
          }
        />
      }
    >
      <div data-testid="admin-platform-health">

        {error ? (
          <Card variant="status" tone="risk" padding="comfortable">
            <div style={{ fontWeight: 650, color: INK_PRIMARY }}>
              Could not load platform health
            </div>
            <div style={{ marginTop: 6, fontSize: 13.5, color: INK_SECONDARY }}>
              {error}
            </div>
          </Card>
        ) : null}

        {loading && !data ? (
          <EmptyState
            framed
            title="Loading platform health…"
            purpose="Connecting to the runtime-readiness, signer, queue, observability, and provider health probes."
          />
        ) : !data ? (
          <EmptyState
            framed
            title="No health snapshot available"
            purpose="The platform-health endpoint returned no data. Try refreshing, or check that the API is reachable."
            action={
              <Button variant="primary" onClick={() => void load()}>
                Retry
              </Button>
            }
          />
        ) : (
          <>
            <PageSection
              title="Now"
              description="Live platform activity. Each number is a real count or an honest 'Not measured' — never a fabricated value."
            >
              <div style={NOW_GRID} data-testid="admin-platform-health-now">
                <NowTile label="Active sessions (5m)" metric={now?.activeSessions} />
                <NowTile label="Uploads in progress" metric={now?.uploadsInProgress} />
                <NowTile label="Jobs pending" metric={now?.jobsPending} />
                <NowTile label="Open incidents" metric={now?.openIncidents} />
                <NowTile label="Logins (15m)" metric={now?.recentLogins} />
                <NowTile label="Audit events (15m)" metric={now?.recentAuditEvents} />
                <NowTile
                  label="Queue telemetry age"
                  metric={now?.queueTelemetryAgeSeconds}
                  suffix="s"
                />
              </div>
            </PageSection>

            <PageSection
              title="Service status"
              description="Each row connects an existing health probe. Green means a live signal proves it up; 'Not connected' means no credential is bound; 'Not measured' means no live probe exists in this build."
            >
              {data.services.length === 0 ? (
                <EmptyState
                  framed
                  title="No services reported"
                  purpose="The platform-health aggregate returned no service rows. This is unexpected — try refreshing."
                />
              ) : (
                <div style={SERVICE_GRID} data-testid="admin-platform-health-services">
                  {data.services.map((row) => (
                    <ServiceCard key={row.key} row={row} />
                  ))}
                </div>
              )}
            </PageSection>

            <div style={{ fontSize: 12, color: INK_MUTED }}>
              Snapshot generated {formatUserDateTime(data.generatedAtUtc)} ·
              read-only · connects existing health services · no secrets, no
              estimated availability figures.
            </div>
          </>
        )}
      </div>
    </PageShell>
  );
}

export default function AdminPlatformHealthPageGated() {
  return (
    <PageRouteGate routeId="platform.platform_health">
      <AdminPlatformHealthPage />
    </PageRouteGate>
  );
}
