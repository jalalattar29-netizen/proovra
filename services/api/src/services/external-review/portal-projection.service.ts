/**
 * PROOVRA Phase 2B — Portal dashboard projection.
 *
 * Bounded single read that assembles the portal's dashboard for an
 * authenticated session. Returns the `ExternalPortalProjection`
 * shape consumed verbatim by the portal UI.
 */

import type { PrismaClient } from "@prisma/client";
import {
  EXTERNAL_PORTAL_LIMITATIONS,
  EXTERNAL_PORTAL_SCHEMA_VERSION,
  externalPortalCapabilitiesForRole,
  type ExternalPortalProjection,
  type ExternalReviewerRole,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { buildSignedWatermark } from "./portal-watermark.service.js";
import type { PortalSessionContext } from "./portal-session.service.js";

export async function projectPortalDashboard(input: {
  prisma?: PrismaClient;
  session: PortalSessionContext;
}): Promise<ExternalPortalProjection> {
  const prisma = input.prisma ?? defaultPrisma;
  const s = input.session;

  // Resolve assigned workflows from the grant scope.
  let assignedWorkflows: Array<{
    id: string;
    evidenceId: string;
    dueAt: Date | null;
  }> = [];
  if (s.scopeKind === "EVIDENCE" && s.evidenceId) {
    assignedWorkflows = await prisma.evidenceReviewWorkflow.findMany({
      where: { teamId: s.teamId, evidenceId: s.evidenceId },
      orderBy: { dueAt: "asc" },
      take: 200,
      select: { id: true, evidenceId: true, dueAt: true },
    });
  } else if (s.scopeKind === "CASE" && s.caseId) {
    // The workflow is per-evidence; join via case assignments.
    const caseAssignments = await prisma.caseEvidenceLink.findMany({
      where: { caseId: s.caseId },
      select: { evidenceId: true },
      take: 500,
    }).catch(() => []);
    const ids = caseAssignments.map((a) => a.evidenceId);
    if (ids.length > 0) {
      assignedWorkflows = await prisma.evidenceReviewWorkflow.findMany({
        where: { teamId: s.teamId, evidenceId: { in: ids } },
        orderBy: { dueAt: "asc" },
        take: 200,
        select: { id: true, evidenceId: true, dueAt: true },
      });
    }
  }

  // Pull recorded external decisions to mark completed entries.
  const decisions = await prisma.externalReviewDecision.findMany({
    where: { teamId: s.teamId, grantId: s.grantId },
    select: { workflowId: true, submittedAtUtc: true },
    take: 500,
  });
  const decidedMap = new Map<string, Date>(
    decisions.map((d: (typeof decisions)[number]) => [d.workflowId, d.submittedAtUtc]),
  );

  const assigned = assignedWorkflows.map((w) => ({
    workflowId: w.id,
    evidenceId: w.evidenceId,
    title: null as string | null,
    dueAt: w.dueAt ? w.dueAt.toISOString() : null,
    submittedDecisionAtUtc: decidedMap.has(w.id)
      ? decidedMap.get(w.id)!.toISOString()
      : null,
  }));

  const completedCount = assigned.filter((a) => a.submittedDecisionAtUtc !== null)
    .length;
  const pendingCount = assigned.length - completedCount;

  const watermark =
    s.watermarkPolicy === "NEVER"
      ? null
      : buildSignedWatermark({
          grantId: s.grantId,
          sessionId: s.sessionId,
          reviewerEmail: s.reviewerEmail,
          reviewerDisplayName: s.reviewerDisplayName,
          organization: s.organization,
          evidenceId: s.evidenceId,
          grantExpiresAtUtc: s.expiresAtUtc,
        });

  const role = (s.role as ExternalReviewerRole) ?? "EXTERNAL_REVIEWER";

  const proj: ExternalPortalProjection = {
    schemaVersion: EXTERNAL_PORTAL_SCHEMA_VERSION,
    generatedAtUtc: new Date().toISOString(),
    reviewer: {
      grantId: s.grantId,
      email: s.reviewerEmail,
      displayName: s.reviewerDisplayName,
      organization: s.organization,
      role,
      capabilities: Array.from(externalPortalCapabilitiesForRole(role)),
    },
    scope: {
      kind: s.scopeKind,
      label:
        s.scopeKind === "EVIDENCE"
          ? `Evidence ${s.evidenceId?.slice(0, 8) ?? ""}…`
          : s.scopeKind === "CASE"
          ? `Case ${s.caseId?.slice(0, 8) ?? ""}…`
          : `Package ${s.packageId?.slice(0, 8) ?? ""}…`,
      expiresAtUtc: s.expiresAtUtc.toISOString(),
    },
    assigned,
    completedCount,
    pendingCount,
    totalCount: assigned.length,
    watermark: {
      policy: s.watermarkPolicy as "ALWAYS" | "BYTES_ONLY" | "NEVER",
      signedToken: watermark,
    },
    session: {
      sessionId: s.sessionId,
      inactivityTimeoutMs: s.inactivityTimeoutMs,
      maxSessionMs: s.maxSessionMs,
      // Phase 2B Closure — surface federation + adaptive auth.
      authMethod: s.authMethod,
      ssoConnectionId: s.ssoConnectionId,
      ssoSubjectHash: s.ssoSubjectHash,
      mfaRequired: s.mfaRequired,
      mfaSatisfied: s.mfaSatisfied,
    },
    limitations: EXTERNAL_PORTAL_LIMITATIONS,
  };
  return proj;
}
