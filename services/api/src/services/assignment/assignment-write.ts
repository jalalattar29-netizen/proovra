/**
 * HOW A WRITER USES THE ONE ASSIGNEE AUTHORITY (members re-audit 2, B1-B11).
 *
 * `assertWorkAssigneeEligible` (assignee-eligibility.ts) decides WHO may be
 * given work. This module holds the three pieces every writer needs around it,
 * so no writer grows its own:
 *
 *   - `withinAssignmentWrite` — run the decision and the write as ONE
 *     transaction (the caller's, when it already is one), so the authority can
 *     be asked with `inTransaction: true` and the placement it relies on stays
 *     share-locked until the assignment commits (defect 5 / B5);
 *   - `CASE_ROLE_WORK_PERMISSION` — the capability a case role carries (B6);
 *   - `assigneeRefusal` — the typed, never-paged 422 a refusal answers with.
 */
import type { Permission } from "@proovra/shared";
import type { PrismaClient } from "@prisma/client";

import { DomainError } from "../../errors.js";
import type { AssigneeIneligibility } from "./assignee-eligibility.js";

/**
 * Run `fn` as one write: inside the caller's transaction when `client` already
 * is one (an interactive-transaction client has no `$transaction`), otherwise
 * in a transaction of its own.
 */
export async function withinAssignmentWrite<T>(
  client: PrismaClient,
  fn: (tx: PrismaClient) => Promise<T>,
): Promise<T> {
  const runner = (client as unknown as { $transaction?: unknown }).$transaction;
  if (typeof runner !== "function") return fn(client);
  return client.$transaction(async (tx) => fn(tx as unknown as PrismaClient));
}

/**
 * WHAT A CASE ROLE ASKS OF ITS HOLDER (members re-audit B6).
 *
 * Case assignment asked only `evidence.read`, which every VIEWER holds, so a
 * VIEWER could be made a case's OWNER, INVESTIGATOR or REVIEWER — while a Team
 * task (CT-06) and a review assignment (REV-02) refuse them. There is no
 * case-specific permission; each role is mapped to the existing workspace
 * permission that names the work it carries:
 *
 *   OWNER, INVESTIGATOR  work the case's evidence → `evidence.update_metadata`
 *                        (OWNER, ADMIN, REVIEWER/MEMBER, CONTRIBUTOR; not VIEWER)
 *   REVIEWER             review it → `evidence_request.review`, the reviewer
 *                        permission every review writer already asks
 *   GOVERNANCE, OBSERVER read it → `evidence.read` (unchanged; see the report:
 *                        whether GOVERNANCE should ask more is a product call)
 *
 * The SIU adjuster is case work (INVESTIGATOR) and the SIU reviewer is review
 * work (REVIEWER), so the SIU profile asks the same (B11).
 */
export const CASE_ROLE_WORK_PERMISSION: Readonly<
  Record<"OWNER" | "INVESTIGATOR" | "REVIEWER" | "GOVERNANCE" | "OBSERVER", Permission>
> = {
  OWNER: "evidence.update_metadata",
  INVESTIGATOR: "evidence.update_metadata",
  REVIEWER: "evidence_request.review",
  GOVERNANCE: "evidence.read",
  OBSERVER: "evidence.read",
};

/**
 * The typed refusal for a writer whose route has no vocabulary of its own: a
 * 422 the central handler answers verbatim and never pages. A review writer
 * answers REVIEW_ASSIGNEE_*, any other work ASSIGNEE_*. Like the authority, a
 * capability or reach refusal is one indistinct answer.
 */
export function assigneeRefusal(
  reason: AssigneeIneligibility,
  family: "REVIEW" | "WORK",
): DomainError {
  const prefix = family === "REVIEW" ? "REVIEW_ASSIGNEE" : "ASSIGNEE";
  return reason === "NOT_PLACED"
    ? new DomainError(`${prefix}_NOT_PLACED`, {
        httpStatus: 422,
        publicCode: `${prefix}_NOT_PLACED`,
        publicMessage:
          "That person isn't in a Collaboration Team yet. Place them in a team before assigning them work.",
        reportability: "EXPECTED_DENIAL",
        severity: "info",
      })
    : new DomainError(`${prefix}_NOT_ELIGIBLE`, {
        httpStatus: 422,
        publicCode: `${prefix}_NOT_ELIGIBLE`,
        publicMessage:
          family === "REVIEW"
            ? "That person cannot be assigned this review. Choose an active reviewer who can open this record."
            : "That person cannot be assigned this work. Choose an active member who can open this record.",
        reportability: "EXPECTED_DENIAL",
        severity: "warning",
      });
}
