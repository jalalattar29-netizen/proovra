/**
 * PHASE 5 §8.5 (2026-07-22) — portal grant→workflow scope binding.
 *
 * An external-review grant is scoped to EXACTLY ONE resource
 * (EVIDENCE | CASE | PACKAGE). Before this module, the portal workflow
 * routes bound only (teamId, workflowId-from-URL), so a reviewer
 * invited to Evidence A could comment on / decide / read decisions of
 * ANY workflow in the workspace — a within-tenant scope escalation.
 *
 * `resolveWorkflowInGrantScope` is the ONE gate: it loads the workflow
 * inside the grant's tenant and proves the workflow's evidence is the
 * grant's scope target (directly for EVIDENCE, via the package's
 * evidence for PACKAGE, via CaseEvidenceLink for CASE). Everything else
 * is OUT_OF_SCOPE — the same denial as "does not exist" so workflow ids
 * are not enumerable through the portal.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";

export type PortalGrantScope = {
  teamId: string;
  scopeKind: "EVIDENCE" | "CASE" | "PACKAGE";
  evidenceId: string | null;
  caseId: string | null;
  packageId: string | null;
};

export async function resolveWorkflowInGrantScope(input: {
  prisma?: PrismaClient;
  scope: PortalGrantScope;
  workflowId: string;
}): Promise<{ ok: true; evidenceId: string } | { ok: false }> {
  const prisma = input.prisma ?? defaultPrisma;
  const { scope, workflowId } = input;

  const workflow = await prisma.evidenceReviewWorkflow.findFirst({
    where: { id: workflowId, teamId: scope.teamId },
    select: { evidenceId: true },
  });
  if (!workflow) return { ok: false };

  switch (scope.scopeKind) {
    case "EVIDENCE":
      return scope.evidenceId !== null &&
        workflow.evidenceId === scope.evidenceId
        ? { ok: true, evidenceId: workflow.evidenceId }
        : { ok: false };
    case "PACKAGE": {
      if (!scope.packageId) return { ok: false };
      const pkg = await prisma.verificationPackage.findFirst({
        where: { id: scope.packageId },
        select: { evidenceId: true },
      });
      return pkg && pkg.evidenceId === workflow.evidenceId
        ? { ok: true, evidenceId: workflow.evidenceId }
        : { ok: false };
    }
    case "CASE": {
      if (!scope.caseId) return { ok: false };
      const link = await prisma.caseEvidenceLink.findFirst({
        where: {
          teamId: scope.teamId,
          caseId: scope.caseId,
          evidenceId: workflow.evidenceId,
        },
        select: { id: true },
      });
      return link
        ? { ok: true, evidenceId: workflow.evidenceId }
        : { ok: false };
    }
    default:
      return { ok: false };
  }
}
