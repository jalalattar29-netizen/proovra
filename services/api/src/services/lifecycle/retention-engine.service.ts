/**
 * PROOVRA Phase 4B — Retention policy engine.
 *
 * Workspace-scoped retention policy registry + inheritance/override
 * resolver + runtime gate for DELETE / ARCHIVE actions on evidence.
 *
 * Design mirrors `governance-policy.service.ts` (inheritance walk,
 * narrowest-override-wins) and `policy-runtime-gates.service.ts`
 * (collapse to a binary `{ ok, denial, reason }` shape for callers).
 *
 * Hard rules:
 *   * Bounded template vocabulary — see `RETENTION_TEMPLATE_DEFAULTS`.
 *   * `CUSTOM` template requires an explicit `years` value.
 *   * Effective retention walks WORKSPACE → DEPARTMENT → CASE →
 *     EVIDENCE, narrowest override wins. When two policies apply at
 *     the same scope (no override), the strictest (longest years) wins.
 *   * The gate compares evidence age (ms since createdAt) against
 *     effective years; under-age requests are denied with a bounded
 *     reason. Denials emit a bounded `POLICY_BLOCK` event.
 *   * Audit emission is best-effort — it must never block the
 *     operational write path.
 */

import type { PrismaClient } from "@prisma/client";
import {
  RETENTION_POLICY_TEMPLATES,
  type RetentionPolicyProjection,
  type RetentionPolicyTemplate,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { resolveEntitlement } from "../packaging/entitlement.service.js";
import { emitLifecycleEvent } from "../intelligence/intelligence-activity.service.js";

// ===========================================================================
// Template defaults
// ===========================================================================

export const RETENTION_TEMPLATE_DEFAULTS: Record<
  RetentionPolicyTemplate,
  { years: number }
> = {
  INSURANCE_7Y: { years: 7 },
  JOURNALISM_10Y: { years: 10 },
  CORPORATE_5Y: { years: 5 },
  CUSTOM: { years: 0 },
};

// ===========================================================================
// Bounded scope vocabulary
// ===========================================================================

export const RETENTION_SCOPE_KINDS = [
  "WORKSPACE",
  "DEPARTMENT",
  "CASE",
  "EVIDENCE",
] as const;
export type RetentionScopeKind = (typeof RETENTION_SCOPE_KINDS)[number];

// Scope precedence — narrower scopes appear later. When `isOverride`
// is set, the narrower scope replaces the parent's effective years.
// Otherwise the strictest (max years) effective value wins.
const SCOPE_RANK: Record<RetentionScopeKind, number> = {
  WORKSPACE: 0,
  DEPARTMENT: 1,
  CASE: 2,
  EVIDENCE: 3,
};

// ===========================================================================
// Bounded denial codes
// ===========================================================================

export type RetentionDenial =
  | "POLICY_REJECTED"
  | "RETENTION_NOT_EXPIRED"
  | "EVIDENCE_NOT_FOUND";

// ===========================================================================
// Best-effort audit emit (audit MUST never block the call site)
// ===========================================================================

type RetentionAuditCode =
  | "RETENTION_POLICY_CREATED"
  | "RETENTION_POLICY_RELEASED"
  | "POLICY_BLOCK";

function emitRetentionAudit(input: {
  teamId: string;
  policyId: string | null;
  code: RetentionAuditCode;
  actorUserId?: string | null;
  reason?: string | null;
}): void {
  try {
    // Phase 4B foundation: bounded structured-log emit. Phase 4B
    // wire-up swaps this for a persisted audit row in
    // retention_policy_audit (forthcoming) without changing the call
    // shape here.
    const payload = {
      kind: "retention_policy_audit",
      teamId: input.teamId,
      policyId: input.policyId,
      code: input.code,
      actorUserId: input.actorUserId ?? null,
      reason: input.reason?.slice(0, 200) ?? null,
      occurredAtUtc: new Date().toISOString(),
    };
    // eslint-disable-next-line no-console
    console.info(JSON.stringify(payload));
  } catch {
    /* swallow — audit must never block ops */
  }
}

// ===========================================================================
// Bounded helpers
// ===========================================================================

function nowMs(): number {
  return Date.now();
}

function yearsInMs(years: number): number {
  return Math.max(0, years) * 365.25 * 24 * 3600 * 1000;
}

function clampExceptions(
  exceptions?: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (!exceptions || exceptions.length === 0) return [];
  const trimmed: Array<string> = [];
  for (const e of exceptions) {
    if (typeof e !== "string") continue;
    const v = e.slice(0, 80);
    if (v.length > 0) trimmed.push(v);
    if (trimmed.length >= 50) break;
  }
  return trimmed;
}

function projectPolicyRow(row: {
  id: string;
  name: string;
  template: string;
  years: number;
  scopeKind: string;
  scopeTargetId: string | null;
  inheritsFromId: string | null;
  isOverride: boolean;
  exceptions: unknown;
}): RetentionPolicyProjection {
  const appliesTo =
    row.scopeKind === "WORKSPACE"
      ? "workspace"
      : `${row.scopeKind.toLowerCase()}:${(row.scopeTargetId ?? "").slice(0, 8)}`;
  const exceptions = Array.isArray(row.exceptions)
    ? (row.exceptions as ReadonlyArray<unknown>).filter(
        (v): v is string => typeof v === "string",
      )
    : [];
  return {
    id: row.id,
    name: row.name,
    template: row.template as RetentionPolicyTemplate,
    years: row.years,
    appliesTo,
    inheritsFrom: row.inheritsFromId,
    isOverride: row.isOverride,
    exceptions,
  };
}

// ===========================================================================
// createRetentionPolicy
// ===========================================================================

export type CreateRetentionPolicyInput = {
  prisma?: PrismaClient;
  teamId: string;
  name: string;
  template: RetentionPolicyTemplate;
  years?: number;
  scopeKind: "WORKSPACE" | "DEPARTMENT" | "CASE";
  scopeTargetId?: string;
  inheritsFromId?: string;
  isOverride?: boolean;
  exceptions?: ReadonlyArray<string>;
  createdByUserId: string;
};

export type CreateRetentionPolicyResult =
  | { ok: true; policyId: string }
  | { ok: false; denial: "POLICY_REJECTED"; reason: string }
  | { ok: false; denial: "RETENTION_LIMIT_EXCEEDED"; limit: number };

export async function createRetentionPolicy(
  input: CreateRetentionPolicyInput,
): Promise<CreateRetentionPolicyResult> {
  if (
    !(RETENTION_POLICY_TEMPLATES as ReadonlyArray<string>).includes(
      input.template,
    )
  ) {
    return {
      ok: false,
      denial: "POLICY_REJECTED",
      reason: "unknown_template",
    };
  }
  if (input.template === "CUSTOM" && (input.years === undefined || input.years === null)) {
    return {
      ok: false,
      denial: "POLICY_REJECTED",
      reason: "custom_template_requires_years",
    };
  }
  const years = input.years ?? RETENTION_TEMPLATE_DEFAULTS[input.template].years;
  if (!Number.isFinite(years) || years < 0 || years > 100) {
    return {
      ok: false,
      denial: "POLICY_REJECTED",
      reason: "years_out_of_range",
    };
  }
  if (
    input.scopeKind !== "WORKSPACE" &&
    !input.scopeTargetId
  ) {
    return {
      ok: false,
      denial: "POLICY_REJECTED",
      reason: "scope_requires_target_id",
    };
  }
  const prisma = input.prisma ?? defaultPrisma;

  // 4B-I9: RETENTION_MAX_YEARS — gate before policy creation.
  // Reads the workspace entitlement limit and rejects when the requested
  // years exceed it. Emits POLICY_VIOLATION_RETENTION on denial.
  // Engine errors are swallowed so this gate never blocks the operational path.
  try {
    const limitGrant = await resolveEntitlement({
      prisma,
      teamId: input.teamId,
      key: "RETENTION_MAX_YEARS",
    });
    const maxYears = typeof limitGrant.value === "number" ? limitGrant.value : 0;
    if (years > maxYears) {
      // Emit lifecycle event for the violation (best-effort).
      emitLifecycleEvent({
        prisma,
        teamId: input.teamId,
        code: "POLICY_VIOLATION_RETENTION" as never,
        actorUserId: input.createdByUserId,
        reason: `retention_limit_exceeded:requested=${years};limit=${maxYears}`.slice(0, 200),
        targetType: "RETENTION_POLICY",
        targetId: null,
        payload: { requestedYears: years, limitYears: maxYears },
      }).catch(() => null);
      return { ok: false, denial: "RETENTION_LIMIT_EXCEEDED", limit: maxYears };
    }
  } catch {
    /* entitlement engine error — do not block policy creation */
  }

  const row = await prisma.retentionPolicyConfig.create({
    data: {
      teamId: input.teamId,
      name: input.name.slice(0, 200),
      template: input.template,
      years: Math.round(years),
      scopeKind: input.scopeKind,
      scopeTargetId: input.scopeTargetId ?? null,
      inheritsFromId: input.inheritsFromId ?? null,
      isOverride: input.isOverride ?? false,
      exceptions: clampExceptions(input.exceptions) as never,
      state: "ACTIVE",
      createdByUserId: input.createdByUserId,
    },
    select: { id: true },
  });
  emitRetentionAudit({
    teamId: input.teamId,
    policyId: row.id,
    code: "RETENTION_POLICY_CREATED",
    actorUserId: input.createdByUserId,
    reason: `template=${input.template}; years=${Math.round(years)}; scope=${input.scopeKind}`,
  });
  return { ok: true, policyId: row.id };
}

// ===========================================================================
// releaseRetentionPolicy
// ===========================================================================

export async function releaseRetentionPolicy(input: {
  prisma?: PrismaClient;
  teamId: string;
  policyId: string;
  actorUserId: string;
}): Promise<{ ok: boolean }> {
  const prisma = input.prisma ?? defaultPrisma;
  const row = await prisma.retentionPolicyConfig.findFirst({
    where: { id: input.policyId, teamId: input.teamId },
    select: { id: true },
  });
  if (!row) return { ok: false };
  await prisma.retentionPolicyConfig.update({
    where: { id: row.id },
    data: { state: "ARCHIVED" },
  });
  emitRetentionAudit({
    teamId: input.teamId,
    policyId: row.id,
    code: "RETENTION_POLICY_RELEASED",
    actorUserId: input.actorUserId,
    reason: null,
  });
  return { ok: true };
}

// ===========================================================================
// resolveEffectiveRetention
// ===========================================================================

export type EffectiveRetention = {
  effectiveYears: number;
  appliedPolicyId: string | null;
  isOverride: boolean;
  exceptions: ReadonlyArray<string>;
};

export async function resolveEffectiveRetention(input: {
  prisma?: PrismaClient;
  teamId: string;
  evidenceId: string;
  caseId?: string;
  departmentId?: string;
}): Promise<EffectiveRetention> {
  const prisma = input.prisma ?? defaultPrisma;

  // If caseId / departmentId weren't supplied, hydrate from the
  // canonical CaseEvidenceLink table. Track 1B closure — retention
  // scope considers ALL linked cases (the strictest matching policy
  // wins in the walk below), not a single legacy primary case.
  const departmentId = input.departmentId ?? null;
  let caseIds: string[] = input.caseId ? [input.caseId] : [];
  if (caseIds.length === 0) {
    const links = await prisma.caseEvidenceLink
      .findMany({
        where: { evidenceId: input.evidenceId },
        select: { caseId: true },
        take: 100,
      })
      .catch(() => []);
    caseIds = links.map((l) => l.caseId);
    // departmentId is not stored on Evidence; caller must supply it if needed
  }

  const orClauses: Array<{ scopeKind: string; scopeTargetId: string | null }> = [
    { scopeKind: "WORKSPACE", scopeTargetId: null },
  ];
  if (departmentId) {
    orClauses.push({ scopeKind: "DEPARTMENT", scopeTargetId: departmentId });
  }
  for (const cid of caseIds) {
    orClauses.push({ scopeKind: "CASE", scopeTargetId: cid });
  }
  orClauses.push({ scopeKind: "EVIDENCE", scopeTargetId: input.evidenceId });

  const rows = await prisma.retentionPolicyConfig.findMany({
    where: {
      teamId: input.teamId,
      state: "ACTIVE",
      OR: orClauses,
    },
    select: {
      id: true,
      years: true,
      scopeKind: true,
      scopeTargetId: true,
      isOverride: true,
      exceptions: true,
    },
  });

  // Walk narrowest-to-widest. When the narrowest scope present carries
  // `isOverride=true`, it wins outright. Otherwise the strictest
  // (max years) across all matching policies wins.
  let chosen: {
    id: string;
    years: number;
    isOverride: boolean;
    exceptions: ReadonlyArray<string>;
    rank: number;
  } | null = null;

  for (const r of rows) {
    const kind = r.scopeKind as RetentionScopeKind;
    const rank = SCOPE_RANK[kind] ?? 0;
    const exceptions = Array.isArray(r.exceptions)
      ? (r.exceptions as ReadonlyArray<unknown>).filter(
          (v): v is string => typeof v === "string",
        )
      : [];
    const candidate = {
      id: r.id,
      years: r.years,
      isOverride: r.isOverride,
      exceptions,
      rank,
    };
    if (!chosen) {
      chosen = candidate;
      continue;
    }
    // Narrower override outright replaces.
    if (candidate.isOverride && candidate.rank >= chosen.rank) {
      chosen = candidate;
      continue;
    }
    // Otherwise, strictest (longest) wins so we never auto-shrink
    // retention by accident.
    if (!chosen.isOverride && candidate.years > chosen.years) {
      chosen = candidate;
    }
  }

  if (!chosen) {
    return {
      effectiveYears: 0,
      appliedPolicyId: null,
      isOverride: false,
      exceptions: [],
    };
  }
  return {
    effectiveYears: chosen.years,
    appliedPolicyId: chosen.id,
    isOverride: chosen.isOverride,
    exceptions: chosen.exceptions,
  };
}

// ===========================================================================
// gateRetention
// ===========================================================================

export type GateRetentionResult =
  | { ok: true }
  | { ok: false; denial: "RETENTION_NOT_EXPIRED"; reason: string }
  | { ok: false; denial: "EVIDENCE_NOT_FOUND"; reason: string };

export async function gateRetention(input: {
  prisma?: PrismaClient;
  teamId: string;
  evidenceId: string;
  action: "DELETE" | "ARCHIVE";
}): Promise<GateRetentionResult> {
  const prisma = input.prisma ?? defaultPrisma;
  const ev = await prisma.evidence
    .findUnique({
      where: { id: input.evidenceId },
      select: { id: true, createdAt: true },
    })
    .catch(() => null);
  if (!ev) {
    return {
      ok: false,
      denial: "EVIDENCE_NOT_FOUND",
      reason: "evidence_not_found",
    };
  }
  // caseId deliberately omitted — resolveEffectiveRetention hydrates
  // ALL linked cases from the canonical link table.
  const effective = await resolveEffectiveRetention({
    prisma,
    teamId: input.teamId,
    evidenceId: ev.id,
  });
  if (effective.effectiveYears <= 0) {
    // No policy or 0-year policy = no retention floor; allow.
    return { ok: true };
  }
  const ageMs = nowMs() - ev.createdAt.getTime();
  const requiredMs = yearsInMs(effective.effectiveYears);
  if (ageMs < requiredMs) {
    const reason = `retention_floor_${effective.effectiveYears}y_not_met_action_${input.action.toLowerCase()}`;
    emitRetentionAudit({
      teamId: input.teamId,
      policyId: effective.appliedPolicyId,
      code: "POLICY_BLOCK",
      actorUserId: null,
      reason,
    });
    return {
      ok: false,
      denial: "RETENTION_NOT_EXPIRED",
      reason,
    };
  }
  return { ok: true };
}

// ===========================================================================
// listRetentionPolicies
// ===========================================================================

export async function listRetentionPolicies(input: {
  prisma?: PrismaClient;
  teamId: string;
}): Promise<ReadonlyArray<RetentionPolicyProjection>> {
  const prisma = input.prisma ?? defaultPrisma;
  const rows = await prisma.retentionPolicyConfig.findMany({
    where: { teamId: input.teamId, state: "ACTIVE" },
    orderBy: [{ scopeKind: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      template: true,
      years: true,
      scopeKind: true,
      scopeTargetId: true,
      inheritsFromId: true,
      isOverride: true,
      exceptions: true,
    },
  });
  return rows.map(projectPolicyRow);
}

// ===========================================================================
// computeUpcomingExpirations
// ===========================================================================

export async function computeUpcomingExpirations(input: {
  prisma?: PrismaClient;
  teamId: string;
  withinDays?: number;
}): Promise<{ count: number; sampleEvidenceIds: ReadonlyArray<string> }> {
  const prisma = input.prisma ?? defaultPrisma;
  const withinDays = Math.max(1, Math.min(input.withinDays ?? 30, 3650));
  const horizonMs = withinDays * 24 * 3600 * 1000;
  const now = nowMs();

  // Fast path: rely on the pre-computed `retentionUntilUtc` column the
  // retention sweeper maintains. Anything expiring within the horizon
  // is a candidate. We deliberately cap the scan to keep this O(N).
  const upcoming = await prisma.evidence
    .findMany({
      where: {
        teamId: input.teamId,
        deletedAt: null,
        archivedAt: null,
        retentionUntilUtc: {
          not: null,
          lte: new Date(now + horizonMs),
          gte: new Date(now),
        },
      },
      select: { id: true },
      orderBy: { retentionUntilUtc: "asc" },
      take: 500,
    })
    .catch(() => [] as Array<{ id: string }>);

  return {
    count: upcoming.length,
    sampleEvidenceIds: upcoming.slice(0, 25).map((r) => r.id),
  };
}

// Compile-time guard.
function _assertContractsIntact(): void {
  const _t: RetentionPolicyTemplate = "CUSTOM";
  void _t;
  void RETENTION_POLICY_TEMPLATES;
  void RETENTION_SCOPE_KINDS;
}
void _assertContractsIntact;
