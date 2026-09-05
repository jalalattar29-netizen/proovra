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
import {
  AdmAttention,
  AdmCard,
  AdmFacts,
  AdmInline,
} from "../../../../components/admin/AdminSurfaces";
import { formatUserDateTime } from "../../../../lib/date";

type ServiceStatus =
  | "healthy"
  | "degraded"
  | "critical"
  | "stale"
  | "stopped"
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
    // Amber, not neutral: a cleanly stopped fleet is understood, but there is
    // still nothing processing work.
    case "stopped":
      return { tone: "pending", label: "Stopped" };
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

/**
 * SERVICES SPLIT BY WHETHER ANYBODY IS MEASURING THEM.
 *
 * =============================================================================
 * WHY THE FLAT GRID WAS THE DEFECT
 * =============================================================================
 * The page rendered all 24 service rows as one 4-column grid of equal cards.
 * The data behind them was already honest — Healthy / Degraded / Not measured /
 * Not connected, each with its reason — but the PRESENTATION gave a stuck job
 * queue exactly the same weight as "DEEPGRAM_API_KEY is not bound", and there
 * were fourteen of the latter. An operator opening this page during an incident
 * had to read twenty-four cards to find the two that were degraded.
 *
 * The three groups answer three different questions and belong apart:
 *
 *   ATTENTION   a live probe says something is wrong right now. This is the
 *               only group that should ever be read first.
 *   PROBED      a live probe says it is fine. Worth seeing, and worth seeing
 *               as a group so "everything else is up" is one glance.
 *   UNPROBED    no probe exists, or no credential is bound. This is
 *               CONFIGURATION INVENTORY, not health: it does not change
 *               between page loads and nothing about it is urgent. It cannot
 *               be deleted — "we are not watching this" is exactly the kind of
 *               thing a console must not hide — but it belongs in one list
 *               rather than in fourteen cards.
 */
type HealthGroup = "attention" | "probed" | "unprobed";

function groupFor(status: ServiceStatus): HealthGroup {
  switch (status) {
    // A live reading that is bad, old, or stopped. Somebody has to look.
    case "critical":
    case "degraded":
    case "stale":
    case "stopped":
      return "attention";
    case "healthy":
      return "probed";
    // `unavailable` is a probe that EXISTS and could not be read, which is a
    // different fact from "no probe exists" — but it is also not an outage of
    // the service, so it sits with the unprobed rather than raising an alarm
    // about a subsystem nobody has measured.
    case "unavailable":
    case "unknown":
    case "not_connected":
    default:
      return "unprobed";
  }
}

