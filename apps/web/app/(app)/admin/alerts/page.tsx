"use client";

/**
 * PROOVRA Platform Admin (item K) — Alerts Center console.
 *
 * READ-ONLY platform-admin surface. Renders the current, severity-grouped list
 * of alert-worthy platform signals (open incidents, recent HIGH/CRITICAL
 * security events, failed jobs / degraded queues + workers, failed reports /
 * packages, recent failed payments, SSO outages), each with its source and an
 * action link back to the surface that owns it.
 *
 * There is no platform-alert resolution workflow — the backend list is a
 * read-only point-in-time snapshot; operators resolve an alert at its source.
 * This is stated honestly in the page copy.
 *
 * The page inherits the `platform.admin` gate from admin/layout.tsx AND wraps
 * itself in an explicit gate on `platform.alerts` — its OWN registry id, so
 * the gate, the breadcrumb and the command palette all resolve the same entry.
 * It previously gated on the layout's id, which made the page unable to
 * require anything the layout did not.
 *
 * Errors surface via toSafeUserError. When there are no signals the page shows
 * an honest "No active alerts" EmptyState.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { PageShell, PageHeader, PageSection } from "../../../../components/ui";
import { Card } from "../../../../components/ui/Card";
import { Badge } from "../../../../components/ui/Badge";
import type { BadgeTone } from "../../../../components/ui/Badge";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { ResultCount } from "../../../../components/ui/ResultCount";
import { Button } from "../../../../components/ui/Button";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { apiFetch } from "../../../../lib/api";
import { useToast } from "../../../../components/ui";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { formatUserDateTime } from "../../../../lib/date";

type AlertSeverity = "critical" | "high" | "medium" | "low";

type AlertSource =
  | "incident"
  | "security"
  | "operational"
  | "delivery"
  | "health"
  | "billing"
  | "identity";

type PlatformAlert = {
  severity: AlertSeverity;
  source: AlertSource;
  title: string;
  organizationId: string | null;
  createdAt: string;
  href: string | null;
};

type AlertsResponse = {
  items: PlatformAlert[];
  counts: Record<AlertSeverity, number>;
  total: number;
  readOnly: boolean;
  /**
   * The alert list is a UNION of several capped queries. When a contributing
   * source came back full there are signals this page never received, so a
   * severity group's length is a floor rather than a count.
   */
  truncated?: boolean;
  cappedSources?: string[];
  sourceCap?: number;
};

const INK_MUTED = "var(--ink-muted, #94a3b8)";

const SEVERITY_ORDER: AlertSeverity[] = ["critical", "high", "medium", "low"];

const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

const SOURCE_LABEL: Record<AlertSource, string> = {
  incident: "Incident",
  security: "Security",
  operational: "Operational",
  delivery: "Delivery",
  health: "Health",
  billing: "Billing",
  identity: "Identity",
};

function severityTone(sev: AlertSeverity): BadgeTone {
  if (sev === "critical" || sev === "high") return "risk";
  if (sev === "medium") return "pending";
  return "info";
}

function formatTimestamp(value: string) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return formatUserDateTime(value);
}

