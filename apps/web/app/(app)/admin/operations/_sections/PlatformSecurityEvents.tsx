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
import { Button } from "../../../../../components/ui/Button";
import { Card } from "../../../../../components/ui/Card";
import { EmptyState } from "../../../../../components/ui/EmptyState";
import { ResultCount } from "../../../../../components/ui/ResultCount";
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
  /**
   * ONE PAGE, AND WHETHER THERE IS ANOTHER.
   *
   * The section asked for 100 rows and rendered them in one table, which was
   * most of the Operations page's height. It now reads 25 at a time over the
   * server's keyset cursor: `hasMore` is the server's own answer, so the
   * count beneath the table is a fact rather than "we got what we asked for".
   */
  nextCursor: string | null;
  hasMore: boolean;
  severityBreakdown: Record<SeverityBucket, number>;
  totalEvents: number;
};

const PAGE_SIZE = 25;

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
  const [failed, setFailed] = useState(false);
  const [data, setData] = useState<EventsResponse | null>(null);
  /** Cursors that led to the current page, oldest first; page one is []. */
  const [cursors, setCursors] = useState<string[]>([]);

  const load = useCallback(async (cursor: string | null) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      qs.set("limit", String(PAGE_SIZE));
      if (cursor) qs.set("cursor", cursor);
      if (severity) qs.set("severity", severity);
      if (eventType.trim()) qs.set("eventType", eventType.trim());
      const res = (await apiFetch(
        `/v1/admin/security-events?${qs.toString()}`,
      )) as EventsResponse;
      setData(res ?? null);
      setFailed(false);
    } catch (err) {
      addToast(
        toSafeUserError(err, {
          message: "We couldn't load platform security events.",
        }).message,
        "error",
      );
      setData(null);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [addToast, severity, eventType]);

  // A filter change is a new query, so it restarts at page one; the event
  // type box applies on blur/submit through `applyFilters` below.
  useEffect(() => {
    setCursors([]);
    void load(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [severity]);

  const applyFilters = () => {
    setCursors([]);
    void load(null);
  };

  const nextCursor = data?.nextCursor ?? null;
  const hasMore = data?.hasMore === true;

  const goNext = () => {
    if (!nextCursor) return;
    setCursors((prev) => [...prev, nextCursor]);
    void load(nextCursor);
  };

  const goPrevious = () => {
    if (cursors.length === 0) return;
    const remaining = cursors.slice(0, -1);
    setCursors(remaining);
    void load(remaining.length > 0 ? remaining[remaining.length - 1] : null);
  };

  const columns = useMemo<DataTableColumn<SecurityEventRow>[]>(
    () => [
      {
        key: "eventType",
        header: "Event",
        render: (r) => (
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 620 }}>{r.eventType}</div>
            <div style={{ fontSize: 12, color: "var(--ink-muted)", marginTop: 2 }}>
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
              <span style={{ color: "var(--ink-muted)" }}>No workspace</span>
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

  // Next/Previous over the SERVER's cursor, disabled truthfully: Previous has
  // nothing to pop on page one, Next nothing to follow when hasMore is false.
  const pager = (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <span style={{ fontSize: 12.5, color: "var(--ink-muted)" }}>
        {`Page ${cursors.length + 1}`}
      </span>
      <Button
        variant="secondary"
        size="sm"
        disabled={loading || cursors.length === 0}
        onClick={goPrevious}
        data-testid="admin-security-events-previous"
      >
        Previous
      </Button>
      <Button
        variant="secondary"
        size="sm"
        disabled={loading || !hasMore || !nextCursor}
        onClick={goNext}
        data-testid="admin-security-events-next"
      >
        Next
      </Button>
    </div>
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
            applyFilters();
          }}
          style={{ display: "contents" }}
        >
          <FilterBar.Search
            label="Event type"
            value={eventType}
            onChange={setEventType}
            onBlur={applyFilters}
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
            <EmptyState variant="inline"
              title="No security events"
              purpose="No security event matches the current filters. An empty table here is a real zero, not an unmeasured signal."
            />
          }
        />
        <ResultCount
          shown={data?.items.length ?? 0}
          hasMore={hasMore}
          noun="security event"
          filtered={severity !== "" || eventType.trim() !== ""}
          loading={loading}
          failed={failed}
          data-testid="admin-security-events-count"
          action={pager}
        />
      </Card>
    </PageSection>
  );
}
