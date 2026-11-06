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
 *   * Policy create / release audit rows are written through the canonical
 *     tenant-audit facade in the SAME transaction as the change, so a
 *     policy change can never exist without its audit row (nor the reverse).
 *     The runtime-gate POLICY_BLOCK row is best-effort: a failed audit write
 *     must not turn a correct denial into a 500.
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
import { workspaceEvidenceWhere } from "@proovra/shared-runtime";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import {
  RetentionEngineError,
  createRetentionPolicy as createCanonicalPolicy,
  transitionRetentionPolicy as transitionCanonicalPolicy,
} from "../governance-lifecycle/retention-engine.service.js";

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

// ===========================================================================
// Bounded denial codes
// ===========================================================================

export type RetentionDenial =
  | "POLICY_REJECTED"
  | "RETENTION_NOT_EXPIRED"
  | "EVIDENCE_NOT_FOUND";

// ===========================================================================
// Retention audit — a persisted row through the canonical tenant-audit facade
// ===========================================================================
//
// This used to be a `console.info` line described as "forthcoming" persisted
// audit, so releasing a retention policy — which lifts a retention floor off
// evidence — left no audit record at all.

type RetentionAuditCode =
  | "RETENTION_POLICY_CREATED"
  | "RETENTION_POLICY_RELEASED"
  | "POLICY_BLOCK";

const RETENTION_AUDIT_ACTION: Record<RetentionAuditCode, string> = {
  RETENTION_POLICY_CREATED: "lifecycle.retention_policy.create",
  RETENTION_POLICY_RELEASED: "lifecycle.retention_policy.release",
  POLICY_BLOCK: "lifecycle.retention_policy.block",
};

