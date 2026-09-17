"use client";

/**
 * PHASE 12B — Workspace security posture: the product surface for
 *
 *   GET /v1/security/summary?teamId&sinceDays
 *   GET /v1/security/scans?teamId&status&limit
 *   GET /v1/security/events?teamId&severity&eventType&limit&cursor
 *
 * All three were registered with NO product consumer: the backend counted
 * malware scans and security events per workspace and nothing rendered them.
 *
 * The workspace comes from `lib/platform-context` — the operator can never
 * type or pick an arbitrary teamId, and a response that lands after a
 * workspace switch is dropped via `useTenantGuard`.
 *
 * The client computes NO security decision: `malwareScanningEnabled`, every
 * count, and every status label are read straight from the server envelope.
 *
 * ONE STRIP, NOT A WALL
 *   The summary rendered one card per scan status and one per event
 *   severity — nine boxes, each holding one number, each a full row on a
 *   phone, and every zero wearing the colour of the thing it counted, so
 *   "0 infected" read as an alarm. The same nine values are now one
 *   definition list, and a value is only toned when it is non-zero and the
 *   category itself is an alarm.
 *
 * PAGED, NOT CAPPED
 *   The events table asked for 100 rows and rendered them; on a phone that
 *   was fourteen thousand pixels of table. It reads 25 at a time over a
 *   server keyset cursor, with the severity filter applied by the server
 *   under that cursor. Scans keep their single bounded read and the count
 *   row says so.
 */

import { useCallback, useEffect, useState } from "react";

import {
  FILE_SECURITY_SCAN_STATUSES,
  SECURITY_EVENT_SEVERITIES,
} from "@proovra/shared";
import { apiFetch } from "../../../../../lib/api";
import { useTeamId, useTenantGuard } from "../../../../../lib/platform-context";
import { Badge, type BadgeTone } from "../../../../../components/ui/Badge";
import { Button } from "../../../../../components/ui/Button";
import { CursorPager, useCursorPager } from "../../../../../components/ui/CursorPager";
import { DataTable, type DataTableColumn } from "../../../../../components/ui/DataTable";
import { EmptyState } from "../../../../../components/ui/EmptyState";
import { FilterBar } from "../../../../../components/ui/FilterBar";
import { PageSection } from "../../../../../components/ui/PageShell";
import { ResultCount } from "../../../../../components/ui/ResultCount";
import { formatUserDateTime } from "../../../../../lib/date";
import {
  NoWorkspaceSelected,
  SectionDenied,
  SectionPlanGated,
  SectionDescription,
  SectionError,
  SectionLoading,
  classifyError,
  sectionMuted,
  type SectionState,
} from "./section-state";

type SummaryEnvelope = {
  malwareScanningEnabled: boolean;
  scanCounts: Record<string, number>;
  eventCounts: Record<string, number>;
  sinceDays: number;
};

type ScanRow = {
  id: string;
  evidenceId: string;
  teamId: string | null;
  status: string;
  scanner: string | null;
  signatureVersion: string | null;
  findingsSummary: string | null;
  scannedAtUtc: string | null;
  createdAt: string;
};

type EventRow = {
  id: string;
  teamId: string | null;
  eventType: string;
  severity: string;
  evidenceId: string | null;
  details: Record<string, unknown> & { redacted?: boolean };
  createdAt: string;
};

type Overview = {
  summary: SummaryEnvelope;
  scans: ScanRow[];
};

type EventsPage = {
  events: EventRow[];
  nextCursor: string | null;
  hasMore: boolean;
};

/**
 * THE FILTER OFFERED A SEVERITY THAT DOES NOT EXIST.
 *
 * This list was written by hand and opened with "Critical". A security event's
 * severity domain is `SECURITY_EVENT_SEVERITIES` — INFO, WARNING, HIGH — and
 * `GET /v1/security/events` validates `severity` against exactly that zod
 * enum. So choosing Critical sent a value the route refuses, the read came
 * back 400, and the section rendered "Some details need attention before we
 * can continue. / Try again": a form-validation sentence, on a list, for a
 * choice the page itself had offered. Nothing the reader could do would make
 * it work, and nothing on screen said why.
 *
 * Derived from the canonical constant now, so a severity added or removed in
 * `packages/shared` cannot leave a dead option behind here. The labels stay
 * sentence-case for the control; the values are the enum verbatim.
 */
