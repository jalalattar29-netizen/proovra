/**
 * MEMBERS & ACCESS LIFECYCLE NOTICES (members audit AUD-04).
 *
 * A person whose access changes is told. Removal, suspension, restoration, a
 * role change, receiving ownership, the closure of a workspace they belonged
 * to, and the closure of their own account each enqueue ONE email to the
 * person affected — never to anyone else, and never with anything but the
 * workspace name and the change.
 *
 * The notice is written INSIDE the transaction that made the change, through
 * the notification outbox (`enqueueEmailNotificationTx`): a rolled-back
 * change sends nothing, a committed one cannot lose its notice. The caller
 * dispatches the returned ids after commit; the notification sweeper owns any
 * the caller never dispatched.
 *
 * Who is not written to: the actor acting on themselves (leaving a workspace
 * is the person's own act), an account already anonymised (no address to
 * write to), and nobody at all when notifications are switched off (the
 * orchestrator records a SKIPPED row instead).
 */
import type { Prisma } from "@prisma/client";
import { absoluteInternalUrl, internalNavPath, type NotificationEventType } from "@proovra/shared";

import { RBAC_MATRIX_ROLES } from "../platform-context/rbac-matrix.js";
import { getEmailWebBaseUrl } from "./templates.js";
import { enqueueEmailNotificationTx } from "./index.js";

export type MembershipLifecycleNoticeEvent = Extract<
  NotificationEventType,
  | "WORKSPACE_ACCESS_REMOVED"
  | "WORKSPACE_ACCESS_SUSPENDED"
  | "WORKSPACE_ACCESS_RESTORED"
  | "WORKSPACE_ROLE_CHANGED"
  | "WORKSPACE_OWNERSHIP_RECEIVED"
  | "WORKSPACE_CLOSED"
  | "ACCOUNT_CLOSED"
>;

function roleLabel(role: string | null | undefined): string | null {
  if (!role) return null;
  return RBAC_MATRIX_ROLES.find((r) => r.id === role)?.label ?? null;
}

/**
 * Enqueue one lifecycle notice for `recipientUserId`. `teamId` is the
 * workspace the change happened in (null for ACCOUNT_CLOSED). Returns the
 * delivery id to dispatch after commit, or null when nothing is sent.
 */
export async function enqueueMembershipLifecycleNoticeTx(
  tx: Prisma.TransactionClient,
  input: {
    eventType: MembershipLifecycleNoticeEvent;
    teamId: string | null;
    recipientUserId: string;
    actorUserId: string | null;
    newRole?: string | null;
  },
): Promise<string | null> {
  const user = await tx.user.findUnique({
    where: { id: input.recipientUserId },
    select: { email: true, displayName: true },
  });
  if (!user?.email) return null;
  const team = input.teamId
    ? await tx.team.findUnique({ where: { id: input.teamId }, select: { name: true } })
    : null;
  const actionUrl =
    input.eventType === "ACCOUNT_CLOSED" || input.eventType === "WORKSPACE_CLOSED"
      ? null
      : absoluteInternalUrl(getEmailWebBaseUrl(), internalNavPath("/workspaces"));
  return enqueueEmailNotificationTx(tx, {
    eventType: input.eventType,
    teamId: input.teamId,
    recipientEmail: user.email,
    recipientName: user.displayName ?? null,
    recipientUserId: input.recipientUserId,
    initiatedByUserId: input.actorUserId,
    template: {
      kind: "MembershipLifecycle",
      data: {
        workspaceName: team?.name ?? "your workspace",
        roleLabel: roleLabel(input.newRole),
        actionUrl,
      },
    },
  });
}
