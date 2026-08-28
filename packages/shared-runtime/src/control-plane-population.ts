/**
 * CONTROL-PLANE POPULATION — the single query authority for "which rows is a
 * platform-wide count actually about?".
 *
 * WHY THIS MODULE EXISTS
 * ---------------------------------------------------------------------------
 * The Platform Admin console asked four population questions and answered each
 * of them differently in each place it asked:
 *
 *   "how many customers?"    `organization.count()` — with no `kind` predicate,
 *                            so it counted the 1:1 SYSTEM container every Team
 *                            receives. The number was the workspace count
 *                            wearing the word "customers".
 *   "how many workspaces?"   `team.findMany()` — with no predicate at all, so
 *                            closed workspaces counted as live.
 *   "how many seats?"        `_count.members` — every status, while the
 *                            canonical seat authority counts ACTIVE only.
 *   "how much evidence?"     `deletedAtUtc: null` in one service and
 *                            `deletedAt: null` in three others, over a model
 *                            that has BOTH columns and whose ordinary delete
 *                            paths write only one of them.
 *
 * None of those was a lie anyone told on purpose. Each was a `where` clause
 * written against a plausible-looking column by someone who did not have the
 * other three in front of them. The fix is not to correct four queries; it is
 * to make there be one place the question is answered, so the next query
 * written cannot invent a fifth answer.
 *
 * WHAT BELONGS HERE
 * ---------------------------------------------------------------------------
 * Predicates whose correctness is a PLATFORM-WIDE fact — "customer", "live
 * workspace", "seat-consuming member", "live evidence". They are pure Prisma
 * `where` fragments: no I/O, no authorization, no projection.
 *
 * WHAT DOES NOT
 * ---------------------------------------------------------------------------
 * Commercial truth. What plan a subject is on, whether an enterprise contract
 * is active, whether access is in grace — those are compositions over several
 * models with lifecycle rules of their own, and they already have canonical
 * owners (`resolveCommercialContext`, `resolveEnterpriseContract`). A `where`
 * clause that tried to encode them would become the parallel commercial model
 * this whole remediation exists to remove.
 *
 * Tenant read scope also does not belong here — that is `workspace-scope.ts`,
 * which answers "which rows belong to THIS workspace". This module answers
 * "which rows exist at all, platform-wide". Two different questions; keeping
 * them in separate modules is what stops a control-plane widening from
 * accidentally becoming a tenant-isolation widening.
 */

import type { Prisma } from "@prisma/client";

// ===========================================================================
// Customers
// ===========================================================================

/**
 * THE customer predicate.
 *
 * `Team.organizationId` has been NOT NULL since Phase 2.7X, which means every
 * workspace — including a free personal space — owns an `Organization` row.
 * `Organization.kind` is what separates those internal containers from real
 * sales-provisioned customers, and the schema comment on it is unambiguous:
 * SYSTEM containers must never surface as "Organizations" in product UI.
 *
 * The tenant product already honours this (`organizations.routes.ts`,
 * `teams.routes.ts`, `billing-accounts.service.ts`). Admin did not, anywhere.
 */
export function customerOrganizationWhere(): Prisma.OrganizationWhereInput {
  return { kind: "CUSTOMER" };
}

/**
 * The complement: internal bootstrap containers.
 *
 * Exported because some legitimate operational reads DO want them — a
 * consistency probe asking "does every SYSTEM container have exactly one
 * workspace?" is asking about containers on purpose. Naming it makes that
 * intent explicit at the call site instead of leaving a bare `kind: "SYSTEM"`
 * for a later reader to second-guess.
 */
export function systemContainerOrganizationWhere(): Prisma.OrganizationWhereInput {
  return { kind: "SYSTEM" };
}

// ===========================================================================
// Workspace lifecycle
// ===========================================================================

/**
 * The three lifecycle populations a control-plane query can ask for.
 *
 * `ALL` is deliberately spelled out rather than left as "pass no predicate":
 * an operator viewing history needs closed workspaces, and a caller that wants
 * them should have to say so in the same vocabulary as everyone else.
 */
export type WorkspaceLifecycleFilter = "LIVE" | "CLOSED" | "ALL";

/**
 * THE workspace-liveness predicate. Reads `Team.closedAtUtc` (ADM-004) — the
 * only column either closure or reopen writes.
 *
 * Never substitute billing state. A workspace can be live and unpaid (every
 * FREE personal space is), or closed while a cancellation is still settling
 * with the provider. `billingStatus !== 'CANCELED'` answers a different
 * question and gets both of those wrong.
 */
export function liveWorkspaceWhere(): Prisma.TeamWhereInput {
  return { closedAtUtc: null };
}

export function closedWorkspaceWhere(): Prisma.TeamWhereInput {
  return { closedAtUtc: { not: null } };
}

/** Resolve a lifecycle filter to its predicate. `ALL` contributes nothing. */
export function workspaceLifecycleWhere(
  filter: WorkspaceLifecycleFilter = "LIVE",
): Prisma.TeamWhereInput {
  if (filter === "ALL") return {};
  if (filter === "CLOSED") return closedWorkspaceWhere();
  return liveWorkspaceWhere();
}

// ===========================================================================
// Seats
// ===========================================================================

/**
 * THE seat-consuming membership predicate.
 *
 * A seat is consumed by an ACTIVE `TeamMember`. SUSPENDED and REVOKED members
 * are denied all access, so charging a licence for them would be charging for
 * nothing — the rule `workspace-usage.service.ts` and
 * `enterprise-provisioning.service.ts` already apply, and the one the admin
 * roster did not, which is why an org could read as over its seat limit when it
 * was not.
 */
export function seatConsumingMemberWhere(): Prisma.TeamMemberWhereInput {
  return { status: "ACTIVE" };
}

/**
 * The same rule shaped for a nested `_count` select, which is how the roster
 * queries need it. Kept beside the predicate so the two cannot drift.
 */
export function seatConsumingMemberCountArgs(): {
  where: Prisma.TeamMemberWhereInput;
} {
  return { where: seatConsumingMemberWhere() };
}

// ===========================================================================
// Evidence liveness
// ===========================================================================

/**
 * THE live-evidence predicate.
 *
 * `Evidence` carries two soft-delete columns. `deletedAt` is written by EVERY
 * delete path — the three in `evidence.routes.ts` and the lifecycle service.
 * `deletedAtUtc` is written by the lifecycle service and one collaboration
 * path ONLY, so filtering on it alone counts records the ordinary delete routes
 * removed. `deletedAt` is therefore the canonical column and this is the only
 * predicate a control-plane count may use.
 *
 * Both columns are retained: `deletedAtUtc` participates in the retention and
 * destruction schedule alongside `deleteScheduledForUtc` and
 * `retentionUntilUtc`, so it is load-bearing for governance even though it is
 * not the liveness authority.
 */
export function liveEvidenceWhere(): Prisma.EvidenceWhereInput {
  return { deletedAt: null };
}

/**
 * Compose the liveness predicate with additional conditions.
 *
 * Exists so a caller writes `liveEvidenceWith({ tsaStatus: "FAILED" })` rather
 * than spreading `liveEvidenceWhere()` by hand — a spread is one careless edit
 * away from being dropped, and dropping it is silent.
 */
export function liveEvidenceWith(
  extra: Prisma.EvidenceWhereInput,
): Prisma.EvidenceWhereInput {
  return { ...liveEvidenceWhere(), ...extra };
}
