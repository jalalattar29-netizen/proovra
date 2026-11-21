/**
 * PRO-K1-07 — the case notes list is the newest page; older pages load on
 * request.
 *
 * GET /v1/cases/:id/matter-workspace returns at most the newest 25 case
 * comments, with `caseCommentsTotal` (the case's real count),
 * `caseCommentsTruncated` and — on an API with the paged notes route —
 * `caseCommentsNextCursor`. Older notes come from
 * GET /v1/cases/:id/comments?cursor=, which applies the same note read rule on
 * every page. The page says how many of the case's notes are loaded; with a
 * cursor it offers "Load older notes", without one (an older API) it says
 * plainly that older notes are not listed and offers nothing it cannot do.
 *
 * An API older than the count projection sends none of the fields: the list is
 * then all the page knows, and it is presented as before.
 */
export type CaseNotesSection = {
  caseComments: ReadonlyArray<unknown>;
  caseCommentsTotal?: number;
  caseCommentsTruncated?: boolean;
  caseCommentsNextCursor?: string | null;
};

export type CaseNotesPage = {
  shown: number;
  total: number;
  truncated: boolean;
  /** True when the API handed a cursor for the next older page. */
  canLoadOlder?: boolean;
};

export function caseNotesPage(
  notes: CaseNotesSection | null | undefined,
  loaded?: { shown: number; canLoadOlder: boolean },
): CaseNotesPage {
  const shown = loaded?.shown ?? notes?.caseComments.length ?? 0;
  const total =
    typeof notes?.caseCommentsTotal === "number" && notes.caseCommentsTotal >= shown
      ? notes.caseCommentsTotal
      : shown;
  const truncated = loaded
    ? loaded.canLoadOlder || total > shown
    : notes?.caseCommentsTruncated === true || total > shown;
  return { shown, total, truncated, canLoadOlder: loaded?.canLoadOlder ?? false };
}

/** The sentence shown under a truncated list; null when the list is complete. */
export function caseNotesTruncationMessage(page: CaseNotesPage): string | null {
  if (!page.truncated) return null;
  if (page.canLoadOlder) return `Showing the newest ${page.shown} of ${page.total} notes on this case.`;
  return `Showing the newest ${page.shown} of ${page.total} notes on this case. Older notes are kept but are not listed here.`;
}

/** A filter only searches the notes that were loaded. */
export const CASE_NOTES_FILTER_SCOPE_MESSAGE = "The filter searches only the newest notes shown here.";

export const LOAD_OLDER_NOTES_LABEL = "Load older notes";
