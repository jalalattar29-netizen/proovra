/**
 * Phase CASE-DETAIL-PERSONAL-UX — pure helpers shared across the
 * personal/small-business Case Detail tabs. Kept separate from the
 * tab components so they can be unit-tested in isolation and to keep
 * each tab file under the page byte-size guard.
 *
 * Hard rules:
 *   - NO over-claim vocabulary.
 *   - NO fabricated counts. Every derived value below is computed
 *     from real envelope fields (matter-workspace response).
 *   - Status labels mirror the global CASES_PERSONAL_UX vocabulary
 *     used on the Cases list page so the two surfaces feel uniform.
 */

import type { MatterWorkspaceEnvelope } from "../types";

/** Friendly case-status labels (UPPER_SNAKE enum → Sentence case). */
export const CASE_STATUS_LABEL: Record<string, string> = {
  OPEN: "Open",
  INVESTIGATING: "Investigating",
  ON_HOLD: "On hold",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
  ARCHIVED: "Archived",
};

export function caseStatusLabel(status: string | null | undefined): string {
  if (!status) return "Unknown";
  return CASE_STATUS_LABEL[status] ?? status;
}

/**
 * Allowed status transitions, mirroring the backend state machine in
 * `services/api/src/services/cases/case-lifecycle.service.ts`. Used by
 * the Settings tab to render only the transitions the API will accept.
 * Source-pinned by a contract test.
 *
 * Phase CASE-ARCHIVE-RESTORE — ARCHIVED is no longer terminal. The
 * only path INTO ARCHIVED is `CLOSED → ARCHIVED`, so the only valid
 * restore is the inverse: `ARCHIVED → CLOSED`. The Settings tab
 * renders this transition as a dedicated "Restore case" button
 * (not via the generic transition loop) so the copy + confirm modal
 * follow the spec.
 */
export const ALLOWED_STATUS_TRANSITIONS: Record<string, ReadonlyArray<string>> = {
  OPEN: ["INVESTIGATING", "ON_HOLD", "RESOLVED"],
  INVESTIGATING: ["ON_HOLD", "RESOLVED"],
  ON_HOLD: ["INVESTIGATING", "RESOLVED"],
  RESOLVED: ["CLOSED", "INVESTIGATING"],
  CLOSED: ["ARCHIVED", "RESOLVED"],
  ARCHIVED: ["CLOSED"],
};

export type DeliverableSummary = {
  /** Number of linked evidence records with at least one Report row. */
  reportsReady: number;
  /** Number of linked evidence records with at least one VerificationPackage row. */
  packagesReady: number;
  /** Number of linked evidence records missing either deliverable. */
  needsAttention: number;
};

/**
 * Derive deliverable readiness from the matter-workspace envelope.
 * Reads only existing real fields: `reportReady` and `packageReady`
 * on each evidence link row.
 */
export function summariseDeliverables(
  envelope: MatterWorkspaceEnvelope,
): DeliverableSummary {
  const items = envelope.sections.evidence.items ?? [];
  let reportsReady = 0;
  let packagesReady = 0;
  let needsAttention = 0;
  for (const item of items) {
    if (item.reportReady) reportsReady += 1;
    if (item.packageReady) packagesReady += 1;
    if (!item.reportReady || !item.packageReady) needsAttention += 1;
  }
  return { reportsReady, packagesReady, needsAttention };
}

/**
 * Personal-mode "what needs attention" derivation. Returns an ordered
 * list of plain-language items the user can act on, derived only from
 * existing envelope fields. The list intentionally avoids enterprise
 * vocabulary (governance blockers, SLA, etc.). Empty array means
 * "no open issues" — the empty state for the Overview tab.
 */
export function deriveNeedsAttention(
  envelope: MatterWorkspaceEnvelope,
): Array<{ key: string; label: string }> {
  const items = envelope.sections.evidence.items ?? [];
  const out: Array<{ key: string; label: string }> = [];
  if (items.length === 0) {
    out.push({
      key: "no-evidence",
      label: "No evidence yet — add evidence to start working on this case.",
    });
    return out;
  }
  const missingReport = items.filter((i) => !i.reportReady).length;
  const missingPackage = items.filter((i) => !i.packageReady).length;
  const integrityIssues = items.filter(
    (i) =>
      i.verificationStatus &&
      (i.verificationStatus === "FAILED" ||
        i.verificationStatus === "REVIEW_REQUIRED"),
  ).length;
  if (missingReport > 0) {
    out.push({
      key: "missing-report",
      label:
        missingReport === 1
          ? "1 evidence record is missing a report."
          : `${missingReport} evidence records are missing a report.`,
    });
  }
  if (missingPackage > 0) {
    out.push({
      key: "missing-package",
      label:
        missingPackage === 1
          ? "1 evidence record is missing a verification package."
          : `${missingPackage} evidence records are missing a verification package.`,
    });
  }
  if (integrityIssues > 0) {
    out.push({
      key: "integrity",
      label:
        integrityIssues === 1
          ? "1 evidence record has an integrity issue that needs review."
          : `${integrityIssues} evidence records have integrity issues that need review.`,
    });
  }
  return out;
}

/**
 * Read-friendly relative date — purpose-built for the case header
 * "Last updated …" line. The Cases list page formats relative time
 * elsewhere; we keep this local so the personal Case Detail surface
 * doesn't grow new shared imports.
 */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "—";
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const d = date.getUTCDate();
  const m = months[date.getUTCMonth()];
  const y = date.getUTCFullYear();
  return `${m} ${d}, ${y}`;
}
