/**
 * IS THIS WORKSPACE OPERATING? For the paths with no member to authorize: a
 * portal token, a public intake link, an issued intake session.
 *
 * Such a path holds a token and nothing else, so the canonical authorization
 * chain, which decides workspace liveness and Organization lifecycle for every
 * member, has nothing to evaluate. It asks this instead.
 *
 * Reuses the canonical classifier (`resolveWorkspaceKind` +
 * `organizationLifecycleApplies`): it does NOT re-derive what an ORGANIZATION
 * workspace is, and it does NOT invent a second lifecycle rule. Fails CLOSED on
 * an unloadable row, an unprovable kind, or any read error.
 */
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { organizationLifecycleApplies, resolveWorkspaceKind } from "../identity/workspace-kind.js";

export async function isLiveOperatingWorkspace(
  teamId: string,
  client: PrismaClient = defaultPrisma,
): Promise<boolean> {
  try {
    const team = await client.team.findUnique({
      where: { id: teamId },
      select: {
        isPersonal: true,
        workspaceKind: true,
        billingPlan: true,
        closedAtUtc: true,
        organization: { select: { status: true } },
      },
    });
    if (!team || team.closedAtUtc !== null) return false;
    const kind = resolveWorkspaceKind({
      workspaceKind: team.workspaceKind,
      isPersonal: team.isPersonal,
      billingPlan: team.billingPlan,
      teamLoaded: true,
    });
    if (kind === "UNKNOWN") return false;
    if (organizationLifecycleApplies(kind)) {
      return team.organization?.status === "ACTIVE";
    }
    return true;
  } catch {
    return false;
  }
}
