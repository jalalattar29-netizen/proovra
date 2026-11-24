/**
 * TEAM-SPEC §2 items 7–8 / §3 — display rules shared by the Monitoring pages
 * (`/reviewer-ops/sla`, `/reviewer-ops/escalations`). Kept out of the page
 * modules (a Next.js page may only export its page) and pure, so they are
 * unit-testable.
 */

import { REVIEW_ESCALATED_STATUS_LABEL, identifierLabel } from "@proovra/shared";

/** Definition shown wherever an "open escalation" count appears. */
export const OPEN_ESCALATION_DEFINITION =
  "An open escalation is one that is open, acknowledged or reassigned — not yet resolved or suppressed. The Escalations page lists them under Active.";

/**
 * Human label for a by-stage row. T-057 (stage C, COR-B): the stored ESCALATED
 * status comes from an escalation, a first/second conflict or an unresolved
 * adjudication — never "manual decision" — and is not the same as an active
 * escalation record.
 */
export function stageRowLabel(stage: string): string {
  if (stage.toUpperCase() === "ESCALATED") return REVIEW_ESCALATED_STATUS_LABEL;
  return identifierLabel(stage);
}

/** Finished outcome stages (reported apart from open work, T-057). */
const FINISHED_STAGES = new Set(["APPROVED_INTERNAL", "REJECTED_INSUFFICIENT", "CLOSED"]);

/**
 * T-057 (stage C) — the by-stage rows split into open work and finished
 * outcomes. Uses the server's split when present, else derives it.
 */
export function splitStageCounts(counts: {
  byStage: Record<string, number>;
  openByStage?: Record<string, number>;
  closedByStage?: Record<string, number>;
}): { open: Array<[string, number]>; closed: Array<[string, number]> } {
  if (counts.openByStage && counts.closedByStage) {
    return { open: Object.entries(counts.openByStage), closed: Object.entries(counts.closedByStage) };
  }
  const entries = Object.entries(counts.byStage).filter(([, n]) => n > 0);
  return {
    open: entries.filter(([stage]) => !FINISHED_STAGES.has(stage.toUpperCase())),
    closed: entries.filter(([stage]) => FINISHED_STAGES.has(stage.toUpperCase())),
  };
}

/** Hours from milliseconds; null (nothing qualified) reads "No data", never 0 h. */
export function hoursOrNoData(ms: number | null | undefined): string | number {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "No data";
  return Math.round(ms / 3_600_000);
}

/** SLA compliance; null means no review completed in the range (never 100% or 0%). */
export function complianceLabel(rate: number | null | undefined): string {
  if (typeof rate !== "number" || !Number.isFinite(rate)) return "No completed reviews in range";
  return `${Math.round(rate * 100)}%`;
}

export type EscalationStatusFilter =
  | "ACTIVE"
  | "OPEN"
  | "ACKNOWLEDGED"
  | "REASSIGNED"
  | "RESOLVED"
  | "SUPPRESSED"
  | "ALL";

/** Status filter options, in the order a person scans them, with human labels. */
export const ESCALATION_STATUS_FILTERS: ReadonlyArray<{
  value: EscalationStatusFilter;
  label: string;
}> = [
  // Short so the filter fits a 320px phone; the page states the definition.
  { value: "ACTIVE", label: "Active" },
  { value: "OPEN", label: "Open" },
  { value: "ACKNOWLEDGED", label: "Acknowledged" },
  { value: "REASSIGNED", label: "Reassigned" },
  { value: "RESOLVED", label: "Resolved" },
  { value: "SUPPRESSED", label: "Suppressed" },
  { value: "ALL", label: "All" },
];
