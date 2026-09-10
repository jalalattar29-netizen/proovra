/**
 * Phase 27 — Enterprise Retention Engine.
 *
 * First-class versioned retention policy CRUD with inheritance,
 * conflict resolution, and append-only history. Layered on top of the
 * Phase 14 governance.service.ts (which holds the workspace-default
 * retention-day columns) — Phase 27 adds the named, scoped, versioned
 * policy objects operators bind to evidence types / cases / regulatory
 * profiles.
 *
 * Hard rules:
 *   - Every mutation writes a new RetentionPolicyVersion row + bumps
 *     `currentVersion`. The previous version is immutable.
 *   - The resolver returns ONE effective policy per evidence according
 *     to the shared `RETENTION_PRECEDENCE_ORDER` (CASE > EVIDENCE_TYPE
 *     > REGULATORY > WORKSPACE).
 *   - SUPERSEDED / ARCHIVED policies are never removed — they remain
 *     for audit history. Only ACTIVE policies participate in the
 *     resolver.
 *   - Operator-readable display name + change note are required;
 *     legal text is not stored here (it stays in EvidenceLegalHold).
 */

import type {
  PrismaClient,
  EvidenceRetentionPolicy as DbPolicy,
  EvidenceRetentionPolicyVersion as DbPolicyVersion,
} from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import {
  RETENTION_POLICY_SCOPES,
  RETENTION_POLICY_STATUSES,
  RetentionPolicyCreateInputSchema,
  RetentionPolicyUpdateInputSchema,
  isAllowedRetentionPolicyTransition,
  pickHighestPrecedencePolicy,
  type RetentionPolicyScope,
  type RetentionPolicyStatus,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import {
  applyOrganizationRetentionFloor,
  isWeakerRetention,
  readOrganizationRetentionTemplate,
} from "../organization/retention-template.js";

// -----------------------------------------------------------------------------
// Error
// -----------------------------------------------------------------------------

export class RetentionEngineError extends Error {
  constructor(
    public readonly code:
      | "RETENTION_POLICY_NOT_FOUND"
      | "RETENTION_POLICY_DUPLICATE"
      | "RETENTION_POLICY_INVALID"
      | "RETENTION_POLICY_TERMINAL"
      | "RETENTION_POLICY_INVALID_TRANSITION",
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "RetentionEngineError";
  }
}

// -----------------------------------------------------------------------------
// Projection
// -----------------------------------------------------------------------------

export type RetentionPolicyProjection = {
  id: string;
  teamId: string;
  displayName: string;
  description: string | null;
  status: RetentionPolicyStatus;
  scope: RetentionPolicyScope;
  scopeQualifier: string | null;
  caseId: string | null;
  retentionDays: number | null;
  immutable: boolean;
  autoExtensionEnabled: boolean;
  autoExtensionDays: number | null;
  supersededByPolicyId: string | null;
  currentVersion: number;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  archivedAtUtc: string | null;
};

export function projectPolicy(row: DbPolicy): RetentionPolicyProjection {
  return {
    id: row.id,
    teamId: row.teamId,
    displayName: row.displayName,
    description: row.description,
    status: row.status as RetentionPolicyStatus,
    scope: row.scope as RetentionPolicyScope,
    scopeQualifier: row.scopeQualifier,
    caseId: row.caseId,
    retentionDays: row.retentionDays,
    immutable: row.immutable,
    autoExtensionEnabled: row.autoExtensionEnabled,
    autoExtensionDays: row.autoExtensionDays,
    supersededByPolicyId: row.supersededByPolicyId,
    currentVersion: row.currentVersion,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAtUtc: row.archivedAtUtc?.toISOString() ?? null,
  };
}

const SCOPE_SET = new Set<string>(RETENTION_POLICY_SCOPES);
const STATUS_SET = new Set<string>(RETENTION_POLICY_STATUSES);

// -----------------------------------------------------------------------------
// Create
// -----------------------------------------------------------------------------

export async function createRetentionPolicy(
  input: {
    teamId: string;
    actorUserId: string;
    displayName: string;
    description?: string | null;
    scope: RetentionPolicyScope;
    scopeQualifier?: string | null;
    caseId?: string | null;
    retentionDays?: number | null;
    immutable?: boolean;
    autoExtensionEnabled?: boolean;
    autoExtensionDays?: number | null;
    changeNote?: string;
  },
  client: PrismaClient = defaultPrisma,
): Promise<RetentionPolicyProjection> {
  const parsed = RetentionPolicyCreateInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new RetentionEngineError("RETENTION_POLICY_INVALID", {
      detail: parsed.error.flatten(),
    });
  }
  if (!SCOPE_SET.has(input.scope)) {
    throw new RetentionEngineError("RETENTION_POLICY_INVALID");
  }
  try {
    const row = await client.evidenceRetentionPolicy.create({
      data: {
        teamId: input.teamId,
        displayName: input.displayName.slice(0, 180),
        description: input.description?.slice(0, 2000) ?? null,
        status: "ACTIVE",
        scope: input.scope,
        scopeQualifier: input.scopeQualifier ?? null,
        caseId: input.caseId ?? null,
        retentionDays: input.retentionDays ?? null,
        immutable: input.immutable ?? false,
        autoExtensionEnabled: input.autoExtensionEnabled ?? false,
        autoExtensionDays: input.autoExtensionDays ?? null,
        currentVersion: 1,
        createdByUserId: input.actorUserId,
      },
    });
    // Seed version 1.
    await client.evidenceRetentionPolicyVersion.create({
      data: {
        retentionPolicyId: row.id,
        version: 1,
        retentionDays: row.retentionDays,
        immutable: row.immutable,
        autoExtensionEnabled: row.autoExtensionEnabled,
        autoExtensionDays: row.autoExtensionDays,
        diffJson: { initial: true } as unknown as prismaPkg.Prisma.InputJsonValue,
        authoredByUserId: input.actorUserId,
        changeNote: input.changeNote?.slice(0, 2000) ?? "Initial policy",
      },
    });
    bump("retention_policy_created_total");
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "retention_policy_created",
      severity: "WARNING",
      details: {
        retentionPolicyId: row.id,
        scope: input.scope,
        retentionDays: input.retentionDays,
        immutable: input.immutable ?? false,
        actorUserId: input.actorUserId,
      },
    });
    await emitTenantAudit({
      action: "retention.policy.create",
      outcome: "success",
      sourceApp: "API",
      actorUserId: input.actorUserId,
      workspaceId: input.teamId,
      resourceType: "evidence_retention_policy",
      resourceId: row.id,
      metadata: {
        scope: input.scope,
        retentionDays: input.retentionDays,
      },
    }, client);
    return projectPolicy(row);
  } catch (err) {
    if (
      err instanceof prismaPkg.Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new RetentionEngineError("RETENTION_POLICY_DUPLICATE");
    }
    throw err;
  }
}

