"use client";

/**
 * PHASE 12B — MFA event surfaces. Product surface for
 *
 *   GET /v1/identity/mfa-admin/events/:teamId?limit&cursor — workspace MFA events
 *   GET /v1/identity/mfa-admin/recovery-events?limit&windowDays&cursor
 *                                                    — actor-scoped recovery feed
 *
 * Both were registered with no consumer. The workspace feed is scoped by the
 * SERVER-AUTHORIZED `:teamId` taken from `lib/platform-context`; its event
 * `details` blob is allow-list projected on the server, so no device hash or
 * correlation secret can reach this table. The recovery feed is scoped to the
 * signed-in operator's own owner/admin memberships and carries labelled rows
 * only — never a raw details payload.
 *
 * PAGED, NOT CAPPED
 *   The workspace feed rendered the most recent fifty rows and the recovery
 *   feed the most recent hundred, each in one table. Both now read 25 rows at
 *   a time over a server keyset cursor, and the count row states what the
 *   server said about a further page rather than inferring it from a full one.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { useTeamId, useTenantGuard } from "../../../../../lib/platform-context";
import { Badge, type BadgeTone } from "../../../../../components/ui/Badge";
import { Button } from "../../../../../components/ui/Button";
import { CursorPager, useCursorPager } from "../../../../../components/ui/CursorPager";
import { DataTable, type DataTableColumn } from "../../../../../components/ui/DataTable";
import { EmptyState } from "../../../../../components/ui/EmptyState";
import { ResultCount } from "../../../../../components/ui/ResultCount";
import { PageSection } from "../../../../../components/ui/PageShell";
import { formatUserDateTime } from "../../../../../lib/date";
import { presentActor } from "../../../../../lib/audit/auditPresentation";
import {
  NoWorkspaceSelected,
  SectionDenied,
  SectionDescription,
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
  // PHASE 5 §6 — who, resolved by the API for the page.
  actorUserId?: string | null;
  actorDisplay?: string | null;
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

type EventsPage = {
  events: MfaEvent[];
  nextCursor: string | null;
  hasMore: boolean;
};

type RecoveryPage = {
  events: RecoveryEvent[];
  windowDays: number;
  nextCursor: string | null;
  hasMore: boolean;
};

const PAGE_SIZE = 25;
const RECOVERY_WINDOW_DAYS = 14;

function severityTone(severity: string): BadgeTone {
  const v = severity.toUpperCase();
  if (v === "CRITICAL" || v === "HIGH") return "risk";
  if (v === "WARNING") return "pending";
  return "info";
}

export function MfaEventsSection() {
  const teamId = useTeamId();
  const { stamp, isStale } = useTenantGuard();

  const [eventsState, setEventsState] = useState<SectionState<EventsPage>>({
    kind: "loading",
  });
  const [recoveryState, setRecoveryState] = useState<SectionState<RecoveryPage>>({
    kind: "loading",
  });
  const [eventsBusy, setEventsBusy] = useState(false);
  const [recoveryBusy, setRecoveryBusy] = useState(false);

  // Each table walks its own cursor; both reset when the workspace changes.
  const eventsPager = useCursorPager(teamId ?? "");
  const recoveryPager = useCursorPager(teamId ?? "");

  const loadEvents = useCallback(async () => {
    if (!teamId) return;
    setEventsState((prev) => (prev.kind === "ready" ? prev : { kind: "loading" }));
    setEventsBusy(true);
    const captured = stamp();
    try {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (eventsPager.cursor) qs.set("cursor", eventsPager.cursor);
      const res = (await apiFetch(
        `/v1/identity/mfa-admin/events/${encodeURIComponent(teamId)}?${qs.toString()}`,
        { method: "GET" },
      )) as {
        events?: MfaEvent[];
        nextCursor?: string | null;
        hasMore?: boolean;
      } | null;
      if (isStale(captured)) return;
      setEventsState({
        kind: "ready",
        data: {
          events: res?.events ?? [],
          nextCursor: res?.nextCursor ?? null,
          hasMore: res?.hasMore ?? false,
        },
      });
    } catch (err) {
      if (isStale(captured)) return;
      setEventsState(
        classifyError<EventsPage>(err, "We couldn't load the MFA event feed."),
      );
    } finally {
      if (!isStale(captured)) setEventsBusy(false);
    }
  }, [teamId, eventsPager.cursor, stamp, isStale]);

  const loadRecovery = useCallback(async () => {
    if (!teamId) return;
    setRecoveryState((prev) => (prev.kind === "ready" ? prev : { kind: "loading" }));
    setRecoveryBusy(true);
    const captured = stamp();
    try {
      const qs = new URLSearchParams({
        limit: String(PAGE_SIZE),
        windowDays: String(RECOVERY_WINDOW_DAYS),
      });
      if (recoveryPager.cursor) qs.set("cursor", recoveryPager.cursor);
      const res = (await apiFetch(
        `/v1/identity/mfa-admin/recovery-events?${qs.toString()}`,
        { method: "GET" },
      )) as {
        events?: RecoveryEvent[];
        windowDays?: number;
        nextCursor?: string | null;
        hasMore?: boolean;
      } | null;
      if (isStale(captured)) return;
      setRecoveryState({
        kind: "ready",
        data: {
          events: res?.events ?? [],
          windowDays: res?.windowDays ?? RECOVERY_WINDOW_DAYS,
          nextCursor: res?.nextCursor ?? null,
          hasMore: res?.hasMore ?? false,
        },
      });
    } catch (err) {
      if (isStale(captured)) return;
      setRecoveryState(
        classifyError<RecoveryPage>(
          err,
          "We couldn't load the recovery activity feed.",
        ),
      );
    } finally {
      if (!isStale(captured)) setRecoveryBusy(false);
    }
  }, [teamId, recoveryPager.cursor, stamp, isStale]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    void loadRecovery();
  }, [loadRecovery]);

  const reload = useCallback(async () => {
    await Promise.all([loadEvents(), loadRecovery()]);
  }, [loadEvents, loadRecovery]);

  const description = (
    <SectionDescription text="What actually happened to second factors in this workspace, and what has happened across the recovery queues you administer. Event context is allow-list projected on the server: no authenticator seeds, recovery codes, tokens or device fingerprints appear here." />
  );

  if (!teamId) {
    return (
      <PageSection title="MFA activity" description={description}>
        <NoWorkspaceSelected purpose="Switch to a workspace to read its MFA activity." />
      </PageSection>
    );
  }
  if (eventsState.kind === "loading") {
    return (
      <PageSection title="MFA activity" description={description}>
        <SectionLoading label="Reading MFA and recovery activity…" />
      </PageSection>
    );
  }
  if (eventsState.kind === "denied") {
    return (
      <PageSection title="MFA activity" description={description}>
        <SectionDenied message={eventsState.message} />
      </PageSection>
    );
  }
  if (eventsState.kind === "error") {
    return (
      <PageSection title="MFA activity" description={description}>
        <SectionError message={eventsState.message} onRetry={() => void reload()} />
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
      key: "actor",
      header: "Actor",
      /*
       * PHASE 5 §6 — THE SECURITY CONSOLE HAD NO ACTOR COLUMN.
       *
       * It showed what happened to second factors and never who did it, which
       * on the surface an operator opens after a suspected account compromise
       * is the missing half of the question. `SecurityEvent.userId` was always
       * there; the read simply never selected it.
       *
       * Rendered through the same presenter as the Admin Audit table, so a
       * deleted account reads as "Unknown legacy actor" rather than as a blank
       * cell, and a detection with no human behind it is not dressed up as one.
       */
      render: (r) => {
        const actor = presentActor({
          actorType: r.actorUserId ? "HUMAN" : "UNKNOWN_LEGACY",
          actorDisplay: r.actorDisplay ?? null,
          userId: r.actorUserId ?? null,
        });
        return (
          <span style={{ display: "grid", gap: 1 }}>
            <span style={{ fontStyle: actor.unknown ? "italic" : "normal" }}>
              {actor.name}
            </span>
            {actor.reference ? (
              <span style={sectionMuted}>{actor.reference}</span>
            ) : null}
          </span>
        );
      },
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

  const recoveryWindowDays =
    recoveryState.kind === "ready"
      ? recoveryState.data.windowDays
      : RECOVERY_WINDOW_DAYS;

  return (
    <PageSection
      title="MFA activity"
      description={description}
      data-mfa-events-section
      action={
        <Button variant="secondary" onClick={() => void reload()}>
          Refresh
        </Button>
      }
 >
      <h3 style={{ fontSize: 13, fontWeight: 700, margin: "0 0 8px" }}>
        Workspace MFA events
      </h3>
      <DataTable
        columns={eventColumns}
        rows={eventsState.data.events}
        getRowId={(r) => r.id}
        loading={eventsBusy}
        ariaLabel="Workspace MFA events"
        emptyState={
          <EmptyState variant="inline"
            title="No MFA events recorded"
            purpose="Nothing has happened to a second factor in this workspace yet. Enrollments, verification failures, admin revocations and trusted-device changes all appear here."
          />
        }
      />
      {/* "No MFA events recorded" and "none on this page" are very different
          answers to "has anything happened to a second factor here"; the
          server's hasMore is what tells them apart. */}
      <ResultCount
        shown={eventsState.data.events.length}
        hasMore={eventsState.data.hasMore}
        noun="MFA event"
        loading={eventsBusy}
        action={
          <CursorPager
            pager={eventsPager}
            nextCursor={eventsState.data.nextCursor}
            hasMore={eventsState.data.hasMore}
            loading={eventsBusy}
            data-testid="admin-security-mfa-events-pager"
          />
        }
        data-testid="admin-security-mfa-events-count"
      />

      <h3 style={{ fontSize: 13, fontWeight: 700, margin: "20px 0 8px" }}>
        Lost-factor recovery activity (last {recoveryWindowDays} days)
      </h3>
      {recoveryState.kind === "loading" ? (
        <SectionLoading label="Reading recovery activity…" />
      ) : recoveryState.kind === "denied" ? (
        <SectionDenied
          message={recoveryState.message}
          hint="The recovery feed is only offered to owners and admins of at least one workspace. This is a refusal, not an empty feed."
        />
      ) : recoveryState.kind === "error" ? (
        <SectionError
          message={recoveryState.message}
          onRetry={() => void loadRecovery()}
        />
      ) : (
        <>
          <DataTable
            columns={recoveryColumns}
            rows={recoveryState.data.events}
            getRowId={(r) => r.id}
            loading={recoveryBusy}
            ariaLabel="Lost-factor recovery activity"
            emptyState={
              <EmptyState variant="inline"
                title="No recovery activity"
                purpose="No lost-factor recovery has been requested, approved, rejected or cancelled across the workspaces you administer in this window."
              />
            }
          />
          <ResultCount
            shown={recoveryState.data.events.length}
            hasMore={recoveryState.data.hasMore}
            noun="recovery event"
            loading={recoveryBusy}
            action={
              <CursorPager
                pager={recoveryPager}
                nextCursor={recoveryState.data.nextCursor}
                hasMore={recoveryState.data.hasMore}
                loading={recoveryBusy}
                data-testid="admin-security-recovery-events-pager"
              />
            }
            data-testid="admin-security-recovery-events-count"
          />
        </>
      )}
    </PageSection>
  );
}

export default MfaEventsSection;
