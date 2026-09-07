/**
 * THE fan-out for Collaboration Team notifications.
 *
 * =============================================================================
 * WHY IT LIVES HERE AND NOT IN A SERVICE
 * =============================================================================
 * This function was defined inside `collaboration-completion.service.ts`,
 * which imports FROM `collaboration-team.service.ts`. That made it unreachable
 * from the assignment writers without creating an import cycle — so the
 * surface that most needed to tell somebody something was the one surface that
 * structurally could not.
 *
 * The result was visible in the vocabulary: of the ten declared
 * `CollaborationTeamNotificationType` values, NINE had no producer. Assignment
 * was among them. A group could be made responsible for a case, with a named
 * assignee, a priority and a due date, and nobody was told — the work existed
 * only for someone who already knew to open that group's Work tab. An
 * assignment nobody is told about is not an assignment.
 *
 * Extracting it to a leaf module both services can import gives it exactly one
 * definition and no cycle. This is a MOVE, not a second emitter: the access
 * review that previously called it still calls this one.
 *
 * =============================================================================
 * IT IS NOT A NOTIFICATION AUTHORITY
 * =============================================================================
 * This writes `CollaborationTeamNotification` rows, which the canonical
 * account inbox (`routes/me-inbox.routes.ts`) already reads and already
 * renders — that is why the rows are worth writing and why no second store,
 * second preference model or second delivery path is introduced here. The
 * inbox owns presentation, read state and dismissal; this owns nothing but the
 * fact that something happened to somebody.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import type { CollaborationTeamNotificationType } from "@proovra/shared";

export async function emitTeamNotifications(
  client: PrismaClient | Prisma.TransactionClient,
  args: {
    teamId: string;
    workspaceId: string;
    actorUserId: string | null;
    recipientUserIds: ReadonlyArray<string>;
    type: CollaborationTeamNotificationType;
    title: string;
    body: string | null;
    targetType: string | null;
    targetId: string | null;
  },
): Promise<number> {
  // Nobody is notified of their own action. Filtering here rather than at each
  // call site is what keeps that rule from being forgotten at the next one.
  const filtered = args.recipientUserIds.filter(
    (id) => id && id !== args.actorUserId,
  );
  if (filtered.length === 0) return 0;
  await client.collaborationTeamNotification.createMany({
    data: filtered.map((uid) => ({
      userId: uid,
      workspaceId: args.workspaceId,
      teamId: args.teamId,
      type: args.type,
      title: args.title.slice(0, 200),
      body: args.body ? args.body.slice(0, 1000) : null,
      targetType: args.targetType,
      targetId: args.targetId,
    })),
  });
  return filtered.length;
}