// -----------------------------------------------------------------------------
// Update (writes new version)
// -----------------------------------------------------------------------------

export async function updateRetentionPolicy(
  input: {
    teamId: string;
    id: string;
    actorUserId: string;
    displayName?: string;
    description?: string | null;
    retentionDays?: number | null;
    immutable?: boolean;
    autoExtensionEnabled?: boolean;
    autoExtensionDays?: number | null;
    changeNote: string;
  },
  client: PrismaClient = defaultPrisma,
): Promise<RetentionPolicyProjection> {
  const parsed = RetentionPolicyUpdateInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new RetentionEngineError("RETENTION_POLICY_INVALID", {
      detail: parsed.error.flatten(),
    });
  }
  const existing = await client.evidenceRetentionPolicy.findFirst({
    where: { id: input.id, teamId: input.teamId },
  });
  if (!existing) {
    throw new RetentionEngineError("RETENTION_POLICY_NOT_FOUND");
  }
  if (existing.status === "ARCHIVED" || existing.status === "SUPERSEDED") {
    throw new RetentionEngineError("RETENTION_POLICY_TERMINAL", {
      status: existing.status,
    });
  }
  // Compute diff for the version row.
  const diff: Record<string, unknown> = {};
  if (
    input.retentionDays !== undefined &&
    input.retentionDays !== existing.retentionDays
  ) {
    diff.retentionDays = {
      from: existing.retentionDays,
      to: input.retentionDays,
    };
  }
  if (
    input.immutable !== undefined &&
    input.immutable !== existing.immutable
  ) {
    diff.immutable = { from: existing.immutable, to: input.immutable };
  }
  if (
    input.autoExtensionEnabled !== undefined &&
    input.autoExtensionEnabled !== existing.autoExtensionEnabled
  ) {
    diff.autoExtensionEnabled = {
      from: existing.autoExtensionEnabled,
      to: input.autoExtensionEnabled,
    };
  }
  if (
    input.autoExtensionDays !== undefined &&
    input.autoExtensionDays !== existing.autoExtensionDays
  ) {
    diff.autoExtensionDays = {
      from: existing.autoExtensionDays,
      to: input.autoExtensionDays,
    };
  }
  if (
    input.displayName !== undefined &&
    input.displayName !== existing.displayName
  ) {
    diff.displayName = { from: existing.displayName, to: input.displayName };
  }
  if (Object.keys(diff).length === 0) {
    return projectPolicy(existing); // no-op
  }
  const nextVersion = existing.currentVersion + 1;
  const updated = await client.evidenceRetentionPolicy.update({
    where: { id: existing.id },
    data: {
      displayName: input.displayName?.slice(0, 180) ?? existing.displayName,
      description:
        input.description === undefined
          ? existing.description
          : input.description?.slice(0, 2000) ?? null,
      retentionDays:
        input.retentionDays === undefined
          ? existing.retentionDays
          : input.retentionDays,
      immutable: input.immutable ?? existing.immutable,
      autoExtensionEnabled:
        input.autoExtensionEnabled ?? existing.autoExtensionEnabled,
      autoExtensionDays:
        input.autoExtensionDays === undefined
          ? existing.autoExtensionDays
          : input.autoExtensionDays,
      currentVersion: nextVersion,
    },
  });
  await client.evidenceRetentionPolicyVersion.create({
    data: {
      retentionPolicyId: updated.id,
      version: nextVersion,
      retentionDays: updated.retentionDays,
      immutable: updated.immutable,
      autoExtensionEnabled: updated.autoExtensionEnabled,
      autoExtensionDays: updated.autoExtensionDays,
      diffJson: diff as unknown as prismaPkg.Prisma.InputJsonValue,
      authoredByUserId: input.actorUserId,
      changeNote: input.changeNote.slice(0, 2000),
    },
  });
  bump("retention_policy_updated_total");
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "retention_policy_updated",
    severity: "WARNING",
    details: {
      retentionPolicyId: updated.id,
      version: nextVersion,
      diffKeys: Object.keys(diff),
      actorUserId: input.actorUserId,
    },
  });
  await emitTenantAudit({
    action: "retention.policy.update",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.actorUserId,
    workspaceId: input.teamId,
    resourceType: "evidence_retention_policy",
    resourceId: updated.id,
    metadata: { version: nextVersion, diffKeys: Object.keys(diff) },
  }, client);
  return projectPolicy(updated);
}

