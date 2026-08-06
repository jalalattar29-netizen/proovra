"use client";

/**
 * PHASE 12B — Workspace security posture: the product surface for
 *
 *   GET /v1/security/summary?teamId&sinceDays
 *   GET /v1/security/scans?teamId&status&limit
 *   GET /v1/security/events?teamId&severity&eventType&limit
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
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { useTeamId, useTenantGuard } from "../../../../../lib/platform-context";
import { Badge, type BadgeTone } from "../../../../../components/ui/Badge";
import { Button } from "../../../../../components/ui/Button";
import { Card } from "../../../../../components/ui/Card";
import { DataTable, type DataTableColumn } from "../../../../../components/ui/DataTable";
import { EmptyState } from "../../../../../components/ui/EmptyState";
import { FilterBar } from "../../../../../components/ui/FilterBar";
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

type Posture = {
  summary: SummaryEnvelope;
  scans: ScanRow[];
  events: EventRow[];
};

const SEVERITY_OPTIONS = [
  { value: "all", label: "All severities" },
  { value: "CRITICAL", label: "Critical" },
  { value: "HIGH", label: "High" },
  { value: "WARNING", label: "Warning" },
  { value: "INFO", label: "Info" },
];

function severityTone(severity: string): BadgeTone {
  const v = severity.toUpperCase();
  if (v === "CRITICAL" || v === "HIGH") return "risk";
  if (v === "WARNING") return "pending";
  return "info";
}

function scanTone(status: string): BadgeTone {
  const v = status.toUpperCase();
  if (v === "INFECTED" || v === "FAILED") return "risk";
  if (v === "PENDING" || v === "RUNNING") return "pending";
  if (v === "CLEAN") return "verified";
  return "neutral";
}

function when(value: string | null): string {
  if (!value) return "—";
  return formatUserDateTime(value);
}

function CountTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: BadgeTone;
}) {
  return (
    <Card padding="compact" style={{ minWidth: 0 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--ink-muted, #64748b)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 8,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span style={{ fontSize: 24, fontWeight: 750 }}>
          {new Intl.NumberFormat().format(value)}
        </span>
        <Badge tone={tone} dot>
          {label}
        </Badge>
      </div>
    </Card>
  );
}

export function WorkspaceSecurityPostureSection() {
  const teamId = useTeamId();
  const { stamp, isStale } = useTenantGuard();
  const [state, setState] = useState<SectionState<Posture>>({ kind: "loading" });
  const [severity, setSeverity] = useState("all");
  const [scanStatus, setScanStatus] = useState("all");

  const load = useCallback(async () => {
    if (!teamId) return;
    setState({ kind: "loading" });
    const captured = stamp();
    try {
      const summaryQs = new URLSearchParams({ teamId, sinceDays: "30" });
      const scanQs = new URLSearchParams({ teamId, limit: "50" });
      if (scanStatus !== "all") scanQs.set("status", scanStatus);
      const eventQs = new URLSearchParams({ teamId, limit: "100" });
      if (severity !== "all") eventQs.set("severity", severity);

      const [summary, scans, events] = await Promise.all([
        apiFetch(`/v1/security/summary?${summaryQs.toString()}`, { method: "GET" }),
        apiFetch(`/v1/security/scans?${scanQs.toString()}`, { method: "GET" }),
        apiFetch(`/v1/security/events?${eventQs.toString()}`, { method: "GET" }),
      ]);
      if (isStale(captured)) return;
      setState({
        kind: "ready",
        data: {
          summary: summary as SummaryEnvelope,
          scans: ((scans as { scans?: ScanRow[] })?.scans ?? []) as ScanRow[],
          events: ((events as { events?: EventRow[] })?.events ?? []) as EventRow[],
        },
      });
    } catch (err) {
      if (isStale(captured)) return;
      setState(
        classifyError<Posture>(
          err,
          "We couldn't load this workspace's security posture.",
        ),
      );
    }
  }, [teamId, severity, scanStatus, stamp, isStale]);

  useEffect(() => {
    void load();
  }, [load]);

  const description =
    "Malware-scan and security-event posture for the workspace you are currently in. Counts, statuses and event details are read live from the backend aggregate; nothing on this panel is estimated and no scanner internals, payloads or raw IP addresses are shown.";

  if (!teamId) {
    return (
      <PageSection title="Workspace security posture" description={description}>
        <NoWorkspaceSelected purpose="Switch to a workspace to read its scan and security-event posture." />
      </PageSection>
    );
  }

  if (state.kind === "loading") {
    return (
      <PageSection title="Workspace security posture" description={description}>
        <SectionLoading label="Reading the workspace security aggregate…" />
      </PageSection>
    );
  }

  if (state.kind === "denied") {
    return (
      <PageSection title="Workspace security posture" description={description}>
        <SectionDenied message={state.message} />
      </PageSection>
    );
  }

  if (state.kind === "error") {
    return (
      <PageSection title="Workspace security posture" description={description}>
        <SectionError message={state.message} onRetry={() => void load()} />
      </PageSection>
    );
  }

  const { summary, scans, events } = state.data;

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
      render: (r) => <span style={sectionMuted}>{when(r.createdAt)}</span>,
    },
  ];

  const scanTiles = Object.entries(summary.scanCounts ?? {});
  const eventTiles = Object.entries(summary.eventCounts ?? {});

  return (
    <PageSection
      title="Workspace security posture"
      description={description}
      data-workspace-security-posture
      action={
        <Button variant="secondary" onClick={() => void load()}>
          Refresh
        </Button>
      }
    >
      <Card padding="compact" style={{ marginBottom: 14 }}>
        <p style={{ margin: 0, fontSize: 13 }}>
          Malware scanning is{" "}
          <strong>{summary.malwareScanningEnabled ? "enabled" : "not enabled"}</strong>{" "}
          for this deployment. Counts cover the last {summary.sinceDays} days.
        </p>
      </Card>

      {scanTiles.length > 0 || eventTiles.length > 0 ? (
        <div
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
            marginBottom: 16,
          }}
        >
          {scanTiles.map(([key, value]) => (
            <CountTile
              key={`scan-${key}`}
              label={`Scans ${key.toLowerCase()}`}
              value={value}
              tone={scanTone(key)}
            />
          ))}
          {eventTiles.map(([key, value]) => (
            <CountTile
              key={`event-${key}`}
              label={`Events ${key.toLowerCase()}`}
              value={value}
              tone={severityTone(key)}
            />
          ))}
        </div>
      ) : null}

      <FilterBar
        actions={
          <Button variant="secondary" onClick={() => void load()}>
            Apply
          </Button>
        }
        style={{ marginBottom: 12 }}
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
          options={[
            { value: "all", label: "All scan results" },
            { value: "PENDING", label: "Pending" },
            { value: "CLEAN", label: "Clean" },
            { value: "INFECTED", label: "Infected" },
            { value: "FAILED", label: "Failed" },
            { value: "SKIPPED", label: "Skipped" },
          ]}
        />
      </FilterBar>

      <h3 style={{ fontSize: 13, fontWeight: 700, margin: "0 0 8px" }}>
        Security events
      </h3>
      <DataTable
        columns={eventColumns}
        rows={events}
        getRowId={(r) => r.id}
        ariaLabel="Workspace security events"
        emptyState={
          <EmptyState
            title="No security events in this window"
            purpose="No security events were recorded for this workspace under the current filters. This is a real empty result from the server, not a permission problem."
          />
        }
      />

      <h3 style={{ fontSize: 13, fontWeight: 700, margin: "20px 0 8px" }}>
        File security scans
      </h3>
      <DataTable
        columns={scanColumns}
        rows={scans}
        getRowId={(r) => r.id}
        ariaLabel="Workspace file security scans"
        emptyState={
          <EmptyState
            title="No scans recorded"
            purpose="No file security scans match the current filter for this workspace."
          />
        }
      />
    </PageSection>
  );
}

export default WorkspaceSecurityPostureSection;
