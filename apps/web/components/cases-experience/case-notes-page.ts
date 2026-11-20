/**
 * PRO-K1-07 — the case notes list is the newest page only.
 *
 * GET /v1/cases/:id/matter-workspace returns at most the newest 25 case
 * comments, with `caseCommentsTotal` (the case's real count) and
 * `caseCommentsTruncated` beside them. Both case pages showed the capped page
 * as if it were every note and counted from it. There is no route that lists
 * older notes, so the page says plainly that it shows the newest ones and how
 * many exist; it offers no "load more" the API cannot answer.
 *
 * An API older than this projection sends neither field: the list is then all
 * the page knows, and it is presented as before.
 */
export type CaseNotesSection = {
  caseComments: ReadonlyArray<unknown>;
  caseCommentsTotal?: number;
  caseCommentsTruncated?: boolean;
};

export type CaseNotesPage = {
  shown: number;
  total: number;
  truncated: boolean;
};

export function caseNotesPage(notes: CaseNotesSection | null | undefined): CaseNotesPage {
  const shown = notes?.caseComments.length ?? 0;
  const total =
    typeof notes?.caseCommentsTotal === "number" && notes.caseCommentsTotal >= shown
      ? notes.caseCommentsTotal
      : shown;
  const truncated = notes?.caseCommentsTruncated === true || total > shown;
  return { shown, total, truncated };
}

/** The sentence shown under a truncated list; null when the list is complete. */
export function caseNotesTruncationMessage(page: CaseNotesPage): string | null {
  if (!page.truncated) return null;
  return `Showing the newest ${page.shown} of ${page.total} notes on this case. Older notes are kept but are not listed here.`;
}

/** A filter only searches the notes that were loaded. */
export const CASE_NOTES_FILTER_SCOPE_MESSAGE = "The filter searches only the newest notes shown here.";
