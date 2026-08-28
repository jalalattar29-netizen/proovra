"use client";

/**
 * PLATFORM ADMIN — the cross-tenant security-event feed.
 *
 * PRESERVED CAPABILITY (ADM-034).
 * This lived on `/admin/security` as half of a section whose other half was the
 * platform incident feed. Splitting that page moved the incidents to the
 * Operations table beside this one; the security-event feed came WITH them,
 * because it is platform-scoped too and losing it while "separating concerns"
 * would have been a capability regression dressed up as an architecture fix.
 *
 * SAFETY, UNCHANGED
 * ---------------------------------------------------------------------------
 * The API projects only bounded, operator-safe columns. `SecurityEvent` stores a
 * hashed IP and never a raw one; `AdminAuditLog.metadata` and its raw-IP column
 * are deliberately not selected server-side. Nothing here can render them
 * because nothing here receives them.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

import {
  PageSection,
  FilterBar,
  DataTable,
  useToast,
  type DataTableColumn,
} from "../../../../../components/ui";
import { Badge, type BadgeTone } from "../../../../../components/ui/Badge";
import { Card } from "../../../../../components/ui/Card";
import { EmptyState } from "../../../../../components/ui/EmptyState";
import { apiFetch } from "../../../../../lib/api";
import { formatUserDateTime } from "../../../../../lib/date";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";

type SeverityBucket = "CRITICAL" | "HIGH" | "WARNING" | "INFO";

type SecurityEventRow = {
  id: string;
  origin: "SECURITY_EVENT" | "ADMIN_AUDIT";
  eventType: string;
  severity: SeverityBucket;
  outcome: string | null;
  category: string | null;
  source: string | null;
  resourceType: string | null;
  teamId: string | null;
  userId: string | null;
  createdAt: string;
};

type EventsResponse = {
  items: SecurityEventRow[];
  severityBreakdown: Record<SeverityBucket, number>;
  totalEvents: number;
};

const SEVERITY_TONE: Record<SeverityBucket, BadgeTone> = {
  CRITICAL: "risk",
  HIGH: "risk",
  WARNING: "pending",
  INFO: "neutral",
};

export function PlatformSecurityEvents() {
  const { addToast } = useToast();
  // Seeded from `eventSeverity` so the Overview's "recent high security
  // events" tile lands on THESE rows already filtered. The page's own
  // `severity` belongs to the incident table and is deliberately not read here.
  const params = useSearchParams();
  const [severity, setSeverity] = useState(params.get("eventSeverity") ?? "");
  const [eventType, setEventType] = useState("");
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<EventsResponse | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      qs.set("limit", "100");
      if (severity) qs.set("severity", severity);
      if (eventType.trim()) qs.set("eventType", eventType.trim());
      const res = (await apiFetch(
        `/v1/admin/security-events?${qs.toString()}`,
      )) as EventsResponse;
      setData(res ?? null);
    } catch (err) {
      addToast(
        toSafeUserError(err, {
          message: "We couldn't load platform security events.",
        }).message,
        "error",
      );
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [addToast, severity, eventType]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [severity]);

  const columns = useMemo<DataTableColumn<SecurityEventRow>[]>(
    () => [
      {
        key: "eventType",
        header: "Event",
        render: (r) => (
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 620 }}>{r.eventType}</div>
            <div style={{ fontSize: 12, color: "var(--ink-muted, #94a3b8)", marginTop: 2 }}>
              {r.origin === "ADMIN_AUDIT" ? "Admin audit" : "Security event"}
              {r.category ? ` · ${r.category}` : ""}
              {r.outcome ? ` · ${r.outcome}` : ""}
            </div>
          </div>
        ),
      },
      {
        key: "severity",
        header: "Severity",
        render: (r) => <Badge tone={SEVERITY_TONE[r.severity]}>{r.severity}</Badge>,
      },
      {
        key: "subject",
        header: "Subject",
        render: (r) => (
          <div style={{ minWidth: 0, fontSize: 12.5 }}>
            {r.teamId ? (
              <Link href={`/admin/workspaces/${encodeURIComponent(r.teamId)}`}>
                Workspace
              </Link>
            ) : (
              <span style={{ color: "var(--ink-muted, #94a3b8)" }}>No workspace</span>
            )}
            {r.userId ? (
              <>
                {" · "}
                <Link href={`/admin/users/${encodeURIComponent(r.userId)}`}>Person</Link>
              </>
            ) : null}
          </div>
        ),
      },
      {
        key: "createdAt",
        header: "When",
        nowrap: true,
        render: (r) => formatUserDateTime(r.createdAt),
      },
    ],
    [],
  );

  return (
    <PageSection
      title="Security events"
      description="High-severity security events and privileged admin actions, aggregated across every workspace. Read-only. No raw IP address, user-agent string or audit metadata is returned by the API."
    >
      <FilterBar>
        <FilterBar.Select
          label="Severity"
          value={severity}
          onChange={setSeverity}
          options={[
            { value: "", label: "All severities" },
            { value: "CRITICAL", label: "Critical" },
            { value: "HIGH", label: "High" },
            { value: "WARNING", label: "Warning" },
            { value: "INFO", label: "Info" },
          ]}
        />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void load();
          }}
          style={{ display: "contents" }}
        >
          <FilterBar.Search
            label="Event type"
            value={eventType}
            onChange={setEventType}
            onBlur={() => void load()}
            placeholder="e.g. login_failed…"
          />
        </form>
      </FilterBar>

      <Card>
        <DataTable<SecurityEventRow>
          ariaLabel="Platform security events"
          columns={columns}
          rows={data?.items ?? []}
          getRowId={(r) => r.id}
          loading={loading}
          emptyState={
            <EmptyState
              title="No security events"
              purpose="No security event matches the current filters. An empty table here is a real zero, not an unmeasured signal."
            />
          }
        />
      </Card>
    </PageSection>
  );
}
