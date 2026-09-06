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

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { PageShell, PageHeader, PageSection } from "../../../../components/ui";
import { Card } from "../../../../components/ui/Card";
import { Badge } from "../../../../components/ui/Badge";
import type { BadgeTone } from "../../../../components/ui/Badge";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { ResultCount } from "../../../../components/ui/ResultCount";
import { Button, buttonSurfaceStyle } from "../../../../components/ui/Button";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { apiFetch } from "../../../../lib/api";
import { useToast } from "../../../../components/ui";
import { severityTone } from "../../../../components/ui/StatusBadge";
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

/*
 * PHASE 7 §B3 — the severity→tone mapping is `severityTone` in
 * `components/ui/StatusBadge`. Three copies of it existed: this one,
 * /admin/audit's, and a raw-hex `severityPalette` in the reviewer-ops design
 * system — and they had already drifted, the reviewer one painting CRITICAL a
 * darker red than HIGH, a distinction the Badge palette does not make and
 * which no operator was ever told the meaning of.
 */

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
                      <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>
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
                        <Card padding="comfortable" style={{ color: "var(--ink-muted)" }}>
                          Loading alerts…
                        </Card>
                      ) : (
                        /*
                          A LIST ROW, NOT A CARD PER ALERT.

                          Each alert carries a title, a category chip, a
                          timestamp and one action — two lines of content — and
                          it was a `padding="comfortable"` Card, which put it
                          at 106px. Twenty-six of them is 2,760px of scroll to
                          read twenty-six one-line facts, and §8 puts a normal
                          list row at 48-56px.

                          It is a LIST because the rows are heterogeneous
                          one-liners rather than grouped concepts, and because
                          the severity headings above them are already the
                          grouping. Nothing is dropped: the title, the
                          category, the timestamp, the organization and the
                          action are all still on the row.

                          The rows are NOT grouped by cause, deliberately.
                          Fifteen of the sixteen criticals here are "Worker
                          unreachable: <queue>" — one root cause fanned out per
                          queue — and collapsing them would mean INFERRING that
                          relationship from a title prefix. The projection does
                          not express it, so inventing it here would be this
                          console asserting something nobody measured. It is
                          recorded as a finding for whoever owns the alert
                          builder instead.
                        */
                        <ul className="adm-alert-list">
                          {rows.map((a, index) => (
                            <li
                              key={`${a.source}:${a.createdAt}:${index}`}
                              className="adm-alert-row"
                            >
                              <span className="adm-alert-row__title">
                                {a.title}
                              </span>
                              <span className="adm-alert-row__meta">
                                <Badge tone="neutral" subtle>
                                  {SOURCE_LABEL[a.source] ?? a.source}
                                </Badge>
                                <span className="adm-alert-row__when">
                                  {formatTimestamp(a.createdAt)}
                                </span>
                                {a.organizationId ? (
                                  <span className="adm-alert-row__org">
                                    org · {a.organizationId}
                                  </span>
                                ) : null}
                              </span>
                              {a.href ? (
                                <Link
                                  href={a.href}
                                  className="ui-button adm-alert-row__action"
                                  data-variant="secondary"
                                  data-size="sm"
                                  style={buttonSurfaceStyle("secondary", "sm")}
                                >
                                  View
                                </Link>
                              ) : (
                                <span />
                              )}
                            </li>
                          ))}
                        </ul>
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
