/**
 * GRAPH READS OBEY CASE REACH (EVID-001).
 *
 * The investigation graph is a denormalised projection read through raw SQL,
 * so it cannot join `case-visibility.ts`. This asks that authority which of the
 * workspace's Cases and Evidence are closed to the caller and has the graph
 * module turn them into node ids, so every read excludes them in its own WHERE
 * clause. A hidden record never reaches a traversal, a cap, a count or a label.
 */
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { hiddenRecordIdsInWorkspace } from "../access/record-reach.js";
import { resolveHiddenGraphNodeIds, type GraphReach } from "./graph-builder.service.js";

export async function resolveGraphReach(
  workspaceId: string,
  callerUserId: string,
  client: PrismaClient = defaultPrisma,
): Promise<GraphReach> {
  const hidden = await hiddenRecordIdsInWorkspace(workspaceId, callerUserId, client);
  const hiddenNodeIds = await resolveHiddenGraphNodeIds(
    { teamId: workspaceId, hiddenEvidenceIds: hidden.evidenceIds, hiddenCaseIds: hidden.caseIds },
    client,
  );
  return { hiddenNodeIds };
}
