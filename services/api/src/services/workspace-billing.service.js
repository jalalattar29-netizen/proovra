import * as prismaPkg from "@prisma/client";
import { prisma } from "../db.js";
import { ensureEntitlement } from "./billing.service.js";
import { getPlanCapabilities } from "./plan-catalog.service.js";
import { getEffectiveSeatLimit, assertWorkspacePlanCompatible, } from "@proovra/shared-billing";
function toBillingWorkspaceScope(scope) {
    return {
        workspaceType: scope.workspaceType,
        ownerUserId: scope.ownerUserId,
        teamId: scope.teamId,
        plan: scope.plan,
        credits: scope.credits,
        teamSeats: scope.teamSeats,
    };
}
async function getActiveWorkspaceStorageAddonBytes(params) {
    const aggregate = await prisma.workspaceStorageAddon.aggregate({
        where: {
            ownerUserId: params.ownerUserId,
            teamId: params.teamId ?? null,
            status: {
                in: [
                    prismaPkg.WorkspaceStorageAddonStatus.ACTIVE,
                    prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE,
                ],
            },
        },
        _sum: {
            extraStorageBytes: true,
        },
    });
    return aggregate._sum.extraStorageBytes ?? 0n;
}
export async function getPersonalWorkspaceScope(userId) {
    const [entitlement, activeStorageAddonBytes, personalTeam] = await Promise.all([
        ensureEntitlement(userId),
        getActiveWorkspaceStorageAddonBytes({
            ownerUserId: userId,
            teamId: null,
        }),
        // Phase A1 — read the personal Team (created by
        // `ensurePersonalWorkspace` on first authenticated request) so
        // we can return its organizationId. Read-only lookup; we never
        // bootstrap from this path. If the row does not exist yet,
        // organizationId stays null and the existing legacy
        // personal-mode behaviour is preserved.
        prisma.team.findFirst({
            where: { ownerUserId: userId, isPersonal: true },
            select: { organizationId: true },
        }),
    ]);
    const scope = {
        workspaceType: "PERSONAL",
        ownerUserId: userId,
        teamId: null,
        organizationId: personalTeam?.organizationId ?? null,
        plan: entitlement.plan,
        credits: entitlement.credits ?? 0,
        teamSeats: 0,
        storageBytesOverride: null,
        activeStorageAddonBytes,
    };
    assertWorkspacePlanCompatible(toBillingWorkspaceScope(scope));
    return scope;
}
export async function getTeamWorkspaceScope(teamId) {
    const team = await prisma.team.findUnique({
        where: { id: teamId },
        select: {
            id: true,
            ownerUserId: true,
            // Phase A1 — organization id is now NOT NULL at the schema
            // level (Stage 6). Selecting it explicitly here makes the
            // tenancy resolution path readable and lets the Phase B0
            // governance inheritance lookups consume the same scope object
            // without an additional join.
            organizationId: true,
            billingPlan: true,
            billingStatus: true,
            includedSeats: true,
            storageBytesOverride: true,
        },
    });
    if (!team) {
        const err = new Error("Team not found");
        err.statusCode = 404;
        throw err;
    }
    /**
     * Effective team workspace plan rules:
     *
     * 1) If this specific team has ACTIVE / PAST_DUE TEAM billing, use TEAM.
     * 2) Otherwise inherit the owner's active entitlement plan when that plan
     *    supports team workspaces (for example PRO, and later TEAM if enabled
     *    at owner/account level).
     * 3) Otherwise fall back to FREE.
     *
     * This allows:
     * - PRO owners to operate team workspaces
     * - TEAM-billed workspaces to remain TEAM
     * - FREE / PAYG owners to see non-entitled teams as FREE
     */
    const ownerEntitlement = await ensureEntitlement(team.ownerUserId);
    const ownerPlanCaps = getPlanCapabilities(ownerEntitlement.plan);
    const ownerPlanSupportsTeams = ownerPlanCaps.allowsTeamWorkspace;
    const effectivePlan = team.billingStatus === prismaPkg.TeamBillingStatus.ACTIVE ||
        team.billingStatus === prismaPkg.TeamBillingStatus.PAST_DUE
        ? team.billingPlan
        : ownerPlanSupportsTeams
            ? ownerEntitlement.plan
            : prismaPkg.PlanType.FREE;
    const activeStorageAddonBytes = await getActiveWorkspaceStorageAddonBytes({
        ownerUserId: team.ownerUserId,
        teamId: team.id,
    });
    const effectiveCaps = getPlanCapabilities(effectivePlan);
    const scope = {
        workspaceType: "TEAM",
        ownerUserId: team.ownerUserId,
        teamId: team.id,
        // Phase A1 — Stage 6 makes this column NOT NULL at the schema
        // level. The non-null assertion here is intentional: a Team
        // returned by the query above whose `organizationId` is null
        // would violate the schema invariant. Surface the violation as
        // an error rather than letting it propagate as a silent fallback.
        organizationId: team.organizationId,
        plan: effectivePlan,
        credits: 0,
        teamSeats: Math.max(0, team.includedSeats ?? 0, effectiveCaps.maxMembersPerTeam ?? 0, effectiveCaps.includedSeats ?? 0),
        storageBytesOverride: team.storageBytesOverride ?? null,
        activeStorageAddonBytes,
    };
    assertWorkspacePlanCompatible(toBillingWorkspaceScope(scope));
    return scope;
}
export async function resolveEvidenceWorkspaceScope(params) {
    if (params.teamId) {
        return getTeamWorkspaceScope(params.teamId);
    }
    return getPersonalWorkspaceScope(params.ownerUserId);
}
export async function resolveWorkspaceScopeForUser(params) {
    return resolveEvidenceWorkspaceScope(params);
}
export function getWorkspaceCapabilities(scope) {
    const caps = getPlanCapabilities(scope.plan);
    const baseIncludedStorageBytes = caps.includedStorageBytes;
    const storageFromPlanAndAddons = baseIncludedStorageBytes + scope.activeStorageAddonBytes;
    const effectiveStorageBytesLimit = scope.storageBytesOverride &&
        scope.storageBytesOverride > storageFromPlanAndAddons
        ? scope.storageBytesOverride
        : storageFromPlanAndAddons;
    return {
        ...caps,
        workspaceType: scope.workspaceType,
        effectiveSeatLimit: getEffectiveSeatLimit(toBillingWorkspaceScope(scope)),
        baseIncludedStorageBytes,
        activeStorageAddonBytes: scope.activeStorageAddonBytes,
        storageBytesOverride: scope.storageBytesOverride,
        effectiveStorageBytesLimit,
    };
}
