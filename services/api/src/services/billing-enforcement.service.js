import * as prismaPkg from "@prisma/client";
import { prisma } from "../db.js";
import { consumeCredits } from "./billing.service.js";
import { getPlanCapabilities } from "./plan-catalog.service.js";
import { getPersonalWorkspaceScope, getTeamWorkspaceScope, } from "./workspace-billing.service.js";
import { assertWorkspaceStorageAvailable, getWorkspaceUsage, } from "./workspace-usage.service.js";
export async function resolveWorkspaceScopeForUser(params) {
    if (params.teamId) {
        return getTeamWorkspaceScope(params.teamId);
    }
    return getPersonalWorkspaceScope(params.ownerUserId);
}
export async function assertWorkspaceAllowsEvidenceCreation(scope) {
    const caps = getPlanCapabilities(scope.plan);
    if (scope.workspaceType === "TEAM" && scope.plan !== prismaPkg.PlanType.TEAM) {
        const err = new Error("TEAM plan required for team workspace evidence");
        err.statusCode = 409;
        err.code = "TEAM_PLAN_REQUIRED";
        throw err;
    }
    if (scope.workspaceType !== "PERSONAL") {
        return;
    }
    const evidenceCount = await prisma.evidence.count({
        where: {
            ownerUserId: scope.ownerUserId,
            teamId: null,
            deletedAt: null,
        },
    });
    const freeIncluded = caps.maxEvidenceRecords;
    const creditsRequired = caps.paygCreditsRequiredPerCompletion ?? 0;
    const availableCredits = scope.credits ?? 0;
    if (freeIncluded !== null && evidenceCount < freeIncluded) {
        return;
    }
    if (creditsRequired > 0) {
        if (availableCredits < creditsRequired) {
            const err = new Error("Insufficient credits");
            err.statusCode = 402;
            err.code = "INSUFFICIENT_CREDITS";
            throw err;
        }
        return;
    }
    if (freeIncluded !== null && evidenceCount >= freeIncluded) {
        const err = new Error("Free evidence limit reached");
        err.statusCode = 409;
        err.code = "FREE_LIMIT_REACHED";
        throw err;
    }
}
export async function assertWorkspaceAllowsStorageGrowth(params) {
    return assertWorkspaceStorageAvailable(params);
}
export async function assertWorkspaceAllowsReport(scope) {
    const caps = getPlanCapabilities(scope.plan);
    if (!caps.reportsIncluded) {
        const err = new Error("Report generation is not included in the current plan");
        err.statusCode = 409;
        err.code = "REPORT_NOT_INCLUDED";
        throw err;
    }
}
export async function assertWorkspaceAllowsVerificationPackage(scope) {
    const caps = getPlanCapabilities(scope.plan);
    if (!caps.verificationPackageIncluded) {
        const err = new Error("Verification package is not included in the current plan");
        err.statusCode = 409;
        err.code = "VERIFICATION_PACKAGE_NOT_INCLUDED";
        throw err;
    }
}
export async function assertWorkspaceAllowsReportStorage(params) {
    await assertWorkspaceAllowsReport(params.scope);
    return assertWorkspaceStorageAvailable({
        scope: params.scope,
        incomingBytes: params.incomingBytes ?? 0n,
    });
}
export async function assertWorkspaceAllowsVerificationPackageStorage(params) {
    await assertWorkspaceAllowsVerificationPackage(params.scope);
    return assertWorkspaceStorageAvailable({
        scope: params.scope,
        incomingBytes: params.incomingBytes ?? 0n,
    });
}
export async function getWorkspaceAvailableStorageBytes(scope) {
    const usage = await getWorkspaceUsage(scope);
    return usage.storageBytesRemaining;
}
export async function consumeWorkspaceCompletionCredits(scope, tx) {
    const caps = getPlanCapabilities(scope.plan);
    const required = caps.paygCreditsRequiredPerCompletion;
    if (required <= 0) {
        return;
    }
    if (!tx) {
        await consumeCredits(scope.ownerUserId, required);
        return;
    }
    const decremented = await tx.entitlement.updateMany({
        where: {
            userId: scope.ownerUserId,
            active: true,
            credits: { gte: required },
        },
        data: {
            credits: { decrement: required },
        },
    });
    if (decremented.count !== 1) {
        const err = new Error("Insufficient credits");
        err.statusCode = 402;
        err.code = "INSUFFICIENT_CREDITS";
        throw err;
    }
}
export async function getWorkspaceBillingSummary(scope) {
    const caps = getPlanCapabilities(scope.plan);
    const usage = await getWorkspaceUsage(scope);
    return {
        scope,
        capabilities: caps,
        usage,
    };
}
