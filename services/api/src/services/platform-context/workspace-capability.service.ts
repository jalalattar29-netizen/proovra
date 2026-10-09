/**
 * THE CAPABILITY DECISION FOR ONE (USER, WORKSPACE) PAIR.
 *
 * WHY THIS EXISTS (OPS-005 / OPS-021)
 * -----------------------------------
 * `buildPlatformContext` is the boot envelope: it resolves capabilities for the
 * caller's PERSISTED current workspace, and the web gates every Operations
 * surface on the result (`OPERATIONS_VIEW`, `OPERATIONS_ACKNOWLEDGE`, ...).
 * The API, however, accepts any `teamId` the caller is a member of and gated
 * the Operations workbench on the role permission alone. The two disagreed:
 * a FREE personal owner, an expired internal grant or a cancelled TEAM
 * workspace was refused by the web and served — reads AND mutations — by the
 * API.
 *
 * This module is the ONE derivation both now use:
 *
 *   * `planProducesOperationalConditions` — the commercial half of the
 *     Operations qualifier, read from the canonical plan catalog. The envelope
 *     and this resolver call the same function, so a package change moves
 *     both at once.
 *   * `activeMemberCount` — the sharing half. Only ACTIVE memberships count;
 *     a revoked or suspended row is not a second operator (OPS-021).
 *   * `resolveMemberWorkspaceCapabilities` — the full capability map for an
 *     arbitrary workspace the caller belongs to, built with the same inputs
 *     and the same `resolveCapabilities` the envelope uses, and the same
 *     effective-plan authority (`resolveCommercialPlan`), so an internal
 *     grant, its expiry and its revocation are honoured identically.
 *
 * It decides nothing new. It is the envelope's decision made reachable for a
 * workspace other than the current one.
 */

import { prisma } from "../../db.js";
import { resolveWorkspaceKind } from "../identity/workspace-kind.js";
import { getPlanCapabilities } from "../plan-catalog.service.js";
import { resolveCapabilities } from "./capability-registry.js";
import {
  isWorkspaceRole,
  type CapabilityKey,
  type ResolvedWorkspaceKind,
  type WorkspacePlan,
  type WorkspaceScope,
} from "./types.js";

const PLANS: ReadonlySet<string> = new Set(["FREE", "PAYG", "PRO", "TEAM", "ENTERPRISE"]);

function coercePlan(raw: string | null | undefined): WorkspacePlan | null {
  if (!raw) return null;
  const upper = String(raw).toUpperCase();
  return PLANS.has(upper) ? (upper as WorkspacePlan) : null;
}

function scopeFromKind(kind: ResolvedWorkspaceKind): WorkspaceScope | null {
  if (kind === "PERSONAL") return "PERSONAL";
  if (kind === "OWNED" || kind === "ORGANIZATION") return "TEAM";
  return null;
}

/** The commercial half of the Operations qualifier. One definition. */
export function planProducesOperationalConditions(plan: WorkspacePlan | null): boolean {
  const caps = getPlanCapabilities((plan ?? "FREE") as Parameters<typeof getPlanCapabilities>[0]);
  return (
    caps.reportsIncluded ||
    caps.verificationPackageIncluded ||
    caps.intakeIncluded ||
    caps.reviewerOperationsIncluded
  );
}

/** Prisma `_count` selector for ACTIVE memberships only (OPS-021). */
export const ACTIVE_MEMBER_COUNT_SELECT = {
  _count: { select: { members: { where: { status: "ACTIVE" as const } } } },
} as const;

export type MemberWorkspaceCapabilities = {
  capabilities: Record<CapabilityKey, boolean>;
  plan: WorkspacePlan | null;
  workspaceKind: ResolvedWorkspaceKind;
  activeMemberCount: number;
};

/**
 * The capability map the envelope WOULD produce if `teamId` were the caller's
 * current workspace. Null when the caller holds no ACTIVE membership there —
 * membership lifecycle (expiry, organization state) is still decided by
 * `evaluateMemberAccess`, which every caller runs first.
 *
 * Fails CLOSED: if the effective plan cannot be resolved, the plan is treated
 * as unknown (FREE capabilities), never as the raw column.
 */
export async function resolveMemberWorkspaceCapabilities(input: {
  userId: string;
  teamId: string;
}): Promise<MemberWorkspaceCapabilities | null> {
  const [team, membership] = await Promise.all([
    prisma.team.findUnique({
      where: { id: input.teamId },
      select: { id: true, isPersonal: true, workspaceKind: true, billingPlan: true, ...ACTIVE_MEMBER_COUNT_SELECT },
    }),
    prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: input.teamId, userId: input.userId } },
      select: { role: true, status: true },
    }),
  ]);
  if (!team || !membership || membership.status !== "ACTIVE") return null;

  const workspaceKind = resolveWorkspaceKind({
    workspaceKind: team.workspaceKind as unknown as string | null,
    isPersonal: team.isPersonal,
    billingPlan: team.billingPlan as unknown as string | null,
    teamLoaded: true,
  });

  let plan: WorkspacePlan | null = null;
  try {
    const { resolveCommercialPlan } = await import("../billing/commercial-context.service.js");
    const commercial = await resolveCommercialPlan({
      type: "WORKSPACE",
      teamId: team.id,
      requesterUserId: input.userId,
    });
    plan = coercePlan(commercial.plan as unknown as string);
  } catch {
    plan = null;
  }

  const role = isWorkspaceRole(String(membership.role)) ? (String(membership.role) as never) : null;
  const activeMemberCount = team._count?.members ?? 0;
  const capabilities = resolveCapabilities({
    scope: scopeFromKind(workspaceKind),
    role,
    plan,
    isPlatformAdmin: false,
    workspaceKind,
    packageProducesOperationalConditions: planProducesOperationalConditions(plan),
    memberCount: activeMemberCount,
  }) as Record<CapabilityKey, boolean>;

  return { capabilities, plan, workspaceKind, activeMemberCount };
}
