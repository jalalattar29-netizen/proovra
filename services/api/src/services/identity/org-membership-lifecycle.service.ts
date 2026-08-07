/**
 * PHASE 12 CORRECTIVE PASS §2 (ARCH-004, 2026-08-07) — THE ONE ORGANIZATION
 * MEMBERSHIP LIFECYCLE ORCHESTRATOR.
 *
 * The finding
 * ---------------------------------------------------------------------------
 * Ordinary revocation was a physical DELETE. Provenance grants were closed
 * first, so the GRANT trail survived — but the membership row did not, so the
 * system could not answer "was this person a member, who removed them, when,
 * and why?" from the membership itself. There was no SUSPENDED state at all,
 * so an administrator wanting to pause governance access had only the
 * irreversible option, and used it.
 *
 * Why ONE module
 * ---------------------------------------------------------------------------
 * The transitions have six callers — manual admin action, self-leave, SCIM
 * deprovision, SCIM reprovision, Organization suspension, and account closure
 * — and each previously did its own thing. Six implementations of one state
 * machine is six chances for one of them to forget the audit row, the session
 * invalidation, or the ACTIVE filter. Every transition now goes through the
 * functions below, and `phase-12-arch-004-org-membership-lifecycle.test.ts`
 * fails if any other module writes `status` on this table.
 *
 * Concurrency: the FENCE, not a lock
 * ---------------------------------------------------------------------------
 * Every transition is a single guarded UPDATE whose WHERE clause names the
 * generation the caller believes it is moving FROM, and whose SET increments
 * it. A caller holding a stale generation updates ZERO rows and is told so.
 * That is what makes a simultaneous suspend and restore produce one
 * deterministic winner instead of last-writer-wins — and it is why the
 * generation column exists rather than a timestamp comparison, which two
 * transitions in the same millisecond would tie on.
 *
 * What this module does NOT do
 * ---------------------------------------------------------------------------
 * It does not touch Workspace membership. Organization membership and
 * Workspace membership are different authorities over different things, and
 * conflating them is how a governance suspension silently removed somebody's
 * Personal Space. Callers that want both compose both, visibly.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";

type TxClient = Pick<PrismaClient, "organizationMembership"> & {
  $queryRawUnsafe: PrismaClient["$queryRawUnsafe"];
};

export const ORG_MEMBERSHIP_STATUSES = ["ACTIVE", "SUSPENDED", "REVOKED"] as const;
export type OrgMembershipStatus = (typeof ORG_MEMBERSHIP_STATUSES)[number];

/**
 * Which authority moved the membership. Bounded so a caller cannot invent a
 * provenance the audit surface has never heard of.
 */
export const ORG_MEMBERSHIP_STATUS_SOURCES = [
  "MANUAL",
  "SELF_SERVICE",
  "SCIM",
  "ORGANIZATION_LIFECYCLE",
  "ACCOUNT_CLOSURE",
  "SYSTEM",
] as const;
export type OrgMembershipStatusSource =
  (typeof ORG_MEMBERSHIP_STATUS_SOURCES)[number];

/**
 * Bounded outcome vocabulary. A caller learns whether it won, whether the
 * membership was already in the state it wanted, or whether somebody else got
 * there first — and never anything about a membership it may not see.
 */
export type LifecycleOutcome =
  | { ok: true; status: OrgMembershipStatus; generation: number; changed: boolean }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "stale_generation"; currentGeneration: number }
  | { ok: false; reason: "illegal_transition"; from: OrgMembershipStatus };

type TransitionInput = {
  prisma?: TxClient;
  organizationId: string;
  membershipId: string;
  actorUserId: string | null;
  reason?: string | null;
  source: OrgMembershipStatusSource;
  /**
   * The generation the caller believes it is moving from. Omit for a
   * "whatever it is now" transition — which is correct for an idempotent
   * administrative action, and wrong for anything resolving a race.
   */
  expectedGeneration?: number;
};

type MembershipRow = {
  id: string;
  status: OrgMembershipStatus;
  status_generation: number;
};

async function loadMembership(
  client: TxClient,
  organizationId: string,
  membershipId: string,
): Promise<MembershipRow | null> {
  const rows = await client.$queryRawUnsafe<MembershipRow[]>(
    `SELECT "id", "status"::text AS status, "status_generation"
       FROM "organization_memberships"
      WHERE "id" = $1::uuid AND "organization_id" = $2::uuid
      LIMIT 1`,
    membershipId,
    organizationId,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    status: row.status as OrgMembershipStatus,
    status_generation: Number(row.status_generation),
  };
}

/**
 * The one guarded UPDATE.
 *
 * `allowedFrom` is the state machine, expressed where it is enforced rather
 * than in a comment: the row must currently be in one of those states AND at
 * the expected generation, or nothing moves.
 */
