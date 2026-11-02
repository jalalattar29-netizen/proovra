/**
 * WHETHER AN ACCOUNT HAS BEEN CLOSED (IDENT-010).
 *
 * Closure scrambles the provider subject of the User row in the same transaction
 * that ends its access, and that value is the durable marker. It is what any path
 * able to start a session or restore access has to check: revoked sessions are
 * judged by issue time, so a newly minted token would pass them.
 */
import type { PrismaClient } from "@prisma/client";

const CLOSED_PREFIX = "closed:";

export function closedAccountProviderId(userId: string): string {
  return `${CLOSED_PREFIX}${userId}`;
}

export async function isAccountClosed(
  userId: string,
  client: Pick<PrismaClient, "user">,
): Promise<boolean> {
  const user = await client.user.findUnique({
    where: { id: userId },
    select: { providerUserId: true },
  });
  return user?.providerUserId?.startsWith(CLOSED_PREFIX) === true;
}
