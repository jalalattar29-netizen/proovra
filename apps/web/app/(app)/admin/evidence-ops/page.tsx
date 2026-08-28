"use client";

/**
 * Platform Control Center P1 — Evidence Pipeline Health console.
 *
 * READ-ONLY operator surface at /admin/evidence-ops. Inherits the
 * `platform.admin` gate from admin/layout.tsx. Renders the platform-wide
 * evidence pipeline snapshot from GET /v1/admin/evidence-health.
 *
 * Honesty contract mirrored from the backend:
 *   - A metric value of `null` means the signal is genuinely absent
 *     ("Not measured" / "Not connected") — rendered as such, NEVER as a
 *     fabricated healthy 0.
 *   - A badge is "degraded" (risk tone) ONLY when a real value > 0.
 *     `null` → neutral "Not measured". A real 0 → verified "Clear".
 *   - No evidence contents are shown; counts only.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import { formatUserDateTime } from "../../../../lib/date";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import {
  PageShell,
  PageHeader,
  PageSection,
} from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import { Badge } from "../../../../components/ui/Badge";
import { Button } from "../../../../components/ui/Button";
import { EmptyState } from "../../../../components/ui/EmptyState";

type Measured = number | null;

interface EvidenceHealthSnapshot {
  generatedAtUtc: string;
  windowHours: number;
  uploads: { inProgress: Measured; stalled: Measured; failed: Measured };
  evidence: {
    created: Measured;
    createdInWindow: Measured;
    signed: Measured;
    withoutReport: Measured;
    hashMismatch: Measured;
  };
  reports: { failedGeneration: Measured; queued: Measured };
  packages: {
    verificationBacklog: Measured;
    failed: Measured;
    queued: Measured;
  };
  preservation: { tsaFailures: Measured; otsAnchoringFailures: Measured };
  incidents: {
    openReport: Measured;
    openPackage: Measured;
    openStorage: Measured;
    openUpload: Measured;
  };
  workerQueues: {
    totalFailed: Measured;
    totalStalled: Measured;
    degradedCount: Measured;
    queueCount: Measured;
    detailHref: string;
  };
}

/** How a metric card reads its value: higher = worse, or informational. */
type Sense = "problem" | "info";

function formatValue(value: Measured): string {
  return value == null ? "Not measured" : String(value);
}

/**
 * Honest tone selection.
 *   null            → neutral "Not measured" (signal absent)
 *   info metric     → info tone (informational count, never "bad")
 *   problem, 0      → verified "Clear"
 *   problem, > 0    → risk "Attention"
 */
function toneFor(value: Measured, sense: Sense): {
  tone: "neutral" | "info" | "verified" | "risk";
  label: string;
} {
  if (value == null) return { tone: "neutral", label: "Not measured" };
  if (sense === "info") return { tone: "info", label: "Measured" };
  if (value > 0) return { tone: "risk", label: "Attention" };
  return { tone: "verified", label: "Clear" };
}

function MetricCard({
  label,
  value,
  sense,
  note,
}: {
  label: string;
  value: Measured;
  sense: Sense;
  note?: string;
}) {
  const { tone, label: badgeLabel } = toneFor(value, sense);
  const measuredMissing = value == null;
  return (
    <Card variant="summary" padding="comfortable">
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "var(--ink-muted, #94a3b8)",
          }}
        >
          {label}
        </div>
        <Badge tone={tone} subtle>
          {badgeLabel}
        </Badge>
      </div>
      <div
        style={{
          marginTop: 12,
          fontSize: measuredMissing ? 15 : 30,
          fontWeight: measuredMissing ? 600 : 750,
          lineHeight: 1.1,
          letterSpacing: "-0.02em",
          color: measuredMissing
            ? "var(--ink-muted, #94a3b8)"
            : "var(--ink-primary, #0f172a)",
        }}
      >
        {formatValue(value)}
      </div>
      {note ? (
        <div
          style={{
            marginTop: 8,
            fontSize: 12.5,
            lineHeight: 1.5,
            color: "var(--ink-secondary, #475569)",
          }}
        >
          {note}
        </div>
      ) : null}
    </Card>
  );
}