// -----------------------------------------------------------------------------
// Status transition (PAUSE / SUPERSEDE / ARCHIVE)
// -----------------------------------------------------------------------------

export async function transitionRetentionPolicy(
  input: {
    teamId: string;
    id: string;
    actorUserId: string;
    nextStatus: RetentionPolicyStatus;
    supersededByPolicyId?: string | null;
    changeNote: string;
  },
  client: PrismaClient = defaultPrisma,
): Promise<RetentionPolicyProjection> {
  if (!STATUS_SET.has(input.nextStatus)) {
    throw new RetentionEngineError("RETENTION_POLICY_INVALID");
  }
  const existing = await client.evidenceRetentionPolicy.findFirst({
    where: { id: input.id, teamId: input.teamId },
  });
  if (!existing) throw new RetentionEngineError("RETENTION_POLICY_NOT_FOUND");
  if (
    !isAllowedRetentionPolicyTransition(
      existing.status as RetentionPolicyStatus,
      input.nextStatus,
    )
  ) {
    throw new RetentionEngineError("RETENTION_POLICY_INVALID_TRANSITION", {
      from: existing.status,
      to: input.nextStatus,
    });
  }
  const now = new Date();
  const updated = await client.evidenceRetentionPolicy.update({
    where: { id: existing.id },
    data: {
      status: input.nextStatus,
      supersededByPolicyId:
        input.nextStatus === "SUPERSEDED"
          ? input.supersededByPolicyId ?? null
          : existing.supersededByPolicyId,
      archivedAtUtc: input.nextStatus === "ARCHIVED" ? now : existing.archivedAtUtc,
    },
  });
  const nextVersion = existing.currentVersion + 1;
  await client.evidenceRetentionPolicy.update({
    where: { id: updated.id },
    data: { currentVersion: nextVersion },
  });
  await client.evidenceRetentionPolicyVersion.create({
    data: {
      retentionPolicyId: updated.id,
      version: nextVersion,
      retentionDays: updated.retentionDays,
      immutable: updated.immutable,
      autoExtensionEnabled: updated.autoExtensionEnabled,
      autoExtensionDays: updated.autoExtensionDays,
      diffJson: {
        statusTransition: { from: existing.status, to: input.nextStatus },
        supersededByPolicyId: input.supersededByPolicyId ?? null,
      } as unknown as prismaPkg.Prisma.InputJsonValue,
      authoredByUserId: input.actorUserId,
      changeNote: input.changeNote.slice(0, 2000),
    },
  });
  if (input.nextStatus === "PAUSED") bump("retention_policy_updated_total");
  if (input.nextStatus === "SUPERSEDED") bump("retention_policy_superseded_total");
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType:
      input.nextStatus === "SUPERSEDED"
        ? "retention_policy_superseded"
        : input.nextStatus === "ARCHIVED"
          ? "retention_policy_archived"
          : input.nextStatus === "PAUSED"
            ? "retention_policy_paused"
            : "retention_policy_updated",
    severity: "WARNING",
    details: {
      retentionPolicyId: updated.id,
      from: existing.status,
      to: input.nextStatus,
      actorUserId: input.actorUserId,
    },
  });
  return projectPolicy(updated);
}