/** The one-line verdict, derived from the rows rather than declared. */
function overallHealth(rows: ServiceStatusRow[]): {
  severity: "critical" | "warning" | "healthy" | "unknown";
  statement: string;
} {
  const attention = rows.filter((r) => groupFor(r.status) === "attention");
  const critical = attention.filter((r) => r.status === "critical");
  const probed = rows.filter((r) => groupFor(r.status) === "probed");
  const unprobed = rows.filter((r) => groupFor(r.status) === "unprobed");

  if (critical.length > 0) {
    return {
      severity: "critical",
      statement: `${critical.length} subsystem${critical.length === 1 ? "" : "s"} failing`,
    };
  }
  if (attention.length > 0) {
    return {
      severity: "warning",
      statement: `${attention.length} subsystem${attention.length === 1 ? "" : "s"} degraded`,
    };
  }
  /*
   * "ALL CLEAR" IS ONLY CLAIMED WHEN SOMETHING WAS ACTUALLY MEASURED, and it
   * is never claimed on behalf of the unprobed ones. A page that says
   * "Healthy" while fourteen subsystems have no probe is the exact dishonesty
   * the per-row states were built to avoid; saying it at the row level and
   * then contradicting it in the summary would give the whole thing away.
   */
  if (probed.length === 0) {
    return {
      severity: "unknown",
      statement: "Nothing is being measured",
    };
  }
  if (unprobed.length > 0) {
    return {
      severity: "unknown",
      statement: `${probed.length} of ${rows.length} subsystems measured and healthy`,
    };
  }
  return {
    severity: "healthy",
    statement: `All ${probed.length} subsystems measured and healthy`,
  };
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

/**
 * Seven counters, four to a row.
 *
 * `auto-fit minmax(200px, 1fr)` laid them out five-and-two at 1440px, and a
 * lone pair on a second row reads as an afterthought rather than as the last
 * two of seven. Four columns gives 4+3, which reads as one block. It steps
 * down rather than reflowing arbitrarily, which is what the explicit count is
 * for.
 */
const NOW_GRID: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
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

  /*
   * THE THREE GROUPS, AND THE VERDICT, DERIVED FROM THE ROWS.
   *
   * Not from a separate field. A summary that CAN disagree with the rows it
   * summarises is the thing this page most needs not to have: if a row's
   * status changes the verdict changes with it, and there is no second place
   * anybody has to remember to update.
   */
  const serviceRows = data?.services ?? [];
  const attentionRows = serviceRows.filter((r) => groupFor(r.status) === "attention");
  const probedRows = serviceRows.filter((r) => groupFor(r.status) === "probed");
  const unprobedRows = serviceRows.filter((r) => groupFor(r.status) === "unprobed");
  const verdict = overallHealth(serviceRows);

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
          <EmptyState variant="inline"
            framed
            title="Loading platform health…"
            purpose="Connecting to the runtime-readiness, signer, queue, observability, and provider health probes."
          />
        ) : !data ? (
          <EmptyState variant="inline"
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
            {/* ---- 1. THE VERDICT, derived from the rows -------------- */}
            <AdmAttention
              severity={verdict.severity}
              statement={verdict.statement}
              detail={
                attentionRows.length > 0
                  ? `${attentionRows.map((r) => r.label).join(", ")} — read the rows below before acting.`
                  : unprobedRows.length > 0
                    ? `${unprobedRows.length} subsystem${unprobedRows.length === 1 ? " has" : "s have"} no live probe or no bound credential. Their state is unknown, not healthy.`
                    : undefined
              }
            />

            {/* ---- 2. WHAT A LIVE PROBE SAYS IS WRONG ----------------- */}
            {attentionRows.length > 0 ? (
              <PageSection
                title="Needs attention"
                description="A live probe reports a non-healthy state for these. Everything else on this page is either measured healthy or not measured at all."
              >
                <div style={SERVICE_GRID} data-testid="admin-platform-health-attention">
                  {attentionRows.map((row) => (
                    <ServiceCard key={row.key} row={row} />
                  ))}
                </div>
              </PageSection>
            ) : null}

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

            {/* ---- 3. MEASURED AND HEALTHY --------------------------- */}
            <PageSection
              title="Measured healthy"
              description="A live probe proved each of these up. Green appears here and nowhere else on the page."
            >
              {data.services.length === 0 ? (
                <EmptyState
                  variant="inline"
                  framed
                  title="No services reported"
                  purpose="The platform-health aggregate returned no service rows. This is unexpected — try refreshing."
                />
              ) : probedRows.length === 0 ? (
                <AdmInline state="not-measured" label="Nothing measured healthy">
                  No live probe currently reports a healthy state. That is not
                  the same as an outage — see the two sections above.
                </AdmInline>
              ) : (
                <div style={SERVICE_GRID} data-testid="admin-platform-health-services">
                  {probedRows.map((row) => (
                    <ServiceCard key={row.key} row={row} />
                  ))}
                </div>
              )}
            </PageSection>

            {/* ---- 4. NOT MEASURED — inventory, not health ------------
                Fourteen cards saying "no credential is bound" became one
                list. The FACTS are unchanged and none is dropped: what
                changes is that they no longer compete with a degraded
                queue for the operator's attention. */}
            {unprobedRows.length > 0 ? (
              <PageSection
                title="Not measured"
                description="No live probe exists for these in this build, or no credential is bound. Their state is UNKNOWN — this page never reads an unprobed subsystem as healthy."
              >
                <AdmCard pad="compact">
                  <AdmFacts
                    items={unprobedRows.map((row) => ({
                      key: row.key,
                      label: row.label,
                      value: (
                        <span className="adm-row" style={{ alignItems: "baseline", gap: 8 }}>
                          <Badge tone={statusPresentation(row.status).tone} dot>
                            {statusPresentation(row.status).label}
                          </Badge>
                          {row.detail ? (
                            <span className="adm-secondary" style={{ fontSize: 12.5 }}>
                              {row.detail}
                            </span>
                          ) : null}
                        </span>
                      ),
                    }))}
                  />
                </AdmCard>
              </PageSection>
            ) : null}

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