const GRID: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 16,
};

export default function AdminEvidenceOpsPage() {
  const [snapshot, setSnapshot] = useState<EvidenceHealthSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch("/v1/admin/evidence-health", {
        method: "GET",
      });
      setSnapshot((data?.snapshot ?? null) as EvidenceHealthSnapshot | null);
      setError(null);
    } catch (err) {
      setError(
        toSafeUserError(err, {
          message: "Failed to load evidence pipeline health.",
        }).message,
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const wq = snapshot?.workerQueues ?? null;
  const queueDegraded =
    wq != null &&
    ((wq.totalFailed != null && wq.totalFailed > 0) ||
      (wq.totalStalled != null && wq.totalStalled > 0) ||
      (wq.degradedCount != null && wq.degradedCount > 0));

  return (
    <PageShell
      header={
        <PageHeader
          eyebrow="Platform control center"
          title="Evidence Operations"
          subtitle="Platform-wide, read-only health of the evidence pipeline — uploads, signing, reports, verification packages, and cryptographic timestamping. Every metric is a real count or an honest 'Not measured'. This console never touches evidence contents."
          primaryAction={
            <Button variant="secondary" onClick={() => void load()}>
              Refresh
            </Button>
          }
        />
      }
    >

      {error ? (
        <Card variant="status" tone="risk" padding="comfortable">
          <div style={{ fontWeight: 650, color: "var(--ink-primary, #0f172a)" }}>
            Could not load the pipeline snapshot
          </div>
          <div
            style={{
              marginTop: 6,
              fontSize: 13.5,
              color: "var(--ink-secondary, #475569)",
            }}
          >
            {error}
          </div>
        </Card>
      ) : null}

      {loading && !snapshot ? (
        <EmptyState
          framed
          title="Loading pipeline health…"
          purpose="Reading platform-wide upload, evidence, report, package, and preservation counts."
        />
      ) : !snapshot ? (
        <EmptyState
          framed
          title="No pipeline snapshot available"
          purpose="The evidence-health endpoint returned no data. Try refreshing, or check that the API and workers are reachable."
          action={
            <Button variant="primary" onClick={() => void load()}>
              Retry
            </Button>
          }
        />
      ) : (
        <>
          <PageSection
            title="Uploads"
            description="In-flight and failed upload sessions across the platform."
          >
            <div style={GRID}>
              <MetricCard
                label="Uploads in progress"
                value={snapshot.uploads.inProgress}
                sense="info"
                note="Sessions currently UPLOADING or PARTIAL."
              />
              <MetricCard
                label="Stalled uploads"
                value={snapshot.uploads.stalled}
                sense="problem"
                note="Sessions in the STALLED state."
              />
              <MetricCard
                label="Failed uploads"
                value={snapshot.uploads.failed}
                sense="problem"
                note="Sessions in the FAILED state."
              />
            </div>
          </PageSection>

          <PageSection
            title="Evidence"
            description={`Created, signed, and gaps. Windowed count covers the last ${snapshot.windowHours}h.`}
          >
            <div style={GRID}>
              <MetricCard
                label="Evidence created"
                value={snapshot.evidence.created}
                sense="info"
                note="All live evidence records."
              />
              <MetricCard
                label={`Created (last ${snapshot.windowHours}h)`}
                value={snapshot.evidence.createdInWindow}
                sense="info"
                note="New live evidence in the window."
              />
              <MetricCard
                label="Signed evidence"
                value={snapshot.evidence.signed}
                sense="info"
                note="Live evidence in the SIGNED state."
              />
              <MetricCard
                label="Signed without report"
                value={snapshot.evidence.withoutReport}
                sense="problem"
                note="SIGNED evidence with no report generated yet."
              />
              <MetricCard
                label="Hash-mismatch"
                value={snapshot.evidence.hashMismatch}
                sense="problem"
                note="Evidence in the FAILED_HASH_MISMATCH terminal state."
              />
            </div>
          </PageSection>

          <PageSection
            title="Reports & packages"
            description="Report generation, verification-package backlog, and queued work."
          >
            <div style={GRID}>
              <MetricCard
                label="Failed report generation"
                value={snapshot.reports.failedGeneration}
                sense="problem"
                note="Failed report jobs + report DLQ backlog."
              />
              <MetricCard
                label="Reports queued"
                value={snapshot.reports.queued}
                sense="info"
                note="Report work waiting, active, or delayed."
              />
              <MetricCard
                label="Verification-package backlog"
                value={snapshot.packages.verificationBacklog}
                sense="problem"
                note="REPORTED evidence still missing a package."
              />
              <MetricCard
                label="Packages queued"
                value={snapshot.packages.queued}
                sense="info"
                note="Package work on the report queue."
              />
              <MetricCard
                label="Failed packages"
                value={snapshot.packages.failed}
                sense="problem"
                note="No independent package-queue signal in this build."
              />
            </div>
          </PageSection>

          <PageSection
            title="Cryptographic timestamping"
            description="RFC-3161 TSA and OpenTimestamps anchoring failures, from evidence status."
          >
            <div style={GRID}>
              <MetricCard
                label="TSA failures"
                value={snapshot.preservation.tsaFailures}
                sense="problem"
                note="Evidence with tsaStatus = FAILED."
              />
              <MetricCard
                label="OTS anchoring failures"
                value={snapshot.preservation.otsAnchoringFailures}
                sense="problem"
                note="Evidence with otsStatus = FAILED."
              />
            </div>
          </PageSection>

          <PageSection
            title="Open incidents"
            description="Open or acknowledged operational incidents by evidence-relevant category."
          >
            <div style={GRID}>
              <MetricCard
                label="Report incidents"
                value={snapshot.incidents.openReport}
                sense="problem"
              />
              <MetricCard
                label="Package incidents"
                value={snapshot.incidents.openPackage}
                sense="problem"
              />
              <MetricCard
                label="Storage incidents"
                value={snapshot.incidents.openStorage}
                sense="problem"
              />
              <MetricCard
                label="Upload incidents"
                value={snapshot.incidents.openUpload}
                sense="problem"
              />
            </div>
          </PageSection>

          <PageSection
            title="Worker queue health"
            description="Rollup across all known queues. Open the queue console for per-queue detail and replay controls."
            action={
              wq ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    window.location.href = wq.detailHref;
                  }}
                >
                  Open queue console
                </Button>
              ) : undefined
            }
          >
            <Card
              variant="status"
              tone={
                wq == null ? "neutral" : queueDegraded ? "risk" : "verified"
              }
              padding="comfortable"
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  flexWrap: "wrap",
                }}
              >
                <Badge
                  tone={
                    wq == null ? "neutral" : queueDegraded ? "risk" : "verified"
                  }
                  dot
                >
                  {wq == null
                    ? "Not connected"
                    : queueDegraded
                      ? "Degraded"
                      : "Healthy"}
                </Badge>
                <span
                  style={{
                    fontSize: 13,
                    color: "var(--ink-secondary, #475569)",
                  }}
                >
                  {wq == null
                    ? "Queue inventory is unreachable (worker/Redis not connected)."
                    : `${formatValue(wq.queueCount)} queues monitored.`}
                </span>
              </div>
              <div style={{ ...GRID, marginTop: 16 }}>
                <MetricCard
                  label="Total failed jobs"
                  value={wq?.totalFailed ?? null}
                  sense="problem"
                />
                <MetricCard
                  label="Total stalled jobs"
                  value={wq?.totalStalled ?? null}
                  sense="problem"
                />
                <MetricCard
                  label="Degraded queues"
                  value={wq?.degradedCount ?? null}
                  sense="problem"
                />
              </div>
            </Card>
          </PageSection>

          <div
            style={{
              fontSize: 12,
              color: "var(--ink-muted, #94a3b8)",
            }}
          >
            Snapshot generated{" "}
            {formatUserDateTime(snapshot.generatedAtUtc)} · read-only ·
            counts only, no evidence contents.
          </div>
        </>
      )}
    </PageShell>
  );
}
