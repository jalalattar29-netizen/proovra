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
import Link from "next/link";

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
import { resolveRunbookSlug } from "../../../../lib/runbooks/slugs.generated";

type Measured = number | null;

/**
 * ADM-013 — the cohort projection.
 *
 * The metric cards further down answer "which records carry this failure".
 * They cannot answer "how many records need attention", because a record whose
 * timestamp failed AND which has no report appears under two of them and is
 * ONE record. Reading "TSA failures 34" and "Signed without report 16" as 50
 * is the arithmetic this section exists to replace.
 */
interface CohortCount {
  cohort: string;
  label: string;
  description: string;
  /** `null` means the count could not be read. Never rendered as 0. */
  count: number | null;
  retryable: boolean;
  reason: string | null;
  operatorAction: string;
  runbookSlug: string | null;
  drillDown: string;
}

interface CohortProjection {
  generatedAtUtc: string;
  cohorts: CohortCount[];
  arithmetic: {
    disjointSum: number | null;
    measuredUnion: number | null;
    agrees: boolean | null;
  };
  unavailableCohorts: string[];
}

/**
 * The three disjoint parts, then the union, then the two action cuts. Rendering
 * them in this order is what makes the overlap legible: a reader sees 3 + 4 + 2
 * and then sees 9, rather than seeing two totals and adding them.
 */
const COHORT_ORDER = [
  "TSA_FAILED_ONLY",
  "SIGNED_NO_REPORT_ONLY",
  "BOTH",
  "ALL_AFFECTED",
  "RETRYABLE",
  "MANUAL_REVIEW",
] as const;

/** The union and the two action cuts overlap the three parts by construction. */
const OVERLAPPING = new Set(["ALL_AFFECTED", "RETRYABLE", "MANUAL_REVIEW"]);

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
            color: "var(--ink-muted)",
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
            ? "var(--ink-muted)"
            : "var(--ink-primary)",
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
            color: "var(--ink-secondary)",
          }}
        >
          {note}
        </div>
      ) : null}
    </Card>
  );
}

/**
 * One cohort. Shows the count, whether an operator can act, what the action is,
 * and a link to exactly the records counted.
 *
 * A tile whose count is `null` says "Not measured" and offers no drill-down —
 * a link promising records we could not count is a link that lands on an empty
 * table and reads as "nothing wrong".
 */
function CohortCard({ c }: { c: CohortCount }) {
  const unmeasured = c.count == null;
  const overlapping = OVERLAPPING.has(c.cohort);
  return (
    <Card
      variant="summary"
      padding="comfortable"
      data-cohort={c.cohort}
      data-count={c.count == null ? "unmeasured" : String(c.count)}
      data-retryable={String(c.retryable)}
    >
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
            color: "var(--ink-muted)",
          }}
        >
          {c.label}
        </div>
        {/* The disposition, not the severity. "Retryable" is the fact an
            operator needs before they look for a button. */}
        <Badge tone={c.retryable ? "info" : "neutral"} subtle>
          {c.retryable ? "Retryable" : "Manual"}
        </Badge>
      </div>

      <div
        style={{
          marginTop: 12,
          fontSize: unmeasured ? 15 : 30,
          fontWeight: unmeasured ? 600 : 750,
          lineHeight: 1.1,
          letterSpacing: "-0.02em",
          color: unmeasured
            ? "var(--ink-muted)"
            : "var(--ink-primary)",
        }}
      >
        {unmeasured ? "Not measured" : String(c.count)}
      </div>

      {overlapping ? (
        <div
          style={{
            marginTop: 6,
            fontSize: 11.5,
            fontWeight: 600,
            color: "var(--ink-muted)",
          }}
        >
          Overlaps the three cohorts above — do not add to them.
        </div>
      ) : null}

      <div
        style={{
          marginTop: 8,
          fontSize: 12.5,
          lineHeight: 1.5,
          color: "var(--ink-secondary)",
        }}
      >
        {c.description}
      </div>

      <div
        style={{
          marginTop: 10,
          paddingTop: 10,
          borderTop: "1px solid var(--border-subtle)",
          fontSize: 12.5,
          lineHeight: 1.5,
          color: "var(--ink-secondary)",
        }}
      >
        <strong style={{ color: "var(--ink-primary)" }}>Action:</strong>{" "}
        {c.operatorAction}
        {/*
          A REFUSAL WITHOUT A REASON IS WHAT AN OPERATOR ESCALATES ABOUT, so
          the reason stays. BEHIND A DISCLOSURE, because of what it is: three
          of the six cohorts return the SAME 80-word paragraph verbatim — "A
          timestamp proves a record existed at a moment. Re-contacting the
          authority now would mint a token whose genTime is later..." — and
          printed in full it made these cards 340px to 730px tall. A CSS grid
          stretches its row to the tallest member, so the short cohorts carried
          ~400px of empty space each and the whole row was 730px.

          Nothing is removed and nothing is summarised: `<details>` is the
          complete text, one click away, keyboard-operable without any
          JavaScript, and the same words are in the Runbook this card already
          links to. What changes is that a count an operator is scanning for is
          no longer buried under an explanation they have read five times.
        */}
        {c.reason ? (
          <details className="adm-why">
            <summary>Why</summary>
            <p>{c.reason}</p>
          </details>
        ) : null}
      </div>

      <div
        style={{
          marginTop: 12,
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          fontSize: 13,
        }}
      >
        {/* admin-hit-link: 44px hit boxes; the card footer keeps its height
            (admin-console.css). */}
        {unmeasured ? null : (
          <Link
            href={c.drillDown}
            data-testid={`cohort-drilldown-${c.cohort}`}
            className="admin-hit-link"
          >
            View {c.count} record{c.count === 1 ? "" : "s"}
          </Link>
        )}
        {c.runbookSlug ? (
          <Link
            href={`/admin/platform/runbooks/${resolveRunbookSlug(c.runbookSlug)}`}
            className="admin-hit-link"
          >
            Runbook
          </Link>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * The signal rows: as many 220px tiles as fit. Right for a row of counters.
 */
const GRID: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 16,
};

/**
 * THE COHORT ROW IS NOT A ROW OF COUNTERS, so it does not get the counter
 * grid.
 *
 * Six cohort cards in `minmax(220px, 1fr)` laid out five across at 1440px,
 * which gave each one about 250px of width for a count, a description and an
 * operator action — so the text wrapped to eight and nine lines and the cards
 * ran 340px to 730px. A CSS grid stretches its row to the tallest member, so
 * every short cohort carried the tallest one's height as empty space.
 *
 * Three columns is 410px each at the console width: the same words in three
 * lines instead of nine. The card is wider and the ROW is less than half as
 * tall, which is the opposite of the trade it looks like.
 */
const COHORT_GRID: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  gap: 16,
  /* Peers, so equal height within a row is correct here — what was wrong was
     the row being 730px, not the cards matching. */
  alignItems: "stretch",
};

