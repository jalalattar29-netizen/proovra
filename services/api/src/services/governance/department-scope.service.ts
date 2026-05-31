/**
 * PROOVRA Phase 4A Closure — Department scope resolver.
 *
 * Server-side resolver returning the bounded `DepartmentScopeEnvelope`
 * the user can access plus Prisma where-clause helpers consumers
 * compose into their queries.
 *
 * Hard rules:
 *   * Workspace-anchored — every resolve requires `teamId` + `userId`.
 *   * Bounded envelope from `@proovra/shared` (`DepartmentScopeEnvelope`).
 *   * GLOBAL_ADMIN / ORG_ADMIN / workspace owner → unrestricted.
 *   * Otherwise: `allowedDepartmentIds = ACTIVE DepartmentMembership.departmentId`.
 *   * Empty allowed-set means the user only sees rows with
 *     `departmentId IS NULL`.
 *   * Forbidden access emits `POLICY_VIOLATION` via the trust audit
 *     emitter (writes through the intelligence-activity stream).
 */

import type { PrismaClient } from "@prisma/client";
import type { DepartmentScopeEnvelope } from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { hasDelegatedTier } from "./delegated-admin.service.js";
import { emitTrustEvent } from "../trust/trust-and-governance-audit.service.js";

// ---------------------------------------------------------------------------
// Bounded denial vocabulary.
// ---------------------------------------------------------------------------

export type DepartmentAccessDenial = "DEPARTMENT_FORBIDDEN";

export type DepartmentAccessResult =
  | { ok: true }
  | { ok: false; denial: DepartmentAccessDenial };

// ---------------------------------------------------------------------------
// Department where-clause fragment shape. Bounded — only the two
// branches `buildDepartmentScopeWhere` returns.
// ---------------------------------------------------------------------------

export type DepartmentScopeWhereFragment =
  | { departmentId: null }
  | {
      OR: ReadonlyArray<
        | { departmentId: null }
        | { departmentId: { in: ReadonlyArray<string> } }
      >;
    };

/**
 * Strict variant: NEVER includes the `{ departmentId: null }` OR-branch,
 * so NULL-tagged rows are excluded from every non-unrestricted query.
 */
export type StrictDepartmentScopeWhereFragment = {
  departmentId: { in: ReadonlyArray<string> };
};

// ---------------------------------------------------------------------------
// Resolver.
// ---------------------------------------------------------------------------

export type ResolveUserDepartmentScopeInput = {
  prisma?: PrismaClient;
  teamId: string;
  userId: string;
};

/**
 * Resolve the bounded `DepartmentScopeEnvelope` for `(teamId, userId)`.
 *
 *   * Workspace owner: `unrestricted = true`.
 *   * GLOBAL_ADMIN / ORG_ADMIN delegated tier: `unrestricted = true`.
 *   * Otherwise: `allowedDepartmentIds` is the set of `departmentId`
 *     values where the user holds an `ACTIVE` `DepartmentMembership`
 *     in this workspace.
 *
 * NOTE: GLOBAL_ADMIN / ORG_ADMIN unrestricted access bypasses the
 * department filter entirely. Call sites MUST audit any cross-department
 * read/write by invoking `auditCrossDepartmentAccess(...)` whenever an
 * unrestricted envelope touches a `departmentId` that is NOT one of the
 * actor's own active memberships. This emits a `POLICY_VIOLATION`-style
 * event with reason `cross_department_admin_access:<deptId>` so the
 * trust audit trail captures admin-tier cross-department visibility.
 */
export async function resolveUserDepartmentScope(
  input: ResolveUserDepartmentScopeInput,
): Promise<DepartmentScopeEnvelope> {
  const prisma = input.prisma ?? defaultPrisma;

  // Workspace owner is always unrestricted.
  const team = await prisma.team.findFirst({
    where: { id: input.teamId },
    select: { ownerUserId: true },
  });
  if (team && team.ownerUserId === input.userId) {
    return {
      teamId: input.teamId,
      userId: input.userId,
      unrestricted: true,
      allowedDepartmentIds: [],
    };
  }

  // GLOBAL_ADMIN / ORG_ADMIN bypass the department scope. The
  // hierarchical `hasDelegatedTier` check with `ORG_ADMIN` also
  // returns true for `GLOBAL_ADMIN` grants.
  const isOrgAdmin = await hasDelegatedTier({
    prisma,
    teamId: input.teamId,
    userId: input.userId,
    requiredTier: "ORG_ADMIN",
  });
  if (isOrgAdmin) {
    return {
      teamId: input.teamId,
      userId: input.userId,
      unrestricted: true,
      allowedDepartmentIds: [],
    };
  }

  const memberships = await prisma.departmentMembership.findMany({
    where: {
      teamId: input.teamId,
      userId: input.userId,
      state: "ACTIVE",
    },
    select: { departmentId: true },
  });

  const allowedDepartmentIds: ReadonlyArray<string> = Array.from(
    new Set(memberships.map((m: (typeof memberships)[number]) => m.departmentId)),
  );

  return {
    teamId: input.teamId,
    userId: input.userId,
    unrestricted: false,
    allowedDepartmentIds,
  };
}

// ---------------------------------------------------------------------------
// Where-clause helper.
// ---------------------------------------------------------------------------

