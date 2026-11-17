/**
 * B3C-F-007 (Free-user audit 0ea0, owner directive) — existing cases after a
 * downgrade.
 *
 * `casesIncluded` (plan catalogue) decides who may CREATE a case
 * (`assertWorkspaceAllowsCases` on POST /v1/cases). A workspace that created
 * cases while on a paid plan and then lost the capability kept every other
 * case write. The directive:
 *
 *   - authorized READING, EXPORT and the privacy / safety actions — deleting
 *     the case, revoking a person's or a Collaboration Team's access, removing
 *     an assignment, deleting one's own note — stay open under the existing
 *     object and actor rules (A1-06 essentials; legal holds still apply);
 *   - case CREATION and the paid case edits and workflow writes (rename,
 *     status, linking and unlinking records, notes and their resolution,
 *     assignments, access grants, bulk status) answer to the CURRENT Cases
 *     entitlement, through the SAME gate the create route asks.
 *
 * This module is the one place those writes ask. It reads the case's own
 * workspace (or, for a legacy case with no workspace, its owner's personal
 * account), exactly as the create route reads the workspace the case will
 * belong to, and asks `assertWorkspaceAllowsCases` — so the refusal code and
 * message are the create route's. Personal and standalone evidence actions
 * are not cases and keep their own entitlement.
 */
import type { FastifyReply } from "fastify";

import { prisma } from "../../db.js";
import {
  assertWorkspaceAllowsCases,
  resolveEnforcementScopeForRequester,
} from "../billing-enforcement.service.js";

export type CasePlanWriteRefusal = {
  statusCode: number;
  code: string;
  message: string;
};

/**
 * `null` when the case's workspace currently includes Cases (or the case does
 * not exist — the caller's own lookup answers that). Otherwise the refusal the
 * create route would give.
 */
export async function casePlanWriteRefusal(
  caseRef: string | { teamId: string | null; ownerUserId: string },
): Promise<CasePlanWriteRefusal | null> {
  const row =
    typeof caseRef === "string"
      ? await prisma.case.findUnique({
          where: { id: caseRef },
          select: { teamId: true, ownerUserId: true },
        })
      : caseRef;
  if (!row) return null;
  try {
    const scope = await resolveEnforcementScopeForRequester({
      ownerUserId: row.ownerUserId,
      teamId: row.teamId,
    });
    await assertWorkspaceAllowsCases(scope);
    return null;
  } catch (err) {
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (!e.code) throw err;
    return {
      statusCode: e.statusCode ?? 409,
      code: e.code,
      message: e.message ?? "Cases and matters are not included in the current plan",
    };
  }
}

/** Plain-language reason the case views show beside a control the plan withholds. */
export const CASE_PLAN_WRITE_REASON =
  "Cases are not included in this workspace's current plan. You can still read, export and delete this case and remove access; change plan in Billing to edit it.";

/**
 * Route form: replies with the refusal (both the flat `code`/`message` the
 * case routes already send and the nested `error.code` the web client's
 * `apiFetch` raises as an ApiError) and returns true; returns false when the
 * write may proceed. Ask it AFTER the object and actor checks, so a caller who
 * cannot reach or mutate the case still gets the answer they got before.
 */
export async function refuseCasePlanWrite(
  reply: FastifyReply,
  caseRef: string | { teamId: string | null; ownerUserId: string },
): Promise<boolean> {
  const refusal = await casePlanWriteRefusal(caseRef);
  if (!refusal) return false;
  reply.code(refusal.statusCode).send({
    code: refusal.code,
    message: refusal.message,
    error: { code: refusal.code, message: refusal.message },
  });
  return true;
}
