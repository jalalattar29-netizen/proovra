/**
 * PROOVRA Phase 4A — Department service.
 *
 * Org sub-units enabling departmental isolation. A Department is
 * a bounded grouping under an Organization; workspaces / cases /
 * reviews can be scoped to a department for visibility + governance
 * separation.
 */

import type { PrismaClient } from "@prisma/client";
import {
  DEPARTMENT_STATES,
  type DepartmentProjection,
  type DepartmentState,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { emitDepartmentEvent } from "../trust/trust-and-governance-audit.service.js";

export type CreateDepartmentInput = {
  prisma?: PrismaClient;
  teamId: string;
  organizationId: string;
  name: string;
  slug: string;
  createdByUserId: string;
};

export type CreateDepartmentResult =
  | { ok: true; departmentId: string }
  | { ok: false; denial: "POLICY_REJECTED" | "DUPLICATE" };

export async function createDepartment(
  input: CreateDepartmentInput,
): Promise<CreateDepartmentResult> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.slug)) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  const prisma = input.prisma ?? defaultPrisma;
  const existing = await prisma.department.findFirst({
    where: { organizationId: input.organizationId, slug: input.slug },
    select: { id: true },
  });
  if (existing) return { ok: false, denial: "DUPLICATE" };
  const row = await prisma.department.create({
    data: {
      teamId: input.teamId,
      organizationId: input.organizationId,
      name: input.name.slice(0, 200),
      slug: input.slug,
      state: "ACTIVE",
      createdByUserId: input.createdByUserId,
    },
    select: { id: true },
  });
  void emitDepartmentEvent({
    prisma,
    teamId: input.teamId,
    departmentId: row.id,
    code: "DEPARTMENT_CREATED",
    actorUserId: input.createdByUserId,
  }).catch(() => {});
  return { ok: true, departmentId: row.id };
}

export async function archiveDepartment(input: {
  prisma?: PrismaClient;
  teamId: string;
  departmentId: string;
}): Promise<{ ok: boolean }> {
  const prisma = input.prisma ?? defaultPrisma;
  const row = await prisma.department.findFirst({
    where: { id: input.departmentId, teamId: input.teamId },
    select: { id: true, state: true },
  });
  if (!row) return { ok: false };
  if (row.state === "ARCHIVED") return { ok: true };
  await prisma.department.update({
    where: { id: row.id },
    data: { state: "ARCHIVED" },
  });
  void emitDepartmentEvent({
    prisma,
    teamId: input.teamId,
    departmentId: row.id,
    code: "DEPARTMENT_ARCHIVED",
    actorUserId: "system",
  }).catch(() => {});
  return { ok: true };
}

export async function listDepartments(input: {
  prisma?: PrismaClient;
  teamId: string;
  organizationId?: string;
  state?: DepartmentState;
}): Promise<ReadonlyArray<DepartmentProjection>> {
  const prisma = input.prisma ?? defaultPrisma;
  const rows = await prisma.department.findMany({
    where: {
      teamId: input.teamId,
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      ...(input.state ? { state: input.state } : {}),
    },
    orderBy: { name: "asc" },
    take: 500,
  });
  return rows.map((r) => ({
    id: r.id,
    // R7-governance: organizationId is R7-additive nullable. Coalesce to "" so projection contract
    // stays non-null. Department isolation enforcement reads the column directly (not the projection).
    organizationId: r.organizationId ?? "",
    name: r.name,
    // R7-governance: slug is R7-additive nullable. Coalesce to "" so projection contract stays non-null.
    slug: r.slug ?? "",
    state: r.state as DepartmentState,
    // R7-governance: workspaceCount + reviewerCount are dashboard aggregates. Placeholder 0 here;
    // the governance-dashboard.service computes the real counts in its own aggregation pass.
    workspaceCount: 0,
    reviewerCount: 0,
    createdAtUtc: r.createdAt.toISOString(),
  }));
}

// Compile-time guard.
function _assertEnumsIntact(): void {
  const _s: DepartmentState = "ACTIVE";
  void _s;
  void DEPARTMENT_STATES;
}
void _assertEnumsIntact;
