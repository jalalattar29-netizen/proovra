/**
 * THE CANONICAL USER-FACING NAMES FOR ONE OPERATION.
 *
 * ===========================================================================
 * RELIABILITY CLOSURE (2026-09-09)
 * ===========================================================================
 * The same request was called four things. Evidence Detail offered "Generate
 * report & verification package"; the Reports page offered "Generate report &
 * package"; the AI Copilot offered "Generate / regenerate Report…"; retry was
 * "Retry generation" on both pages, which names a different noun from its two
 * siblings. A person comparing surfaces had to work out whether they did the
 * same thing, and they do — one request produces both artifacts, because the
 * verification package is built inside the report job.
 *
 * Downloads are here for the same reason: the header said "Download Report
 * PDF", the Artifacts cards said "Download latest" on both of them, the Reports
 * page said "Download report PDF", and the library preview said "Download
 * Report".
 *
 * WHY A MODULE AND NOT A CONSTANT IN EACH FILE. Four surfaces render these, and
 * the point is that they cannot drift again. A shared table makes a rename one
 * edit; four local strings made the last four renames three-quarters complete.
 *
 * These are LABELS ONLY. Which of them a surface may show is decided by the
 * server's `OutputAction`, never here.
 */

import type { EvidenceOutputState, OutputAction } from "@proovra/shared";

/**
 * The verb, in full, for every action the server can hand a surface.
 *
 * `NONE` has an empty string rather than being absent so the record is total:
 * a caller that reaches for a label it should not be rendering gets nothing,
 * not a crash and not a stale word from another state.
 */
export const GENERATION_ACTION_LABEL: Record<OutputAction, string> = {
  GENERATE: "Generate report & verification package",
  RETRY: "Retry report & verification package",
  REGENERATE: "Regenerate report & verification package",
  NONE: "",
};

/**
 * The compact form, for surfaces that render this control inside a dense row
 * beside two downloads and a link.
 *
 * DOCUMENTED, NOT IMPROVISED. The audit's rule is that a shorter label is
 * allowed only where a surface explicitly declares it needs one, and the
 * Reports index is that surface: three full-width actions at 320px is where its
 * horizontal overflow came from. The words are a strict prefix of the canonical
 * label — never a different name for the same thing.
 */
export const GENERATION_ACTION_LABEL_COMPACT: Record<OutputAction, string> = {
  GENERATE: "Generate report & package",
  RETRY: "Retry report & package",
  REGENERATE: "Regenerate report & package",
  NONE: "",
};

/**
 * The two download controls, named the same way everywhere.
 *
 * THESE ARE THE EXISTING PRODUCT STRINGS, ADOPTED — not new ones. The "PDF" and
 * "ZIP" suffixes are a deliberate vocabulary contract (phase A2 / G5.2): they
 * are what tell the two downloads apart at a glance, and three tests pin them.
 * Inventing a fourth spelling to unify the other three would have been the same
 * mistake in the other direction.
 *
 * What was genuinely ambiguous, and is fixed by adopting these: the Artifacts
 * cards labelled BOTH buttons "Download latest", so the two most important
 * controls on the record were textually identical and told apart only by which
 * card they sat in — unusable from a screen reader's linear reading, and
 * ambiguous in a bug report.
 */
export const DOWNLOAD_REPORT_LABEL = "Download Report PDF";
export const DOWNLOAD_PACKAGE_LABEL = "Download Verification Package ZIP";

// ===========================================================================
// P2-4 CLOSURE (2026-09-10) — THE CASES VOCABULARY FOR ONE OUTPUT STATE.
// ===========================================================================

/**
 * IS THIS OUTPUT'S CURRENT STATE SOMETHING THE CASE OWNER SHOULD ACT ON?
 *
 * The Cases surfaces counted `!reportReady || !packageReady` into a
 * "needs attention" total and wrote "N evidence records are missing a report".
 * Three different situations produced that sentence:
 *
 *   * an output the plan and this record's funding exclude — the product
 *     working as sold, restated as a deficiency in the customer's own case
 *     file;
 *   * a record that is not finalized, or whose integrity check failed;
 *   * a generation that was queued or running at that exact moment.
 *
 * Only the last group of states is genuinely outstanding work, and this is the
 * one predicate that says so. It is total over `EvidenceOutputState`, so a new
 * state is a compile error here rather than a silent "missing".
 */
export function caseOutputNeedsAttention(state: EvidenceOutputState): boolean {
  switch (state) {
    case "READY":
    // Not included, and not applicable to this record: neither is a gap in the
    // case file, and neither has an action behind it.
    case "NOT_INCLUDED":
    case "NOT_APPLICABLE":
    // In flight. The system owes an answer and is producing one; a case
    // dashboard that flags this trains its reader to ignore the flag.
    case "QUEUED":
    case "GENERATING":
      return false;
    case "ELIGIBLE_NOT_GENERATED":
    case "RETRYABLE_FAILURE":
    case "TERMINAL_FAILURE":
    case "BLOCKED":
      return true;
  }
}

/**
 * The short cell label a Cases row renders for one output.
 *
 * Total, and deliberately free of the word "missing" for every state where
 * nothing is missing.
 */
export function caseOutputLabel(
  state: EvidenceOutputState,
  noun: "Report" | "Package",
): string {
  switch (state) {
    case "READY":
      return `${noun} ready`;
    case "NOT_INCLUDED":
      return `${noun} not included`;
    case "NOT_APPLICABLE":
      return `${noun} not applicable`;
    case "QUEUED":
    case "GENERATING":
      return `${noun} generating`;
    case "ELIGIBLE_NOT_GENERATED":
      return `${noun} not generated`;
    case "RETRYABLE_FAILURE":
    case "TERMINAL_FAILURE":
      return `${noun} generation failed`;
    case "BLOCKED":
      return `${noun} blocked`;
  }
}
