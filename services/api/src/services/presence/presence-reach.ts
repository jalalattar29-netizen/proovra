/**
 * PRESENCE FOLLOWS RECORD REACH (PRO-046 / AUTHZ-002).
 *
 * "Who is looking at this" names the members viewing a record. On a record a
 * restricted case closes to the caller, that list (and the act of announcing
 * yourself on it) is the record's own data, so it follows the record's reach:
 * the caller gets the same 404 the record itself gives them.
 *
 * Not a new rule: each resource kind is resolved to the case or evidence row it
 * belongs to and decided by `record-reach.ts` (`case-visibility.ts`). An id that
 * names no row of its kind has no record to protect.
 */
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { caseClosedTo, evidenceClosedTo } from "../access/record-reach.js";

export type PresenceResourceKind =
  | "evidence"
  | "matter"
  | "discussion_thread"
  | "reviewer_workflow"
  | "evidence_request";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A2-19 — every lookup is bound to the workspace the route authorized. A row of
 * another workspace is, for this workspace's presence key, exactly a row that
 * does not exist: it is never judged (its restricted flag is not probed) and the
 * answer is the one an unknown id gets. Legacy teamless records/cases are still
 * judged by the canonical rule, as before.
 */
const IN_WORKSPACE = (teamId: string) => ({ OR: [{ teamId }, { teamId: null }] });

async function evidenceClosedHere(
  evidenceId: string,
  callerUserId: string,
  teamId: string,
  client: PrismaClient,
): Promise<boolean> {
  const here = await client.evidence.count({ where: { id: evidenceId, ...IN_WORKSPACE(teamId) } });
  return here > 0 && evidenceClosedTo(evidenceId, callerUserId, client);
}

async function caseClosedHere(
  caseId: string,
  callerUserId: string,
  teamId: string,
  client: PrismaClient,
): Promise<boolean> {
  const here = await client.case.count({ where: { id: caseId, ...IN_WORKSPACE(teamId) } });
  return here > 0 && caseClosedTo(caseId, callerUserId, client);
}

export async function presenceResourceClosedTo(
  kind: PresenceResourceKind,
  resourceId: string,
  callerUserId: string,
  teamId: string,
  client: PrismaClient = defaultPrisma,
): Promise<boolean> {
  // Every row a presence key can name has a uuid id; anything else names no row.
  if (!UUID.test(resourceId)) return false;
  switch (kind) {
    case "evidence":
      return evidenceClosedHere(resourceId, callerUserId, teamId, client);
    case "matter":
      return caseClosedHere(resourceId, callerUserId, teamId, client);
    case "discussion_thread": {
      const thread = await client.discussionThread.findFirst({
        where: { id: resourceId, teamId },
        select: { evidenceId: true },
      });
      if (thread && !thread.evidenceId) return false;
      // The mobile discussion panel keys presence on the record itself until a
      // thread is selected, so an id that is not a thread is read as a record id.
      return evidenceClosedHere(thread?.evidenceId ?? resourceId, callerUserId, teamId, client);
    }
    case "reviewer_workflow": {
      const workflow = await client.evidenceReviewWorkflow.findFirst({
        where: { id: resourceId, ...IN_WORKSPACE(teamId) },
        select: { evidenceId: true },
      });
      return workflow ? evidenceClosedHere(workflow.evidenceId, callerUserId, teamId, client) : false;
    }
    case "evidence_request": {
      const request = await client.evidenceRequest.findFirst({
        where: { id: resourceId, teamId },
        select: { caseId: true, evidenceId: true },
      });
      if (!request) return false;
      if (request.caseId && (await caseClosedHere(request.caseId, callerUserId, teamId, client))) return true;
      return request.evidenceId ? evidenceClosedHere(request.evidenceId, callerUserId, teamId, client) : false;
    }
  }
}