export default function AdminAlertsPage() {
  const { addToast } = useToast();
  const [data, setData] = useState<AlertsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res: AlertsResponse = await apiFetch(`/v1/admin/alerts`);
      setData(res ?? null);
    } catch (err) {
      const message = toSafeUserError(err, {
        message: "We couldn't load the platform alerts.",
      }).message;
      addToast(message, "error");
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const grouped = useMemo(() => {
    const buckets: Record<AlertSeverity, PlatformAlert[]> = {
      critical: [],
      high: [],
      medium: [],
      low: [],
    };
    for (const a of data?.items ?? []) {
      (buckets[a.severity] ?? buckets.low).push(a);
    }
    return buckets;
  }, [data]);

  const total = data?.total ?? 0;
  const hasAlerts = total > 0;

  return (
    <PageRouteGate routeId="platform.alerts">
      <PageShell width="full" data-testid="admin-alerts">
        <PageHeader
          eyebrow="Platform admin"
          title="Alerts center"
          subtitle="Current alert-worthy platform signals, grouped by severity: open incidents, recent high/critical security events, failed jobs and degraded queues, failed reports or packages, recent failed payments, and SSO outages. Read-only and live — no secrets, tokens, or raw IP addresses are surfaced."
          secondaryActions={
            <Button variant="secondary" onClick={() => void load()}>
              Refresh
            </Button>
          }
        />


        <PageSection
          title="Active alerts"
          description="This list is a read-only point-in-time snapshot. There is no per-alert acknowledge / resolve workflow — resolve an alert at its source (resolve the incident, drain the failed job, fix the SSO connection) and it clears on the next refresh. Each alert links to the surface that owns it."
        >
          {!loading && !hasAlerts ? (
            <EmptyState variant="inline"
              framed
              title="No active alerts"
              purpose="No alert-worthy platform signals are currently active. Open incidents, recent high/critical security events, failed jobs, failed payments, and SSO outages would appear here — right now there are none."
              data-testid="admin-alerts-empty"
            />
          ) : (
            <div style={{ display: "grid", gap: 20 }}>
              {SEVERITY_ORDER.map((sev) => {
                const rows = grouped[sev];
                if (!loading && rows.length === 0) return null;
                return (
                  <div key={sev} data-testid={`admin-alerts-group-${sev}`}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        marginBottom: 10,
                      }}
                    >
                      <Badge tone={severityTone(sev)} dot>
                        {SEVERITY_LABEL[sev]}
                      </Badge>
                      <span style={{ fontSize: 12, color: INK_MUTED }}>
                        <ResultCount
                          shown={rows.length}
                          hasMore={data?.truncated ?? false}
                          noun="alert"
                          loading={loading}
                          data-testid={`admin-alerts-count-${sev}`}
                        />
                      </span>
                    </div>

                    <div style={{ display: "grid", gap: 10 }}>
                      {loading ? (
                        <Card padding="comfortable" style={{ color: INK_MUTED }}>
                          Loading alerts…
                        </Card>
                      ) : (
                        rows.map((a, index) => (
                          <Card
                            key={`${a.source}:${a.createdAt}:${index}`}
                            padding="comfortable"
                            style={{ minWidth: 0 }}
                          >
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                gap: 16,
                                alignItems: "flex-start",
                                flexWrap: "wrap",
                              }}
                            >
                              <div style={{ minWidth: 0, flex: 1 }}>
                                <div
                                  style={{
                                    fontWeight: 600,
                                    overflowWrap: "anywhere",
                                    color: "var(--ink-primary, #0f172a)",
                                  }}
                                >
                                  {a.title}
                                </div>
                                <div
                                  style={{
                                    marginTop: 6,
                                    display: "flex",
                                    gap: 8,
                                    flexWrap: "wrap",
                                    alignItems: "center",
                                  }}
                                >
                                  <Badge tone="neutral" subtle>
                                    {SOURCE_LABEL[a.source] ?? a.source}
                                  </Badge>
                                  <span style={{ fontSize: 12, color: INK_MUTED }}>
                                    {formatTimestamp(a.createdAt)}
                                  </span>
                                  {a.organizationId ? (
                                    <span
                                      style={{
                                        fontSize: 12,
                                        color: INK_MUTED,
                                        overflowWrap: "anywhere",
                                      }}
                                    >
                                      org · {a.organizationId}
                                    </span>
                                  ) : null}
                                </div>
                              </div>

                              {a.href ? (
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  onClick={() => {
                                    window.location.href = a.href as string;
                                  }}
                                >
                                  View
                                </Button>
                              ) : null}
                            </div>
                          </Card>
                        ))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </PageSection>
      </PageShell>
    </PageRouteGate>
  );
}
