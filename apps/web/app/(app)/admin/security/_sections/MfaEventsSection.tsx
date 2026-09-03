"use client";

/**
 * PHASE 12B — MFA event surfaces. Product surface for
 *
 *   GET /v1/identity/mfa-admin/events/:teamId       — workspace MFA events
 *   GET /v1/identity/mfa-admin/recovery-events      — actor-scoped recovery feed
 *
 * Both were registered with no consumer. The workspace feed is scoped by the
 * SERVER-AUTHORIZED `:teamId` taken from `lib/platform-context`; its event
 * `details` blob is allow-list projected on the server, so no device hash or
 * correlation secret can reach this table. The recovery feed is scoped to the
 * signed-in operator's own owner/admin memberships and carries labelled rows
 * only — never a raw details payload.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { useTeamId, useTenantGuard } from "../../../../../lib/platform-context";
import { Badge, type BadgeTone } from "../../../../../components/ui/Badge";
import { Button } from "../../../../../components/ui/Button";
import { DataTable, type DataTableColumn } from "../../../../../components/ui/DataTable";
import { EmptyState } from "../../../../../components/ui/EmptyState";
import { ResultCount } from "../../../../../components/ui/ResultCount";
import { PageSection } from "../../../../../components/ui/PageShell";
import { formatUserDateTime } from "../../../../../lib/date";
import {
  NoWorkspaceSelected,
  SectionDenied,
  SectionError,
  SectionLoading,
  classifyError,
  sectionMuted,
  type SectionState,
} from "./section-state";

type MfaEvent = {
  id: string;
  eventType: string;
  severity: string;
  createdAt: string;
  details: Record<string, unknown> & { redacted?: boolean };
};

type RecoveryEvent = {
  id: string;
  eventType: string;
  severity: string;
  createdAt: string;
  summary: string;
  teamId: string | null;
  teamName: string | null;
};

type Feeds = {
  events: MfaEvent[];
  /** The row cap the events read ran under, as reported by the route. */
  eventsLimit: number | undefined;
  recoveryEvents: RecoveryEvent[];
  recoveryWindowDays: number;
};

function severityTone(severity: string): BadgeTone {
  const v = severity.toUpperCase();
  if (v === "CRITICAL" || v === "HIGH") return "risk";
  if (v === "WARNING") return "pending";
  return "info";
}