async function transition(
  input: TransitionInput & {
    to: OrgMembershipStatus;
    allowedFrom: ReadonlyArray<OrgMembershipStatus>;
  },
): Promise<LifecycleOutcome> {
  const client = (input.prisma ?? (defaultPrisma as unknown as TxClient));
  const current = await loadMembership(
    client,
    input.organizationId,
    input.membershipId,
  );
  if (!current) return { ok: false, reason: "not_found" };

  // IDEMPOTENCE. A repeated suspend or revoke is a no-op that reports success,
  // because an administrator clicking twice has not done anything wrong and
  // must not be shown an error that suggests they have.
  if (current.status === input.to) {
    return {
      ok: true,
      status: current.status,
      generation: current.status_generation,
      changed: false,
    };
  }
  if (!input.allowedFrom.includes(current.status)) {
    return { ok: false, reason: "illegal_transition", from: current.status };
  }
  if (
    input.expectedGeneration !== undefined &&
    input.expectedGeneration !== current.status_generation
  ) {
    return {
      ok: false,
      reason: "stale_generation",
      currentGeneration: current.status_generation,
    };
  }

  const now = new Date();
  const reason = (input.reason ?? "").slice(0, 400) || null;

  // The timestamp columns are set so the CHECK constraint added by
  // 20271128000000 holds for every state: ACTIVE clears both, SUSPENDED sets
  // the suspension pair, REVOKED sets the revocation pair.
  const rows = await client.$queryRawUnsafe<
    Array<{ id: string; status_generation: number }>
  >(
    `UPDATE "organization_memberships"
        SET "status" = $1::"OrganizationMembershipStatus",
            "status_changed_at_utc" = $2,
            "status_source" = $3,
            "status_generation" = "status_generation" + 1,
            "suspended_at_utc"   = CASE WHEN $1 = 'SUSPENDED' THEN $2 WHEN $1 = 'ACTIVE' THEN NULL ELSE "suspended_at_utc" END,
            "suspended_by_user_id" = CASE WHEN $1 = 'SUSPENDED' THEN $4::uuid WHEN $1 = 'ACTIVE' THEN NULL ELSE "suspended_by_user_id" END,
            "suspension_reason"  = CASE WHEN $1 = 'SUSPENDED' THEN $5 WHEN $1 = 'ACTIVE' THEN NULL ELSE "suspension_reason" END,
            "revoked_at_utc"     = CASE WHEN $1 = 'REVOKED' THEN $2 WHEN $1 = 'ACTIVE' THEN NULL ELSE "revoked_at_utc" END,
            "revoked_by_user_id" = CASE WHEN $1 = 'REVOKED' THEN $4::uuid WHEN $1 = 'ACTIVE' THEN NULL ELSE "revoked_by_user_id" END,
            "revocation_reason"  = CASE WHEN $1 = 'REVOKED' THEN $5 WHEN $1 = 'ACTIVE' THEN NULL ELSE "revocation_reason" END,
            "updated_at" = $2
      WHERE "id" = $6::uuid
        AND "organization_id" = $7::uuid
        AND "status_generation" = $8
      RETURNING "id", "status_generation"`,
    input.to,
    now,
    input.source,
    input.actorUserId,
    reason,
    input.membershipId,
    input.organizationId,
    current.status_generation,
  );

  const updated = rows[0];
  if (!updated) {
    // Somebody else moved it between the read and the write. The fence did its
    // job; re-read so the caller is told the truth rather than a guess.
    const fresh = await loadMembership(
      client,
      input.organizationId,
      input.membershipId,
    );
    return {
      ok: false,
      reason: "stale_generation",
      currentGeneration: fresh?.status_generation ?? current.status_generation,
    };
  }

  // Audit AFTER the durable transition, never before: an audit row for a
  // transition that did not happen is worse than no audit row.
  await emitTenantAudit({
    action: `identity.org_membership_${input.to.toLowerCase()}`,
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.actorUserId,
    organizationId: input.organizationId,
    resourceType: "organization_membership",
    resourceId: input.membershipId,
    metadata: {
      from: current.status,
      to: input.to,
      source: input.source,
      generation: Number(updated.status_generation),
    },
  }).catch(() => null);

  return {
    ok: true,
    status: input.to,
    generation: Number(updated.status_generation),
    changed: true,
  };
}

/**
 * Reversible pause. ACTIVE → SUSPENDED.
 *
 * A REVOKED membership cannot be suspended: revocation is terminal, and
 * pretending otherwise would let an administrator "un-terminal" it by a route
 * that records no restoration.
 */
export async function suspendOrganizationMembership(
  input: TransitionInput,
): Promise<LifecycleOutcome> {
  return transition({ ...input, to: "SUSPENDED", allowedFrom: ["ACTIVE"] });
}

