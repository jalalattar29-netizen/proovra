"use client";

/**
 * Phase 26.5 — Identity Event Timeline admin page.
 *
 * Single chronological feed of every identity-governance event:
 * SSO logins, SCIM syncs, session revocations, suspicious sessions,
 * temporary elevations, access reviews, trusted-device changes,
 * step-up events, privilege changes.
 *
 * Operator-safe: each row carries the eventType + a humanised label.
 * No private notes, no raw IPs, no secrets.
 */

import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { useTeamId } from "../../../../../lib/platform-context";
import { PageShell, PageHeader, PageSection } from "../../../../../components/ui/PageShell";
import { Button } from "../../../../../components/ui/Button";
import { FilterBar } from "../../../../../components/ui/FilterBar";
import { EmptyState } from "../../../../../components/ui/EmptyState";
import { DataTable, type DataTableColumn } from "../../../../../components/ui/DataTable";
import { ResultCount } from "../../../../../components/ui/ResultCount";
import { presentActor } from "../../../../../lib/audit/auditPresentation";
import {
  AdmInline,
} from "../../../../../components/admin/AdminSurfaces";
import { formatCellDateTime } from "../../../../../lib/date";
import { Badge, type BadgeTone } from "../../../../../components/ui/Badge";

/**
 * A SEVERITY IS NOT A STATUS, AND THE STATUS MAP MUST NOT DECIDE IT.
 *
 * This column carries INFO / WARNING / HIGH. Routing those through the
 * product's status→tone map would find no entry for any of them and fall
 * through to the default informational blue, so a HIGH-severity identity
 * event — a revoke, a quarantine — would look exactly like a sign-in.
 */
const SEVERITY_TONE: Record<TimelineEvent["severity"], BadgeTone> = {
  HIGH: "risk",
  WARNING: "pending",
  INFO: "info",
};

type TimelineEvent = {
  id: string;
  kind: string;
  severity: "INFO" | "WARNING" | "HIGH";
  occurredAtUtc: string;
  actorUserId: string | null;
  summary: string;
};

const FILTERS: { label: string; kinds: string }[] = [
  { label: "All identity events", kinds: "" },
  {
    label: "SSO",
    kinds: [
      "sso_login_started",
      "sso_login_succeeded",
      "sso_login_failed",
      "sso_jit_provisioned",
      "sso_jit_denied",
      "sso_callback_replay_detected",
      "sso_state_expired",
      "sso_connection_created",
      "sso_connection_revoked",
      "idp_outage_detected",
      "idp_outage_cleared",
    ].join(","),
  },
  {
    label: "SCIM",
    kinds: [
      "scim_token_created",
      "scim_token_revoked",
      "scim_user_created",
      "scim_user_deactivated",
      "scim_group_created",
      "scim_group_updated",
      "scim_group_synced",
      "scim_group_deleted",
      "scim_group_membership_changed",
    ].join(","),
  },
  {
    label: "Sessions",
    kinds: [
      "session_revoked_admin",
      "all_sessions_revoked_admin",
      "session_inventory_viewed",
      "suspicious_session_detected",
      "forced_reauthentication",
      "session_replay_detected",
      "session_heartbeat_timeout",
      "stale_session_swept",
    ].join(","),
  },
  {
    label: "Adaptive auth + RBAC",
    kinds: [
      "adaptive_step_up_triggered",
      "adaptive_block_triggered",
      "rbac_temporary_elevation_granted",
      "rbac_temporary_elevation_expired",
      "rbac_permission_matrix_viewed",
    ].join(","),
  },
  {
    label: "Access reviews",
    kinds: ["access_review_initiated", "access_review_completed", "access_review_decided"].join(","),
  },
];

/**
 * ONE PAGE OF THE FEED, AND THE CURSOR TO THE NEXT.
 *
 * The page asked for 250 rows and rendered them all — ten screens on a
 * desktop — and then filtered severity in the browser, so "HIGH" showed only
 * the HIGH rows that happened to fall inside the newest 250. Both filters now
 * go to the server, the page is 25 rows, and the server says whether more
 * exist. Nothing is hidden: Next walks the whole feed.
 */
type TimelinePage = {
  events: TimelineEvent[];
  nextCursor: string | null;
  hasMore: boolean;
};

const PAGE_SIZE = 25;

