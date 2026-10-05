/**
 * INTERNAL PLAN GRANT — THE write authority (apply / revoke / expire).
 *
 * Provider-independent, reversible plan access for an existing account's
 * Personal subject, for internal testing. The one admin route and the one CLI
 * both call these functions; neither carries business logic of its own.
 *
 * WHAT A GRANT IS: one `plan_grants` row. The canonical resolution
 * (workspace-billing.service → shared-billing resolvePersonalEffectivePlan,
 * reading through shared-runtime readActiveInternalPlanGrant) takes the HIGHER
 * of the provider-derived plan and an active grant and reports the source
 * (INTERNAL_GRANT). The grant therefore never needs to touch:
 *   - entitlements (plan, credits, seats, record-cap override),
 *   - subscriptions, payments, checkout / billing attempts, provider ids,
 *   - credit-ledger entries, usage, workspaces, memberships or evidence.
 * Nothing here writes any of those, and nothing provider-driven writes a grant.
 *
 * GUARANTEES
 *   - TRANSACTIONAL: the grant row and its audit event commit together.
 *   - IDEMPOTENT: `idempotencyKey` is UNIQUE; a repeated apply with the same key
 *     returns the same grant and records no second "applied" event. A key reused
 *     for a different subject/plan is refused.
 *   - ONE ACTIVE GRANT per account/source: a per-account advisory lock
 *     serialises concurrent applies; the partial unique index
 *     plan_grants_one_unrevoked_per_user_source is the database backstop.
 *   - REVERSIBLE: revoke (or expiry) marks the row; the plan falls back to what
 *     the providers say on the very next resolution. Nothing is deleted.
 *   - AUDITED: billing.internal_grant.applied / .revoked / .expired, with
 *     subject, plan, source, reason, actor, idempotency key and expiry — never
 *     an email, token or secret.
 */
import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import { PLAN_RANK } from "@proovra/shared-billing";
import {
  GRANTABLE_INTERNAL_PLANS,
  readActiveInternalPlanGrant,
  type GrantableInternalPlan,
} from "@proovra/shared-runtime";

import { prisma as defaultPrisma } from "../../db.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";

export const INTERNAL_GRANT_AUDIT = {
  applied: "billing.internal_grant.applied",
  revoked: "billing.internal_grant.revoked",
  expired: "billing.internal_grant.expired",
} as const;

export type InternalGrantErrorCode =
  | "INVALID_REQUEST"
  | "SUBJECT_NOT_FOUND"
  | "SUBJECT_AMBIGUOUS"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "GRANT_ALREADY_ACTIVE"
  | "GRANT_NOT_FOUND";

const STATUS_BY_CODE: Record<InternalGrantErrorCode, number> = {
  INVALID_REQUEST: 400,
  SUBJECT_NOT_FOUND: 404,
  SUBJECT_AMBIGUOUS: 409,
  IDEMPOTENCY_KEY_CONFLICT: 409,
  GRANT_ALREADY_ACTIVE: 409,
  GRANT_NOT_FOUND: 404,
};

export class InternalPlanGrantError extends Error {
  readonly statusCode: number;
  constructor(
    readonly code: InternalGrantErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "InternalPlanGrantError";
    this.statusCode = STATUS_BY_CODE[code];
  }
}

/** Exactly one of the two: an exact user id, or an email matched case-insensitively. */
export type InternalGrantSubjectInput = { userId?: string | null; email?: string | null };

export type InternalPlanGrantView = {
  id: string;
  userId: string;
  plan: GrantableInternalPlan;
  source: "INTERNAL_TEST";
  reason: string;
  grantedByUserId: string;
  grantedAtUtc: string;
  expiresAtUtc: string | null;
  revokedAtUtc: string | null;
  revokedByUserId: string | null;
  revocationReason: string | null;
  idempotencyKey: string;
};

