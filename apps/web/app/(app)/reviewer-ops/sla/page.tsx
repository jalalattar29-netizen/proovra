"use client";

/**
 * MONITORING — the one Monitoring area of the Review hub (stage D, T-078).
 *
 * Deadlines, escalations, workload, quality and metrics are sections of this
 * one page, chosen by `?section=` with an in-page segmented control — not a
 * second tab row under the hub and not separate tool pages. The old pages
 * redirect here: `/reviewer-ops/escalations` (keeping `?escalationId=`),
 * `/review/qc` and `/review/metrics`.
 *
 *   - A section is offered only where the route it came from opens for this
 *     actor (`MONITORING_SECTION_ROUTE`, the same resolver as the hub tabs):
 *     Team keeps QC and metrics (COR-N); a Member is never offered Metrics.
 *   - Each section loads its own data when it is shown (T-095).
 *   - Quality lists human QC samples first; Copilot output checks are a
 *     separate block that lists only runs with output (T-080).
 *
 * Gate: `review.sla` — PERSONAL_OR_ORG + reviewer operations (TEAM-SPEC R1).
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { PageShell } from "../../../../components/ui/PageShell";
import { ReviewPageHeader } from "../../../../components/reviewer-experience/ReviewPageHeader";
import { ReviewHubNav } from "../../../../components/reviewer-experience/ReviewHubNav";
import { useReviewDestination, useReviewDestinationResolver } from "../../../../components/reviewer-experience/reviewDestination";
import { QcSamplingPanel } from "../../../../components/ai-copilot/QcSamplingPanel";
import { useActiveSpaceId } from "../../../../lib/platform-context";
import { useHealthDestination } from "../../../../lib/navigation/healthDestination";
import {
  MONITORING_SECTIONS,
  MONITORING_SECTION_LABELS,
  MONITORING_SECTION_ROUTE,
  isMonitoringSection,
  monitoringHref,
  type MonitoringSection,
} from "../../../../lib/reviewer-workspace/monitoring-sections";
import "../../../../components/reviewer-experience/review-surfaces.css";
import { DeadlinesSection, EscalationAnalyticsPanel, WorkloadSection } from "./_sections";
import { EscalationsSection } from "../escalations/_section";
import { QcSection } from "../../review/qc/_section";
import { MetricsSection } from "../../review/metrics/_section";

export default function MonitoringPage() {
  return (
    <PageRouteGate routeId="review.sla">
      <MonitoringShell />
    </PageRouteGate>
  );
}

function useOfferedSections(): ReadonlyArray<MonitoringSection> {
  const resolve = useReviewDestinationResolver();
  return MONITORING_SECTIONS.filter((s) => {
    const d = resolve(MONITORING_SECTION_ROUTE[s], { label: MONITORING_SECTION_LABELS[s] });
    return d?.kind === "link";
  });
}

function MonitoringShell() {
  const teamId = useActiveSpaceId();
  const searchParams = useSearchParams();
  const offered = useOfferedSections();
  const requested = searchParams?.get("section") ?? null;
  const section: MonitoringSection =
    isMonitoringSection(requested) && offered.includes(requested) ? requested : offered[0] ?? "deadlines";
  const healthDestination = useHealthDestination();
  const healthLink = healthDestination ? (
    <Link href={healthDestination.href} className="app-ghost-action" data-sla-health-link>
      {healthDestination.label}
    </Link>
  ) : undefined;

  return (
    <PageShell
      width="full"
      className="review-launcher-clearance"
      data-monitoring-page
      data-monitoring-section={section}
      header={
        <ReviewPageHeader
          title="Monitoring"
          subtitle="Deadlines, escalations, workload, quality and metrics for reviews in this workspace."
          secondaryActions={healthLink}
        />
      }
    >
      <ReviewHubNav active="monitoring" />
      {/* The review-automation notice sits in the sections whose figures
          depend on it (Deadlines, Escalations, Workload), never twice. */}

      {offered.length > 1 ? (
        <div className="review-segmented" role="group" aria-label="Monitoring sections" data-monitoring-sections>
          {offered.map((s) => {
            const active = s === section;
            return (
              <Link
                key={s}
                href={monitoringHref(s)}
                className={active ? "review-segmented__item is-active" : "review-segmented__item"}
                aria-current={active ? "true" : undefined}
                data-monitoring-section-link={s}
                scroll={false}
              >
                {MONITORING_SECTION_LABELS[s]}
              </Link>
            );
          })}
        </div>
      ) : null}

      {!teamId ? (
        <p className="app-field-help" data-sla-loading>
          Loading workspace…
        </p>
      ) : section === "deadlines" ? (
        <DeadlinesSection teamId={teamId} />
      ) : section === "escalations" ? (
        <EscalationsSection />
      ) : section === "workload" ? (
        <WorkloadSection teamId={teamId} />
      ) : section === "quality" ? (
        <QualitySection />
      ) : (
        <div className="review-monitoring-section">
          <MetricsSection />
          <EscalationAnalyticsPanel teamId={teamId} />
        </div>
      )}
    </PageShell>
  );
}

/**
 * Monitoring → Quality (T-080): human QC samples first; "Copilot output
 * checks" (sampled Reviewer / Case Copilot runs that produced output) are a
 * separate block below, never mixed into the reviewer's Inbox.
 */
function QualitySection() {
  const challenged = useReviewDestination("workspace.review_disagreements", { label: "Challenged decisions" });
  return (
    <div className="review-monitoring-section" data-monitoring-quality>
      <QcSection />
      <section className="app-panel" aria-labelledby="copilot-output-checks-title" data-copilot-output-checks>
        <div className="app-panel__head">
          <h2 id="copilot-output-checks-title" className="app-panel__title">
            Copilot output checks
          </h2>
        </div>
        <div className="app-panel__body">
          <p className="app-field-help" style={{ marginTop: 0 }}>
            A human check of sampled Copilot runs that produced output. Separate from the QC samples of reviews above.
          </p>
          <QcSamplingPanel />
        </div>
      </section>
      {challenged?.kind === "link" ? (
        <p className="app-field-help" data-monitoring-challenged-link>
          Decisions a reviewer formally challenged are listed under{" "}
          <Link href={challenged.href} className="app-ghost-action">
            Challenged decisions
          </Link>
          .
        </p>
      ) : null}
    </div>
  );
}
