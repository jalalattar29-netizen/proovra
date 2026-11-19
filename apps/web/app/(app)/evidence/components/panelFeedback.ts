/**
 * PRO-E1C-01 — the one failure vocabulary for the Review-tab note panels
 * (reviewer comments, legal notes, annotations).
 *
 * Their loads had `try/finally` with no catch, so a failed read ended as
 * "none yet", and every create/edit/delete was an unhandled rejection: a
 * refused delete left the item in place with no word, a write to a record
 * moved to Trash kept the draft and said nothing. The sibling panels on the
 * same tab already say what happened through `toSafeUserError`; these use the
 * same mapper, plus the two refusals these routes are known to give.
 */
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";

export function panelWriteError(err: unknown, fallback: string): string {
  const e = (err ?? {}) as { statusCode?: unknown; code?: unknown };
  if (e.code === "EVIDENCE_NOT_WRITABLE") {
    return "This record is not writable now (it may have been moved to Trash or locked). Your text was kept.";
  }
  if (e.statusCode === 403) {
    return "You are not permitted to change this item. Only its author or a workspace manager can.";
  }
  return toSafeUserError(err, { message: fallback }).message;
}

export const PANEL_LOAD_FAILED =
  "This list could not be loaded. That is not the same as there being none.";