/**
 * Terminal removal. ACTIVE or SUSPENDED → REVOKED.
 *
 * THE ROW SURVIVES. That is the whole point of ARCH-004: the membership stays,
 * carrying who revoked it, when and why, so the removal is attributable. It
 * grants nothing — `organizationMembershipGrantsAccess` returns false — but it
 * can be read.
 */
export async function revokeOrganizationMembership(
  input: TransitionInput,
): Promise<LifecycleOutcome> {
  return transition({
    ...input,
    to: "REVOKED",
    allowedFrom: ["ACTIVE", "SUSPENDED"],
  });
}

/**
 * Explicit, audited reinstatement. SUSPENDED or REVOKED → ACTIVE.
 *
 * Restoring from REVOKED is permitted and deliberately noisy: it is a real
 * administrative need (a mistaken removal), and forcing an administrator to
 * delete-and-recreate instead would destroy exactly the history this change
 * exists to keep.
 */
export async function restoreOrganizationMembership(
  input: TransitionInput,
): Promise<LifecycleOutcome> {
  return transition({
    ...input,
    to: "ACTIVE",
    allowedFrom: ["SUSPENDED", "REVOKED"],
  });
}

/**
 * THE ACCESS PREDICATE. One function, so "which statuses grant access" has one
 * answer and every surface reads it from here.
 */
export function organizationMembershipGrantsAccess(input: {
  status: string | null | undefined;
  validUntilUtc?: Date | null;
  now?: Date;
}): boolean {
  if (input.status !== "ACTIVE") return false;
  if (input.validUntilUtc) {
    const now = input.now ?? new Date();
    if (input.validUntilUtc.getTime() <= now.getTime()) return false;
  }
  return true;
}

/**
 * The Prisma `where` fragment every ACTIVE-membership query uses.
 *
 * Exported as DATA rather than left to each call site to spell, because
 * "filter on ACTIVE" written twenty times is twenty chances to write it
 * nineteen times.
 */
export const ACTIVE_ORG_MEMBERSHIP_WHERE = {
  status: "ACTIVE",
  OR: [{ validUntilUtc: null }, { validUntilUtc: { gt: new Date(0) } }],
} as const;

/**
 * Suspend every ACTIVE membership of an Organization, in one statement.
 *
 * Used by Organization suspension. One statement rather than a loop because a
 * partially-suspended Organization is a state nobody asked for, and because
 * the row count is the honest report of what happened.
 */
export async function suspendAllOrganizationMemberships(input: {
  prisma?: TxClient;
  organizationId: string;
  actorUserId: string | null;
  reason: string;
}): Promise<{ suspended: number }> {
  const client = input.prisma ?? (defaultPrisma as unknown as TxClient);
  const rows = await client.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE "organization_memberships"
        SET "status" = 'SUSPENDED',
            "status_changed_at_utc" = now(),
            "status_source" = 'ORGANIZATION_LIFECYCLE',
            "status_generation" = "status_generation" + 1,
            "suspended_at_utc" = now(),
            "suspended_by_user_id" = $1::uuid,
            "suspension_reason" = $2,
            "updated_at" = now()
      WHERE "organization_id" = $3::uuid
        AND "status" = 'ACTIVE'
      RETURNING "id"`,
    input.actorUserId,
    input.reason.slice(0, 400),
    input.organizationId,
  );
  return { suspended: rows.length };
}

/**
 * Restore ONLY the memberships this Organization suspension suspended.
 *
 * Matched on the marker reason, so a membership an administrator suspended
 * individually — before or during the Organization suspension — stays
 * suspended when the Organization resumes. Resuming an Organization is not a
 * blanket amnesty.
 */
export async function resumeOrganizationSuspendedMemberships(input: {
  prisma?: TxClient;
  organizationId: string;
  actorUserId: string | null;
  markerReason: string;
}): Promise<{ restored: number }> {
  const client = input.prisma ?? (defaultPrisma as unknown as TxClient);
  const rows = await client.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE "organization_memberships"
        SET "status" = 'ACTIVE',
            "status_changed_at_utc" = now(),
            "status_source" = 'ORGANIZATION_LIFECYCLE',
            "status_generation" = "status_generation" + 1,
            "suspended_at_utc" = NULL,
            "suspended_by_user_id" = NULL,
            "suspension_reason" = NULL,
            "updated_at" = now()
      WHERE "organization_id" = $1::uuid
        AND "status" = 'SUSPENDED'
        AND "suspension_reason" = $2
      RETURNING "id"`,
    input.organizationId,
    input.markerReason.slice(0, 400),
  );
  return { restored: rows.length };
}

/** The marker an Organization-wide suspension writes, so resume can undo exactly it. */
export const ORG_SUSPENSION_MEMBERSHIP_MARKER =
  "organization_suspended:governance_membership_paused";
