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

  if (item.deletedAt) {
    alerts.push({
      severity: "critical",
      label: "Deleted scope",
      detail: "This record is currently in deleted scope and should be restored or reviewed carefully before reuse.",
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
      detail: "Offline verification materials are not currently available from the detail endpoints.",
    });
  }

  if (!item.caseId) {
    alerts.push({
      severity: "informational",
      label: "No case assigned",
      detail: "Assign a case if this record should be tracked in a legal, compliance, or investigation matter.",
    });
  }

  if (!detail?.evidence?.lockedAt && !intelligence?.preservation.locked) {
    alerts.push({
      severity: "informational",
      label: "Preservation lock not recorded",
      detail: "No permanent lock state is currently recorded on this evidence record.",
    });
  }

  if (!detail?.evidence?.anchor?.configured) {
    alerts.push({
      severity: "informational",
      label: "Public verification not configured",
      detail: "Public verification is not configured for this record in the detail view.",
    });
  }

  return alerts;
}

export function buildReviewPriority(item: EvidenceListItem, detail?: DetailWorkspaceState | null): {
  level: "critical" | "operational" | "informational" | "stable";
  label: string;
} {
  const alerts = buildReviewAlerts(item, detail);

  if (alerts.some((alert) => alert.severity === "critical")) {
    return { level: "critical", label: "Critical follow-up" };
  }

  if (alerts.some((alert) => alert.severity === "operational")) {
    return { level: "operational", label: "Reviewer action recommended" };
  }

  if (alerts.some((alert) => alert.severity === "informational")) {
    return { level: "informational", label: "Operational notes" };
  }

  return { level: "stable", label: "Stable review state" };
}