export function MfaEventsSection() {
  const teamId = useTeamId();
  const { stamp, isStale } = useTenantGuard();
  const [state, setState] = useState<SectionState<Feeds>>({ kind: "loading" });

  const load = useCallback(async () => {
    if (!teamId) return;
    setState({ kind: "loading" });
    const captured = stamp();
    try {
      const [events, recovery] = await Promise.all([
        apiFetch(`/v1/identity/mfa-admin/events/${encodeURIComponent(teamId)}`, {
          method: "GET",
        }),
        apiFetch(`/v1/identity/mfa-admin/recovery-events?limit=100&windowDays=14`, {
          method: "GET",
        }),
      ]);
      if (isStale(captured)) return;
      const recoveryEnvelope = recovery as {
        events?: RecoveryEvent[];
        windowDays?: number;
      } | null;
      setState({
        kind: "ready",
        data: {
          events: ((events as { events?: MfaEvent[] })?.events ?? []) as MfaEvent[],
          eventsLimit: (events as { limit?: number } | null)?.limit,
          recoveryEvents: recoveryEnvelope?.events ?? [],
          recoveryWindowDays: recoveryEnvelope?.windowDays ?? 14,
        },
      });
    } catch (err) {
      if (isStale(captured)) return;
      setState(classifyError<Feeds>(err, "We couldn't load the MFA event feeds."));
    }
  }, [teamId, stamp, isStale]);

  useEffect(() => {
    void load();
  }, [load]);

  const description =
    "What actually happened to second factors in this workspace, and what has happened across the recovery queues you administer. Event context is allow-list projected on the server: no authenticator seeds, recovery codes, tokens or device fingerprints appear here.";

  if (!teamId) {
    return (
      <PageSection title="MFA activity" description={description}>
        <NoWorkspaceSelected purpose="Switch to a workspace to read its MFA activity." />
      </PageSection>
    );
  }
  if (state.kind === "loading") {
    return (
      <PageSection title="MFA activity" description={description}>
        <SectionLoading label="Reading MFA and recovery activity…" />
      </PageSection>
    );
  }
  if (state.kind === "denied") {
    return (
      <PageSection title="MFA activity" description={description}>
        <SectionDenied message={state.message} />
      </PageSection>
    );
  }
  if (state.kind === "error") {
    return (
      <PageSection title="MFA activity" description={description}>
        <SectionError message={state.message} onRetry={() => void load()} />
      </PageSection>
    );
  }

  const eventColumns: DataTableColumn<MfaEvent>[] = [
    {
      key: "eventType",
      header: "Event",
      render: (r) => (
        <span style={{ fontSize: 12.5, fontWeight: 600, overflowWrap: "anywhere" }}>
          {r.eventType}
        </span>
      ),
    },
    {
      key: "severity",
      header: "Severity",
      render: (r) => <Badge tone={severityTone(r.severity)}>{r.severity}</Badge>,
    },
    {
      key: "details",
      header: "Context",
      render: (r) => {
        const keys = Object.keys(r.details ?? {}).filter((k) => k !== "redacted");
        return (
          <span style={sectionMuted}>
            {keys.length === 0 ? "no additional context" : keys.join(", ")}
            {r.details?.redacted ? " · some fields withheld" : ""}
          </span>
        );
      },
    },
    {
      key: "createdAt",
      header: "When",
      nowrap: true,
      render: (r) => <span style={sectionMuted}>{formatUserDateTime(r.createdAt)}</span>,
    },
  ];

  const recoveryColumns: DataTableColumn<RecoveryEvent>[] = [
    {
      key: "summary",
      header: "What happened",
      render: (r) => (
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>{r.summary}</div>
          <div style={sectionMuted}>
            {r.eventType}
            {r.teamName ? ` · ${r.teamName}` : ""}
          </div>
        </div>
      ),
    },
    {
      key: "severity",
      header: "Severity",
      render: (r) => <Badge tone={severityTone(r.severity)}>{r.severity}</Badge>,
    },
    {
      key: "when",
      header: "When",
      nowrap: true,
      render: (r) => (
        <span style={sectionMuted}>{formatUserDateTime(r.createdAt)}</span>
      ),
    },
  ];

  return (
    <PageSection
      title="MFA activity"
      description={description}
      data-mfa-events-section
      action={
        <Button variant="secondary" onClick={() => void load()}>
          Refresh
        </Button>
      }
    >
      <h3 style={{ fontSize: 13, fontWeight: 700, margin: "0 0 8px" }}>
        Workspace MFA events
      </h3>
      <DataTable
        columns={eventColumns}
        rows={state.data.events}
        getRowId={(r) => r.id}
        ariaLabel="Workspace MFA events"
        emptyState={
          <EmptyState
            title="No MFA events recorded"
            purpose="Nothing has happened to a second factor in this workspace yet. Enrollments, verification failures, admin revocations and trusted-device changes all appear here."
          />
        }
      />
      {/* The most RECENT N. "No MFA events recorded" and "none in the last
          fifty" are very different answers to "has anything happened to a
          second factor here", and the page gave the first for both. */}
      <ResultCount
        shown={state.data.events.length}
        cap={state.data.eventsLimit}
        noun="MFA event"
        data-testid="admin-security-mfa-events-count"
      />

      <h3 style={{ fontSize: 13, fontWeight: 700, margin: "20px 0 8px" }}>
        Lost-factor recovery activity (last {state.data.recoveryWindowDays} days)
      </h3>
      <DataTable
        columns={recoveryColumns}
        rows={state.data.recoveryEvents}
        getRowId={(r) => r.id}
        ariaLabel="Lost-factor recovery activity"
        emptyState={
          <EmptyState
            title="No recovery activity"
            purpose="No lost-factor recovery has been requested, approved, rejected or cancelled across the workspaces you administer in this window."
          />
        }
      />
    </PageSection>
  );
}

export default MfaEventsSection;