const SEVERITY_OPTIONS = [
  { value: "all", label: "All severities" },
  // Highest first: an operator scanning a severity filter is looking for the
  // worst thing, and the enum is declared ascending.
  ...[...SECURITY_EVENT_SEVERITIES].reverse().map((value) => ({
    value,
    label: value.charAt(0) + value.slice(1).toLowerCase(),
  })),
];

/**
 * AND THE SCAN FILTER OFFERED A STATUS THAT DOES NOT EXIST EITHER.
 *
 * It listed "Infected". `FILE_SECURITY_SCAN_STATUSES` says SUSPICIOUS, and
 * `GET /v1/security/scans` validates against that enum — so the one result an
 * operator opens this page to find was also the one choice that returned 400.
 * The posture strip two elements above it was already labelling the same
 * number "SCANS SUSPICIOUS", so the page disagreed with itself in view.
 */
const SCAN_STATUS_OPTIONS = [
  { value: "all", label: "All scan results" },
  ...FILE_SECURITY_SCAN_STATUSES.map((value) => ({
    value,
    label: value.charAt(0) + value.slice(1).toLowerCase(),
  })),
];

/** One screen of events; the whole reason the table is paged. */
const EVENTS_PAGE_SIZE = 25;
/** The scans read stays a single bounded request; the count row discloses it. */
const SCANS_CAP = 50;

function severityTone(severity: string): BadgeTone {
  const v = severity.toUpperCase();
  if (v === "CRITICAL" || v === "HIGH") return "risk";
  if (v === "WARNING") return "pending";
  return "info";
}

/**
 * A SUSPICIOUS SCAN WAS THE ONE RESULT WEARING NO COLOUR.
 *
 * This tested for "INFECTED", which is not a status this platform has:
 * `FILE_SECURITY_SCAN_STATUSES` is PENDING, CLEAN, SUSPICIOUS, FAILED,
 * SKIPPED. So the single result an operator must act on fell through to
 * `neutral` — grey, in a strip where zero-value counters are also grey, and in
 * a table where CLEAN is green and FAILED is red. The strip's own label read
 * "SCANS SUSPICIOUS" while its number could never alarm.
 *
 * "INFECTED" is kept as a synonym rather than dropped: it costs one clause and
 * it means a scanner or an older row using that word still reads as risk.
 */
function scanTone(status: string): BadgeTone {
  const v = status.toUpperCase();
  if (v === "SUSPICIOUS" || v === "INFECTED" || v === "FAILED") return "risk";
  if (v === "PENDING" || v === "RUNNING") return "pending";
  if (v === "CLEAN") return "verified";
  return "neutral";
}

function when(value: string | null): string {
  if (!value) return "—";
  return formatUserDateTime(value);
}

/**
 * One term in the posture strip.
 *
 * A count is toned only when it is non-zero AND the category is one an
 * operator should act on. Zero infected scans is the good outcome and must
 * not wear red; twelve clean scans is not an alarm either. Existing tones
 * only — no new colours were introduced for this strip.
 */