// -----------------------------------------------------------------------------
// Listing
// -----------------------------------------------------------------------------

export type ListRetentionPoliciesInput = {
  teamId: string;
  status?: RetentionPolicyStatus | "ALL";
  scope?: RetentionPolicyScope;
  limit?: number;
};

export async function listRetentionPolicies(
  input: ListRetentionPoliciesInput,
  client: PrismaClient = defaultPrisma,
): Promise<ReadonlyArray<RetentionPolicyProjection>> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const rows = await client.evidenceRetentionPolicy.findMany({
    where: {
      teamId: input.teamId,
      ...(input.status && input.status !== "ALL"
        ? { status: input.status }
        : {}),
      ...(input.scope ? { scope: input.scope } : {}),
    },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: limit,
  });
  return rows.map(projectPolicy);
}

export async function listPolicyVersions(
  input: { teamId: string; id: string; limit?: number },
  client: PrismaClient = defaultPrisma,
): Promise<
  ReadonlyArray<{
    version: number;
    retentionDays: number | null;
    immutable: boolean;
    diffJson: unknown;
    authoredByUserId: string;
    changeNote: string | null;
    authoredAtUtc: string;
  }>
> {
  const policy = await client.evidenceRetentionPolicy.findFirst({
    where: { id: input.id, teamId: input.teamId },
    select: { id: true },
  });
  if (!policy) throw new RetentionEngineError("RETENTION_POLICY_NOT_FOUND");
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const versions: DbPolicyVersion[] =
    await client.evidenceRetentionPolicyVersion.findMany({
      where: { retentionPolicyId: policy.id },
      orderBy: { authoredAtUtc: "desc" },
      take: limit,
    });
  return versions.map((v) => ({
    version: v.version,
    retentionDays: v.retentionDays,
    immutable: v.immutable,
    diffJson: v.diffJson,
    authoredByUserId: v.authoredByUserId,
    changeNote: v.changeNote,
    authoredAtUtc: v.authoredAtUtc.toISOString(),
  }));
}

// -----------------------------------------------------------------------------
// Resolver — pick the effective policy for a given evidence context.
// -----------------------------------------------------------------------------

export type ResolveEffectivePolicyInput = {
  teamId: string;
  evidenceType?: string | null;
  caseId?: string | null;
  jurisdiction?: string | null;
};

