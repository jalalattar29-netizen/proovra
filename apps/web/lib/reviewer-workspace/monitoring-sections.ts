/**
 * Stage D (team remediation, T-078) — THE MONITORING AREA.
 *
 * One Monitoring page (`/reviewer-ops/sla`) with in-page sections instead of a
 * second tab row and separate tool pages:
 *
 *   deadlines    deadline pressure, open reviews by stage, reminders
 *   escalations  the escalation console          (was /reviewer-ops/escalations)
 *   workload     reviewer workload, assignment suggestions, review stages,
 *                routing recommendations, reviewer performance
 *   quality      human QC samples first, Copilot output checks apart
 *                                                 (was /review/qc, and the AI QC
 *                                                 panel on the personal Inbox)
 *   metrics      reviewer metrics and escalation analytics
 *                                                 (was /review/metrics)
 *
 * Each section is offered only where the route it came from opens for the
 * actor (the registry ids below), so Team keeps QC and metrics (COR-N) and a
 * Member is never offered the metrics section their role cannot read.
 */

export const MONITORING_SECTIONS = ["deadlines", "escalations", "workload", "quality", "metrics"] as const;
export type MonitoringSection = (typeof MONITORING_SECTIONS)[number];

export const MONITORING_SECTION_LABELS: Readonly<Record<MonitoringSection, string>> = {
  deadlines: "Deadlines",
  escalations: "Escalations",
  workload: "Workload",
  quality: "Quality",
  metrics: "Metrics",
};

/** The registry route whose gate decides whether a section is offered. */
export const MONITORING_SECTION_ROUTE: Readonly<Record<MonitoringSection, string>> = {
  deadlines: "review.sla",
  escalations: "review.escalations",
  workload: "review.sla",
  quality: "workspace.review_qc",
  metrics: "workspace.review_metrics",
};

export function isMonitoringSection(value: string | null | undefined): value is MonitoringSection {
  return typeof value === "string" && (MONITORING_SECTIONS as ReadonlyArray<string>).includes(value);
}

export function monitoringHref(section: MonitoringSection, extra?: Record<string, string>): string {
  const q = new URLSearchParams();
  if (section !== "deadlines") q.set("section", section);
  for (const [k, v] of Object.entries(extra ?? {})) q.set(k, v);
  const qs = q.toString();
  return qs ? `/reviewer-ops/sla?${qs}` : "/reviewer-ops/sla";
}
