/**
 * PROOVRA Phase 4A Closure — Department membership service.
 *
 * Sibling to `department-scope.service.ts`. Bounded grant / revoke
 * / list path for the `DepartmentMembership` table the scope resolver
 * reads from.
 *
 * Hard rules:
 *   * Workspace-anchored — every mutation requires `teamId`.
 *   * Append-only — revoked memberships stay in the table with
 *     `state = REVOKED` + `revokedAtUtc`.
 *   * Bounded role + state vocabulary from `@proovra/shared`.
 *   * `(departmentId, userId)` is unique — re-granting an existing
 *     membership flips it back to `ACTIVE` rather than inserting a
 *     duplicate row.
 *   * Projections never include PII; only ids + bounded enums.
 */

import type { PrismaClient } from "@prisma/client";
import {
  DEPARTMENT_MEMBERSHIP_ROLES,
  DEPARTMENT_MEMBERSHIP_STATES,
  type DepartmentMembershipProjection,
  type DepartmentMembershipRole,
  type DepartmentMembershipState,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";

// ---------------------------------------------------------------------------
// Bounded denial vocabulary.
// ---------------------------------------------------------------------------

export type GrantDepartmentMembershipResult =
  | { ok: true; membershipId: string }
  | { ok: false; denial: "POLICY_REJECTED" | "DEPARTMENT_NOT_FOUND" };

export type RevokeDepartmentMembershipResult =
  | { ok: true }
  | { ok: false; denial: "NOT_FOUND" | "ALREADY_REVOKED" };

// ---------------------------------------------------------------------------
// Grant.
// ---------------------------------------------------------------------------

export type GrantDepartmentMembershipInput = {
  prisma?: PrismaClient;
  teamId: string;
  departmentId: string;
  userId: string;
  role?: DepartmentMembershipRole;
  grantedByUserId: string;
};

/**
 * Grant the user a membership in the department.
 *
 *   * If a prior `REVOKED` membership exists, the row is re-activated
 *     in place (state → ACTIVE, role updated, grantedByUserId
 *     refreshed, `revokedAtUtc` cleared).
 *   * If an `ACTIVE` membership already exists, the role is updated
 *     idempotently and the existing id returned.
 *   * Validates the bounded role + verifies the department is in the
 *     same workspace.
 */
export async function grantDepartmentMembership(
  input: GrantDepartmentMembershipInput,
): Promise<GrantDepartmentMembershipResult> {
  const role: DepartmentMembershipRole = input.role ?? "MEMBER";
  if (!(DEPARTMENT_MEMBERSHIP_ROLES as ReadonlyArray<string>).includes(role)) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  const prisma = input.prisma ?? defaultPrisma;

  // Workspace-anchor check.
  const department = await prisma.department.findFirst({
    where: { id: input.departmentId, teamId: input.teamId },
    select: { id: true },
  });
  if (!department) {
    return { ok: false, denial: "DEPARTMENT_NOT_FOUND" };
  }

  const existing = await prisma.departmentMembership.findFirst({
    where: { departmentId: input.departmentId, userId: input.userId },
    select: { id: true, state: true },
  });

  if (existing) {
    await prisma.departmentMembership.update({
      where: { id: existing.id },
      data: {
        role,
        state: "ACTIVE",
        grantedByUserId: input.grantedByUserId,
        revokedAtUtc: null,
      },
    });
    return { ok: true, membershipId: existing.id };
  }

  const row = await prisma.departmentMembership.create({
    data: {
      teamId: input.teamId,
      departmentId: input.departmentId,
      userId: input.userId,
      role,
      state: "ACTIVE",
      grantedByUserId: input.grantedByUserId,
    },
    select: { id: true },
  });
  return { ok: true, membershipId: row.id };
}

// ---------------------------------------------------------------------------
// Revoke.
// ---------------------------------------------------------------------------

export type RevokeDepartmentMembershipInput = {
  prisma?: PrismaClient;
  teamId: string;
  membershipId: string;
  actorUserId: string;
};

/**
 * Revoke the given membership. Append-only — the row stays in the
 * table with `state = REVOKED` + `revokedAtUtc` populated.
 *
 *   * Workspace-anchored on `teamId`.
 *   * `actorUserId` is currently used as the audit hook; the row
 *     itself only stores the original grant chain.
 */
export async function revokeDepartmentMembership(
  input: RevokeDepartmentMembershipInput,
): Promise<RevokeDepartmentMembershipResult> {
  const prisma = input.prisma ?? defaultPrisma;
  const row = await prisma.departmentMembership.findFirst({
    where: { id: input.membershipId, teamId: input.teamId },
    select: { id: true, state: true },
  });
  if (!row) return { ok: false, denial: "NOT_FOUND" };
  if (row.state !== "ACTIVE") {
    return { ok: false, denial: "ALREADY_REVOKED" };
  }
  // Touch the row using a bounded mutation; actorUserId is reserved
  // for the audit emitter the caller is expected to invoke separately.
  void input.actorUserId;
  await prisma.departmentMembership.update({
    where: { id: row.id },
    data: { state: "REVOKED", revokedAtUtc: new Date() },
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// List.
// ---------------------------------------------------------------------------

export type ListDepartmentMembershipsInput = {
  prisma?: PrismaClient;
  teamId: string;
  departmentId?: string;
  userId?: string;
};

/**
 * List department memberships in the workspace, optionally narrowed
 * by department and/or user. Returns bounded `DepartmentMembershipProjection`
 * rows ordered newest-first. Capped at 500 rows.
 */
export async function listDepartmentMemberships(
  input: ListDepartmentMembershipsInput,
): Promise<ReadonlyArray<DepartmentMembershipProjection>> {
  const prisma = input.prisma ?? defaultPrisma;
  const rows = await prisma.departmentMembership.findMany({
    where: {
      teamId: input.teamId,
      ...(input.departmentId ? { departmentId: input.departmentId } : {}),
      ...(input.userId ? { userId: input.userId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  return rows.map((r: (typeof rows)[number]) => ({
    id: r.id,
    departmentId: r.departmentId,
    userId: r.userId,
    role: r.role as DepartmentMembershipRole,
    state: r.state as DepartmentMembershipState,
    grantedByUserId: r.grantedByUserId ?? null,
    createdAtUtc: r.createdAt.toISOString(),
    revokedAtUtc: r.revokedAtUtc?.toISOString() ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Compile-time guard — keep bounded enums referenced so a future
// removal trips TypeScript here first.
// ---------------------------------------------------------------------------

function _assertEnumsIntact(): void {
  const _r: DepartmentMembershipRole = "MEMBER";
  const _s: DepartmentMembershipState = "ACTIVE";
  void _r;
  void _s;
  void DEPARTMENT_MEMBERSHIP_ROLES;
  void DEPARTMENT_MEMBERSHIP_STATES;
}
void _assertEnumsIntact;
