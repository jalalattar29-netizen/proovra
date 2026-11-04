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

export async function presenceResourceClosedTo(
  kind: PresenceResourceKind,
  resourceId: string,
  callerUserId: string,
  client: PrismaClient = defaultPrisma,
): Promise<boolean> {
  // Every row a presence key can name has a uuid id; anything else names no row.
  if (!UUID.test(resourceId)) return false;
  switch (kind) {
    case "evidence":
      return evidenceClosedTo(resourceId, callerUserId, client);
    case "matter":
      return caseClosedTo(resourceId, callerUserId, client);
    case "discussion_thread": {
      const thread = await client.discussionThread.findUnique({
        where: { id: resourceId },
        select: { evidenceId: true },
      });
      // The mobile discussion panel keys presence on the record itself until a
      // thread is selected, so an id that is not a thread is read as a record id.
      return evidenceClosedTo(thread?.evidenceId ?? resourceId, callerUserId, client);
    }
    case "reviewer_workflow": {
      const workflow = await client.evidenceReviewWorkflow.findUnique({
        where: { id: resourceId },
        select: { evidenceId: true },
      });
      return workflow ? evidenceClosedTo(workflow.evidenceId, callerUserId, client) : false;
    }
    case "evidence_request": {
      const request = await client.evidenceRequest.findUnique({
        where: { id: resourceId },
        select: { caseId: true, evidenceId: true },
      });
      if (!request) return false;
      if (request.caseId && (await caseClosedTo(request.caseId, callerUserId, client))) return true;
      return request.evidenceId ? evidenceClosedTo(request.evidenceId, callerUserId, client) : false;
    }
  }
}
