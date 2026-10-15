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

// ===========================================================================
// Evidence population classes (legacy lifecycle reconciliation, 2026-10-15)
// ===========================================================================

/**
 * EVERY evidence row belongs to EXACTLY ONE of these classes.
 *
 * Production held rows whose markers disagreed with their lifecycle: sealed
 * records still `ACTIVE` while carrying a legacy `deleted_at` (a delete path
 * that predates the lifecycle authority), and incomplete uploads released or
 * trashed before any content was committed. Counting "every row in the
 * workspace" turned those into "unlinked records" on Home — six where the
 * owner had two. These classes are the one answer to "what is this row?",
 * shared by the counts (Home, Library, usage) and the reconciliation tool.
 *
 *   ACTIVE            sealed, active lifecycle, no deletion/archive/destroy marker
 *   IN_PROGRESS       an upload still being captured (a live reservation)
 *   ARCHIVED          the owner's archive
 *   TRASH             sealed and deleted, inside or awaiting its 90-day Trash
 *   RETENTION_ARCHIVE left Trash while a retention barrier remains
 *   PURGE             destruction pending or done
 *   ABANDONED_UPLOAD  never committed: released, expired or discarded
 *   MANUAL_REVIEW     contradictory markers that no rule may guess at
 */
export const EVIDENCE_POPULATION_CLASSES = [
  "ACTIVE",
  "IN_PROGRESS",
  "ARCHIVED",
  "TRASH",
  "RETENTION_ARCHIVE",
  "PURGE",
  "ABANDONED_UPLOAD",
  "MANUAL_REVIEW",
] as const;
export type EvidencePopulationClass = (typeof EVIDENCE_POPULATION_CLASSES)[number];

/** Records not yet sealed: no content has been committed to them. */
export const UNSEALED_EVIDENCE_STATUSES = ["CREATED", "UPLOADING"] as const;

/**
 * The lifecycle states of a WORKING record. UNDER_REVIEW / ON_HOLD /
 * RETENTION_LOCKED are governance postures of an active record, not exits.
 */
export const ACTIVE_EVIDENCE_LIFECYCLE_STATES = [
  "ACTIVE",
  "UNDER_REVIEW",
  "ON_HOLD",
  "RETENTION_LOCKED",
] as const;

/**
 * THE active-evidence predicate. Both deletion columns are read — the legacy
 * `deleted_at` and the canonical `deleted_at_utc` — because a row carrying
 * EITHER was deleted by someone, whatever its lifecycle pointer says.
 */
export function activeEvidenceWhere(): Prisma.EvidenceWhereInput {
  return {
    status: { notIn: [...UNSEALED_EVIDENCE_STATUSES] },
    lifecycleState: { in: [...ACTIVE_EVIDENCE_LIFECYCLE_STATES] },
    deletedAt: null,
    deletedAtUtc: null,
    archivedAt: null,
    destroyedAtUtc: null,
  };
}

/**
 * The WORKING SET: everything not deleted, archived or destroyed — active
 * records plus uploads still in flight. Pipeline views ("stuck uploads",
 * "recent evidence") read this; counts of records read `activeEvidenceWhere`.
 */
export function workingEvidenceWhere(): Prisma.EvidenceWhereInput {
  return {
    lifecycleState: { in: [...ACTIVE_EVIDENCE_LIFECYCLE_STATES] },
    deletedAt: null,
    deletedAtUtc: null,
    archivedAt: null,
    destroyedAtUtc: null,
  };
}

/**
 * Active evidence linked to no ACTIVE case/matter — Home's "unlinked records".
 * A link to a closed or archived case does not make a record "in a matter".
 */
export function unlinkedActiveEvidenceWhere(): Prisma.EvidenceWhereInput {
  return {
    AND: [
      activeEvidenceWhere(),
      { caseLinks: { none: { case: { status: { notIn: ["CLOSED", "ARCHIVED"] } } } } },
    ],
  };
}

export interface EvidencePopulationFacts {
  status: string;
  lifecycleState: string | null;
  deletedAt: Date | null;
  deletedAtUtc: Date | null;
  archivedAt: Date | null;
  destroyedAtUtc: Date | null;
  signedAtUtc: Date | null;
  /** For an unsealed, unmarked row: is its reservation still live? */
  reservationLive?: boolean;
}

/** The ONE classification. Pure; the reconciliation tool and tests share it. */
export function classifyEvidencePopulation(row: EvidencePopulationFacts): EvidencePopulationClass {
  const lifecycle = row.lifecycleState ?? "ACTIVE";
  const deleted = row.deletedAt !== null || row.deletedAtUtc !== null;
  const unsealed = (UNSEALED_EVIDENCE_STATUSES as readonly string[]).includes(row.status);
  const activeLifecycle = (ACTIVE_EVIDENCE_LIFECYCLE_STATES as readonly string[]).includes(lifecycle);

  if (lifecycle === "DESTROYED" || lifecycle === "PENDING_DESTRUCTION" || row.destroyedAtUtc !== null) {
    return "PURGE";
  }
  if (unsealed) {
    // A signature on a row that was never sealed contradicts itself.
    if (row.signedAtUtc !== null) return "MANUAL_REVIEW";
    if (!deleted && activeLifecycle && row.reservationLive === true) return "IN_PROGRESS";
    // Released, expired, trashed or archived before any content existed.
    return "ABANDONED_UPLOAD";
  }
  if (lifecycle === "RETENTION_ARCHIVED") return deleted ? "RETENTION_ARCHIVE" : "MANUAL_REVIEW";
  if (lifecycle === "TRASHED") return deleted ? "TRASH" : "MANUAL_REVIEW";
  if (lifecycle === "ARCHIVED") return deleted ? "MANUAL_REVIEW" : "ARCHIVED";
  if (activeLifecycle) {
    // A completed record deleted by a pre-lifecycle path belongs in Trash
    // (the reconciliation tool moves it there, keeping its deletion date).
    if (deleted) return row.archivedAt === null ? "TRASH" : "MANUAL_REVIEW";
    if (row.archivedAt !== null) return "MANUAL_REVIEW";
    return "ACTIVE";
  }
  return "MANUAL_REVIEW";
}
