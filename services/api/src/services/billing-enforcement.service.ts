import * as prismaPkg from "@prisma/client";
import { prisma } from "../db.js";
import { consumeCredits } from "./billing.service.js";
import { getPlanCapabilities } from "./plan-catalog.service.js";
import {
  getPersonalWorkspaceScope,
  getTeamWorkspaceScope,
  type WorkspaceScope,
} from "./workspace-billing.service.js";
import { assertWorkspaceStorageAvailable } from "./workspace-usage.service.js";

type EntitlementWriter = Pick<prismaPkg.Prisma.TransactionClient, "entitlement">;

export async function resolveWorkspaceScopeForUser(params: {
  ownerUserId: string;
  teamId?: string | null;
}): Promise<WorkspaceScope> {
  if (params.teamId) {
    return getTeamWorkspaceScope(params.teamId);
  }
  return getPersonalWorkspaceScope(params.ownerUserId);
}

export async function assertWorkspaceAllowsEvidenceCreation(
  scope: WorkspaceScope
) {
  const caps = getPlanCapabilities(scope.plan);

  if (scope.workspaceType === "TEAM" && scope.plan !== prismaPkg.PlanType.TEAM) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "TEAM plan required for team workspace evidence"
    );
    err.statusCode = 409;
    err.code = "TEAM_PLAN_REQUIRED";
    throw err;
  }

  if (scope.workspaceType === "PERSONAL" && caps.maxEvidenceRecords !== null) {
    const evidenceCount = await prisma.evidence.count({
      where: {
        ownerUserId: scope.ownerUserId,
        teamId: null,
        deletedAt: null,
      },
    });

    if (evidenceCount >= caps.maxEvidenceRecords) {
      const err: Error & { statusCode?: number; code?: string } = new Error(
        "Free evidence limit reached"
      );
      err.statusCode = 409;
      err.code = "FREE_LIMIT_REACHED";
      throw err;
    }
  }
}

export async function assertWorkspaceAllowsStorageGrowth(params: {
  scope: WorkspaceScope;
  incomingBytes?: bigint | number | null;
}) {
  return assertWorkspaceStorageAvailable(params);
}

export async function assertWorkspaceAllowsReport(scope: WorkspaceScope) {
  const caps = getPlanCapabilities(scope.plan);

  if (!caps.reportsIncluded) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Report generation is not included in the current plan"
    );
    err.statusCode = 409;
    err.code = "REPORT_NOT_INCLUDED";
    throw err;
  }
}

export async function assertWorkspaceAllowsVerificationPackage(
  scope: WorkspaceScope
) {
  const caps = getPlanCapabilities(scope.plan);

  if (!caps.verificationPackageIncluded) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Verification package is not included in the current plan"
    );
    err.statusCode = 409;
    err.code = "VERIFICATION_PACKAGE_NOT_INCLUDED";
    throw err;
  }
}

export async function assertWorkspaceAllowsReportStorage(params: {
  scope: WorkspaceScope;
  incomingBytes?: bigint | number | null;
}) {
  await assertWorkspaceAllowsReport(params.scope);
  return assertWorkspaceStorageAvailable({
    scope: params.scope,
    incomingBytes: params.incomingBytes ?? 0n,
  });
}

export async function assertWorkspaceAllowsVerificationPackageStorage(params: {
  scope: WorkspaceScope;
  incomingBytes?: bigint | number | null;
}) {
  await assertWorkspaceAllowsVerificationPackage(params.scope);
  return assertWorkspaceStorageAvailable({
    scope: params.scope,
    incomingBytes: params.incomingBytes ?? 0n,
  });
}

export async function getWorkspaceAvailableStorageBytes(
  scope: WorkspaceScope
): Promise<bigint> {
  const usage = await assertWorkspaceStorageAvailable({
    scope,
    incomingBytes: 0n,
  });

  return usage.storageBytesRemaining;
}

export async function consumeWorkspaceCompletionCredits(
  scope: WorkspaceScope,
  tx?: EntitlementWriter
) {
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
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Insufficient credits"
    );
    err.statusCode = 402;
    err.code = "INSUFFICIENT_CREDITS";
    throw err;
  }
}

export async function getWorkspaceBillingSummary(scope: WorkspaceScope) {
  const caps = getPlanCapabilities(scope.plan);

  return {
    scope,
    capabilities: caps,
  };
}