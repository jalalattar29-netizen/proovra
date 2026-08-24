import { getEvidenceScope } from "./evidence-library-status";
import type {
  DetailWorkspaceState,
  EvidenceListItem,
  ReviewAlert,
} from "./evidence-library-types";
import { buildReportAvailability, buildVerificationPackageAvailability } from "./evidence-library-helpers";

export function buildReviewAlerts(
  item: EvidenceListItem,
  detail?: DetailWorkspaceState | null
): ReviewAlert[] {
  const alerts: ReviewAlert[] = [];
  const intelligence = detail?.evidence?.evidenceIntelligence ?? null;
  const report = buildReportAvailability(item, detail);
  const verificationPackage = buildVerificationPackageAvailability(detail);
  const verificationStatus = String(
    detail?.evidence?.verificationStatus ?? item.verificationStatus ?? ""
  )
    .trim()
    .toUpperCase();

  // EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24) — a trashed record is not a
  // critical incident. It is recoverable, physically intact, and got there
  // because somebody asked. The old alert called it "Deleted scope" at critical
  // severity, which was wrong on the noun and wrong on the severity: it put a
  // red banner on every record sitting normally in the trash.
  if (getEvidenceScope(item) === "trash") {
    alerts.push({
      severity: "operational",
      label: "In trash",
      detail:
        "This record is in the trash. It is fully retained and can be restored; review before reusing it in a case.",
    });
  }

  if (verificationStatus === "FAILED") {
    alerts.push({
      severity: "critical",
      label: "Technical verification failed",
      detail: "Backend verification status indicates a failed verification outcome and requires immediate reviewer follow-up.",
    });
  }

  if (verificationStatus === "REVIEW_REQUIRED") {
    alerts.push({
      severity: "operational",
      label: "Review required",
      detail: "Backend verification status explicitly marks this record for reviewer attention.",
    });
  }

  if (intelligence?.events.chainIntegrity.valid === false) {
    alerts.push({
      severity: "critical",
      label: "Custody chain issue",
      detail: "The recorded custody chain did not validate cleanly in the intelligence summary.",
    });
  }

  if (!report.available && (item.status === "SIGNED" || item.status === "REPORTED")) {
    alerts.push({
      severity: "operational",
      label: "Report not ready",
      detail: "A report is not currently recorded as downloadable for this preserved record.",
    });
  }

  if (!verificationPackage.available && detail) {
    alerts.push({
      severity: "operational",
      label: "Verification package unavailable",
      detail: "Verification package materials are not currently available from the detail endpoints.",
    });
  }

  if (!item.caseId) {
    alerts.push({
      severity: "informational",
      label: "No case assigned",
      detail: "Assign a case if this record should be tracked in a legal, compliance, or investigation matter.",
    });
  }

  if (detail && !detail?.evidence?.lockedAt && !intelligence?.preservation.locked) {
    alerts.push({
      severity: "informational",
      label: "Preservation lock not recorded",
      detail: "No permanent lock state is currently recorded on this evidence record.",
    });
  }

  return alerts;
}

export function buildReviewPriority(item: EvidenceListItem, detail?: DetailWorkspaceState | null): {
  level: "critical" | "operational" | "informational" | "stable";
  label: string;
  /**
   * The concrete notes that DROVE this level — the exact `buildReviewAlerts`
   * entries at the deciding severity. This is what makes the summary label
   * explainable: "Operational notes" without a note beside it is the vague
   * label a reader cannot act on, so the same canonical alerts that decide the
   * level travel with it for the row to surface (e.g. as a tooltip). `stable`
   * has none by definition. No second computation — one source, read twice.
   */
  notes: ReviewAlert[];
} {
  const alerts = buildReviewAlerts(item, detail);

  const at = (severity: ReviewAlert["severity"]) =>
    alerts.filter((alert) => alert.severity === severity);

  const critical = at("critical");
  if (critical.length > 0) {
    return { level: "critical", label: "Critical follow-up", notes: critical };
  }

  const operational = at("operational");
  if (operational.length > 0) {
    return { level: "operational", label: "Reviewer action recommended", notes: operational };
  }

  const informational = at("informational");
  if (informational.length > 0) {
    return { level: "informational", label: "Operational notes", notes: informational };
  }

  return { level: "stable", label: "Stable review state", notes: [] };
}
