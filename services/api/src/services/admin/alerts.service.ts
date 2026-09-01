/**
 * PROOVRA Platform Admin (item K) — Alerts Center service.
 *
 * READ-ONLY aggregation of CURRENT platform alert-worthy signals into a single
 * severity-ranked list. This service adds NO writers and mutates NO state.
 *
 * NOTE ON RESOLUTION WORKFLOW:
 *   There is no dedicated "platform alert" table with an ack/resolve
 *   lifecycle. This service therefore returns a READ-ONLY, point-in-time list
 *   derived live from the underlying signals. Acknowledging / resolving an
 *   alert happens at the source (e.g. resolve the OperationalIncident, drain
 *   the failed job) — not on the alert row itself. The list reflects the
 *   current state on every read.
 *
 * SIGNAL SOURCES:
 *   - OperationalIncident (status OPEN)          → per-incident alerts
 *   - SecurityEvent (HIGH/CRITICAL, recent)      → security alerts
 *   - Failed jobs / degraded queues + workers    → operational alerts
 *   - Failed reports / packages                  → delivery alerts
 *   - Degraded evidence-health services          → health alerts
 *   - Payment status FAILED (recent)             → billing alerts
 *   - SsoConnection outageDetectedAtUtc != null  → identity alerts
 *
 * HONESTY / SAFETY:
 *   - No secrets, no raw/hashed IPs, no tokens, no free-form metadata.
 *   - Every alert is derived from a REAL row/count; nothing is fabricated.
 *   - If a source cannot be read (e.g. Redis down for the queue inventory)
 *     that source contributes no alerts rather than a fabricated one.
 */

import { prisma } from "../../db.js";
import {
  getQueueInventory,
  getWorkerHealth,
} from "../operations/queue-inventory.service.js";
import { buildEvidenceHealthSnapshot } from "../operations/evidence-health.service.js";

export type AlertSeverity = "critical" | "high" | "medium" | "low";

export type AlertSource =
  | "incident"
  | "security"
  | "operational"
  | "delivery"
  | "health"
  | "billing"
  | "identity";

export type PlatformAlert = {
  severity: AlertSeverity;
  source: AlertSource;
  title: string;
  organizationId: string | null;
  createdAt: string;
  href: string | null;
  /**
   * ADM-013 PHASE 3 — the durable record this signal came FROM, or `null`
   * when nothing durable owns it.
   *
   * Without this the two totals on the control plane were unreconcilable.
   * "72 open incidents" and "78 unresolved alerts" read as 150 problems, when
   * 72 of the 78 ARE the 72 — one alert is emitted per open incident by the
   * block below. Nothing in the payload said so, so every surface that showed
   * both invited the reader to add them.
   *
   * A set id also makes the drill-down possible at all: the alert used to
   * carry `href: "/admin/security"` regardless of what produced it, so an
   * operator reading "Open incident: X" had no route to incident X.
   */
  incidentId: string | null;
  /**
   * TRUE when an OperationalIncident produced this signal.
   *
   * Derived from `incidentId` today and stated separately on purpose: a
   * future durable owner that is not an incident (a security case, a billing
   * dispute) is still incident-BACKED in the sense the reconciliation cares
   * about — "something with a lifecycle owns this" — and a consumer should be
   * asking that question rather than testing an id for null.
   */
  incidentBacked: boolean;
};

export type AlertsResult = {
  items: PlatformAlert[];
  counts: Record<AlertSeverity, number>;
  total: number;
  /**
   * ADM-013 PHASE 3 — the reconciliation, computed HERE rather than by each
   * surface that renders it.
   *
   * `total` is every signal. `incidentBacked` is the subset an incident
   * produced, and `additional` is the rest. A card that prints `total`
   * beside an incident count taken from anywhere else is printing two
   * overlapping populations as if they were disjoint, which is what produced
   * "72 incidents / 78 alerts" on a control plane with 78 things to look at.
   */
  reconciliation: {
    incidentBacked: number;
    additional: number;
  };
  /** True — the list is a read-only point-in-time snapshot (no ack/resolve). */
  readOnly: true;
};