export type EffectiveRetentionDecision = {
  policy: RetentionPolicyProjection | null;
  reason: string;
  /**
   * Phase G1 (B0.4) — source attribution for the effective retention
   * decision. Mirrors the Phase B0 `resolveTeamRetentionPolicy` verdict
   * so callers can render inheritance state without a second round-trip:
   *
   *   * `team_policy`         — an explicit `EvidenceRetentionPolicy`
   *                             row matched (scope-based pick winner).
   *   * `org_policy_inherited` — no explicit policy matched; the engine
   *                              fell back to the parent organization's
   *                              published retention template.
   *   * `none`                 — no policy at any tier; indefinite
   *                              retention default applies.
   */
  source: "team_policy" | "org_policy_inherited" | "none";
  /**
   * Phase G1 (B0.4) — when `source === "org_policy_inherited"`, this
   * carries the inherited template's retention horizon + immutable
   * flag so downstream callers don't need to recompute it from the
   * inheritance resolver.
   */
  inheritedTemplate?: {
    organizationId: string;
    retentionDays: number | null;
    immutable: boolean;
    description: string | null;
  };
  /**
   * PV-DUP-002 — the retention that actually GOVERNS, after the organization's
   * mandatory floor. `null` is indefinite. Equal to the winning policy's own
   * value unless an immutable organization template raised it, in which case
   * `mandatoryFloorApplied` is true. Every surface shows this number, so the
   * effective panel and the inheritance panel cannot disagree about it.
   */
  effectiveRetentionDays: number | null;
  mandatoryFloorApplied?: boolean;
  /**
   * Phase G1 — bounded conflict surface. The engine emits structured
   * conflict codes whenever an operational rule fires (same-scope
   * duplicate, weaker-than-inherited workspace override, etc.). UI
   * consumers can render these without inventing copy.
   */
  conflicts: ReadonlyArray<{
    code:
      | "duplicate_same_scope"
      | "workspace_weaker_than_inherited"
      | "workspace_overrides_immutable";
    detail: string;
  }>;
};

