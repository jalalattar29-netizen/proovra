/**
 * PROOVRA Phase 4A — Delegated administration service.
 *
 * Tiered admin grants — GLOBAL_ADMIN / ORG_ADMIN / DEPARTMENT_ADMIN
 * / WORKSPACE_ADMIN / REVIEWER_LEAD / SECURITY_OFFICER /
 * COMPLIANCE_OFFICER. Enforced server-side.
 *
 * Hard rules:
 *   * Workspace-anchored.
 *   * Append-only grant + revoke history (revoked grants stay in
 *     the table with state=REVOKED + revokedAtUtc).
 *   * `hasDelegatedTier` is the single canonical authorisation
 *     check — routes wire it through.
 */

import type { PrismaClient } from "@prisma/client";
import {
  DELEGATED_ADMIN_GRANT_STATES,
  DELEGATED_ADMIN_TIERS,
  type DelegatedAdminGrantProjection,
  type DelegatedAdminGrantState,
  type DelegatedAdminTier,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { emitDelegatedAdminEvent } from "../trust/trust-and-governance-audit.service.js";

export type GrantDelegatedAdminInput = {
  prisma?: PrismaClient;
  teamId: string;
  organizationId: string;
  departmentId?: string | null;
  workspaceId?: string | null;
  granteeUserId: string;
  tier: DelegatedAdminTier;
  grantedByUserId: string;
  expiresAtUtc?: Date | null;
};

export type GrantDelegatedAdminResult =
  | { ok: true; grantId: string }
  | { ok: false; denial: "POLICY_REJECTED" };

export async function grantDelegatedAdmin(
  input: GrantDelegatedAdminInput,
): Promise<GrantDelegatedAdminResult> {
  if (!(DELEGATED_ADMIN_TIERS as ReadonlyArray<string>).includes(input.tier)) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  if (input.tier === "DEPARTMENT_ADMIN" && !input.departmentId) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  if (input.tier === "WORKSPACE_ADMIN" && !input.workspaceId) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  const prisma = input.prisma ?? defaultPrisma;
  const row = await prisma.delegatedAdminGrant.create({
    data: {
      teamId: input.teamId,
      organizationId: input.organizationId,
      departmentId: input.departmentId ?? null,
      workspaceId: input.workspaceId ?? null,
      granteeUserId: input.granteeUserId,
      tier: input.tier,
      state: "ACTIVE",
      grantedByUserId: input.grantedByUserId,
      expiresAtUtc: input.expiresAtUtc ?? null,
    },
    select: { id: true },
  });
  void emitDelegatedAdminEvent({
    prisma,
    teamId: input.teamId,
    grantId: row.id,
    code: "DELEGATED_ADMIN_GRANTED",
    actorUserId: input.grantedByUserId,
  }).catch(() => {});
  return { ok: true, grantId: row.id };
}

export async function revokeDelegatedAdmin(input: {
  prisma?: PrismaClient;
  teamId: string;
  grantId: string;
  actorUserId: string;
}): Promise<{ ok: boolean }> {
  const prisma = input.prisma ?? defaultPrisma;
  const row = await prisma.delegatedAdminGrant.findFirst({
    where: { id: input.grantId, teamId: input.teamId },
    select: { id: true, state: true },
  });
  if (!row) return { ok: false };
  if (row.state !== "ACTIVE") return { ok: false };
  await prisma.delegatedAdminGrant.update({
    where: { id: row.id },
    data: { state: "REVOKED", revokedAtUtc: new Date() },
  });
  void emitDelegatedAdminEvent({
    prisma,
    teamId: input.teamId,
    grantId: row.id,
    code: "DELEGATED_ADMIN_REVOKED",
    actorUserId: input.actorUserId,
  }).catch(() => {});
  return { ok: true };
}

export async function listDelegatedGrants(input: {
  prisma?: PrismaClient;
  teamId: string;
  organizationId?: string;
  granteeUserId?: string;
  tier?: DelegatedAdminTier;
  state?: DelegatedAdminGrantState;
}): Promise<ReadonlyArray<DelegatedAdminGrantProjection>> {
  const prisma = input.prisma ?? defaultPrisma;
  const rows = await prisma.delegatedAdminGrant.findMany({
    where: {
      teamId: input.teamId,
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      ...(input.granteeUserId ? { granteeUserId: input.granteeUserId } : {}),
      ...(input.tier ? { tier: input.tier } : {}),
      ...(input.state ? { state: input.state } : {}),
    },
    orderBy: { grantedAtUtc: "desc" },
    take: 500,
  });
  return rows.map((r) => ({
    id: r.id,
    // R7-governance: organizationId is R7-additive nullable (org-less grants exist for workspace-only
    // tiers like WORKSPACE_ADMIN). Coalesce to "" so projection contract stays string. Role-check
    // engine doesn't depend on this projection field — it reads the column directly.
    organizationId: r.organizationId ?? "",
    departmentId: r.departmentId,
    workspaceId: r.workspaceId,
    granteeUserId: r.granteeUserId,
    tier: r.tier as DelegatedAdminTier,
    state: r.state as DelegatedAdminGrantState,
    grantedByUserId: r.grantedByUserId,
    grantedAtUtc: r.grantedAtUtc.toISOString(),
    revokedAtUtc: r.revokedAtUtc?.toISOString() ?? null,
    expiresAtUtc: r.expiresAtUtc?.toISOString() ?? null,
  }));
}

/**
 * Canonical authorisation check. Returns true if the user holds an
 * ACTIVE delegated admin grant of the requested tier (or stronger)
 * anywhere in the workspace.
 *
 * Tier strength: GLOBAL_ADMIN > ORG_ADMIN > DEPARTMENT_ADMIN >
 * WORKSPACE_ADMIN. The cross-cutting tiers (REVIEWER_LEAD,
 * SECURITY_OFFICER, COMPLIANCE_OFFICER) are independent — they
 * only match themselves.
 */
export async function hasDelegatedTier(input: {
  prisma?: PrismaClient;
  teamId: string;
  userId: string;
  requiredTier: DelegatedAdminTier;
  organizationId?: string | null;
  departmentId?: string | null;
  workspaceId?: string | null;
}): Promise<boolean> {
  const prisma = input.prisma ?? defaultPrisma;
  const acceptableTiers = expandAcceptableTiers(input.requiredTier);
  // Phase O — Sentry NODE-1K hardening. The
  // 20270802000000_phase_sentry_batch_schema_drift_repair migration
  // adds `granted_to_user_id`, `scope_target_id`, `created_at`,
  // `updated_at` on `delegated_admin_grants` so this `findMany`
  // succeeds against partial-state production. Until the migration
  // is applied everywhere, a P2022 from a stale DB MUST NOT crash
  // the auth path. We fail closed (return false) but continue
  // through the implicit-owner ladder below so the workspace owner
  // can still pass the tier check on a degraded DB. Operator sees a
  // POLICY_VIOLATION audit event from the middleware on denial —
  // that's the canonical surface for the failed authorisation.
  let grants: Array<{
    tier: string;
    organizationId: string | null;
    departmentId: string | null;
    workspaceId: string | null;
    expiresAtUtc: Date | null;
  }> = [];
  try {
    grants = await prisma.delegatedAdminGrant.findMany({
      where: {
        teamId: input.teamId,
        granteeUserId: input.userId,
        state: "ACTIVE",
        tier: { in: acceptableTiers },
      },
      select: {
        tier: true,
        organizationId: true,
        departmentId: true,
        workspaceId: true,
        expiresAtUtc: true,
      },
    });
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code ?? "")
        : "";
    if (code !== "P2022" && code !== "P2021") {
      // Genuine error — re-throw so observability can capture it.
      throw err;
    }
    // Schema-drift on delegated_admin_grants — fall through with no
    // explicit grants. The implicit owner ladder below still runs.
    grants = [];
  }
  const now = Date.now();
  for (const g of grants) {
    if (g.expiresAtUtc && g.expiresAtUtc.getTime() < now) continue;
    // GLOBAL_ADMIN matches every scope.
    if (g.tier === "GLOBAL_ADMIN") return true;
    // ORG_ADMIN matches when the org matches OR when the candidate
    // operation has no org context (workspace-wide).
    if (g.tier === "ORG_ADMIN") {
      if (!input.organizationId || g.organizationId === input.organizationId) return true;
    }
    if (g.tier === "DEPARTMENT_ADMIN") {
      if (!input.departmentId || g.departmentId === input.departmentId) return true;
    }
    if (g.tier === "WORKSPACE_ADMIN") {
      if (!input.workspaceId || g.workspaceId === input.workspaceId) return true;
    }
    if (
      g.tier === "REVIEWER_LEAD" ||
      g.tier === "SECURITY_OFFICER" ||
      g.tier === "COMPLIANCE_OFFICER"
    ) {
      // Cross-cutting tiers — return true at the same tier only.
      if (g.tier === input.requiredTier) return true;
    }
  }

  // Phase 4A Closure — implicit workspace-owner grant.
  // The workspace owner is treated as an ORG_ADMIN of the workspace by
  // construction: they bootstrapped the tenant and there is nobody
  // hierarchically above them to issue a formal grant. We honour that
  // for any tier in the org-chain ladder (ORG_ADMIN, DEPARTMENT_ADMIN,
  // WORKSPACE_ADMIN). GLOBAL_ADMIN and the cross-cutting tiers
  // (REVIEWER_LEAD / SECURITY_OFFICER / COMPLIANCE_OFFICER) must still
  // be granted explicitly — owner ≠ global super-user.
  const ownerImpliedTiers: ReadonlyArray<DelegatedAdminTier> = [
    "ORG_ADMIN",
    "DEPARTMENT_ADMIN",
    "WORKSPACE_ADMIN",
  ];
  if (ownerImpliedTiers.includes(input.requiredTier)) {
    try {
      const team = await prisma.team.findUnique({
        where: { id: input.teamId },
        select: { ownerUserId: true },
      });
      if (team && team.ownerUserId === input.userId) {
        return true;
      }
    } catch {
      // Fail closed on owner lookup error — fall through to false.
    }
  }
  return false;
}

function expandAcceptableTiers(
  requiredTier: DelegatedAdminTier,
): DelegatedAdminTier[] {
  // Strongest-first hierarchy for the org chain.
  const ladder: DelegatedAdminTier[] = [
    "GLOBAL_ADMIN",
    "ORG_ADMIN",
    "DEPARTMENT_ADMIN",
    "WORKSPACE_ADMIN",
  ];
  const idx = ladder.indexOf(requiredTier);
  if (idx >= 0) {
    return ladder.slice(0, idx + 1);
  }
  // Cross-cutting tiers — only themselves match.
  return [requiredTier];
}

// Compile-time guard.
function _assertStatesIntact(): void {
  const _x: DelegatedAdminGrantState = "ACTIVE";
  void _x;
  void DELEGATED_ADMIN_GRANT_STATES;
}
void _assertStatesIntact;
