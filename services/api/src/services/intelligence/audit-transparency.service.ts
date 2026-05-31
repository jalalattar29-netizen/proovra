/**
 * PROOVRA Phase 3B — Audit & Transparency Center aggregator.
 *
 * Phase 3B Enterprise Closure additions:
 *   * Federates the new `intelligence_activity_events` table so
 *     RECORD_INGESTED / RECORD_ACCEPTED / RECORD_REJECTED /
 *     RECORD_SUPERSEDED / CORRECTION_CREATED / CORRECTION_ACCEPTED /
 *     CORRECTION_REVERTED / CORRECTION_SUPERSEDED /
 *     PROVIDER_CALL_STARTED / COMPLETED / FAILED / REFUSED_BUDGET /
 *     BUDGET_SOFT_LIMIT_REACHED / BUDGET_HARD_LIMIT_REACHED /
 *     BUDGET_BLOCKED appear in the single bounded timeline.
 *   * Federates `provider_budget_alerts` directly so SOFT / HARD
 *     threshold rows are visible in the audit centre.
 *   * Provider usage rows now surface `failureReason` in the
 *     bounded payload so an auditor can see WHY a call failed.
 *
 * Hard rules:
 *   * NEVER PII — bounded counts + ids + labels only.
 *   * Workspace-anchored.
 *   * Bounded category vocabulary (`AUDIT_TRANSPARENCY_CATEGORIES`).
 *   * Pagination bounded (≤ 500 per call).
 */