export async function resolveEffectiveRetentionPolicy(
  input: ResolveEffectivePolicyInput,
  client: PrismaClient = defaultPrisma,
): Promise<EffectiveRetentionDecision> {
  /*
   * ONE ARM PER FILTER THE CALLER ACTUALLY SUPPLIED.
   *
   * This used to emit `{ id: "__never__" }` for each absent optional filter,
   * intending an arm that matches nothing. `EvidenceRetentionPolicy.id` is
   * `@db.Uuid`, so PostgreSQL rejected the WHOLE statement with
   * `invalid input syntax for type uuid: "__never__"` — the sentinel did not
   * match nothing, it invalidated the query.
   *
   * It fired on the ORDINARY call. A workspace-level resolution supplies no
   * evidence type, no jurisdiction and no case, so all three no-op arms were
   * present and the resolver failed at exactly the question it exists to
   * answer. Every such call also raised a critical operational alert.
   *
   * An absent filter is the ABSENCE of a predicate, so it is expressed by not
   * pushing one. The WORKSPACE arm is unconditional and keeps the array
   * non-empty, so `OR` is always well-formed.
   */
  const scopeArms: prismaPkg.Prisma.EvidenceRetentionPolicyWhereInput[] = [
    { scope: "WORKSPACE" },
  ];
  if (input.evidenceType) {
    scopeArms.push({ scope: "EVIDENCE_TYPE", scopeQualifier: input.evidenceType });
  }
  if (input.jurisdiction) {
    scopeArms.push({ scope: "REGULATORY", scopeQualifier: input.jurisdiction });
  }
  if (input.caseId) {
    scopeArms.push({ scope: "CASE", caseId: input.caseId });
  }

  const candidates = await client.evidenceRetentionPolicy.findMany({
    where: {
      teamId: input.teamId,
      status: "ACTIVE",
      OR: scopeArms,
    },
  });

  const conflicts: Array<{
    code:
      | "duplicate_same_scope"
      | "workspace_weaker_than_inherited"
      | "workspace_overrides_immutable";
    detail: string;
  }> = [];

  // -------------------------------------------------------------------
  // PV-DUP-002 — ONE read of the organization template, shared by the
  // inheritance fallback, the mandatory floor and the conflict checks.
  //
  // This used to ask the Phase B0 inheritance resolver twice. That resolver
  // answers "team_policy" whenever the workspace has a policy of its own, so
  // the conflict branch below — which only ran when it said
  // "org_policy_inherited" — could never fire beside a winner: both conflict
  // codes were dead, and the immutable floor that resolver applied never
  // reached this decision. The retention page showed one number here and a
  // different one in its inheritance panel.
  //
  // A database failure propagates. It is not "no policy applies".
  // -------------------------------------------------------------------
  const org = await readOrganizationRetentionTemplate(input.teamId, client);

  if (candidates.length === 0) {
    if (org.organizationId && org.template) {
      bump("retention_policy_inherited_total");
      return {
        policy: null,
        reason: "inherited_from_org",
        source: "org_policy_inherited",
        inheritedTemplate: {
          organizationId: org.organizationId,
          retentionDays: org.template.retentionDays,
          immutable: org.template.immutable,
          description: org.template.description,
        },
        effectiveRetentionDays: org.template.retentionDays,
        conflicts,
      };
    }
    return {
      policy: null,
      reason: "no_active_policy",
      source: "none",
      effectiveRetentionDays: null,
      conflicts,
    };
  }

  const projected = candidates.map(projectPolicy);
  const winner = pickHighestPrecedencePolicy(projected);
  if (!winner) {
    return {
      policy: null,
      reason: "no_winner",
      source: "none",
      effectiveRetentionDays: null,
      conflicts,
    };
  }
  // Check for genuine conflict at the SAME scope (two ACTIVE policies
  // at the same scope is a config error worth surfacing).
  const sameScopeMatches = projected.filter(
    (p) => p.scope === winner.scope && p.scopeQualifier === winner.scopeQualifier,
  );
  if (sameScopeMatches.length > 1) {
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "retention_policy_updated",
      severity: "WARNING",
      details: {
        scope: winner.scope,
        conflictCount: sameScopeMatches.length,
      },
    });
    conflicts.push({
      code: "duplicate_same_scope",
      detail: `${sameScopeMatches.length} ACTIVE policies at scope ${winner.scope}${winner.scopeQualifier ? `/${winner.scopeQualifier}` : ""}`,
    });
  }

  // -------------------------------------------------------------------
  // The organization template against the winning policy (§9.4: a child
  // may strengthen the organization's rule, never weaken it).
  //
  //   * workspace_overrides_immutable — the template is IMMUTABLE and the
  //     winning policy is weaker. The template is a mandatory floor, so
  //     the effective retention is RAISED to it; the local row is left
  //     untouched and the conflict is surfaced for the governance admin.
  //   * workspace_weaker_than_inherited — the template is advisory and
  //     the winning policy is weaker. The local policy applies.
  //
  // A policy at least as strong as the template is compliant and raises
  // nothing.
  // -------------------------------------------------------------------
  const floor = applyOrganizationRetentionFloor(winner.retentionDays, org.template);
  if (org.template && isWeakerRetention(winner.retentionDays, org.template.retentionDays)) {
    const days = (d: number | null) => (d === null ? "indefinite retention" : `${d} days`);
    conflicts.push(
      org.template.immutable
        ? {
            code: "workspace_overrides_immutable",
            detail: `The organization's retention template is immutable (${days(org.template.retentionDays)}). This workspace's policy (${days(winner.retentionDays)}) is weaker, so the organization floor is enforced.`,
          }
        : {
            code: "workspace_weaker_than_inherited",
            detail: `Local workspace retention (${days(winner.retentionDays)}) is shorter than the organization template (${days(org.template.retentionDays)}). The template is advisory, so the workspace policy applies.`,
          },
    );
  }

  return {
    policy: winner,
    reason: `picked_${winner.scope.toLowerCase()}`,
    source: "team_policy",
    effectiveRetentionDays: floor.retentionDays,
    ...(floor.mandatoryFloorApplied ? { mandatoryFloorApplied: true } : {}),
    conflicts,
  };
}

// -----------------------------------------------------------------------------
// Conflict count — operator dashboard signal.
// -----------------------------------------------------------------------------

export async function countActivePolicyConflicts(
  teamId: string,
  client: PrismaClient = defaultPrisma,
): Promise<number> {
  // A "conflict" is two ACTIVE policies covering the same (scope,
  // scopeQualifier, caseId) tuple. We compute by groupBy + count > 1.
  const rows = await client.evidenceRetentionPolicy.groupBy({
    by: ["teamId", "scope", "scopeQualifier", "caseId", "status"],
    where: { teamId, status: "ACTIVE" },
    _count: { _all: true },
  });
  return rows.filter((r) => r._count._all > 1).length;
}
