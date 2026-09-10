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

import type { AppTone } from "../../app-primitives/AppStatusBadge";
import { lifecycleTone } from "../../../lib/status-tone/lifecycleTone";
import type { MatterWorkspaceEnvelope } from "../types";
// P2-4 — the ONE predicate that says whether an output state is case work.
import { caseOutputNeedsAttention } from "../../../lib/evidence/generation-labels";

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
 * Case status → the canonical semantic tone vocabulary.
 *
 * DISPLAY ONLY: it never changes which statuses exist, which transitions are
 * allowed, or who may perform them (the backend state machine stays
 * authoritative). Mapping in TypeScript rather than in CSS is what lets ONE
 * definition serve every surface instead of a per-domain `[data-status]`
 * colour table.
 *
 * A THIN DELEGATION, deliberately. The table itself moved to
 * `lib/status-tone/lifecycleTone` because Cases was not its only reader:
 * Search renders the same six states, and while each surface owned its own
 * switch they disagreed — ARCHIVED was slate in one and RESOLVED shared OPEN's
 * green in another. This function stays because it is the name every Cases
 * call site already imports, and because "case status" is the domain question;
 * what it must not stay is a second answer to it.
 */
export function caseStatusTone(status: string | null | undefined): AppTone {
  return lifecycleTone(status);
}

/**
 * Phase CASES-STATUS-MANUAL — the personal Settings tab now exposes
 * case status as a plain organizational dropdown (Open / Investigating
 * / On hold / Resolved / Closed / Archived). Every option is always
 * reachable from every other option; status is not a workflow state
 * machine for personal/SB users. This ordered list is the single
 * source of truth for the dropdown's options and for the cases-list
 * filter. Source-pinned by `cases-status-selector.test.ts`.
 */
export const CASE_STATUS_OPTIONS: ReadonlyArray<{
  value: string;
  label: string;
}> = [
  { value: "OPEN", label: "Open" },
  { value: "INVESTIGATING", label: "Investigating" },
  { value: "ON_HOLD", label: "On hold" },
  { value: "RESOLVED", label: "Resolved" },
  { value: "CLOSED", label: "Closed" },
  { value: "ARCHIVED", label: "Archived" },
];

/**
 * Backend transition table mirror. The backend now allows ANY status
 * to ANY status (case status is plain metadata for personal users);
 * this map mirrors that shape so any contract test pin keeps a single
 * client/server source of truth.
 */
export const ALLOWED_STATUS_TRANSITIONS: Record<string, ReadonlyArray<string>> =
  Object.fromEntries(
    CASE_STATUS_OPTIONS.map((o) => [
      o.value,
      CASE_STATUS_OPTIONS.filter((x) => x.value !== o.value).map(
        (x) => x.value,
      ),
    ]),
  );

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
    /*
     * P2-4 CLOSURE (2026-09-10) — "MISSING EITHER DELIVERABLE" WAS THE WRONG
     * QUESTION.
     *
     * This was `!item.reportReady || !item.packageReady`, so a record the plan
     * never produces an artifact for, one still being uploaded, and one whose
     * generation was running at that instant all counted as case work
     * outstanding. On a workspace that had been downgraded, every record in
     * every case counted — a permanent number nobody could reduce.
     *
     * The canonical state decides it, through the one shared predicate. When
     * the server did not send a state (the legacy envelope shape), nothing is
     * counted: an unknown is not a deficiency.
     */
    if (item.outputs) {
      if (
        caseOutputNeedsAttention(item.outputs.report.state) ||
        caseOutputNeedsAttention(item.outputs.verificationPackage.state)
      ) {
        needsAttention += 1;
      }
    }
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
  /*
   * P2-4 — the same correction as `summariseDeliverables`. These two counts
   * drove the sentences "N evidence records are missing a report" and
   * "… missing a verification package", which named a commercial exclusion, an
   * unfinalized upload and an in-flight generation as one kind of problem.
   */
  const missingReport = items.filter(
    (i) => i.outputs && caseOutputNeedsAttention(i.outputs.report.state),
  ).length;
  const missingPackage = items.filter(
    (i) =>
      i.outputs &&
      caseOutputNeedsAttention(i.outputs.verificationPackage.state),
  ).length;
  const integrityIssues = items.filter(
    (i) =>
      i.verificationStatus &&
      (i.verificationStatus === "FAILED" ||
        i.verificationStatus === "REVIEW_REQUIRED"),
  ).length;
  if (missingReport > 0) {
    out.push({
      key: "missing-report",
      // P2-4 — "needs a report generated" is what the count now means, and
      // it is only ever true where an action or an operator step exists.
      label:
        missingReport === 1
          ? "1 evidence record still needs its report generated."
          : `${missingReport} evidence records still need their reports generated.`,
    });
  }
  if (missingPackage > 0) {
    out.push({
      key: "missing-package",
      label:
        missingPackage === 1
          ? "1 evidence record still needs its verification package generated."
          : `${missingPackage} evidence records still need their verification packages generated.`,
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