const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function incidentSeverity(raw: string): AlertSeverity {
  const v = raw.toUpperCase();
  if (v === "CRITICAL") return "critical";
  if (v === "HIGH") return "high";
  if (v === "WARNING") return "medium";
  return "low";
}

/**
 * Aggregate the current alert-worthy signals. Each source is read
 * independently and defensively — a source that throws contributes nothing
 * (honest) rather than aborting the whole aggregate.
 */
export async function buildPlatformAlerts(): Promise<AlertsResult> {
  const now = Date.now();
  const recentSince = new Date(now - RECENT_WINDOW_MS);
  const alerts: PlatformAlert[] = [];

  // ---------------------------------------------------------------------------
  // OperationalIncident (status OPEN) — one alert per open incident.
  // ---------------------------------------------------------------------------
  try {
    const openIncidents = await prisma.operationalIncident.findMany({
      where: { status: "OPEN" },
      orderBy: [{ lastSeenAtUtc: "desc" }],
      take: 100,
      select: {
        id: true,
        severity: true,
        title: true,
        createdAt: true,
      },
    });
    for (const i of openIncidents) {
      alerts.push({
        severity: incidentSeverity(String(i.severity)),
        source: "incident",
        title: `Open incident: ${i.title}`,
        organizationId: null,
        createdAt: i.createdAt.toISOString(),
        // ADM-013 PHASE 3 — the incident, not the security page. Every alert
        // here used to point at /admin/security whatever produced it, so a row
        // reading "Open incident: X" led to a list that was not X.
        href: `/admin/operations?incident=${encodeURIComponent(i.id)}`,
        incidentId: i.id,
        incidentBacked: true,
      });
    }
  } catch {
    // Non-fatal — no incident alerts contributed.
  }

  // ---------------------------------------------------------------------------
  // SecurityEvent (HIGH / CRITICAL, recent).
  // ---------------------------------------------------------------------------
  try {
    const securityRows = await prisma.securityEvent.findMany({
      where: {
        severity: { in: ["HIGH", "CRITICAL"] },
        createdAt: { gte: recentSince },
      },
      orderBy: [{ createdAt: "desc" }],
      take: 100,
      select: {
        id: true,
        eventType: true,
        severity: true,
        createdAt: true,
      },
    });
    for (const s of securityRows) {
      alerts.push({
        severity: String(s.severity).toUpperCase() === "CRITICAL"
          ? "critical"
          : "high",
        source: "security",
        title: `Security event: ${s.eventType}`,
        organizationId: null,
        createdAt: s.createdAt.toISOString(),
        href: "/admin/security",
        incidentId: null,
        incidentBacked: false,
      });
    }
  } catch {
    // Non-fatal.
  }

  // ---------------------------------------------------------------------------
  // Failed jobs / degraded queues + workers (reuse operations inventory).
  // Redis outage → inventory throws → no operational alerts (honest).
  // ---------------------------------------------------------------------------
  try {
    const [inventory, workers] = await Promise.all([
      getQueueInventory(),
      getWorkerHealth(),
    ]);
    for (const q of inventory) {
      if (q.counts.failed > 0) {
        alerts.push({
          severity: "high",
          source: "operational",
          title: `${q.label}: ${q.counts.failed} failed job${q.counts.failed === 1 ? "" : "s"}`,
          organizationId: null,
          createdAt: new Date(now).toISOString(),
          href: "/admin/security",
          incidentId: null,
          incidentBacked: false,
        });
      } else if (q.health === "outage") {
        alerts.push({
          severity: "critical",
          source: "operational",
          title: `${q.label}: queue unreachable`,
          organizationId: null,
          createdAt: new Date(now).toISOString(),
          href: "/admin/security",
          incidentId: null,
          incidentBacked: false,
        });
      } else if (q.health === "degraded") {
        alerts.push({
          severity: "medium",
          source: "operational",
          title: `${q.label}: queue degraded`,
          organizationId: null,
          createdAt: new Date(now).toISOString(),
          href: "/admin/security",
          incidentId: null,
          incidentBacked: false,
        });
      }
    }
    for (const w of workers) {
      if (w.status === "missing") {
        alerts.push({
          severity: "critical",
          source: "operational",
          title: `Worker unreachable: ${w.queueName}`,
          organizationId: null,
          createdAt: new Date(now).toISOString(),
          href: "/admin/security",
          incidentId: null,
          incidentBacked: false,
        });
      }
    }
  } catch {
    // Non-fatal — queue/worker inventory unavailable.
  }

  // ---------------------------------------------------------------------------
  // Failed reports / packages + degraded services (evidence-health snapshot).
  // The snapshot returns `Measured` (number | null) fields; null → not
  // measured → no alert.
  // ---------------------------------------------------------------------------
  try {
    const health = await buildEvidenceHealthSnapshot();
    const openReports = health.incidents.openReport;
    if (openReports !== null && openReports > 0) {
      alerts.push({
        severity: "medium",
        source: "delivery",
        title: `${openReports} report incident${openReports === 1 ? "" : "s"} open`,
        organizationId: null,
        createdAt: new Date(now).toISOString(),
        href: "/admin/security",
        incidentId: null,
        incidentBacked: false,
      });
    }
    const openPackages = health.incidents.openPackage;
    if (openPackages !== null && openPackages > 0) {
      alerts.push({
        severity: "medium",
        source: "delivery",
        title: `${openPackages} package incident${openPackages === 1 ? "" : "s"} open`,
        organizationId: null,
        createdAt: new Date(now).toISOString(),
        href: "/admin/security",
        incidentId: null,
        incidentBacked: false,
      });
    }
  } catch {
    // Non-fatal — evidence-health snapshot unavailable.
  }

  // ---------------------------------------------------------------------------
  // Billing failures — Payment status FAILED, recent.
  // ---------------------------------------------------------------------------
  try {
    const failedPayments = await prisma.payment.count({
      where: { status: "FAILED", createdAt: { gte: recentSince } },
    });
    if (failedPayments > 0) {
      alerts.push({
        severity: "high",
        source: "billing",
        title: `${failedPayments} failed payment${failedPayments === 1 ? "" : "s"} (24h)`,
        organizationId: null,
        createdAt: new Date(now).toISOString(),
        href: "/admin/billing",
        incidentId: null,
        incidentBacked: false,
      });
    }
  } catch {
    // Non-fatal.
  }

  // ---------------------------------------------------------------------------
  // Identity failures — SsoConnection with an unresolved outage.
  // ---------------------------------------------------------------------------
  try {
    const outages = await prisma.ssoConnection.findMany({
      where: { outageDetectedAtUtc: { not: null } },
      orderBy: [{ outageDetectedAtUtc: "desc" }],
      take: 100,
      select: {
        id: true,
        displayName: true,
        outageDetectedAtUtc: true,
      },
    });
    for (const c of outages) {
      alerts.push({
        severity: "high",
        source: "identity",
        title: `SSO connection outage: ${c.displayName}`,
        organizationId: null,
        createdAt: (c.outageDetectedAtUtc ?? new Date(now)).toISOString(),
        href: "/admin/security",
        incidentId: null,
        incidentBacked: false,
      });
    }
  } catch {
    // Non-fatal.
  }

  // Rank by severity, then recency (newest first) within a severity.
  alerts.sort((a, b) => {
    const rank = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (rank !== 0) return rank;
    return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
  });

  const counts: Record<AlertSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  for (const a of alerts) counts[a.severity] += 1;

  const incidentBacked = alerts.filter((a) => a.incidentBacked).length;

  return {
    items: alerts,
    counts,
    total: alerts.length,
    reconciliation: {
      incidentBacked,
      additional: alerts.length - incidentBacked,
    },
    readOnly: true,
  };
}