export default function IdentityTimelinePage() {
  const teamId = useTeamId();
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filterIdx, setFilterIdx] = useState(0);
  const [severityFilter, setSeverityFilter] = useState<"" | "INFO" | "WARNING" | "HIGH">("");
  /** Cursors that led to the current page, oldest first; page one is []. */
  const [cursors, setCursors] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const load = useCallback((cursor: string | null) => {
    if (!teamId) return;
    const filter = FILTERS[filterIdx];
    const qs = new URLSearchParams();
    qs.set("teamId", teamId);
    if (filter.kinds) qs.set("kinds", filter.kinds);
    if (severityFilter) qs.set("severity", severityFilter);
    qs.set("limit", String(PAGE_SIZE));
    if (cursor) qs.set("cursor", cursor);
    setEvents(null);
    apiFetch(`/v1/admin/identity/timeline?${qs.toString()}`, { method: "GET" })
      .then((r: Partial<TimelinePage> | null) => {
        setEvents(Array.isArray(r?.events) ? r.events : []);
        setNextCursor(typeof r?.nextCursor === "string" ? r.nextCursor : null);
        setHasMore(r?.hasMore === true);
        setError(null);
      })
      .catch((err: { message?: string }) => {
        setEvents([]);
        setError(toSafeUserError(err, { message: "Could not load timeline." }).message);
      });
  }, [teamId, filterIdx, severityFilter]);

  // A filter change is a new query, so it restarts at page one: a cursor
  // issued under the old filters names a position in a different list.
  useEffect(() => {
    setCursors([]);
    load(null);
  }, [load]);

  const currentCursor = cursors.length > 0 ? cursors[cursors.length - 1] : null;

  const goNext = () => {
    if (!nextCursor) return;
    setCursors((prev) => [...prev, nextCursor]);
    load(nextCursor);
  };

  const goPrevious = () => {
    if (cursors.length === 0) return;
    const remaining = cursors.slice(0, -1);
    setCursors(remaining);
    load(remaining.length > 0 ? remaining[remaining.length - 1] : null);
  };

  if (!teamId) {
    return (
      <PageShell header={<PageHeader eyebrow="Identity operations" title="Identity Audit" />}>
        <EmptyState variant="inline"
          framed
          title="No workspace selected"
          purpose="Switch to a workspace to view its identity-governance event timeline."
        />
      </PageShell>
    );
  }

  // Next/Previous over the SERVER's cursor, disabled truthfully: Previous has
  // nothing to pop on page one, Next nothing to follow when hasMore is false.
  const pager = (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <span className="adm-help">{`Page ${cursors.length + 1}`}</span>
      <Button
        variant="secondary"
        size="sm"
        disabled={events === null || cursors.length === 0}
        onClick={goPrevious}
        data-testid="admin-identity-timeline-previous"
      >
        Previous
      </Button>
      <Button
        variant="secondary"
        size="sm"
        disabled={events === null || !hasMore || !nextCursor}
        onClick={goNext}
        data-testid="admin-identity-timeline-next"
      >
        Next
      </Button>
    </div>
  );

  const columns: DataTableColumn<TimelineEvent>[] = [
    {
      key: "when",
      header: "When",
      nowrap: true,
      render: (e) => (
        <span className="adm-help">{formatCellDateTime(e.occurredAtUtc)}</span>
      ),
    },
    {
      key: "severity",
      header: "Severity",
      render: (e) => (
        <Badge tone={SEVERITY_TONE[e.severity]}>{e.severity}</Badge>
      ),
    },
    {
      key: "kind",
      header: "Event",
      render: (e) => (
        <code
          style={{
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            fontSize: 12,
          }}
        >
          {e.kind}
        </code>
      ),
    },
    {
      key: "actor",
      header: "Actor",
      /*
       * PHASE 5 §6 — THIS COLUMN DID NOT EXIST.
       *
       * `actorUserId` has been on the row type since this page was written and
       * nothing rendered it, so an identity timeline — the surface an operator
       * opens to answer "who changed our SSO" — showed what happened and never
       * who. The presenter is the same one the Admin Audit table uses, so the
       * two surfaces cannot describe the same actor two ways.
       */
      render: (e) => {
        const actor = presentActor({
          actorType: e.actorUserId ? "HUMAN" : "SYSTEM",
          userId: e.actorUserId,
        });
        return (
          <span style={{ display: "grid", gap: 1, fontSize: 12 }}>
            <span style={{ fontStyle: actor.unknown ? "italic" : "normal" }}>
              {actor.name}
            </span>
            {actor.reference ? (
              <span style={{ fontSize: 11, opacity: 0.75 }}>{actor.reference}</span>
            ) : null}
          </span>
        );
      },
    },
    {
      key: "summary",
      header: "Summary",
      render: (e) => <span style={{ fontSize: 12 }}>{e.summary}</span>,
    },
  ];

  return (
    <PageShell
      header={
        <PageHeader
          eyebrow="Identity operations"
          title="Identity Audit"
          subtitle="Workspace-wide identity events: SSO logins, SCIM syncs, session revocations, suspicious sessions, temporary elevations, access reviews, and adaptive auth decisions. Sourced from the Phase 21 SecurityEvent table — operator-safe projections only."
          secondaryActions={
            <Button variant="secondary" onClick={() => load(currentCursor)}>
              Refresh
            </Button>
          }
        />
      }
        >
      {error ? <AdmInline state="error">{error}</AdmInline> : null}

      <PageSection>
        <FilterBar>
          <FilterBar.Select
            label="Event category"
            value={String(filterIdx)}
            onChange={(v) => setFilterIdx(Number(v))}
            options={FILTERS.map((f, i) => ({
              value: String(i),
              label: f.label,
            }))}
          />
          <FilterBar.Select
            label="Severity"
            value={severityFilter}
            onChange={(v) =>
              setSeverityFilter(v as "" | "INFO" | "WARNING" | "HIGH")
            }
            options={[
              { value: "", label: "All severities" },
              { value: "INFO", label: "Info" },
              { value: "WARNING", label: "Warning" },
              { value: "HIGH", label: "High" },
            ]}
          />
        </FilterBar>
        <div style={{ marginTop: 12 }}>
          <DataTable
            columns={columns}
            rows={events ?? []}
            getRowId={(e) => e.id}
            loading={events === null}
            ariaLabel="Identity event timeline"
            emptyState={
              <EmptyState variant="inline"
                title="No identity events"
                purpose="No events match the selected category and severity. Adjust the filters or refresh."
              />
            }
          />
          {/* The server says whether another page exists; the count never claims a total it was not given. */}
          <ResultCount
            shown={events?.length ?? 0}
            hasMore={hasMore}
            noun="event"
            filtered={filterIdx !== 0 || severityFilter !== ""}
            loading={events === null}
            failed={error !== null}
            data-testid="admin-identity-timeline-count"
            action={pager}
          />
        </div>
      </PageSection>
    </PageShell>
  );
}
