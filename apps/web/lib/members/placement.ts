/**
 * THE PLACEMENT PREREQUISITE, SAID WHERE WORK IS GIVEN (Team remediation
 * T-097 / T-098).
 *
 * Owner decision 2026-10-25 (`services/api/src/services/assignment/
 * placement-policy.ts`): on Pro and Team a person must be in a Collaboration
 * Team before they can be assigned work or claim a review (the workspace owner
 * excepted); on Enterprise only when the contract says so. The server keeps
 * the rule. These helpers make it VISIBLE:
 *
 *   - `GET /v1/reviewer-ops/assignable-reviewers` projects `placed` per person;
 *     a picker lists `placed: false` as unavailable, with the sentence and the
 *     way to fix it. An older API without the field is read as placed.
 *   - the 422 refusal (`REVIEW_ASSIGNEE_NOT_PLACED`, `details.reason:
 *     "assignee_not_placed"`, or the legacy lowercase code
 *     `assignee_not_placed`) is recognised in every shape.
 *
 * The fix is the EXISTING Collaboration-Team add-member flow — this module
 * only points at it.
 */
import { USER_FACING_ERRORS } from "@proovra/shared/user-facing-errors";

/** Where a person is placed in a Collaboration Team (its Members tab adds them). */
export const COLLABORATION_TEAMS_HREF = "/collaboration-teams";

/** The action that takes an operator to the add-member flow. */
export const PLACEMENT_ACTION_LABEL = "Add to a review team";

/** Missing (older API) is placed: the server still enforces the rule. */
export function isPlacedReviewer(r: { placed?: boolean | null } | null | undefined): boolean {
  return r?.placed !== false;
}

/** The picker's sentence for an unplaced person. */
export function placementPrerequisiteSentence(name: string): string {
  return `Add ${name} to a review team first`;
}

/** The shared title for the refusal ("Place them in a team first"). */
export const PLACEMENT_REFUSAL_TITLE = USER_FACING_ERRORS.REVIEW_ASSIGNEE_NOT_PLACED.title;

/** Assigning someone else who is not placed. */
export const ASSIGN_PLACEMENT_REFUSAL_MESSAGE = USER_FACING_ERRORS.REVIEW_ASSIGNEE_NOT_PLACED.message;

/** Claiming a review yourself while not placed. */
export const CLAIM_PLACEMENT_REFUSAL_MESSAGE =
  "You are not in a Collaboration Team in this workspace yet, so you cannot claim reviews here. An owner or admin adds you to a Collaboration Team, then you can claim work.";

/** One line for a toast or alert after a refused claim. */
export const CLAIM_PLACEMENT_REFUSAL_TEXT = `${PLACEMENT_REFUSAL_TITLE}. ${CLAIM_PLACEMENT_REFUSAL_MESSAGE}`;

/** The invite dialog's statement of the prerequisite. */
export const INVITE_PLACEMENT_NOTE =
  "Before a new member can be assigned reviews or claim work, they must be added to a Collaboration Team (a review team). Once they accept, add them to one from Collaboration Teams.";

const PLACEMENT_CODES = new Set(["REVIEW_ASSIGNEE_NOT_PLACED", "ASSIGNEE_NOT_PLACED"]);

/**
 * Is this error the placement refusal? Reads the normalised `code`, the nested
 * `body.error.code` and `body.error.details.reason`, so the new canonical code,
 * the legacy lowercase one and a reason-only body all qualify.
 */
export function isPlacementRefusal(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    code?: unknown;
    body?: { error?: { code?: unknown; details?: { reason?: unknown } | null } };
  };
  const codes = [e.code, e.body?.error?.code]
    .filter((c): c is string => typeof c === "string")
    .map((c) => c.trim().toUpperCase());
  if (codes.some((c) => PLACEMENT_CODES.has(c))) return true;
  return e.body?.error?.details?.reason === "assignee_not_placed";
}