export default function AdminEvidenceOpsPage() {
  const [snapshot, setSnapshot] = useState<EvidenceHealthSnapshot | null>(null);
  const [cohorts, setCohorts] = useState<CohortProjection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch("/v1/admin/evidence-health", {
        method: "GET",
      });
      setSnapshot((data?.snapshot ?? null) as EvidenceHealthSnapshot | null);
      setCohorts((data?.cohorts ?? null) as CohortProjection | null);
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
          <div style={{ fontWeight: 650, color: "var(--ink-primary)" }}>
            Could not load the pipeline snapshot
          </div>
          <div
            style={{
              marginTop: 6,
              fontSize: 13.5,
              color: "var(--ink-secondary)",
            }}
          >
            {error}
          </div>
        </Card>
      ) : null}

      {loading && !snapshot ? (
        <EmptyState variant="inline"
          framed
          title="Loading pipeline health…"
          purpose="Reading platform-wide upload, evidence, report, package, and preservation counts."
        />
      ) : !snapshot ? (
        <EmptyState variant="inline"
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
          {/* ADM-013 — FIRST, because it is the only section that answers
              "how many records need attention". Everything below it counts
              failures; this counts records, once each. */}
          {cohorts ? (
            <PageSection
              title="Records needing attention"
              description="Records, counted once each. A record can carry more than one failure, so the three cohorts below are disjoint and the totals after them are measured unions — never sums."
            >
              <div style={COHORT_GRID}>
                {COHORT_ORDER.map((key) => {
                  const c = cohorts.cohorts.find((x) => x.cohort === key);
                  return c ? <CohortCard key={key} c={c} /> : null;
                })}
              </div>

              {/* The self-check, shown rather than assumed. If the three
                  disjoint parts stop summing to the measured union, one
                  predicate changed and the other did not, and the page says so
                  instead of rendering a total nobody can reconcile. */}
              <div
                style={{
                  marginTop: 16,
                  fontSize: 12.5,
                  lineHeight: 1.6,
                  color:
                    cohorts.arithmetic.agrees === false
                      ? "var(--danger-standard)"
                      : "var(--ink-muted)",
                }}
                data-arithmetic-agrees={String(cohorts.arithmetic.agrees)}
              >
                {cohorts.arithmetic.agrees === true ? (
                  <>
                    Checked: {cohorts.arithmetic.disjointSum} disjoint records
                    equals the measured union of{" "}
                    {cohorts.arithmetic.measuredUnion}.
                  </>
                ) : cohorts.arithmetic.agrees === false ? (
                  <>
                    <strong>These counts do not reconcile.</strong> The three
                    disjoint cohorts total{" "}
                    {cohorts.arithmetic.disjointSum} but the measured union is{" "}
                    {cohorts.arithmetic.measuredUnion}. Treat both as
                    unreliable and report this.
                  </>
                ) : (
                  <>
                    The reconciliation check could not run — at least one cohort
                    count is unavailable.
                  </>
                )}
                {cohorts.unavailableCohorts.length > 0 ? (
                  <>
                    {" "}
                    Unavailable: {cohorts.unavailableCohorts.join(", ")}. A
                    missing count is shown as &ldquo;Not measured&rdquo;, never
                    as zero.
                  </>
                ) : null}
              </div>
            </PageSection>
          ) : null}

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
                    color: "var(--ink-secondary)",
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
              color: "var(--ink-muted)",
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