/**
 * PERMISSIVE variant — back-compat only.
 *
 * Build the where-fragment consumers merge into Prisma queries against
 * tables with an optional `departmentId` column.
 *
 *   * `unrestricted = true` → `undefined` (caller MUST NOT add a
 *     department filter).
 *   * empty `allowedDepartmentIds` → `{ departmentId: null }` (only
 *     un-scoped rows visible).
 *   * non-empty → `{ OR: [{ departmentId: null }, { departmentId: {
 *     in: allowedDepartmentIds } }] }` — rows with no department OR
 *     within the user's allowed set.
 *
 * WARNING — NULL LEAK:
 * The permissive variant ALWAYS merges `{ departmentId: null }` into
 * the OR. This means every NULL-tagged row is visible to EVERY user
 * in the workspace regardless of their allowed department set, so any
 * un-tagged (legacy) evidence row effectively leaks across departments.
 * This behaviour is preserved for back-compat with tables that still
 * contain pre-Phase-4A NULL-tagged data. New department-scoped queries
 * MUST use `buildStrictDepartmentScopeWhere(...)` instead, which never
 * includes the null-OR branch.
 */
export function buildDepartmentScopeWhere(
  envelope: DepartmentScopeEnvelope,
): DepartmentScopeWhereFragment | undefined {
  if (envelope.unrestricted) return undefined;
  if (envelope.allowedDepartmentIds.length === 0) {
    return { departmentId: null };
  }
  return {
    OR: [
      { departmentId: null },
      { departmentId: { in: envelope.allowedDepartmentIds } },
    ],
  };
}

/**
 * STRICT variant — preferred for all NEW department-scoped tables.
 *
 * Unlike `buildDepartmentScopeWhere`, this never includes a
 * `{ departmentId: null }` OR-branch — NULL-tagged rows are EXCLUDED
 * from every non-unrestricted query.
 *
 *   * `unrestricted = true` → `undefined` (no filter; caller is admin).
 *   * empty `allowedDepartmentIds` → `{ departmentId: { in: [] } }`
 *     (zero rows visible — strict default-deny for users with no
 *     department memberships).
 *   * non-empty → `{ departmentId: { in: allowedDepartmentIds } }`
 *     (only rows tagged with one of the user's allowed departments).
 *
 * Use this for any new department-scoped table where NULL values
 * indicate "not yet classified" rather than "globally visible".
 * Migrating an existing permissive call site requires backfilling
 * `departmentId` on all NULL-tagged rows first.
 */
export function buildStrictDepartmentScopeWhere(
  envelope: DepartmentScopeEnvelope,
): StrictDepartmentScopeWhereFragment | undefined {
  if (envelope.unrestricted) return undefined;
  return { departmentId: { in: envelope.allowedDepartmentIds } };
}

// ---------------------------------------------------------------------------
// Per-row assertion.
// ---------------------------------------------------------------------------

/**
 * Assert that the envelope can access the given `departmentId` value.
 *
 *   * `unrestricted = true` → ok.
 *   * `departmentId === null` → ok (un-scoped row visible to everyone
 *     in the workspace).
 *   * `departmentId in allowedDepartmentIds` → ok.
 *   * Otherwise → forbidden. A `POLICY_VIOLATION` trust event is
 *     emitted with `reason = "department_access_denied"`. The audit
 *     emit is fire-and-forget — failures NEVER block the calling
 *     authorisation decision.
 */
export function assertDepartmentAccess(
  envelope: DepartmentScopeEnvelope,
  departmentId: string | null,
): DepartmentAccessResult {
  if (envelope.unrestricted) return { ok: true };
  if (departmentId === null) return { ok: true };
  if (envelope.allowedDepartmentIds.includes(departmentId)) {
    return { ok: true };
  }
  // Fire-and-forget audit emit. The trust audit emitter persists to
  // the SAME `intelligence_activity_events` table the
  // intelligence-activity emitter writes to.
  void emitTrustEvent({
    teamId: envelope.teamId,
    code: "POLICY_VIOLATION",
    actorUserId: envelope.userId,
    targetType: "DEPARTMENT",
    targetId: departmentId,
    reason: "department_access_denied",
  }).catch(() => {
    /* audit emit is best-effort */
  });
  return { ok: false, denial: "DEPARTMENT_FORBIDDEN" };
}

// ---------------------------------------------------------------------------
// Cross-department admin audit helper.
// ---------------------------------------------------------------------------

export type AuditCrossDepartmentAccessInput = {
  teamId: string;
  userId: string;
  accessedDepartmentId: string;
  reason?: string;
};

/**
 * Emit a `POLICY_VIOLATION`-style trust event capturing that a
 * GLOBAL_ADMIN / ORG_ADMIN actor (or any unrestricted envelope) read or
 * wrote a row tagged with `accessedDepartmentId` outside their own
 * `ACTIVE` department memberships.
 *
 * The emitted `reason` is namespaced:
 *   `cross_department_admin_access:<accessedDepartmentId>[:<reason>]`
 *
 * Fire-and-forget — failures NEVER block the calling code path.
 */
export function auditCrossDepartmentAccess(
  input: AuditCrossDepartmentAccessInput,
): void {
  const baseReason = `cross_department_admin_access:${input.accessedDepartmentId}`;
  const reason = input.reason ? `${baseReason}:${input.reason}` : baseReason;
  void emitTrustEvent({
    teamId: input.teamId,
    code: "POLICY_VIOLATION",
    actorUserId: input.userId,
    targetType: "DEPARTMENT",
    targetId: input.accessedDepartmentId,
    reason,
  }).catch(() => {
    /* audit emit is best-effort */
  });
}