function PostureTerm({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: BadgeTone;
}) {
  const alarm =
    typeof value === "number" && value > 0 && (tone === "risk" || tone === "pending");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      <dt
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--ink-muted)",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </dt>
      <dd style={{ margin: 0, fontSize: 15, fontWeight: 650 }}>
        {alarm ? (
          <Badge tone={tone} dot>
            {new Intl.NumberFormat().format(value as number)}
          </Badge>
        ) : typeof value === "number" ? (
          new Intl.NumberFormat().format(value)
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

export function WorkspaceSecurityPostureSection() {
  const teamId = useTeamId();
  const { stamp, isStale } = useTenantGuard();
  const [severity, setSeverity] = useState("all");
  const [scanStatus, setScanStatus] = useState("all");

  const [overview, setOverview] = useState<SectionState<Overview>>({ kind: "loading" });
  const [eventsState, setEventsState] = useState<SectionState<EventsPage>>({
    kind: "loading",
  });
  const [eventsBusy, setEventsBusy] = useState(false);
  const [scansBusy, setScansBusy] = useState(false);

  // A cursor belongs to one query: the pager resets in the same render the
  // workspace or the severity filter changes.
  const eventsPager = useCursorPager(`${teamId ?? ""}|${severity}`);

  const loadOverview = useCallback(async () => {
    if (!teamId) return;
    setOverview((prev) => (prev.kind === "ready" ? prev : { kind: "loading" }));
    setScansBusy(true);
    const captured = stamp();
    try {
      const summaryQs = new URLSearchParams({ teamId, sinceDays: "30" });
      const scanQs = new URLSearchParams({ teamId, limit: String(SCANS_CAP) });
      if (scanStatus !== "all") scanQs.set("status", scanStatus);
      const [summary, scans] = await Promise.all([
        apiFetch(`/v1/security/summary?${summaryQs.toString()}`, { method: "GET" }),
        apiFetch(`/v1/security/scans?${scanQs.toString()}`, { method: "GET" }),
      ]);
      if (isStale(captured)) return;
      setOverview({
        kind: "ready",
        data: {
          summary: summary as SummaryEnvelope,
          scans: ((scans as { scans?: ScanRow[] })?.scans ?? []) as ScanRow[],
        },
      });
    } catch (err) {
      if (isStale(captured)) return;
      setOverview(
        classifyError<Overview>(
          err,
          "We couldn't load this workspace's security posture.",
        ),
      );
    } finally {
      if (!isStale(captured)) setScansBusy(false);
    }
  }, [teamId, scanStatus, stamp, isStale]);

  const loadEvents = useCallback(async () => {
    if (!teamId) return;
    setEventsState((prev) => (prev.kind === "ready" ? prev : { kind: "loading" }));
    setEventsBusy(true);
    const captured = stamp();
    try {
      // The severity filter is SERVER-side and travels under the cursor, so
      // every page is a page of the narrowed set.
      const eventQs = new URLSearchParams({ teamId, limit: String(EVENTS_PAGE_SIZE) });
      if (severity !== "all") eventQs.set("severity", severity);
      if (eventsPager.cursor) eventQs.set("cursor", eventsPager.cursor);
      const res = (await apiFetch(`/v1/security/events?${eventQs.toString()}`, {
        method: "GET",
      })) as {
        events?: EventRow[];
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
        classifyError<EventsPage>(err, "We couldn't load the security events."),
      );
    } finally {
      if (!isStale(captured)) setEventsBusy(false);
    }
  }, [teamId, severity, eventsPager.cursor, stamp, isStale]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  const reload = useCallback(async () => {
    await Promise.all([loadOverview(), loadEvents()]);
  }, [loadOverview, loadEvents]);

  const description = (
    <SectionDescription text="Malware-scan and security-event posture for the workspace you are currently in. Counts, statuses and event details are read live from the backend aggregate; nothing on this panel is estimated and no scanner internals, payloads or raw IP addresses are shown." />
  );

  if (!teamId) {
    return (
      <PageSection title="Workspace security posture" description={description}>
        <NoWorkspaceSelected purpose="Switch to a workspace to read its scan and security-event posture." />
      </PageSection>
    );
  }

  if (overview.kind === "loading") {
    return (
      <PageSection title="Workspace security posture" description={description}>
        <SectionLoading label="Reading the workspace security aggregate…" />
      </PageSection>
    );
  }

  if (overview.kind === "denied") {
    return (
      <PageSection title="Workspace security posture" description={description}>
        <SectionDenied message={overview.message} />
      </PageSection>
    );
  }
  if (overview.kind === "plan_gated") {
    return (
      <PageSection title="Workspace security posture" description={description}>
        <SectionPlanGated
            message={overview.message}
            feature={overview.feature}
            upgradeCta={overview.upgradeCta}
          />
      </PageSection>
    );
  }

  if (overview.kind === "error") {
    return (
      <PageSection title="Workspace security posture" description={description}>
        <SectionError message={overview.message} onRetry={() => void reload()} />
      </PageSection>
    );
  }

  const { summary, scans } = overview.data;

  const scanColumns: DataTableColumn<ScanRow>[] = [
    {
      key: "status",
      header: "Result",
      render: (r) => <Badge tone={scanTone(r.status)}>{r.status}</Badge>,
    },
    {
      key: "scanner",
      header: "Scanner",
      render: (r) => (
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12.5 }}>{r.scanner ?? "—"}</div>
          <div style={sectionMuted}>{r.signatureVersion ?? "no signature version"}</div>
        </div>
      ),
    },
    {
      key: "findings",
      header: "Findings",
      render: (r) => (
        <span style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>
          {r.findingsSummary ?? "—"}
        </span>
      ),
    },
    {
      key: "scannedAt",
      header: "Scanned",
      nowrap: true,
      render: (r) => <span style={sectionMuted}>{when(r.scannedAtUtc)}</span>,
    },
  ];

  const eventColumns: DataTableColumn<EventRow>[] = [
    {
      key: "eventType",
      header: "Event",
      render: (r) => (
        <span style={{ fontWeight: 600, fontSize: 12.5, overflowWrap: "anywhere" }}>
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
        const redacted = Boolean(r.details?.redacted);
        // "no additional context · some fields withheld" said both that there
        // was nothing and that something had been hidden, in one cell, on
        // every row. Two clauses that contradict each other is worse than
        // either alone; one of them is the whole truth in each case.
        const text =
          keys.length === 0
            ? redacted
              ? "context withheld"
              : "no additional context"
            : redacted
              ? `${keys.join(", ")} · some fields withheld`
              : keys.join(", ");
        return <span style={sectionMuted}>{text}</span>;
      },
    },
    {
      key: "createdAt",
      header: "When",
      nowrap: true,
      render: (r) => <span style={sectionMuted}>{when(r.createdAt)}</span>,
    },
  ];

  const scanTerms = Object.entries(summary.scanCounts ?? {});
  const eventTerms = Object.entries(summary.eventCounts ?? {});

  /**
   * SIX ZEROS ARE NOT SIX MEASUREMENTS.
   *
   * With malware scanning off, this strip read "MALWARE SCANNING not enabled ·
   * WINDOW last 30 days · SCANS PENDING 0 · SCANS CLEAN 0 · SCANS SUSPICIOUS 0
   * · SCANS FAILED 0 · SCANS SKIPPED 0" — five counters whose value is the
   * absence of a scanner, sitting in the same row and the same type as the
   * event counts, which ARE measured. Read quickly, five zeros next to
   * "SUSPICIOUS" and "FAILED" say "we scanned and found nothing", which is the
   * opposite of the truth.
   *
   * The counters come back only when there is something to count. A workspace
   * that scanned and then had scanning turned off keeps its history: any
   * non-zero count means these are real numbers about real scans, so the
   * suppression tests the counts and not just the flag.
   */
  const scansMeasured = scanTerms.some(([, value]) => Number(value) > 0);
  const scansAreData = summary.malwareScanningEnabled || scansMeasured;

  return (
    <PageSection
      title="Workspace security posture"
      description={description}
      data-workspace-security-posture
      action={
        <Button variant="secondary" onClick={() => void reload()}>
          Refresh
        </Button>
      }
    >
      {/* Every value the nine cards held, in one row that wraps. */}
      <dl
        data-security-posture-strip
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "12px 28px",
          margin: "0 0 16px",
          padding: "12px 16px",
          border: "1px solid var(--border-default)",
          borderRadius: "var(--radius-card)",
          background: "var(--surface-card)",
        }}
      >
        <PostureTerm
          label="Malware scanning"
          value={summary.malwareScanningEnabled ? "enabled" : "not enabled"}
        />
        <PostureTerm label="Window" value={`last ${summary.sinceDays} days`} />
        {scansAreData ? (
          scanTerms.map(([key, value]) => (
            <PostureTerm
              key={`scan-${key}`}
              label={`Scans ${key.toLowerCase()}`}
              value={value}
              tone={scanTone(key)}
            />
          ))
        ) : (
          <PostureTerm label="Scans" value="none — scanning not enabled" />
        )}
        {eventTerms.map(([key, value]) => (
          <PostureTerm
            key={`event-${key}`}
            label={`Events ${key.toLowerCase()}`}
            value={value}
            tone={severityTone(key)}
          />
        ))}
      </dl>

      {/* Both filters apply as they change — each is part of its request. */}
      <FilterBar
        style={{ marginBottom: 12 }}
        filtered={severity !== "all" || scanStatus !== "all"}
        onReset={() => {
          setSeverity("all");
          setScanStatus("all");
        }}
      >
        <FilterBar.Select
          label="Event severity"
          value={severity}
          onChange={setSeverity}
          options={SEVERITY_OPTIONS}
        />
        <FilterBar.Select
          label="Scan result"
          value={scanStatus}
          onChange={setScanStatus}
          options={SCAN_STATUS_OPTIONS}
        />
      </FilterBar>

      <h3 style={{ fontSize: 13, fontWeight: 700, margin: "0 0 8px" }}>
        Security events
      </h3>
      {eventsState.kind === "loading" ? (
        <SectionLoading label="Reading the workspace security events…" />
      ) : eventsState.kind === "denied" ? (
        <SectionDenied message={eventsState.message} />
      ) : eventsState.kind === "plan_gated" ? (
        <SectionPlanGated
          message={eventsState.message}
          feature={eventsState.feature}
          upgradeCta={eventsState.upgradeCta}
        />
      ) : eventsState.kind === "error" ? (
        <SectionError message={eventsState.message} onRetry={() => void loadEvents()} />
      ) : (
        <>
          <DataTable
            columns={eventColumns}
            rows={eventsState.data.events}
            getRowId={(r) => r.id}
            loading={eventsBusy}
            ariaLabel="Workspace security events"
            emptyState={
              <EmptyState variant="inline"
                title="No security events in this window"
                purpose={
                  severity !== "all"
                    ? "No security event in this window has that severity. Clear the severity filter to see the rest. This is a real empty result from the server, not a permission problem."
                    : `No security event has been recorded for this workspace in the last ${summary.sinceDays} days. This is a real empty result from the server, not a permission problem.`
                }
              />
            }
          />
          <ResultCount
            shown={eventsState.data.events.length}
            hasMore={eventsState.data.hasMore}
            noun="security event"
            filtered={severity !== "all"}
            loading={eventsBusy}
            action={
              <CursorPager
                pager={eventsPager}
                nextCursor={eventsState.data.nextCursor}
                hasMore={eventsState.data.hasMore}
                loading={eventsBusy}
                data-testid="admin-security-events-pager"
              />
            }
            data-testid="admin-security-events-count"
          />
        </>
      )}

      <h3 style={{ fontSize: 13, fontWeight: 700, margin: "20px 0 8px" }}>
        File security scans
      </h3>
      <DataTable
        columns={scanColumns}
        rows={scans}
        getRowId={(r) => r.id}
        loading={scansBusy}
        ariaLabel="Workspace file security scans"
        emptyState={
          /* DO NOT BLAME A FILTER THAT IS NOT APPLIED. This said "No file
             security scans match the current filter" with the filter on "All
             scan results", sending the reader to clear a filter that was
             already clear — while the actual reason was two terms up the
             strip. */
          <EmptyState
            variant="inline"
            title="No scans recorded"
            purpose={
              scanStatus !== "all"
                ? "No file security scan in this window has that result. Clear the scan-result filter to see the rest."
                : summary.malwareScanningEnabled
                  ? `No file in this workspace has been scanned in the last ${summary.sinceDays} days.`
                  : "Malware scanning is not enabled for this workspace, so no file scan has been recorded."
            }
          />
        }
      />
      {/* A single bounded read: the wording admits the cap rather than
          presenting fifty rows as the workspace's scan history. */}
      <ResultCount
        shown={scans.length}
        cap={SCANS_CAP}
        noun="scan"
        filtered={scanStatus !== "all"}
        loading={scansBusy}
        data-testid="admin-security-scans-count"
      />
    </PageSection>
  );
}

export default WorkspaceSecurityPostureSection;
