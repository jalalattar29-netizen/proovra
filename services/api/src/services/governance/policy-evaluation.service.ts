/**
 * PROOVRA Phase 4A Closure — Real runtime policy evaluation engine.
 *
 * This is the missing teeth behind the six governance policy kinds:
 * SECURITY / RETENTION / REVIEW / REDACTION / INTELLIGENCE /
 * VERIFICATION. Before this service, policies could be authored,
 * assigned, and inherited — but at decision time nothing actually
 * consulted them. This module is that consultation surface.
 *
 * Every evaluator:
 *   * Loads the effective policy set for the workspace via
 *     `resolveEffectivePolicies` (org → dept → workspace inheritance
 *     with override).
 *   * Walks each policy's `rule` JSON against the call's context.
 *   * Combines per-policy decisions using strictest-wins:
 *     BLOCK > WARN > ALLOW.
 *   * Emits a `POLICY_EVALUATED` audit row on every call.
 *   * Emits a `POLICY_WARNING` audit row when the combined verdict is
 *     WARN, and `POLICY_BLOCK` + `POLICY_VIOLATION` when the combined
 *     verdict is BLOCK. The governance dashboard counts these last two
 *     codes for the policy-violations widget.
 *
 * Hard rules:
 *   * Bounded reasons — short snake-case chips, never raw rule JSON,
 *     never PII.
 *   * Audit-only enforcement maps to ALLOW (the audit row is the
 *     consequence).
 *   * Failure to load policies degrades to ALLOW with a bounded
 *     reason — never a 5xx — but still emits an audit row.
 *   * Single canonical write path: `emitPolicyAudit` (governance audit
 *     table). The dashboard already counts POLICY_BLOCK +
 *     POLICY_VIOLATION there.
 *
 * Redaction is bridged to the Phase 3A redaction policy engine; this
 * evaluator returns ALLOW with a bounded reason chip so callers can
 * still uniformly funnel through this surface without bypassing the
 * dedicated engine.
 */

