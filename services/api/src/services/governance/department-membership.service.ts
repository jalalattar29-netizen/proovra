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
  | {
      ok: true;
      membershipId: string;
      /**
       * PHASE 12B CLUSTER 14 — idempotency signal. `true` when the row was
       * ALREADY `ACTIVE` with the requested role, so no write happened. The
       * route surfaces this so an accidental double-submit is a no-op
       * instead of a second audit event.
       */
      unchanged: boolean;
      /** Bounded state the row held BEFORE this call (`null` = new row). */
      priorState: DepartmentMembershipState | null;
    }
  | {
      ok: false;
      denial:
        | "POLICY_REJECTED"
        | "DEPARTMENT_NOT_FOUND"
        // PHASE 12B CLUSTER 14 — cross-Organization isolation. The subject
        // must be an ACTIVE member of the SAME workspace; a bare user UUID
        // from another Organization is never grantable.
        | "USER_NOT_A_MEMBER"
        // PHASE 12B CLUSTER 14 — stale-state rejection. The caller declared
        // the state it observed; the row has moved on since.
        | "STALE_STATE";
    };

export type RevokeDepartmentMembershipResult =
  | { ok: true }
  | { ok: false; denial: "NOT_FOUND" | "ALREADY_REVOKED" | "STALE_STATE" };

/**
 * PHASE 12B CLUSTER 14 — the state a mutating caller declares it observed.
 * `"NONE"` means "I saw no membership row for this (department, user)".
 * Omitting it entirely skips the check (used only by non-interactive
 * callers); the departments console ALWAYS sends it.
 */
export type ObservedMembershipState = DepartmentMembershipState | "NONE";

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
  /** PHASE 12B CLUSTER 14 — stale-state guard; see {@link ObservedMembershipState}. */
  expectedState?: ObservedMembershipState;
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

  // PHASE 12B CLUSTER 14 — cross-Organization isolation. Without this the
  // route accepted ANY user UUID, so an operator could attach a member of a
  // different Organization to this workspace's department and hand them
  // department-scoped evidence visibility. The subject must hold an ACTIVE
  // workspace membership in the SAME workspace as the department.
  const subject = await prisma.teamMember.findFirst({
    where: { teamId: input.teamId, userId: input.userId, status: "ACTIVE" },
    select: { id: true },
  });
  if (!subject) {
    return { ok: false, denial: "USER_NOT_A_MEMBER" };
  }

  // ZERO PARTIAL MUTATION — the read-compare-write sequence runs inside one
  // transaction so a concurrent grant/revoke cannot interleave between the
  // stale-state check and the write.
  return prisma.$transaction(async (tx) => {
    const existing = await tx.departmentMembership.findFirst({
      where: { departmentId: input.departmentId, userId: input.userId },
      select: { id: true, state: true, role: true },
    });

    // STALE-STATE REJECTION — the caller declared what it saw; if the row
    // moved on (someone else granted / revoked it), refuse rather than
    // silently overwrite another operator's decision.
    if (input.expectedState !== undefined) {
      const observed: ObservedMembershipState = existing
        ? (existing.state as DepartmentMembershipState)
        : "NONE";
      if (observed !== input.expectedState) {
        return { ok: false, denial: "STALE_STATE" } as const;
      }
    }

    if (existing) {
      // IDEMPOTENCY — already ACTIVE with the requested role: no write, no
      // audit event, same membership id returned.
      if (existing.state === "ACTIVE" && existing.role === role) {
        return {
          ok: true,
          membershipId: existing.id,
          unchanged: true,
          priorState: existing.state as DepartmentMembershipState,
        } as const;
      }
      await tx.departmentMembership.update({
        where: { id: existing.id },
        data: {
          role,
          state: "ACTIVE",
          grantedByUserId: input.grantedByUserId,
          revokedAtUtc: null,
        },
      });
      return {
        ok: true,
        membershipId: existing.id,
        unchanged: false,
        priorState: existing.state as DepartmentMembershipState,
      } as const;
    }

    const row = await tx.departmentMembership.create({
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
    return {
      ok: true,
      membershipId: row.id,
      unchanged: false,
      priorState: null,
    } as const;
  });
}

// ---------------------------------------------------------------------------
// Revoke.
// ---------------------------------------------------------------------------

export type RevokeDepartmentMembershipInput = {
  prisma?: PrismaClient;
  teamId: string;
  membershipId: string;
  actorUserId: string;
  /** PHASE 12B CLUSTER 14 — stale-state guard; see {@link ObservedMembershipState}. */
  expectedState?: ObservedMembershipState;
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
  // Touch the row using a bounded mutation; actorUserId is reserved
  // for the audit emitter the caller is expected to invoke separately.
  void input.actorUserId;
  // ZERO PARTIAL MUTATION — read-compare-write inside one transaction, so a
  // concurrent revoke cannot double-apply.
  return prisma.$transaction(async (tx) => {
    const row = await tx.departmentMembership.findFirst({
      // Workspace-anchored: a membershipId from another Organization reads
      // as NOT_FOUND, never as a revocable row.
      where: { id: input.membershipId, teamId: input.teamId },
      select: { id: true, state: true },
    });
    if (!row) return { ok: false, denial: "NOT_FOUND" } as const;
    // STALE-STATE REJECTION — the console declares the state it rendered.
    if (
      input.expectedState !== undefined &&
      (row.state as DepartmentMembershipState) !== input.expectedState
    ) {
      return { ok: false, denial: "STALE_STATE" } as const;
    }
    if (row.state !== "ACTIVE") {
      return { ok: false, denial: "ALREADY_REVOKED" } as const;
    }
    await tx.departmentMembership.update({
      where: { id: row.id },
      data: { state: "REVOKED", revokedAtUtc: new Date() },
    });
    return { ok: true } as const;
  });
}

// ---------------------------------------------------------------------------
// List.
// ---------------------------------------------------------------------------

export type ListDepartmentMembershipsInput = {
  prisma?: PrismaClient;
  teamId: string;
  departmentId?: string;
  userId?: string;
  /** PHASE 12B CLUSTER 14 — server-side state filter for the console. */
  state?: DepartmentMembershipState;
  /** PHASE 12B CLUSTER 14 — deterministic page size (1..500, default 100). */
  limit?: number;
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
      ...(input.state ? { state: input.state } : {}),
    },
    // DETERMINISTIC ORDER — `createdAt` alone is not a total order (two rows
    // can share a millisecond), which made the page-size boundary unstable.
    // `id` is the tiebreaker.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: Math.min(Math.max(input.limit ?? 100, 1), 500),
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