type Db = PrismaClient;
type Tx = prismaPkg.Prisma.TransactionClient;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// '@' and '+' are allowed so an operator key can name the account it is for
// (e.g. owner-test:someone@example.com:team:2026-10); whitespace, quotes,
// slashes and control characters are not.
const IDEMPOTENCY_RE = /^[A-Za-z0-9._:@+-]{8,120}$/;

/** The ONE shape an internal-grant idempotency key may take. */
export function isValidGrantIdempotencyKey(key: string): boolean {
  return IDEMPOTENCY_RE.test(key);
}

/** Lower-cased, trimmed. The only normalisation applied to an email. */
export function normalizeGrantEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function view(row: {
  id: string;
  userId: string;
  plan: prismaPkg.PlanType;
  source: prismaPkg.PlanGrantSource;
  reason: string;
  grantedByUserId: string;
  grantedAtUtc: Date;
  expiresAtUtc: Date | null;
  revokedAtUtc: Date | null;
  revokedByUserId: string | null;
  revocationReason: string | null;
  idempotencyKey: string;
}): InternalPlanGrantView {
  return {
    id: row.id,
    userId: row.userId,
    plan: row.plan as GrantableInternalPlan,
    source: row.source as "INTERNAL_TEST",
    reason: row.reason,
    grantedByUserId: row.grantedByUserId,
    grantedAtUtc: row.grantedAtUtc.toISOString(),
    expiresAtUtc: row.expiresAtUtc?.toISOString() ?? null,
    revokedAtUtc: row.revokedAtUtc?.toISOString() ?? null,
    revokedByUserId: row.revokedByUserId,
    revocationReason: row.revocationReason,
    idempotencyKey: row.idempotencyKey,
  };
}

/**
 * The ONE account the operator named — or a refusal. An email is matched
 * case-insensitively; more than one match is AMBIGUOUS (emails are not unique
 * in the schema), never a silent pick.
 */
export async function resolveInternalGrantSubject(
  input: InternalGrantSubjectInput,
  db: Pick<Db, "user"> = defaultPrisma,
): Promise<{ userId: string }> {
  const hasId = typeof input.userId === "string" && input.userId.trim() !== "";
  const hasEmail = typeof input.email === "string" && input.email.trim() !== "";
  if (hasId === hasEmail) {
    throw new InternalPlanGrantError("INVALID_REQUEST", "Name exactly one subject: a user id OR an email.");
  }
  if (hasId) {
    const id = input.userId!.trim();
    if (!UUID_RE.test(id)) throw new InternalPlanGrantError("INVALID_REQUEST", "The user id is not a UUID.");
    const user = await db.user.findUnique({ where: { id }, select: { id: true } });
    if (!user) throw new InternalPlanGrantError("SUBJECT_NOT_FOUND", "No account has this id.");
    return { userId: user.id };
  }
  const email = normalizeGrantEmail(input.email!);
  if (email.length > 320 || !email.includes("@")) {
    throw new InternalPlanGrantError("INVALID_REQUEST", "The email is not valid.");
  }
  const matches = await db.user.findMany({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true },
    take: 2,
  });
  if (matches.length === 0) throw new InternalPlanGrantError("SUBJECT_NOT_FOUND", "No account has this email.");
  if (matches.length > 1) {
    throw new InternalPlanGrantError(
      "SUBJECT_AMBIGUOUS",
      "More than one account has this email; name the account by its user id.",
    );
  }
  return { userId: matches[0].id };
}

/** The account's Personal workspace and organization — audit scope only. */
async function personalScopeOf(tx: Tx, userId: string): Promise<{ workspaceId: string | null; organizationId: string | null }> {
  const team = await tx.team.findFirst({
    where: { ownerUserId: userId, isPersonal: true },
    select: { id: true, organizationId: true },
  });
  return { workspaceId: team?.id ?? null, organizationId: team?.organizationId ?? null };
}

