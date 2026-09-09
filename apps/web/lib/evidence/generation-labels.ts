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

import type { OutputAction } from "@proovra/shared";

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