import type { PrismaClient } from "@prisma/client";
import {
  POLICY_EVALUATION_DECISIONS,
  type GovernancePolicyEnforcementMode,
  type GovernancePolicyProjection,
  type PolicyEvaluationDecision,
  type PolicyEvaluationResult,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import {
  emitPolicyAudit,
  resolveEffectivePolicies,
} from "./governance-policy.service.js";

// ===========================================================================
// Internal helpers
// ===========================================================================

const DECISION_STRENGTH: Record<PolicyEvaluationDecision, number> = {
  ALLOW: 0,
  WARN: 1,
  BLOCK: 2,
};

/**
 * Map an enforcement mode to a `PolicyEvaluationResult` for a given
 * violated rule. AUDIT_ONLY degrades to ALLOW because the audit row
 * is the consequence.
 */
export function applyEnforcementMode(
  mode: GovernancePolicyEnforcementMode,
  reason: string,
  policyId: string,
): PolicyEvaluationResult {
  switch (mode) {
    case "BLOCK":
      return { decision: "BLOCK", reason, policyId };
    case "WARN":
      return { decision: "WARN", reason, policyId };
    case "AUDIT_ONLY":
    default:
      return { decision: "ALLOW", reason, policyId };
  }
}

/**
 * Combine the running strictest decision with a candidate result.
 * Strictest wins (BLOCK > WARN > ALLOW). On a tie, the first wins so
 * the earliest authoritative policy (typically org-scope) keeps the
 * audit lineage stable.
 */
function combine(
  running: PolicyEvaluationResult,
  candidate: PolicyEvaluationResult,
): PolicyEvaluationResult {
  if (DECISION_STRENGTH[candidate.decision] > DECISION_STRENGTH[running.decision]) {
    return candidate;
  }
  return running;
}

function defaultAllow(): PolicyEvaluationResult {
  return { decision: "ALLOW", reason: null, policyId: null };
}

function ruleObject(policy: GovernancePolicyProjection): Record<string, unknown> {
  const r = policy.rule as unknown;
  if (r && typeof r === "object" && !Array.isArray(r)) {
    return r as Record<string, unknown>;
  }
  return {};
}

function ruleBool(rule: Record<string, unknown>, key: string): boolean {
  return rule[key] === true;
}

function ruleNumber(rule: Record<string, unknown>, key: string): number | null {
  const v = rule[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

function ruleStringArray(
  rule: Record<string, unknown>,
  key: string,
): ReadonlyArray<string> | null {
  const v = rule[key];
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
    return v as ReadonlyArray<string>;
  }
  return null;
}

function ruleString(rule: Record<string, unknown>, key: string): string | null {
  const v = rule[key];
  return typeof v === "string" ? v : null;
}

/**
 * Bounded confidence-band order. Higher index = stronger band.
 */
const CONFIDENCE_BAND_ORDER: ReadonlyArray<string> = ["LOW", "MEDIUM", "HIGH"];
function confidenceBandRank(band: string | null | undefined): number {
  if (!band) return -1;
  const idx = CONFIDENCE_BAND_ORDER.indexOf(band);
  return idx;
}

/**
 * Bounded reason guard. Trims to <=80 chars; strips non snake-case
 * characters so we cannot accidentally leak rule contents or PII.
 */
function boundReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return reason
    .toLowerCase()
    .replace(/[^a-z0-9_:.-]/g, "_")
    .slice(0, 80);
}

/**
 * Single canonical post-processing path used by every evaluator —
 * emits the POLICY_EVALUATED row and, on strict outcomes, the
 * POLICY_WARNING / POLICY_BLOCK + POLICY_VIOLATION rows. Audit
 * failures are swallowed inside `emitPolicyAudit` so they cannot
 * break the calling operational path.
 */
async function emitEvaluationAudit(
  prisma: PrismaClient,
  teamId: string,
  surface: string,
  result: PolicyEvaluationResult,
  context: string | null,
): Promise<void> {
  // `policyId` is required on the audit row; when no policy is in
  // play (no effective set, or a clean ALLOW) we anchor to a stable
  // sentinel so the audit stream still tells the full story.
  const policyIdForAudit = result.policyId ?? "00000000-0000-0000-0000-000000000000";
  const baseReason = boundReason(
    `${surface}:${result.decision.toLowerCase()}${
      result.reason ? `:${result.reason}` : ""
    }${context ? `:${context}` : ""}`,
  );
  await emitPolicyAudit({
    prisma,
    teamId,
    policyId: policyIdForAudit,
    code: "POLICY_EVALUATED",
    actorUserId: null,
    reason: baseReason,
  });
  if (result.decision === "WARN") {
    await emitPolicyAudit({
      prisma,
      teamId,
      policyId: policyIdForAudit,
      code: "POLICY_WARNING",
      actorUserId: null,
      reason: baseReason,
    });
  }
  if (result.decision === "BLOCK") {
    await emitPolicyAudit({
      prisma,
      teamId,
      policyId: policyIdForAudit,
      code: "POLICY_BLOCK",
      actorUserId: null,
      reason: baseReason,
    });
    await emitPolicyAudit({
      prisma,
      teamId,
      policyId: policyIdForAudit,
      code: "POLICY_VIOLATION",
      actorUserId: null,
      reason: baseReason,
    });
  }
}

async function loadEffective(
  prisma: PrismaClient,
  teamId: string,
  kind:
    | "SECURITY"
    | "RETENTION"
    | "REVIEW"
    | "REDACTION"
    | "INTELLIGENCE"
    | "VERIFICATION",
  scope: {
    organizationId?: string | null;
    departmentId?: string | null;
    workspaceId?: string | null;
  },
): Promise<ReadonlyArray<GovernancePolicyProjection>> {
  try {
    return await resolveEffectivePolicies({
      prisma,
      teamId,
      organizationId: scope.organizationId ?? null,
      departmentId: scope.departmentId ?? null,
      workspaceId: scope.workspaceId ?? teamId,
      kind,
    });
  } catch {
    return [];
  }
}

// ===========================================================================
// SECURITY
// ===========================================================================

export type EvaluateSecurityPolicyInput = {
  prisma?: PrismaClient;
  teamId: string;
  userId: string;
  action: string;
  mfaSatisfied?: boolean;
  samlAuthenticated?: boolean;
  organizationId?: string | null;
  departmentId?: string | null;
  workspaceId?: string | null;
};

export async function evaluateSecurityPolicy(
  input: EvaluateSecurityPolicyInput,
): Promise<PolicyEvaluationResult> {
  const prisma = input.prisma ?? defaultPrisma;
  const policies = await loadEffective(prisma, input.teamId, "SECURITY", {
    organizationId: input.organizationId,
    departmentId: input.departmentId,
    workspaceId: input.workspaceId,
  });

  let result: PolicyEvaluationResult = defaultAllow();
  for (const policy of policies) {
    const rule = ruleObject(policy);

    if (ruleBool(rule, "requireMfa") && !input.mfaSatisfied) {
      result = combine(
        result,
        applyEnforcementMode(policy.enforcementMode, "mfa_required", policy.id),
      );
      continue;
    }
    if (ruleBool(rule, "requireSaml") && !input.samlAuthenticated) {
      result = combine(
        result,
        applyEnforcementMode(policy.enforcementMode, "saml_required", policy.id),
      );
      continue;
    }
    const allowedActions = ruleStringArray(rule, "allowedActions");
    if (allowedActions && !allowedActions.includes(input.action)) {
      result = combine(
        result,
        applyEnforcementMode(
          policy.enforcementMode,
          "action_not_allowed",
          policy.id,
        ),
      );
    }
  }

  await emitEvaluationAudit(
    prisma,
    input.teamId,
    "security",
    result,
    `action=${boundReason(input.action) ?? "unknown"}`,
  );
  return result;
}

// ===========================================================================
// RETENTION
// ===========================================================================

export type EvaluateRetentionPolicyInput = {
  prisma?: PrismaClient;
  teamId: string;
  evidenceId: string;
  action: "DELETE" | "ARCHIVE" | "EXPORT";
  organizationId?: string | null;
  departmentId?: string | null;
  workspaceId?: string | null;
};

export async function evaluateRetentionPolicy(
  input: EvaluateRetentionPolicyInput,
): Promise<PolicyEvaluationResult> {
  const prisma = input.prisma ?? defaultPrisma;
  const policies = await loadEffective(prisma, input.teamId, "RETENTION", {
    organizationId: input.organizationId,
    departmentId: input.departmentId,
    workspaceId: input.workspaceId,
  });

  let result: PolicyEvaluationResult = defaultAllow();

  // Load only what we strictly need for the decision: createdAt (age)
  // and unresolved legal-hold count. Both are bounded scalars — no
  // raw rule contents land in the audit payload.
  let ageDays: number | null = null;
  let hasUnresolvedLegalHold = false;
  try {
    const evidence = await prisma.evidence.findFirst({
      where: { id: input.evidenceId, teamId: input.teamId },
      select: { createdAt: true },
    });
    if (evidence?.createdAt) {
      const ms = Date.now() - evidence.createdAt.getTime();
      ageDays = Math.floor(ms / (1000 * 60 * 60 * 24));
    }
    const holdCount = await prisma.evidenceLegalHold.count({
      where: {
        evidenceId: input.evidenceId,
        teamId: input.teamId,
        status: "ACTIVE",
      },
    });
    hasUnresolvedLegalHold = holdCount > 0;
  } catch {
    /* swallow — degrade to policy-only evaluation */
  }

  for (const policy of policies) {
    const rule = ruleObject(policy);

    const minDays = ruleNumber(rule, "minRetentionDays");
    if (
      minDays !== null &&
      ageDays !== null &&
      ageDays < minDays
    ) {
      result = combine(
        result,
        applyEnforcementMode(
          policy.enforcementMode,
          "min_retention_not_met",
          policy.id,
        ),
      );
    }
    if (
      ruleBool(rule, "requireLegalHoldCheck") &&
      hasUnresolvedLegalHold
    ) {
      result = combine(
        result,
        applyEnforcementMode(
          policy.enforcementMode,
          "legal_hold_active",
          policy.id,
        ),
      );
    }
  }

  await emitEvaluationAudit(
    prisma,
    input.teamId,
    "retention",
    result,
    `action=${input.action.toLowerCase()}`,
  );
  return result;
}

// ===========================================================================
// REVIEW
// ===========================================================================

export type EvaluateReviewPolicyInput = {
  prisma?: PrismaClient;
  teamId: string;
  workflowId: string;
  decision: string;
  organizationId?: string | null;
  departmentId?: string | null;
  workspaceId?: string | null;
};

export async function evaluateReviewPolicy(
  input: EvaluateReviewPolicyInput,
): Promise<PolicyEvaluationResult> {
  const prisma = input.prisma ?? defaultPrisma;
  const policies = await loadEffective(prisma, input.teamId, "REVIEW", {
    organizationId: input.organizationId,
    departmentId: input.departmentId,
    workspaceId: input.workspaceId,
  });

  let result: PolicyEvaluationResult = defaultAllow();

  // Bounded look-ups: QC verdict for this workflow + number of
  // distinct reviewers who have posted a decision.
  let qcPassed = false;
  let approverCount = 0;
  try {
    const qc = await prisma.qcSample.findFirst({
      where: { workflowId: input.workflowId, teamId: input.teamId },
      select: { verdict: true },
    });
    qcPassed = qc?.verdict === "PASS";
    const decisions = await prisma.workflowReviewDecision.findMany({
      where: { workflowId: input.workflowId, teamId: input.teamId },
      select: { reviewerUserId: true },
    });
    const reviewers = new Set<string>();
    for (const d of decisions) reviewers.add(d.reviewerUserId);
    approverCount = reviewers.size;
  } catch {
    /* swallow — degrade to policy-only evaluation */
  }

  const isApprove = input.decision === "APPROVE";

  for (const policy of policies) {
    const rule = ruleObject(policy);

    if (ruleBool(rule, "requireQc") && isApprove && !qcPassed) {
      result = combine(
        result,
        applyEnforcementMode(
          policy.enforcementMode,
          "qc_pass_required",
          policy.id,
        ),
      );
    }
    if (ruleBool(rule, "requireDualApproval") && approverCount < 2) {
      result = combine(
        result,
        applyEnforcementMode(
          policy.enforcementMode,
          "dual_approval_required",
          policy.id,
        ),
      );
    }
  }

  await emitEvaluationAudit(
    prisma,
    input.teamId,
    "review",
    result,
    `decision=${boundReason(input.decision) ?? "unknown"}`,
  );
  return result;
}

// ===========================================================================
// INTELLIGENCE
// ===========================================================================

export type EvaluateIntelligencePolicyInput = {
  prisma?: PrismaClient;
  teamId: string;
  provider: string;
  operation: string;
  evidenceId?: string | null;
  organizationId?: string | null;
  departmentId?: string | null;
  workspaceId?: string | null;
};

export async function evaluateIntelligencePolicy(
  input: EvaluateIntelligencePolicyInput,
): Promise<PolicyEvaluationResult> {
  const prisma = input.prisma ?? defaultPrisma;
  const policies = await loadEffective(prisma, input.teamId, "INTELLIGENCE", {
    organizationId: input.organizationId,
    departmentId: input.departmentId,
    workspaceId: input.workspaceId,
  });

  let result: PolicyEvaluationResult = defaultAllow();

  // Highest confidence band recorded against the evidence (if any).
  // We only need the bounded enum value — not the raw score.
  let recordBand: string | null = null;
  if (input.evidenceId) {
    try {
      const rec = await prisma.mediaIntelligenceRecord
        .findFirst({
          where: {
            evidenceId: input.evidenceId,
            teamId: input.teamId,
          },
          select: { finalConfidenceBand: true },
          orderBy: { createdAt: "desc" },
        })
        .catch(() => null);
      recordBand = (rec?.finalConfidenceBand as string | null) ?? null;
    } catch {
      /* swallow — degrade gracefully */
    }
  }

  for (const policy of policies) {
    const rule = ruleObject(policy);

    const disallowedProviders = ruleStringArray(rule, "disallowedProviders");
    if (disallowedProviders && disallowedProviders.includes(input.provider)) {
      result = combine(
        result,
        applyEnforcementMode(
          policy.enforcementMode,
          "provider_disallowed",
          policy.id,
        ),
      );
    }
    const disallowedOperations = ruleStringArray(rule, "disallowedOperations");
    if (
      disallowedOperations &&
      disallowedOperations.includes(input.operation)
    ) {
      result = combine(
        result,
        applyEnforcementMode(
          policy.enforcementMode,
          "operation_disallowed",
          policy.id,
        ),
      );
    }
    const minBand = ruleString(rule, "minConfidenceBand");
    if (
      minBand &&
      recordBand !== null &&
      confidenceBandRank(recordBand) < confidenceBandRank(minBand)
    ) {
      result = combine(
        result,
        applyEnforcementMode(
          policy.enforcementMode,
          "confidence_below_band",
          policy.id,
        ),
      );
    }
  }

  await emitEvaluationAudit(
    prisma,
    input.teamId,
    "intelligence",
    result,
    `provider=${boundReason(input.provider) ?? "unknown"}:op=${
      boundReason(input.operation) ?? "unknown"
    }`,
  );
  return result;
}

// ===========================================================================
// VERIFICATION
// ===========================================================================

export type EvaluateVerificationPolicyInput = {
  prisma?: PrismaClient;
  teamId: string;
  evidenceId: string;
  action: "PUBLISH_PACKAGE" | "PUBLIC_VERIFY_EXPOSE";
  organizationId?: string | null;
  departmentId?: string | null;
  workspaceId?: string | null;
};

export async function evaluateVerificationPolicy(
  input: EvaluateVerificationPolicyInput,
): Promise<PolicyEvaluationResult> {
  const prisma = input.prisma ?? defaultPrisma;
  const policies = await loadEffective(prisma, input.teamId, "VERIFICATION", {
    organizationId: input.organizationId,
    departmentId: input.departmentId,
    workspaceId: input.workspaceId,
  });

  let result: PolicyEvaluationResult = defaultAllow();

  // Bounded check: do we have at least one published TRUST_CENTER
  // article? We only need a count — never article contents.
  let publishedTrustArticleCount = 0;
  try {
    publishedTrustArticleCount = await prisma.trustCenterArticle.count({
      where: {
        teamId: input.teamId,
        kind: "TRUST_CENTER",
        state: "PUBLISHED",
      },
    });
  } catch {
    /* swallow — degrade gracefully */
  }

  for (const policy of policies) {
    const rule = ruleObject(policy);

    if (
      ruleBool(rule, "requireTrustReferences") &&
      publishedTrustArticleCount === 0
    ) {
      result = combine(
        result,
        applyEnforcementMode(
          policy.enforcementMode,
          "trust_references_missing",
          policy.id,
        ),
      );
    }
    if (
      ruleBool(rule, "blockedPublicExposure") &&
      input.action === "PUBLIC_VERIFY_EXPOSE"
    ) {
      result = combine(
        result,
        applyEnforcementMode(
          policy.enforcementMode,
          "public_exposure_blocked",
          policy.id,
        ),
      );
    }
  }

  await emitEvaluationAudit(
    prisma,
    input.teamId,
    "verification",
    result,
    `action=${input.action.toLowerCase()}`,
  );
  return result;
}

// ===========================================================================
// REDACTION — bridge to the Phase 3A redaction policy engine
// ===========================================================================

export type EvaluateRedactionPolicyInput = {
  prisma?: PrismaClient;
  teamId: string;
  evidenceId: string;
  organizationId?: string | null;
  departmentId?: string | null;
  workspaceId?: string | null;
};

/**
 * Redaction decisions are made by the dedicated Phase 3A redaction
 * policy engine; this evaluator is a uniform funnel so callers can
 * still route through the same surface as the other five kinds. It
 * intentionally returns ALLOW with a bounded reason chip — the
 * Phase 3A engine remains authoritative.
 */
export async function evaluateRedactionPolicy(
  input: EvaluateRedactionPolicyInput,
): Promise<PolicyEvaluationResult> {
  const prisma = input.prisma ?? defaultPrisma;
  const result: PolicyEvaluationResult = {
    decision: "ALLOW",
    reason: "redaction_governed_by_phase_3a_engine",
    policyId: null,
  };
  await emitEvaluationAudit(
    prisma,
    input.teamId,
    "redaction",
    result,
    null,
  );
  return result;
}

// ===========================================================================
// Compile-time guard — keeps the bounded decision vocabulary honest.
// ===========================================================================

function _assertVocabularyIntact(): void {
  const _d: PolicyEvaluationDecision = "ALLOW";
  void _d;
  void POLICY_EVALUATION_DECISIONS;
}
void _assertVocabularyIntact;