async function lockSubject(tx: Tx, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`internal-plan-grant:${userId}`}))`;
}

async function auditGrant(
  tx: Tx,
  action: (typeof INTERNAL_GRANT_AUDIT)[keyof typeof INTERNAL_GRANT_AUDIT],
  grant: InternalPlanGrantView,
  actorUserId: string | null,
  scope: { workspaceId: string | null; organizationId: string | null },
  extra: { correlationId?: string | null } = {},
): Promise<void> {
  await emitTenantAudit(
    {
      action,
      outcome: "success",
      sourceApp: "API",
      actorUserId,
      serviceActor: actorUserId === null ? "internal-plan-grant-expiry" : null,
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      resourceType: "plan_grant",
      resourceId: grant.id,
      reasonCode: action === INTERNAL_GRANT_AUDIT.applied ? "INTERNAL_TEST" : (grant.revocationReason ?? null),
      correlationId: extra.correlationId ?? null,
      metadata: {
        subjectUserId: grant.userId,
        plan: grant.plan,
        source: grant.source,
        reason: grant.reason,
        grantedByUserId: grant.grantedByUserId,
        actorUserId,
        idempotencyKey: grant.idempotencyKey,
        expiresAtUtc: grant.expiresAtUtc,
        revokedAtUtc: grant.revokedAtUtc,
        revocationReason: grant.revocationReason,
      },
    },
    tx as unknown as PrismaClient,
  );
}

/** Close (reason EXPIRED) every unrevoked grant of this account whose expiry has passed. */
async function closeExpiredInTx(tx: Tx, userId: string, now: Date): Promise<InternalPlanGrantView[]> {
  const due = await tx.planGrant.findMany({
    where: { userId, revokedAtUtc: null, expiresAtUtc: { lte: now } },
  });
  const closed: InternalPlanGrantView[] = [];
  if (due.length === 0) return closed;
  const scope = await personalScopeOf(tx, userId);
  for (const row of due) {
    const updated = await tx.planGrant.update({
      where: { id: row.id },
      data: { revokedAtUtc: now, revokedByUserId: null, revocationReason: "EXPIRED" },
    });
    const v = view(updated);
    await auditGrant(tx, INTERNAL_GRANT_AUDIT.expired, v, null, scope);
    closed.push(v);
  }
  return closed;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "P2002";
}

export type ApplyInternalPlanGrantInput = InternalGrantSubjectInput & {
  plan: string;
  reason: string;
  idempotencyKey: string;
  /** ISO-8601; optional. Must be in the future. */
  expiresAtUtc?: string | Date | null;
  actorUserId: string;
  correlationId?: string | null;
};

export type ApplyInternalPlanGrantResult = {
  grant: InternalPlanGrantView;
  /** false = this idempotency key had already applied this grant; nothing new was written. */
  created: boolean;
};

/**
 * Apply an INTERNAL_TEST grant. TEAM only. Writes one plan_grants row and one
 * billing.internal_grant.applied event — nothing else.
 */
export async function applyInternalPlanGrant(
  input: ApplyInternalPlanGrantInput,
  db: Db = defaultPrisma,
  now: Date = new Date(),
): Promise<ApplyInternalPlanGrantResult> {
  if (!(GRANTABLE_INTERNAL_PLANS as readonly string[]).includes(input.plan)) {
    throw new InternalPlanGrantError("INVALID_REQUEST", `Only ${GRANTABLE_INTERNAL_PLANS.join(", ")} may be granted.`);
  }
  const plan = input.plan as GrantableInternalPlan;
  const reason = (input.reason ?? "").trim();
  if (reason.length === 0 || reason.length > 500) {
    throw new InternalPlanGrantError("INVALID_REQUEST", "A reason (1–500 characters) is required.");
  }
  const idempotencyKey = (input.idempotencyKey ?? "").trim();
  if (!isValidGrantIdempotencyKey(idempotencyKey)) {
    throw new InternalPlanGrantError(
      "INVALID_REQUEST",
      "The idempotency key must be 8–120 characters of letters, digits, '.', '_', ':', '@', '+' or '-'.",
    );
  }
  if (!UUID_RE.test(input.actorUserId ?? "")) {
    throw new InternalPlanGrantError("INVALID_REQUEST", "The acting administrator is not identified.");
  }
  let expiresAt: Date | null = null;
  if (input.expiresAtUtc !== undefined && input.expiresAtUtc !== null && input.expiresAtUtc !== "") {
    expiresAt = input.expiresAtUtc instanceof Date ? input.expiresAtUtc : new Date(input.expiresAtUtc);
    if (Number.isNaN(expiresAt.getTime())) {
      throw new InternalPlanGrantError("INVALID_REQUEST", "The expiry is not a valid ISO-8601 time.");
    }
    if (expiresAt.getTime() <= now.getTime()) {
      throw new InternalPlanGrantError("INVALID_REQUEST", "The expiry must be in the future.");
    }
  }

  const { userId } = await resolveInternalGrantSubject(input, db);

  const sameRequest = (row: { userId: string; plan: prismaPkg.PlanType; source: prismaPkg.PlanGrantSource }) =>
    row.userId === userId && row.plan === plan && row.source === "INTERNAL_TEST";

  const run = () =>
    db.$transaction(async (tx) => {
      await lockSubject(tx, userId);

      const byKey = await tx.planGrant.findUnique({ where: { idempotencyKey } });
      if (byKey) {
        if (!sameRequest(byKey)) {
          throw new InternalPlanGrantError(
            "IDEMPOTENCY_KEY_CONFLICT",
            "This idempotency key was already used for a different grant.",
          );
        }
        return { grant: view(byKey), created: false };
      }

      await closeExpiredInTx(tx, userId, now);

      const active = await tx.planGrant.findFirst({
        where: { userId, source: "INTERNAL_TEST", revokedAtUtc: null },
        select: { id: true },
      });
      if (active) {
        throw new InternalPlanGrantError(
          "GRANT_ALREADY_ACTIVE",
          "This account already has an active internal grant; revoke it before applying another.",
        );
      }

      const created = await tx.planGrant.create({
        data: {
          userId,
          plan,
          source: "INTERNAL_TEST",
          reason,
          grantedByUserId: input.actorUserId,
          grantedAtUtc: now,
          expiresAtUtc: expiresAt,
          idempotencyKey,
        },
      });
      const v = view(created);
      await auditGrant(tx, INTERNAL_GRANT_AUDIT.applied, v, input.actorUserId, await personalScopeOf(tx, userId), {
        correlationId: input.correlationId,
      });
      return { grant: v, created: true };
    });

  try {
    return await run();
  } catch (err) {
    // The database backstop fired (a concurrent apply that did not share the
    // lock — e.g. a different key on another connection before ours
    // committed). Re-read: the same key returns the winner; anything else is
    // an active grant.
    if (!isUniqueViolation(err)) throw err;
    const byKey = await db.planGrant.findUnique({ where: { idempotencyKey } });
    if (byKey && sameRequest(byKey)) return { grant: view(byKey), created: false };
    if (byKey) {
      throw new InternalPlanGrantError("IDEMPOTENCY_KEY_CONFLICT", "This idempotency key was already used for a different grant.");
    }
    throw new InternalPlanGrantError(
      "GRANT_ALREADY_ACTIVE",
      "This account already has an active internal grant; revoke it before applying another.",
    );
  }
}

export type RevokeInternalPlanGrantInput = InternalGrantSubjectInput & {
  reason: string;
  actorUserId: string;
  correlationId?: string | null;
};

export type RevokeInternalPlanGrantResult = {
  /** The grant that was revoked by this call, or null when none was active. */
  revoked: InternalPlanGrantView | null;
  /** Grants this call found already past their expiry and closed as EXPIRED. */
  expired: InternalPlanGrantView[];
};

/**
 * Revoke the account's active grant. Idempotent: with nothing active it changes
 * nothing and records nothing. Touches only plan_grants.
 */
export async function revokeInternalPlanGrant(
  input: RevokeInternalPlanGrantInput,
  db: Db = defaultPrisma,
  now: Date = new Date(),
): Promise<RevokeInternalPlanGrantResult> {
  const reason = (input.reason ?? "").trim();
  if (reason.length === 0 || reason.length > 500) {
    throw new InternalPlanGrantError("INVALID_REQUEST", "A reason (1–500 characters) is required.");
  }
  if (!UUID_RE.test(input.actorUserId ?? "")) {
    throw new InternalPlanGrantError("INVALID_REQUEST", "The acting administrator is not identified.");
  }
  const { userId } = await resolveInternalGrantSubject(input, db);

  return db.$transaction(async (tx) => {
    await lockSubject(tx, userId);
    const expired = await closeExpiredInTx(tx, userId, now);
    const active = await tx.planGrant.findFirst({
      where: { userId, source: "INTERNAL_TEST", revokedAtUtc: null },
    });
    if (!active) return { revoked: null, expired };
    const updated = await tx.planGrant.update({
      where: { id: active.id },
      data: { revokedAtUtc: now, revokedByUserId: input.actorUserId, revocationReason: "OPERATOR_REVOKED" },
    });
    const v = view(updated);
    await auditGrant(
      tx,
      INTERNAL_GRANT_AUDIT.revoked,
      { ...v, reason: `${v.reason} | revoked: ${reason}`.slice(0, 1000) },
      input.actorUserId,
      await personalScopeOf(tx, userId),
      { correlationId: input.correlationId },
    );
    return { revoked: v, expired };
  });
}

/**
 * Close every grant whose expiry has passed (reason EXPIRED, one
 * billing.internal_grant.expired event each). The resolver already ignores an
 * expired grant, so this records WHEN it lapsed; it is safe to run any time.
 */
export async function expireInternalPlanGrants(
  db: Db = defaultPrisma,
  now: Date = new Date(),
): Promise<{ expired: InternalPlanGrantView[] }> {
  const due = await db.planGrant.findMany({
    where: { revokedAtUtc: null, expiresAtUtc: { lte: now } },
    select: { userId: true },
    distinct: ["userId"],
  });
  const expired: InternalPlanGrantView[] = [];
  for (const { userId } of due) {
    const closed = await db.$transaction(async (tx) => {
      await lockSubject(tx, userId);
      return closeExpiredInTx(tx, userId, now);
    });
    expired.push(...closed);
  }
  return { expired };
}

/** Read-only: the account's grants, newest first (for the admin view / CLI status). */
export async function listInternalPlanGrants(
  input: InternalGrantSubjectInput,
  db: Db = defaultPrisma,
): Promise<{ userId: string; grants: InternalPlanGrantView[] }> {
  const { userId } = await resolveInternalGrantSubject(input, db);
  const rows = await db.planGrant.findMany({ where: { userId }, orderBy: { grantedAtUtc: "desc" } });
  return { userId, grants: rows.map(view) };
}

/**
 * CHECKOUT GUARD — buying what an internal grant already gives is refused,
 * BEFORE any provider session, order, subscription, billing attempt or payment
 * row exists. Only plans at or below the granted one are refused: ENTERPRISE is
 * a contact flow and stays available, and add-ons / evidence credits are not
 * plan purchases. An existing real subscription is left exactly as it is.
 */
export async function internalGrantCheckoutRefusal(
  userId: string,
  requestedPlan: prismaPkg.PlanType,
  db: Pick<Db, "planGrant"> = defaultPrisma,
  now: Date = new Date(),
): Promise<{ message: string; code: "INTERNAL_GRANT_ACTIVE"; details: Record<string, unknown> } | null> {
  const grant = await readActiveInternalPlanGrant(db, userId, now);
  if (!grant) return null;
  if (PLAN_RANK[grant.plan] < PLAN_RANK[requestedPlan]) return null;
  return {
    message: `Your account already has ${grant.plan} access through an internal grant, so there is nothing to buy for ${requestedPlan}.`,
    code: "INTERNAL_GRANT_ACTIVE",
    details: {
      requestedPlan,
      grantedPlan: grant.plan,
      source: grant.source,
      expiresAtUtc: grant.expiresAtUtc?.toISOString() ?? null,
    },
  };
}
