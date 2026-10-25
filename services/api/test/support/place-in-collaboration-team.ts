/**
 * Place workspace members in an ACTIVE Collaboration Team (members audit,
 * unassigned-member decision). On PRO / TEAM a non-owner member is given
 * reviews, queue work, escalations and cases only once placed; a suite whose
 * subject is the review or case lifecycle — not placement — places its actors
 * once, up front, the way a workspace would be organised in practice. The
 * placement rule itself is proven in members-unassigned-rule.integration.test.ts.
 */
import { randomUUID } from "node:crypto";

type PlacementClient = {
  collaborationTeam: { create: (args: unknown) => Promise<{ id: string }> };
  collaborationTeamMember: { createMany: (args: unknown) => Promise<unknown> };
};

export async function placeInCollaborationTeam(
  prisma: unknown,
  input: { workspaceId: string; createdByUserId: string; userIds: readonly string[] },
): Promise<string> {
  const db = prisma as PlacementClient;
  const group = await db.collaborationTeam.create({
    data: {
      workspaceId: input.workspaceId,
      name: `Placement ${randomUUID().slice(0, 8)}`,
      createdByUserId: input.createdByUserId,
      status: "ACTIVE",
    },
    select: { id: true },
  });
  await db.collaborationTeamMember.createMany({
    data: input.userIds.map((userId) => ({ teamId: group.id, userId, status: "ACTIVE" })),
    skipDuplicates: true,
  });
  return group.id;
}
