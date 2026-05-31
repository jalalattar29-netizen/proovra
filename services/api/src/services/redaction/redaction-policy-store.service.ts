/**
 * PROOVRA Phase 3A Elite Closure — Prisma-backed policy store.
 *
 * Real persistence layer for the Redaction Policy Engine. Replaces
 * the Phase 3A Closure in-memory cache. Provides:
 *
 *   * `createPolicy` / `archivePolicy`
 *   * `createPolicyVersion` (append-only ordinal)
 *   * `transitionPolicyVersion` (bounded state machine driven by
 *     REDACTION_POLICY_VERSION_TRANSITIONS)
 *   * `assignPolicyVersion` / `revokePolicyAssignment`
 *   * `listPolicies` + `listPolicyVersions` + `listAssignmentsForScope`
 *   * `resolveEffectivePolicy` — bounded inheritance resolver
 *     (GLOBAL → WORKSPACE → CASE → PROJECT with deterministic
 *     precedence).
 *   * `appendPolicyAudit` — bounded audit emitter shared by every
 *     transition.
 *
 * Hard rules:
 *   * Workspace-anchored at every entry point.
 *   * Append-only versions; PUBLISH atomically supersedes the prior
 *     PUBLISHED row inside a `$transaction`.
 *   * Policy publication requires DRAFT → IN_REVIEW → APPROVED →
 *     PUBLISHED with separation of duties enforced server-side.
 *   * NEVER default-deny: missing provider/kind entries mean
 *     enabled. The orchestrator's `isPolicyAllowed` reads the
 *     resolved effective policy and refuses ONLY when an explicit
 *     `false` is recorded.
 */

import type { PrismaClient } from "@prisma/client";

