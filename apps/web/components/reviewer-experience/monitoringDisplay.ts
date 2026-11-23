/**
 * TEAM-SPEC §2 items 7–8 / §3 — display rules shared by the Monitoring pages
 * (`/reviewer-ops/sla`, `/reviewer-ops/escalations`). Kept out of the page
 * modules (a Next.js page may only export its page) and pure, so they are
 * unit-testable.
 */

import { identifierLabel } from "@proovra/shared";

/** Definition shown wherever an "open escalation" count appears. */
export const OPEN_ESCALATION_DEFINITION =
  "An open escalation is one that is open, acknowledged or reassigned — not yet resolved or suppressed. The Escalations page lists them under Active.";

/**
 * Human label for a by-stage row. The stored ESCALATED stage is a manual
 * escalation decision, which is NOT the same as an open escalation record.
 */
export function stageRowLabel(stage: string): string {
  if (stage.toUpperCase() === "ESCALATED") return "Escalated (manual decision)";
  return identifierLabel(stage);
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