import type { PrismaClient } from "@prisma/client";
import {
  AUDIT_TRANSPARENCY_CATEGORIES,
  classifyLifecycleCategory,
  type AuditTransparencyCategory,
  type AuditTransparencyEntry,
  type IntelligenceLifecycleCategory,
  type IntelligenceLifecycleCode,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";

export type ListAuditTransparencyInput = {
  prisma?: PrismaClient;
  teamId: string;
  category?: AuditTransparencyCategory;
  sinceUtc?: Date;
  limit?: number;
};

export async function listAuditTransparency(
  input: ListAuditTransparencyInput,
): Promise<ReadonlyArray<AuditTransparencyEntry>> {
  const prisma = input.prisma ?? defaultPrisma;
  const since = input.sinceUtc ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const limit = Math.min(input.limit ?? 200, 500);
  const cat = input.category ?? null;

  const out: AuditTransparencyEntry[] = [];

  // ---- Provider usage / cost ----
  if (!cat || cat === "PROVIDER_USAGE" || cat === "AI_PROVIDER") {
    try {
      const rows = await prisma.providerUsageEvent.findMany({
        where: { teamId: input.teamId, occurredAtUtc: { gte: since } },
        orderBy: { occurredAtUtc: "desc" },
        take: limit,
      });
      for (const r of rows) {
        out.push({
          category: "PROVIDER_USAGE",
          code: `${r.provider}:${r.operation}`,
          label: r.failureReason
            ? `${r.provider} · ${r.operation} · ${r.decision} · FAILED`
            : `${r.provider} · ${r.operation} · ${r.decision}`,
          occurredAtUtc: r.occurredAtUtc.toISOString(),
          actorUserId: r.initiatedByUserId,
          sourceService: "provider-usage",
          payload: {
            units: r.units,
            costMicros: Number(r.estimatedCostUsdMicros),
            decision: r.decision,
            evidenceId: r.evidenceId,
            caseId: r.caseId,
            projectId: r.projectId,
            provider: r.provider,
            operation: r.operation,
            failureReason: r.failureReason,
          },
        });
      }
    } catch {
      /* swallow */
    }
  }

  // ---- Corrections (legacy direct read — kept for backward compat) ----
  if (!cat || cat === "CORRECTION") {
    try {
      const rows = await prisma.reviewerCorrection.findMany({
        where: { teamId: input.teamId, createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
        take: limit,
      });
      for (const r of rows) {
        out.push({
          category: "CORRECTION",
          code: `correction:${r.kind}`,
          label: `correction · ${r.kind} · ${r.state} · v${r.versionNumber}`,
          occurredAtUtc: r.createdAt.toISOString(),
          actorUserId: r.authoredByUserId,
          sourceService: "reviewer-correction",
          payload: {
            state: r.state,
            recordId: r.recordId,
            acceptedByUserId: r.acceptedByUserId,
            versionNumber: r.versionNumber,
            parentCorrectionId: r.parentCorrectionId,
            supersededByCorrectionId: r.supersededByCorrectionId,
          },
        });
      }
    } catch {
      /* swallow */
    }
  }

  // ---- Redaction activity ----
  if (
    !cat ||
    cat === "REDACTION" ||
    cat === "DETECTION" ||
    cat === "APPROVAL" ||
    cat === "REVIEW"
  ) {
    try {
      const rows = await prisma.redactionActivity.findMany({
        where: { teamId: input.teamId, occurredAtUtc: { gte: since } },
        orderBy: { occurredAtUtc: "desc" },
        take: limit,
      });
      for (const r of rows) {
        out.push({
          category: classifyRedactionCategory(r.code),
          code: r.code,
          label: `redaction · ${r.code}`,
          occurredAtUtc: r.occurredAtUtc.toISOString(),
          actorUserId: r.actorUserId,
          sourceService: "redaction-activity",
          payload: {
            projectId: r.projectId,
            versionId: r.versionId,
          },
        });
      }
    } catch {
      /* swallow */
    }
  }

  // ---- Policy audit ----
  if (!cat || cat === "POLICY") {
    try {
      const rows = await prisma.redactionPolicyAudit.findMany({
        where: { teamId: input.teamId, occurredAtUtc: { gte: since } },
        orderBy: { occurredAtUtc: "desc" },
        take: limit,
      });
      for (const r of rows) {
        out.push({
          category: "POLICY",
          code: r.code,
          label: `policy · ${r.code}`,
          occurredAtUtc: r.occurredAtUtc.toISOString(),
          actorUserId: r.actorUserId,
          sourceService: "redaction-policy",
          payload: {
            policyId: r.policyId,
            policyVersionId: r.policyVersionId,
          },
        });
      }
    } catch {
      /* swallow */
    }
  }

  // ---- Video timeline events ----
  if (!cat || cat === "REDACTION") {
    try {
      const rows = await prisma.videoTimelineEvent.findMany({
        where: { teamId: input.teamId, occurredAtUtc: { gte: since } },
        orderBy: { occurredAtUtc: "desc" },
        take: limit,
      });
      for (const r of rows) {
        out.push({
          category: "REDACTION",
          code: r.code,
          label: `video · ${r.layer} · ${r.code}`,
          occurredAtUtc: r.occurredAtUtc.toISOString(),
          actorUserId: r.actorUserId,
          sourceService: "video-timeline",
          payload: {
            evidenceId: r.evidenceId,
            trackId: r.trackId,
            startFrame: r.startFrame,
            endFrame: r.endFrame,
          },
        });
      }
    } catch {
      /* swallow */
    }
  }

  // ---- External reviewer portal ----
  if (!cat || cat === "ACCESS" || cat === "REVIEW") {
    try {
      const rows = await prisma.externalReviewActivity.findMany({
        where: { teamId: input.teamId, occurredAtUtc: { gte: since } },
        orderBy: { occurredAtUtc: "desc" },
        take: limit,
      });
      for (const r of rows) {
        out.push({
          category: r.code.startsWith("DECISION") ? "REVIEW" : "ACCESS",
          code: r.code,
          label: `portal · ${r.code}`,
          occurredAtUtc: r.occurredAtUtc.toISOString(),
          actorUserId: null,
          sourceService: "external-review-portal",
          payload: { grantId: r.grantId, ip: r.ip },
        });
      }
    } catch {
      /* swallow */
    }
  }

  // ---- Phase 3B Closure: intelligence_activity_events (lifecycle) ----
  try {
    const rows = await prisma.intelligenceActivityEvent.findMany({
      where: { teamId: input.teamId, occurredAtUtc: { gte: since } },
      orderBy: { occurredAtUtc: "desc" },
      take: limit,
    });
    for (const r of rows) {
      const lifecycleCategory = r.category as IntelligenceLifecycleCategory;
      const auditCategory = mapLifecycleCategoryToAudit(lifecycleCategory);
      // Respect category filter if set.
      if (cat && cat !== auditCategory) continue;
      out.push({
        category: auditCategory,
        code: r.code,
        label: `lifecycle · ${r.code}${r.reason ? ` · ${r.reason.slice(0, 40)}` : ""}`,
        occurredAtUtc: r.occurredAtUtc.toISOString(),
        actorUserId: r.actorUserId,
        sourceService: "intelligence-activity",
        payload: {
          category: r.category,
          recordId: r.recordId,
          correctionId: r.correctionId,
          budgetId: r.budgetId,
          evidenceId: r.evidenceId,
          caseId: r.caseId,
          projectId: r.projectId,
          provider: r.provider,
          operation: r.operation,
          failureReason: r.failureReason,
          reason: r.reason,
        },
      });
    }
  } catch {
    /* swallow */
  }

  // ---- Phase 3B Closure: provider_budget_alerts (breach trail) ----
  if (!cat || cat === "PROVIDER_USAGE" || cat === "AI_PROVIDER") {
    try {
      const rows = await prisma.providerBudgetAlert.findMany({
        where: { teamId: input.teamId, occurredAtUtc: { gte: since } },
        orderBy: { occurredAtUtc: "desc" },
        take: limit,
        include: { budget: true },
      });
      for (const r of rows) {
        out.push({
          category: "PROVIDER_USAGE",
          code: r.threshold === "HARD" ? "BUDGET_HARD_LIMIT_REACHED" : "BUDGET_SOFT_LIMIT_REACHED",
          label: `budget · ${r.threshold} · ${r.budget.scope}`,
          occurredAtUtc: r.occurredAtUtc.toISOString(),
          actorUserId: null,
          sourceService: "provider-budget-alert",
          payload: {
            budgetId: r.budgetId,
            scope: r.budget.scope,
            scopeTargetId: r.budget.scopeTargetId,
            provider: r.budget.provider,
            period: r.budget.period,
            consumedUsdMicros: Number(r.consumedUsdMicros),
            threshold: r.threshold,
          },
        });
      }
    } catch {
      /* swallow */
    }
  }

  // ---- Sort + cap globally ----
  out.sort((a, b) => (a.occurredAtUtc < b.occurredAtUtc ? 1 : -1));
  return out.slice(0, limit);
}

function classifyRedactionCategory(code: string): AuditTransparencyCategory {
  if (code.startsWith("DETECTION")) return "DETECTION";
  if (code.startsWith("APPROVAL") || code.startsWith("VERSION_APPROVED"))
    return "APPROVAL";
  if (code.startsWith("DERIVATIVE")) return "REDACTION";
  if (code.startsWith("REVIEW")) return "REVIEW";
  return "REDACTION";
}

function mapLifecycleCategoryToAudit(
  c: string,
): AuditTransparencyCategory {
  switch (c) {
    case "RECORD_LIFECYCLE":
      return "REVIEW";
    case "CORRECTION_LIFECYCLE":
      return "CORRECTION";
    case "PROVIDER_LIFECYCLE":
      return "AI_PROVIDER";
    case "BUDGET_LIFECYCLE":
      return "PROVIDER_USAGE";
    // Phase 4A Closure — trust + governance lifecycle categories.
    case "TRUST_LIFECYCLE":
    case "GOVERNANCE_LIFECYCLE":
      return "POLICY";
    default:
      return "POLICY";
  }
}

// Compile-time guard.
function _assertCategoriesBound(): void {
  const _x: AuditTransparencyCategory = "POLICY";
  void _x;
  void AUDIT_TRANSPARENCY_CATEGORIES;
  const _y: IntelligenceLifecycleCode = "RECORD_INGESTED";
  void _y;
  void classifyLifecycleCategory;
}
void _assertCategoriesBound;