async function emitRetentionAudit(
  input: {
    teamId: string;
    policyId: string | null;
    code: RetentionAuditCode;
    actorUserId?: string | null;
    reason?: string | null;
    previousState?: string | null;
    resultingState?: string | null;
  },
  db?: PrismaClient,
): Promise<void> {
  const actorUserId = input.actorUserId ?? null;
  await emitTenantAudit(
    {
      action: RETENTION_AUDIT_ACTION[input.code],
      outcome: input.code === "POLICY_BLOCK" ? "denied" : "success",
      denialReason: input.code === "POLICY_BLOCK" ? (input.reason ?? null) : null,
      sourceApp: actorUserId ? "API" : "SYSTEM",
      actorUserId,
      workspaceId: input.teamId,
      resourceType: "retention_policy_config",
      resourceId: input.policyId,
      previousState: input.previousState ?? null,
      resultingState: input.resultingState ?? null,
      reasonCode: input.code,
      metadata: { reason: input.reason?.slice(0, 200) ?? null },
    },
    db,
  );
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

// ===========================================================================
// GOV-005 / RETENTION-TWO-TABLES — ONE STORE (2026-11-04)
// ===========================================================================
//
// This module kept its own table, `retention_policy_configs`, and nothing read
// it when a record was created or its date ran out: a policy made on the
// evidence-lifecycle page or in the organization setup wizard governed nothing.
// The binding authority is `evidence_retention_policies`
// (`packages/shared-runtime/src/evidence-retention/policy-binding.ts`:
// prospective, extend-only), so every function below now reads and writes that
// store through the canonical engine. The old table is retired by migration
// 20281115100100: its rows were copied (same ids) and it refuses writes.
//
// The request shape is kept (template + years, WORKSPACE or CASE scope) so the
// existing pages keep working. What the binding cannot honour is refused with a
// reason instead of being stored and ignored: DEPARTMENT scope (a record carries
// no department), per-policy exceptions, inheritance and overrides (binding
// precedence is the catalog's, `pickHighestPrecedencePolicy`).

/** The template a lifecycle-page policy was created from, kept in its description. */
const TEMPLATE_MARKER = "lifecycle-template:";

const DAYS_PER_YEAR = 365.25;

function yearsToDays(years: number): number {
  return Math.round(years * DAYS_PER_YEAR);
}

function templateFromDescription(description: string | null, days: number | null): RetentionPolicyTemplate {
  const marked = description?.split(/\s/).find((w) => w.startsWith(TEMPLATE_MARKER))?.slice(TEMPLATE_MARKER.length);
  if (marked && (RETENTION_POLICY_TEMPLATES as ReadonlyArray<string>).includes(marked)) {
    return marked as RetentionPolicyTemplate;
  }
  for (const t of RETENTION_POLICY_TEMPLATES) {
    if (t !== "CUSTOM" && days !== null && yearsToDays(RETENTION_TEMPLATE_DEFAULTS[t].years) === days) return t;
  }
  return "CUSTOM";
}

function projectCanonical(row: {
  id: string;
  displayName: string;
  description: string | null;
  scope: string;
  caseId: string | null;
  retentionDays: number | null;
}): RetentionPolicyProjection {
  const appliesTo =
    row.scope === "WORKSPACE" ? "workspace" : `${row.scope.toLowerCase()}:${(row.caseId ?? "").slice(0, 8)}`;
  return {
    id: row.id,
    name: row.displayName,
    template: templateFromDescription(row.description, row.retentionDays),
    years: row.retentionDays === null ? 0 : Math.round((row.retentionDays / DAYS_PER_YEAR) * 100) / 100,
    appliesTo,
    inheritsFrom: null,
    isOverride: false,
    exceptions: [],
  };
}

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
  if (!(RETENTION_POLICY_TEMPLATES as ReadonlyArray<string>).includes(input.template)) {
    return { ok: false, denial: "POLICY_REJECTED", reason: "unknown_template" };
  }
  if (input.template === "CUSTOM" && (input.years === undefined || input.years === null)) {
    return { ok: false, denial: "POLICY_REJECTED", reason: "custom_template_requires_years" };
  }
  const years = input.years ?? RETENTION_TEMPLATE_DEFAULTS[input.template].years;
  // A zero-year policy used to mean "no floor"; in the binding store a policy
  // with no days is INDEFINITE retention, the opposite. Refused, not inverted.
  if (!Number.isFinite(years) || years < 1 || years > 100) {
    return { ok: false, denial: "POLICY_REJECTED", reason: "years_out_of_range" };
  }
  if (input.scopeKind === "DEPARTMENT") {
    return { ok: false, denial: "POLICY_REJECTED", reason: "scope_not_bindable" };
  }
  if (input.scopeKind !== "WORKSPACE" && !input.scopeTargetId) {
    return { ok: false, denial: "POLICY_REJECTED", reason: "scope_requires_target_id" };
  }
  if ((input.exceptions?.length ?? 0) > 0 || input.inheritsFromId || input.isOverride) {
    return { ok: false, denial: "POLICY_REJECTED", reason: "not_supported_by_binding" };
  }
  const prisma = input.prisma ?? defaultPrisma;

  // 4B-I9: RETENTION_MAX_YEARS — gate before policy creation.
  try {
    const limitGrant = await resolveEntitlement({ prisma, teamId: input.teamId, key: "RETENTION_MAX_YEARS" });
    const maxYears = typeof limitGrant.value === "number" ? limitGrant.value : 0;
    if (years > maxYears) {
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

  if (input.scopeKind === "CASE") {
    const owned = await prisma.case.findFirst({
      where: { id: input.scopeTargetId!, teamId: input.teamId },
      select: { id: true },
    });
    if (!owned) return { ok: false, denial: "POLICY_REJECTED", reason: "case_not_in_workspace" };
  }

  try {
    const created = await createCanonicalPolicy(
      {
        teamId: input.teamId,
        actorUserId: input.createdByUserId,
        displayName: input.name.slice(0, 180),
        description: `${TEMPLATE_MARKER}${input.template}`,
        scope: input.scopeKind,
        caseId: input.scopeKind === "CASE" ? input.scopeTargetId! : null,
        retentionDays: yearsToDays(years),
        changeNote: `Created from the lifecycle retention page (template ${input.template}, ${years} years)`,
      },
      prisma,
    );
    return { ok: true, policyId: created.id };
  } catch (err) {
    if (err instanceof RetentionEngineError && err.code === "RETENTION_POLICY_DUPLICATE") {
      return { ok: false, denial: "POLICY_REJECTED", reason: "duplicate_name" };
    }
    if (err instanceof RetentionEngineError && err.code === "RETENTION_POLICY_INVALID") {
      return { ok: false, denial: "POLICY_REJECTED", reason: "invalid_policy" };
    }
    throw err;
  }
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
  try {
    await transitionCanonicalPolicy(
      {
        teamId: input.teamId,
        id: input.policyId,
        actorUserId: input.actorUserId,
        nextStatus: "ARCHIVED",
        changeNote: "Released from the lifecycle retention page",
      },
      prisma,
    );
    return { ok: true };
  } catch (err) {
    if (err instanceof RetentionEngineError) return { ok: false };
    throw err;
  }
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

/**
 * The longest ACTIVE, dated policy of the binding store that matches the
 * record (workspace, its type, any of its cases). Longest because a template
 * bound must never shorten retention (extend-only); an indefinite policy is
 * reported by the binding itself, not as a date here.
 */
export async function resolveEffectiveRetention(input: {
  prisma?: PrismaClient;
  teamId: string;
  evidenceId: string;
  caseId?: string;
  departmentId?: string;
}): Promise<EffectiveRetention> {
  const prisma = input.prisma ?? defaultPrisma;
  let caseIds: string[] = input.caseId ? [input.caseId] : [];
  if (caseIds.length === 0) {
    const links = await prisma.caseEvidenceLink
      .findMany({ where: { evidenceId: input.evidenceId }, select: { caseId: true }, take: 100 })
      .catch(() => []);
    caseIds = links.map((l) => l.caseId);
  }
  const ev = await prisma.evidence
    .findUnique({ where: { id: input.evidenceId }, select: { type: true } })
    .catch(() => null);
  const arms: Array<Record<string, unknown>> = [{ scope: "WORKSPACE" }];
  if (ev?.type) arms.push({ scope: "EVIDENCE_TYPE", scopeQualifier: String(ev.type) });
  if (caseIds.length > 0) arms.push({ scope: "CASE", caseId: { in: caseIds } });
  const rows = await prisma.evidenceRetentionPolicy.findMany({
    where: { teamId: input.teamId, status: "ACTIVE", retentionDays: { not: null }, OR: arms },
    select: { id: true, retentionDays: true },
  });
  let chosen: { id: string; days: number } | null = null;
  for (const r of rows) {
    if (r.retentionDays !== null && (!chosen || r.retentionDays > chosen.days)) chosen = { id: r.id, days: r.retentionDays };
  }
  if (!chosen) return { effectiveYears: 0, appliedPolicyId: null, isOverride: false, exceptions: [] };
  return { effectiveYears: chosen.days / DAYS_PER_YEAR, appliedPolicyId: chosen.id, isOverride: false, exceptions: [] };
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
    .findUnique({ where: { id: input.evidenceId }, select: { id: true, createdAt: true } })
    .catch(() => null);
  if (!ev) return { ok: false, denial: "EVIDENCE_NOT_FOUND", reason: "evidence_not_found" };
  const effective = await resolveEffectiveRetention({ prisma, teamId: input.teamId, evidenceId: ev.id });
  if (effective.effectiveYears <= 0) return { ok: true };
  const ageMs = nowMs() - ev.createdAt.getTime();
  if (ageMs < yearsInMs(effective.effectiveYears)) {
    const reason = `retention_floor_${Math.round(effective.effectiveYears)}y_not_met_action_${input.action.toLowerCase()}`;
    await emitRetentionAudit(
      { teamId: input.teamId, policyId: effective.appliedPolicyId, code: "POLICY_BLOCK", actorUserId: null, reason },
      prisma,
    ).catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error("retention_policy_block_audit_failed", {
        teamId: input.teamId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return { ok: false, denial: "RETENTION_NOT_EXPIRED", reason };
  }
  return { ok: true };
}

// ===========================================================================
// listRetentionPolicies
// ===========================================================================

/** The workspace's ACTIVE policies of the binding store, in this page's shape. */
export async function listRetentionPolicies(input: {
  prisma?: PrismaClient;
  teamId: string;
}): Promise<ReadonlyArray<RetentionPolicyProjection>> {
  const prisma = input.prisma ?? defaultPrisma;
  const rows = await prisma.evidenceRetentionPolicy.findMany({
    where: { teamId: input.teamId, status: "ACTIVE" },
    orderBy: [{ scope: "asc" }, { displayName: "asc" }],
    select: { id: true, displayName: true, description: true, scope: true, caseId: true, retentionDays: true },
  });
  return rows.map(projectCanonical);
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
  // WORKSPACE-SCOPE CONVERGENCE — the canonical workspace population,
  // resolved once for every query below, on THIS call's client. A strict
  // `teamId` equality here omitted a personal workspace's legacy NULL-team
  // rows, and reported the smaller number as if it were the whole population.
  const scope = await workspaceEvidenceWhere(input.teamId, prisma);
  const withinDays = Math.max(1, Math.min(input.withinDays ?? 30, 3650));
  const horizonMs = withinDays * 24 * 3600 * 1000;
  const now = nowMs();

  // Fast path: rely on the pre-computed `retentionUntilUtc` column the
  // retention sweeper maintains. Anything expiring within the horizon
  // is a candidate. We deliberately cap the scan to keep this O(N).
  const upcoming = await prisma.evidence
    .findMany({
      where: {
        AND: [scope],
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