import {
  POLICY_ASSIGNMENT_PRECEDENCE,
  POLICY_ASSIGNMENT_SCOPES,
  POLICY_DETECTION_RULE_ACTIONS,
  REDACTION_POLICY_ACTIVITY_CODES,
  REDACTION_POLICY_DOCUMENT_SCHEMA_VERSION,
  REDACTION_POLICY_VERSION_STATES,
  REDACTION_POLICY_VERSION_TRANSITIONS,
  isAllowedPolicyVersionTransition,
  type EffectivePolicy,
  type PolicyAssignmentScope,
  type PolicyCustomRegexRule,
  type PolicyDetectionRuleAction,
  type RedactionDenialReason,
  type RedactionDetectionKind,
  type RedactionDetectionProvider,
  type RedactionPolicyActivityCode,
  type RedactionPolicyDocument,
  type RedactionPolicyVersionState,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CreatePolicyInput = {
  prisma?: PrismaClient;
  teamId: string;
  name: string;
  description?: string | null;
  createdByUserId: string;
};

export type CreatePolicyResult =
  | { ok: true; policyId: string }
  | { ok: false; denial: RedactionDenialReason };

export type CreatePolicyVersionInput = {
  prisma?: PrismaClient;
  teamId: string;
  policyId: string;
  authoredByUserId: string;
  rationale?: string | null;
  document: RedactionPolicyDocument;
};

export type CreatePolicyVersionResult =
  | { ok: true; policyVersionId: string; versionOrdinal: number }
  | { ok: false; denial: RedactionDenialReason };

export type TransitionPolicyVersionInput = {
  prisma?: PrismaClient;
  teamId: string;
  policyVersionId: string;
  toState: RedactionPolicyVersionState;
  actorUserId: string;
  rationale?: string | null;
};

export type TransitionPolicyVersionResult =
  | {
      ok: true;
      from: RedactionPolicyVersionState;
      to: RedactionPolicyVersionState;
    }
  | { ok: false; denial: RedactionDenialReason };

export type AssignPolicyVersionInput = {
  prisma?: PrismaClient;
  teamId: string;
  policyVersionId: string;
  scope: PolicyAssignmentScope;
  scopeTargetId: string | null;
  assignedByUserId: string;
  rationale?: string | null;
};

export type AssignPolicyVersionResult =
  | { ok: true; assignmentId: string }
  | { ok: false; denial: RedactionDenialReason };

// ---------------------------------------------------------------------------
// Internal — document normalisation + validation
// ---------------------------------------------------------------------------

function normaliseDocument(doc: RedactionPolicyDocument): RedactionPolicyDocument {
  const customRules = (doc.customRules ?? []).filter(isValidCustomRule).slice(0, 200);
  const ruleActions: Partial<
    Record<RedactionDetectionKind, PolicyDetectionRuleAction>
  > = {};
  for (const [k, v] of Object.entries(doc.ruleActions ?? {})) {
    if ((POLICY_DETECTION_RULE_ACTIONS as ReadonlyArray<string>).includes(v as string)) {
      ruleActions[k as RedactionDetectionKind] =
        v as PolicyDetectionRuleAction;
    }
  }
  return {
    schemaVersion: REDACTION_POLICY_DOCUMENT_SCHEMA_VERSION,
    providers: doc.providers ?? {},
    kinds: doc.kinds ?? {},
    ruleActions,
    customRules,
  };
}

function isValidCustomRule(r: PolicyCustomRegexRule): boolean {
  if (!r || typeof r !== "object") return false;
  if (!r.name || r.name.length > 80) return false;
  if (!r.pattern || r.pattern.length > 400) return false;
  if (typeof r.rawConfidence !== "number" || r.rawConfidence < 0 || r.rawConfidence > 1) {
    return false;
  }
  if (!(POLICY_DETECTION_RULE_ACTIONS as ReadonlyArray<string>).includes(r.action)) {
    return false;
  }
  if (r.flags && /[^imsu]/.test(r.flags)) return false;
  try {
    new RegExp(r.pattern, r.flags ?? "");
  } catch {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Policy CRUD
// ---------------------------------------------------------------------------

export async function createPolicy(
  input: CreatePolicyInput,
): Promise<CreatePolicyResult> {
  const prisma = input.prisma ?? defaultPrisma;
  if (!input.name || input.name.length > 180) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  try {
    const created = await prisma.redactionPolicy.create({
      data: {
        teamId: input.teamId,
        name: input.name.trim(),
        description: input.description?.slice(0, 600) ?? null,
        createdByUserId: input.createdByUserId,
      },
      select: { id: true },
    });
    await appendPolicyAudit({
      prisma,
      teamId: input.teamId,
      policyId: created.id,
      code: "POLICY_CREATED",
      actorUserId: input.createdByUserId,
      payload: { name: input.name },
    });
    return { ok: true, policyId: created.id };
  } catch {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
}

export async function archivePolicy(input: {
  prisma?: PrismaClient;
  teamId: string;
  policyId: string;
  actorUserId: string;
}): Promise<{ ok: true } | { ok: false; denial: RedactionDenialReason }> {
  const prisma = input.prisma ?? defaultPrisma;
  const updated = await prisma.redactionPolicy.updateMany({
    where: { id: input.policyId, teamId: input.teamId, archivedAt: null },
    data: { archivedAt: new Date() },
  });
  if (updated.count === 0) {
    return { ok: false, denial: "PROJECT_NOT_FOUND" };
  }
  await appendPolicyAudit({
    prisma,
    teamId: input.teamId,
    policyId: input.policyId,
    code: "POLICY_ARCHIVED",
    actorUserId: input.actorUserId,
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Policy versions
// ---------------------------------------------------------------------------

export async function createPolicyVersion(
  input: CreatePolicyVersionInput,
): Promise<CreatePolicyVersionResult> {
  const prisma = input.prisma ?? defaultPrisma;
  const policy = await prisma.redactionPolicy.findFirst({
    where: { id: input.policyId, teamId: input.teamId, archivedAt: null },
    select: { id: true },
  });
  if (!policy) return { ok: false, denial: "PROJECT_NOT_FOUND" };
  const doc = normaliseDocument(input.document);
  const previous = await prisma.redactionPolicyVersion.findFirst({
    where: { policyId: input.policyId },
    orderBy: { versionOrdinal: "desc" },
    select: { versionOrdinal: true },
  });
  const next = (previous?.versionOrdinal ?? 0) + 1;
  const created = await prisma.redactionPolicyVersion.create({
    data: {
      policyId: input.policyId,
      teamId: input.teamId,
      versionOrdinal: next,
      state: "DRAFT",
      rationale: input.rationale?.slice(0, 600) ?? null,
      providers: doc.providers as never,
      kinds: doc.kinds as never,
      ruleActions: doc.ruleActions as never,
      customRules: doc.customRules as never,
      authoredByUserId: input.authoredByUserId,
    },
    select: { id: true, versionOrdinal: true },
  });
  await appendPolicyAudit({
    prisma,
    teamId: input.teamId,
    policyId: input.policyId,
    policyVersionId: created.id,
    code: "POLICY_VERSION_CREATED",
    actorUserId: input.authoredByUserId,
    payload: { versionOrdinal: created.versionOrdinal },
  });
  return {
    ok: true,
    policyVersionId: created.id,
    versionOrdinal: created.versionOrdinal,
  };
}

export async function transitionPolicyVersion(
  input: TransitionPolicyVersionInput,
): Promise<TransitionPolicyVersionResult> {
  const prisma = input.prisma ?? defaultPrisma;
  if (
    !(REDACTION_POLICY_VERSION_STATES as ReadonlyArray<string>).includes(
      input.toState,
    )
  ) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  const version = await prisma.redactionPolicyVersion.findFirst({
    where: { id: input.policyVersionId, teamId: input.teamId },
    select: {
      id: true,
      state: true,
      policyId: true,
      authoredByUserId: true,
    },
  });
  if (!version) return { ok: false, denial: "VERSION_NOT_FOUND" };
  const from = version.state as RedactionPolicyVersionState;
  if (!isAllowedPolicyVersionTransition(from, input.toState)) {
    return { ok: false, denial: "INVALID_TRANSITION" };
  }
  // Server-side separation of duties — the approver cannot be the
  // author. Bounded by REDACTION_POLICY_VERSION_TRANSITIONS — APPROVE
  // path (IN_REVIEW → APPROVED) and PUBLISH path (APPROVED →
  // PUBLISHED) both enforce this.
  if (
    (input.toState === "APPROVED" || input.toState === "PUBLISHED") &&
    version.authoredByUserId === input.actorUserId
  ) {
    return { ok: false, denial: "NOT_PERMITTED" };
  }
  const now = new Date();
  const patch: Record<string, unknown> = { state: input.toState };
  if (input.toState === "IN_REVIEW") patch.submittedAtUtc = now;
  if (input.toState === "APPROVED") {
    patch.approvedAtUtc = now;
    patch.approvedByUserId = input.actorUserId;
  }
  if (input.toState === "PUBLISHED") patch.publishedAtUtc = now;
  if (input.toState === "SUPERSEDED") patch.supersededAtUtc = now;

  await prisma.$transaction(async (tx) => {
    if (input.toState === "PUBLISHED") {
      // Stamp prior PUBLISHED versions of the same policy as SUPERSEDED.
      await tx.redactionPolicyVersion.updateMany({
        where: {
          teamId: input.teamId,
          policyId: version.policyId,
          state: "PUBLISHED",
          NOT: { id: input.policyVersionId },
        },
        data: { state: "SUPERSEDED", supersededAtUtc: now },
      });
    }
    await tx.redactionPolicyVersion.update({
      where: { id: input.policyVersionId },
      data: patch,
    });
  });

  const code: RedactionPolicyActivityCode =
    input.toState === "IN_REVIEW"
      ? "POLICY_VERSION_SUBMITTED"
      : input.toState === "APPROVED"
      ? "POLICY_VERSION_APPROVED"
      : input.toState === "REJECTED"
      ? "POLICY_VERSION_REJECTED"
      : input.toState === "PUBLISHED"
      ? "POLICY_VERSION_PUBLISHED"
      : input.toState === "SUPERSEDED"
      ? "POLICY_VERSION_SUPERSEDED"
      : input.toState === "ROLLED_BACK"
      ? "POLICY_VERSION_ROLLED_BACK"
      : "POLICY_VERSION_CREATED";

  await appendPolicyAudit({
    prisma,
    teamId: input.teamId,
    policyId: version.policyId,
    policyVersionId: input.policyVersionId,
    code,
    actorUserId: input.actorUserId,
    payload: { from, to: input.toState },
  });

  return { ok: true, from, to: input.toState };
}

// ---------------------------------------------------------------------------
// Policy assignments
// ---------------------------------------------------------------------------

export async function assignPolicyVersion(
  input: AssignPolicyVersionInput,
): Promise<AssignPolicyVersionResult> {
  const prisma = input.prisma ?? defaultPrisma;
  if (!(POLICY_ASSIGNMENT_SCOPES as ReadonlyArray<string>).includes(input.scope)) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  const version = await prisma.redactionPolicyVersion.findFirst({
    where: { id: input.policyVersionId, teamId: input.teamId },
    select: { id: true, policyId: true, state: true },
  });
  if (!version) return { ok: false, denial: "VERSION_NOT_FOUND" };
  if (version.state !== "PUBLISHED") {
    return { ok: false, denial: "INVALID_TRANSITION" };
  }
  if (input.scope === "GLOBAL" && input.scopeTargetId !== null) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  if (input.scope !== "GLOBAL" && !input.scopeTargetId) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  const created = await prisma.redactionPolicyAssignment.create({
    data: {
      teamId: input.teamId,
      policyId: version.policyId,
      policyVersionId: input.policyVersionId,
      scope: input.scope,
      scopeTargetId: input.scopeTargetId,
      rationale: input.rationale?.slice(0, 600) ?? null,
      assignedByUserId: input.assignedByUserId,
    },
    select: { id: true },
  });
  await appendPolicyAudit({
    prisma,
    teamId: input.teamId,
    policyId: version.policyId,
    policyVersionId: input.policyVersionId,
    code: "POLICY_ASSIGNMENT_CREATED",
    actorUserId: input.assignedByUserId,
    payload: {
      scope: input.scope,
      scopeTargetId: input.scopeTargetId,
      assignmentId: created.id,
    },
  });
  return { ok: true, assignmentId: created.id };
}

export async function revokePolicyAssignment(input: {
  prisma?: PrismaClient;
  teamId: string;
  assignmentId: string;
  actorUserId: string;
}): Promise<{ ok: true } | { ok: false; denial: RedactionDenialReason }> {
  const prisma = input.prisma ?? defaultPrisma;
  const assignment = await prisma.redactionPolicyAssignment.findFirst({
    where: {
      id: input.assignmentId,
      teamId: input.teamId,
      revokedAtUtc: null,
    },
    select: { id: true, policyId: true, policyVersionId: true },
  });
  if (!assignment) return { ok: false, denial: "PROJECT_NOT_FOUND" };
  await prisma.redactionPolicyAssignment.update({
    where: { id: input.assignmentId },
    data: { revokedAtUtc: new Date() },
  });
  await appendPolicyAudit({
    prisma,
    teamId: input.teamId,
    policyId: assignment.policyId,
    policyVersionId: assignment.policyVersionId,
    code: "POLICY_ASSIGNMENT_REVOKED",
    actorUserId: input.actorUserId,
    payload: { assignmentId: input.assignmentId },
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Reads + projection
// ---------------------------------------------------------------------------

export async function listPolicies(input: {
  prisma?: PrismaClient;
  teamId: string;
}) {
  const prisma = input.prisma ?? defaultPrisma;
  return prisma.redactionPolicy.findMany({
    where: { teamId: input.teamId, archivedAt: null },
    orderBy: { createdAt: "desc" },
  });
}

export async function listPolicyVersions(input: {
  prisma?: PrismaClient;
  teamId: string;
  policyId: string;
}) {
  const prisma = input.prisma ?? defaultPrisma;
  return prisma.redactionPolicyVersion.findMany({
    where: { teamId: input.teamId, policyId: input.policyId },
    orderBy: { versionOrdinal: "desc" },
  });
}

export async function listAssignmentsForScope(input: {
  prisma?: PrismaClient;
  teamId: string;
  scope: PolicyAssignmentScope;
  scopeTargetId: string | null;
}) {
  const prisma = input.prisma ?? defaultPrisma;
  return prisma.redactionPolicyAssignment.findMany({
    where: {
      teamId: input.teamId,
      scope: input.scope,
      scopeTargetId: input.scopeTargetId,
      revokedAtUtc: null,
    },
    orderBy: { assignedAtUtc: "desc" },
  });
}

export async function listAuditForPolicy(input: {
  prisma?: PrismaClient;
  teamId: string;
  policyId: string;
  limit?: number;
}) {
  const prisma = input.prisma ?? defaultPrisma;
  return prisma.redactionPolicyAudit.findMany({
    where: { teamId: input.teamId, policyId: input.policyId },
    orderBy: { occurredAtUtc: "desc" },
    take: Math.min(input.limit ?? 200, 500),
  });
}

// ---------------------------------------------------------------------------
// Inheritance resolver — GLOBAL → WORKSPACE → CASE → PROJECT
// ---------------------------------------------------------------------------

export async function resolveEffectivePolicy(input: {
  prisma?: PrismaClient;
  teamId: string;
  caseId?: string | null;
  projectId?: string | null;
}): Promise<EffectivePolicy> {
  const prisma = input.prisma ?? defaultPrisma;
  const targets: Array<{
    scope: PolicyAssignmentScope;
    scopeTargetId: string | null;
  }> = [
    { scope: "GLOBAL", scopeTargetId: null },
    { scope: "WORKSPACE", scopeTargetId: input.teamId },
  ];
  if (input.caseId) targets.push({ scope: "CASE", scopeTargetId: input.caseId });
  if (input.projectId) {
    targets.push({ scope: "PROJECT", scopeTargetId: input.projectId });
  }
  // Fetch every live assignment for the candidate scopes in one round trip.
  const assignments = await prisma.redactionPolicyAssignment.findMany({
    where: {
      teamId: input.teamId,
      revokedAtUtc: null,
      OR: targets.map((t) => ({
        scope: t.scope,
        scopeTargetId: t.scopeTargetId,
      })),
    },
    include: {
      policyVersion: {
        select: {
          id: true,
          versionOrdinal: true,
          state: true,
          providers: true,
          kinds: true,
          ruleActions: true,
          customRules: true,
        },
      },
      policy: { select: { id: true } },
    },
  });
  // Order by precedence ascending (GLOBAL → WORKSPACE → CASE →
  // PROJECT) so higher-precedence overwrites.
  assignments.sort(
    (a: (typeof assignments)[number], b: (typeof assignments)[number]) =>
      POLICY_ASSIGNMENT_PRECEDENCE[a.scope as PolicyAssignmentScope] -
      POLICY_ASSIGNMENT_PRECEDENCE[b.scope as PolicyAssignmentScope],
  );

  const providers: Record<RedactionDetectionProvider, boolean> = {
    MANUAL: true,
    REGEX_PII: true,
    POLICY_RULE: true,
    AWS_REKOGNITION_FACES: true,
    AWS_REKOGNITION_TEXT: true,
    AZURE_DOCUMENT_INTELLIGENCE: true,
    OCR_TEXT_LAYER: true,
    DEEPGRAM_TRANSCRIPT: true,
    CUSTOM_PROVIDER: true,
  };
  const kinds: Partial<Record<RedactionDetectionKind, boolean>> = {};
  const ruleActions: Partial<
    Record<RedactionDetectionKind, PolicyDetectionRuleAction>
  > = {};
  const customRules: PolicyCustomRegexRule[] = [];
  const resolution: Array<{
    scope: PolicyAssignmentScope;
    scopeTargetId: string | null;
    policyId: string;
    policyVersionId: string;
    versionOrdinal: number;
  }> = [];
  for (const a of assignments) {
    if (a.policyVersion.state !== "PUBLISHED") continue;
    const pv = a.policyVersion;
    const docProviders = (pv.providers ?? {}) as Partial<
      Record<RedactionDetectionProvider, boolean>
    >;
    for (const [k, v] of Object.entries(docProviders)) {
      if (typeof v === "boolean") {
        providers[k as RedactionDetectionProvider] = v;
      }
    }
    const docKinds = (pv.kinds ?? {}) as Partial<
      Record<RedactionDetectionKind, boolean>
    >;
    for (const [k, v] of Object.entries(docKinds)) {
      if (typeof v === "boolean") {
        kinds[k as RedactionDetectionKind] = v;
      }
    }
    const docActions = (pv.ruleActions ?? {}) as Partial<
      Record<RedactionDetectionKind, PolicyDetectionRuleAction>
    >;
    for (const [k, v] of Object.entries(docActions)) {
      if (
        (POLICY_DETECTION_RULE_ACTIONS as ReadonlyArray<string>).includes(
          v as string,
        )
      ) {
        ruleActions[k as RedactionDetectionKind] =
          v as PolicyDetectionRuleAction;
      }
    }
    // Custom rules are concatenated (higher-precedence scopes
    // append, never overwrite — bounded to 1000 across all
    // assignments).
    if (Array.isArray(pv.customRules)) {
      for (const r of pv.customRules as PolicyCustomRegexRule[]) {
        if (customRules.length >= 1000) break;
        customRules.push(r);
      }
    }
    resolution.push({
      scope: a.scope as PolicyAssignmentScope,
      scopeTargetId: a.scopeTargetId,
      policyId: a.policyId,
      policyVersionId: a.policyVersionId,
      versionOrdinal: pv.versionOrdinal,
    });
  }
  return {
    schemaVersion: REDACTION_POLICY_DOCUMENT_SCHEMA_VERSION,
    effectiveAtUtc: new Date().toISOString(),
    providers,
    kinds,
    ruleActions,
    customRules,
    resolution,
  };
}

// ---------------------------------------------------------------------------
// Bounded audit emitter
// ---------------------------------------------------------------------------

export async function appendPolicyAudit(input: {
  prisma?: PrismaClient;
  teamId: string;
  policyId: string;
  policyVersionId?: string | null;
  code: RedactionPolicyActivityCode;
  actorUserId?: string | null;
  payload?: Record<string, unknown>;
}): Promise<{ id: string }> {
  if (
    !(REDACTION_POLICY_ACTIVITY_CODES as ReadonlyArray<string>).includes(
      input.code,
    )
  ) {
    throw new Error(`policy-audit: unknown code ${input.code}`);
  }
  const prisma = input.prisma ?? defaultPrisma;
  const row = await prisma.redactionPolicyAudit.create({
    data: {
      teamId: input.teamId,
      policyId: input.policyId,
      policyVersionId: input.policyVersionId ?? null,
      code: input.code,
      actorUserId: input.actorUserId ?? null,
      payload: (input.payload ?? null) as never,
    },
    select: { id: true },
  });
  return { id: row.id };
}

// Compile-time guard.
function _assertVersionTransitionMapIsConsistent(): void {
  for (const s of REDACTION_POLICY_VERSION_STATES) {
    if (!Array.isArray(REDACTION_POLICY_VERSION_TRANSITIONS[s])) {
      throw new Error("REDACTION_POLICY_VERSION_TRANSITIONS shape changed");
    }
  }
}
void _assertVersionTransitionMapIsConsistent;
