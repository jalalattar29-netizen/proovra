/**
 * PHASE 10 STEP 5 (2026-07-23) — SUPPORT ACCESS RUNTIME (dual identity).
 *
 * The RUNTIME composition layer over the ONE support-access authority
 * (services/identity/support-access.service.ts). It does NOT re-implement
 * grant lifecycle, scope evaluation, or action permission — EVERY decision
 * defers to `evaluateSupportAccess` / `evaluateSupportActionAllowed` /
 * `SUPPORT_FORBIDDEN_ACTIONS` exported by that authority. This module only:
 *
 *   1. RESOLVES the active grant for a support actor + customer org into a
 *      dual-identity runtime context. The support actor identity is
 *      PRESERVED — the grant SCOPES access. There is NO invisible customer
 *      token: `supportActorUserId` and `organizationId` are BOTH carried,
 *      server-authoritatively, on every request.
 *   2. GUARDS every operation: re-checks scope / expiry / revocation on
 *      EVERY request (fresh DB read → `evaluateSupportAccess`) + the action
 *      permission (`evaluateSupportActionAllowed`), and audits BOTH
 *      identities via `appendPlatformAuditLog`. Denials mutate NOTHING.
 *   3. SERIALIZES the context for background / queued jobs so the support
 *      actor + customer org + grantId survive the queue boundary and are
 *      RE-VALIDATED (not trusted) when the job runs.
 *   4. PROJECTS the active grant into the platform-context envelope
 *      (`buildSupportAccessEnvelopeSection`) so the web shell can render a
 *      persistent, visible support banner.
 *
 * Fail-closed: no active grant, expired, revoked, org/workspace scope
 * mismatch, or a forbidden / non-read action → the context heals to `null`
 * or the action DENIES, always with ZERO business mutation.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import {
  evaluateSupportAccess,
  evaluateSupportActionAllowed,
  type SupportAccessGrant,
  type SupportAccessLevel,
} from "./support-access.service.js";

/**
 * The dual-identity runtime context carried on a support request. Fully
 * serializable (dates as ISO strings) so it survives the queue boundary.
 * The support actor identity is NEVER swapped for the customer's — this
 * object records BOTH the actor and the customer org/workspace it scopes.
 */
export type SupportRuntimeContext = {
  /** The grant this context descends from (single authority row). */
  grantId: string;
  /** The support ACTOR — a distinct identity, never the customer user. */
  supportActorUserId: string;
  /** The customer Organization the grant scopes access to. */
  organizationId: string;
  /** Optional narrower workspace (Team) scope within the org. */
  teamId: string | null;
  /** READ_ONLY (default) | ELEVATED. Governs which actions are permitted. */
  mode: SupportAccessLevel;
  /** The operator-supplied reason recorded on the grant. */
  reason: string;
  /** ISO-8601 expiry — the context heals out at/after this instant. */
  expiresAtUtc: string;
  /**
   * PHASE 10 STEP 5 — the approver identity recorded on the grant at
   * creation time (`support-access.service.ts#startSupportAccess` already
   * refuses to mint an ELEVATED grant without one). Carried here so the
   * per-request runtime guard (`applySupportAccessGuard`) can independently
   * re-verify the persisted approval before permitting an ELEVATED action —
   * belt-and-suspenders, never a second authority.
   */
  approvedByUserId: string | null;
};

/** Bounded reasons the runtime context could not be composed / an action denied. */
export type SupportRuntimeDenyReason =
  | "no_grant"
  | "revoked"
  | "expired"
  | "inactive"
  | "org_scope_mismatch"
  | "workspace_scope_mismatch"
  | "support_forbidden_action"
  | "support_read_only"
  | "grant_disappeared"
  // PHASE 10 STEP 5 (2026-07-23) — real-operation runtime guard denials.
  | "team_unresolved"
  | "elevated_approval_missing"
  | "elevated_step_up_required";

type GrantRow = Pick<
  SupportAccessGrant,
  | "id"
  | "supportUserId"
  | "organizationId"
  | "teamId"
  | "reason"
  | "accessLevel"
  | "status"
  | "expiresAtUtc"
  | "revokedAtUtc"
> & { approvedByUserId?: string | null };

function toContext(grant: GrantRow): SupportRuntimeContext {
  return {
    grantId: grant.id,
    supportActorUserId: grant.supportUserId,
    organizationId: grant.organizationId,
    teamId: grant.teamId,
    mode: grant.accessLevel as SupportAccessLevel,
    reason: grant.reason,
    expiresAtUtc: grant.expiresAtUtc.toISOString(),
    approvedByUserId: grant.approvedByUserId ?? null,
  };
}

/**
 * Fetch the most recent ACTIVE grant for a support actor scoped to a
 * customer org (optionally narrowed to a workspace). Returns the raw row
 * so callers can defer the active/scope decision to `evaluateSupportAccess`.
 */
async function fetchActiveGrantForActor(
  client: PrismaClient,
  supportActorUserId: string,
  organizationId?: string,
): Promise<GrantRow | null> {
  const row = await client.supportAccessGrant.findFirst({
    where: {
      supportUserId: supportActorUserId,
      status: "ACTIVE",
      ...(organizationId ? { organizationId } : {}),
    },
    orderBy: { startedAtUtc: "desc" },
    select: {
      id: true,
      supportUserId: true,
      organizationId: true,
      teamId: true,
      reason: true,
      accessLevel: true,
      status: true,
      expiresAtUtc: true,
      revokedAtUtc: true,
      approvedByUserId: true,
    },
  });
  return row as GrantRow | null;
}

async function fetchGrantById(
  client: PrismaClient,
  grantId: string,
): Promise<GrantRow | null> {
  const row = await client.supportAccessGrant.findUnique({
    where: { id: grantId },
    select: {
      id: true,
      supportUserId: true,
      organizationId: true,
      teamId: true,
      reason: true,
      accessLevel: true,
      status: true,
      expiresAtUtc: true,
      revokedAtUtc: true,
      approvedByUserId: true,
    },
  });
  return row as GrantRow | null;
}

export type ResolveSupportRuntimeInput = {
  supportActorUserId: string;
  organizationId: string;
  teamId?: string | null;
  nowMs?: number;
};

export type ResolveSupportRuntimeResult =
  | { context: SupportRuntimeContext }
  | { context: null; reason: SupportRuntimeDenyReason };

/**
 * Compose the dual-identity runtime context for a support actor operating
 * within a customer org/workspace. Defers the active/scope decision entirely
 * to the authority's `evaluateSupportAccess`. Heals to `{ context: null }`
 * when no grant is active or the requested scope is not covered.
 */
export async function resolveSupportRuntimeContext(
  input: ResolveSupportRuntimeInput,
  client: PrismaClient = defaultPrisma,
): Promise<ResolveSupportRuntimeResult> {
  const nowMs = input.nowMs ?? Date.now();
  const grant = await fetchActiveGrantForActor(
    client,
    input.supportActorUserId,
    input.organizationId,
  );
  if (!grant) return { context: null, reason: "no_grant" };

  const evaluation = evaluateSupportAccess(grant, {
    organizationId: input.organizationId,
    teamId: input.teamId ?? null,
    nowMs,
  });
  if (!evaluation.active) {
    return {
      context: null,
      reason: (evaluation.reason as SupportRuntimeDenyReason) ?? "inactive",
    };
  }
  return { context: toContext(grant) };
}

export type ResolveSupportRuntimeByGrantIdInput = {
  /** The specific grant referenced by the caller's opaque support-context token. */
  grantId: string;
  /** The authenticated actor — MUST match `grant.supportUserId` (wrong-actor fails closed). */
  supportActorUserId: string;
  /** The customer org the CURRENT request targets (workspace-switch guard). */
  organizationId: string;
  teamId?: string | null;
  nowMs?: number;
};

/**
 * PHASE 10 CLOSURE FIX 1 (2026-07-23) — grant-pinned runtime resolution.
 *
 * Unlike `resolveSupportRuntimeContext` (which finds "the most recent
 * ACTIVE grant for this actor+org"), this resolves the EXACT grant named by
 * the server-issued support-context token (`grantId`). This is what the
 * canonical `authorize.ts` guard uses — a client cannot widen its own scope
 * by omitting `grantId` and letting the lookup fall back to "any active
 * grant"; the token pins the request to one specific, already-validated
 * grant. Re-reads the grant FRESH from the DB (never trusts anything
 * cached in the token beyond the id) and re-runs the full scope/expiry/
 * revocation check via `evaluateSupportAccess` against the org/workspace
 * the CURRENT request targets.
 */
export async function resolveSupportRuntimeContextByGrantId(
  input: ResolveSupportRuntimeByGrantIdInput,
  client: PrismaClient = defaultPrisma,
): Promise<ResolveSupportRuntimeResult> {
  const grant = await fetchGrantById(client, input.grantId);
  if (!grant) return { context: null, reason: "grant_disappeared" };

  // Wrong actor: a token minted for actor A presented by (or replayed for)
  // actor B never resolves to a usable context — fail closed, no fallback
  // to "find some other grant for this actor".
  if (grant.supportUserId !== input.supportActorUserId) {
    return { context: null, reason: "no_grant" };
  }

  const nowMs = input.nowMs ?? Date.now();
  const evaluation = evaluateSupportAccess(grant, {
    organizationId: input.organizationId,
    teamId: input.teamId ?? null,
    nowMs,
  });
  if (!evaluation.active) {
    return {
      context: null,
      reason: (evaluation.reason as SupportRuntimeDenyReason) ?? "inactive",
    };
  }
  return { context: toContext(grant) };
}

export type ValidateGrantForSupportContextEntryResult =
  | { valid: true; grant: GrantRow }
  | {
      valid: false;
      reason: SupportRuntimeDenyReason | "actor_mismatch";
    };

/**
 * PHASE 10 CLOSURE FIX 1 (2026-07-23) — used ONLY by the server-side entry
 * endpoint (`POST /v1/support-access/enter`, enterprise-security.routes.ts)
 * BEFORE it mints an opaque support-context token. Re-reads the grant fresh
 * from the DB and requires: the grant exists, `supportUserId` matches the
 * authenticated actor, and it is currently ACTIVE / unexpired / unrevoked
 * (evaluated against its OWN persisted org/team scope — entry does not
 * require the caller to already be inside the target workspace). The token
 * is minted ONLY when this returns `valid: true`.
 */
export async function validateGrantForSupportContextEntry(
  input: { actorUserId: string; grantId: string; nowMs?: number },
  client: PrismaClient = defaultPrisma,
): Promise<ValidateGrantForSupportContextEntryResult> {
  const grant = await fetchGrantById(client, input.grantId);
  if (!grant) return { valid: false, reason: "no_grant" };
  if (grant.supportUserId !== input.actorUserId) {
    return { valid: false, reason: "actor_mismatch" };
  }
  const evaluation = evaluateSupportAccess(grant, {
    organizationId: grant.organizationId,
    teamId: grant.teamId,
    nowMs: input.nowMs ?? Date.now(),
  });
  if (!evaluation.active) {
    return {
      valid: false,
      reason: (evaluation.reason as SupportRuntimeDenyReason) ?? "inactive",
    };
  }
  return { valid: true, grant };
}

export type AuthorizeSupportActionInput = {
  context: SupportRuntimeContext;
  /** The action being attempted, e.g. "evidence.read" / "evidence.update". */
  action: string;
  /** The customer org the current request targets (workspace-switch guard). */
  customerOrganizationId: string;
  /** The workspace (Team) the current request targets, if narrower. */
  requestedTeamId?: string | null;
  nowMs?: number;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export type AuthorizeSupportActionResult = {
  allowed: boolean;
  reason?: SupportRuntimeDenyReason;
};

/**
 * The per-request guard. Re-reads the grant from the DB (so a revocation or
 * expiry since the context was composed is caught), re-runs BOTH the scope
 * check (`evaluateSupportAccess`) and the action-permission check
 * (`evaluateSupportActionAllowed`), and audits BOTH identities. It performs
 * NO business mutation — on a denial nothing is written except the immutable
 * audit trail.
 */
export async function authorizeSupportAction(
  input: AuthorizeSupportActionInput,
  client: PrismaClient = defaultPrisma,
): Promise<AuthorizeSupportActionResult> {
  const nowMs = input.nowMs ?? Date.now();

  // Fresh read — the context alone is never trusted for a mutation decision.
  const grant = await fetchGrantById(client, input.context.grantId);
  if (!grant) {
    await auditSupportAction(input, "denied", "grant_disappeared", client);
    return { allowed: false, reason: "grant_disappeared" };
  }

  // Scope + expiry + revocation — checked on EVERY request against the
  // workspace the request actually targets. A workspace switch to another
  // org/workspace cannot escape the grant scope: the requested org/team is
  // compared, not the context's stored one.
  const scoped = evaluateSupportAccess(grant, {
    organizationId: input.customerOrganizationId,
    teamId: input.requestedTeamId ?? null,
    nowMs,
  });
  if (!scoped.active) {
    const reason = (scoped.reason as SupportRuntimeDenyReason) ?? "inactive";
    await auditSupportAction(input, "denied", reason, client);
    return { allowed: false, reason };
  }

  // Action permission — READ_ONLY default + forbidden-action blocklist, both
  // owned by the authority.
  const permitted = evaluateSupportActionAllowed(grant, input.action);
  if (!permitted.allowed) {
    const reason = (permitted.reason as SupportRuntimeDenyReason) ?? "support_read_only";
    await auditSupportAction(input, "denied", reason, client);
    return { allowed: false, reason };
  }

  await auditSupportAction(input, "success", undefined, client);
  return { allowed: true };
}

/**
 * Immutable dual-identity audit. ONE row records BOTH identities — the
 * support ACTOR (`userId` + `supportActorUserId`) and the customer
 * ORGANIZATION (`resourceId` + `customerOrganizationId`) — plus the grant,
 * action, and decision. Failures are swallowed so auditing never blocks the
 * deny path.
 */
async function auditSupportAction(
  input: AuthorizeSupportActionInput,
  outcome: "success" | "denied",
  reason: SupportRuntimeDenyReason | undefined,
  client: PrismaClient,
): Promise<void> {
  await emitTenantAudit({
    action: `identity.support_access.action.${outcome}`,
    outcome,
    denialReason: outcome === "denied" ? (reason ?? "support_access_denied") : null,
    sourceApp: "API",
    actorUserId: input.context.supportActorUserId, // ACTOR identity (DUAL IDENTITY)
    supportActorUserId: input.context.supportActorUserId,
    organizationId: input.customerOrganizationId, // CUSTOMER identity
    workspaceId: input.context.teamId ?? null,
    resourceType: "organization",
    resourceId: input.customerOrganizationId, // CUSTOMER identity
    metadata: {
      grantId: input.context.grantId,
      customerOrganizationId: input.customerOrganizationId,
      requestedTeamId: input.requestedTeamId ?? null,
      grantOrganizationId: input.context.organizationId,
      grantTeamId: input.context.teamId,
      mode: input.context.mode,
      attemptedAction: input.action,
      decision: outcome,
      reason: reason ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
  }, client).catch(() => null);
}

/**
 * Pure workspace-switch guard. A support session cannot follow a workspace
 * switch out of its granted org/workspace. Uses the authority's
 * `evaluateSupportAccess` — no independent scope logic.
 */
export function assertWorkspaceWithinScope(input: {
  context: SupportRuntimeContext;
  requestedOrganizationId: string;
  requestedTeamId?: string | null;
  nowMs?: number;
}): { withinScope: boolean; reason?: SupportRuntimeDenyReason } {
  const evaluation = evaluateSupportAccess(
    {
      status: "ACTIVE",
      expiresAtUtc: new Date(input.context.expiresAtUtc),
      revokedAtUtc: null,
      organizationId: input.context.organizationId,
      teamId: input.context.teamId,
    },
    {
      organizationId: input.requestedOrganizationId,
      teamId: input.requestedTeamId ?? null,
      nowMs: input.nowMs ?? Date.now(),
    },
  );
  return evaluation.active
    ? { withinScope: true }
    : {
        withinScope: false,
        reason: (evaluation.reason as SupportRuntimeDenyReason) ?? "org_scope_mismatch",
      };
}

// ===========================================================================
// PHASE 10 STEP 5 / CLOSURE FIX 1 (2026-07-23) — REAL-OPERATION runtime
// guard.
//
// This is the composition point the canonical `authorize.ts` calls when a
// request carries a SERVER-VERIFIED opaque support-context token (never a
// client-controlled boolean, never a DB grant lookup otherwise). It
// COMPOSES the existing authorities (`resolveSupportRuntimeContextByGrantId`,
// `authorizeSupportAction`) — it does not re-implement scope, expiry,
// revocation, or the READ_ONLY/forbidden-action blocklist, all of which
// remain entirely inside `authorizeSupportAction`.
//
// It adds exactly two things of its own, both clearly scoped and both
// documented at the call site:
//   1. `deriveSupportActionFromPermission` — the action evaluated is the
//      SERVER-DERIVED canonical `Permission` already being authorized for
//      the route, never a client-supplied body field.
//   2. An ELEVATED-mode defense-in-depth double-check: the persisted
//      approval (`approvedByUserId`, already enforced at grant-creation time
//      by `support-access.service.ts#startSupportAccess`) and a FRESH
//      step-up proof on THIS request. Grant lifecycle / action-permission
//      logic is untouched.
// ===========================================================================

/**
 * SERVER-DERIVED support action. The canonical `Permission` string already
 * being authorized on the route IS the action evaluated against the support
 * authority — a named passthrough so every call site makes the "action is
 * server-derived, never client-supplied" contract explicit and grep-able.
 */
export function deriveSupportActionFromPermission(permission: string): string {
  return permission;
}

/**
 * Team → Organization resolution used ONLY inside the support guard (i.e.
 * only when a SERVER-VERIFIED support-context token is present on the
 * request).
 * `Team.organizationId` is NOT NULL in the schema — any miss here means the
 * team could not be resolved and the guard fails closed.
 */
async function resolveSupportOrganizationForTeam(
  teamId: string,
  client: PrismaClient,
): Promise<string | null> {
  const team = await client.team.findUnique({
    where: { id: teamId },
    select: { organizationId: true },
  });
  return team?.organizationId ?? null;
}

export type SupportAccessGuardInput = {
  /** The authenticated actor already resolved by canonical authorize. */
  actorUserId: string;
  /**
   * PHASE 10 CLOSURE FIX 1 (2026-07-23) — the grant named by the caller's
   * SERVER-VERIFIED opaque support-context token (never a client-declared
   * value; `middleware/authorize.ts` extracts this only after verifying the
   * token's HMAC signature). The guard is pinned to this EXACT grant — it
   * never falls back to "any active grant for this actor".
   */
  grantId: string;
  /** The workspace (Team) the current request targets. */
  teamId: string;
  /** SERVER-DERIVED action — the canonical `Permission` being authorized. */
  permission: string;
  /**
   * Presence of a step-up proof on THIS request (header check only — full
   * verification/consumption remains `requireStepUpForSensitiveAction`'s
   * job on the routes that already call it explicitly). Used here purely as
   * an ADDITIONAL defense-in-depth gate before permitting an ELEVATED
   * support action; never substitutes for route-level step-up enforcement.
   */
  hasStepUpProof: boolean;
  ipAddress?: string | null;
  userAgent?: string | null;
  nowMs?: number;
};

export type SupportAccessGuardResult =
  | { allowed: true; context: SupportRuntimeContext }
  | { allowed: false; reason: SupportRuntimeDenyReason };

/**
 * The REAL-OPERATION per-request guard. Invoked by `middleware/authorize.ts`
 * ONLY when the request carries a SERVER-VERIFIED opaque support-context
 * token (so ordinary customer sessions never reach this function and never
 * pay for the extra DB reads). Fails closed on every branch — a denial here
 * mutates nothing and `authorizeSupportAction` audits both identities.
 */
export async function applySupportAccessGuard(
  input: SupportAccessGuardInput,
  client: PrismaClient = defaultPrisma,
): Promise<SupportAccessGuardResult> {
  const organizationId = await resolveSupportOrganizationForTeam(input.teamId, client);
  if (!organizationId) {
    return { allowed: false, reason: "team_unresolved" };
  }

  const resolved = await resolveSupportRuntimeContextByGrantId(
    {
      grantId: input.grantId,
      supportActorUserId: input.actorUserId,
      organizationId,
      teamId: input.teamId,
      nowMs: input.nowMs,
    },
    client,
  );
  if (!resolved.context) {
    return { allowed: false, reason: resolved.reason };
  }
  const context = resolved.context;

  // ELEVATED defense-in-depth — see module-header note above. READ_ONLY
  // (the default) skips straight to the authority check below.
  if (context.mode === "ELEVATED") {
    if (!context.approvedByUserId) {
      return { allowed: false, reason: "elevated_approval_missing" };
    }
    if (!input.hasStepUpProof) {
      return { allowed: false, reason: "elevated_step_up_required" };
    }
  }

  const action = deriveSupportActionFromPermission(input.permission);
  const decision = await authorizeSupportAction(
    {
      context,
      action,
      customerOrganizationId: organizationId,
      requestedTeamId: input.teamId,
      nowMs: input.nowMs,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
    client,
  );
  if (!decision.allowed) {
    return { allowed: false, reason: decision.reason ?? "support_read_only" };
  }
  return { allowed: true, context };
}

// ===========================================================================
// Background / queued jobs — serialize + re-validate.
//
// A queued job must preserve the support actor + customer org + grantId so
// the work it performs on the customer's behalf remains attributable and
// bounded. The serialized blob is NOT trusted on execution: the job MUST
// re-validate it against the live grant (revocation/expiry heal the job
// out) before performing any support-scoped work.
// ===========================================================================

export type SerializedSupportContext = {
  __kind: "support_runtime_context_v1";
  grantId: string;
  supportActorUserId: string;
  organizationId: string;
  teamId: string | null;
  mode: SupportAccessLevel;
  reason: string;
  expiresAtUtc: string;
};

/** Serialize the runtime context for enqueue. */
export function serializeSupportContext(
  ctx: SupportRuntimeContext,
): SerializedSupportContext {
  return {
    __kind: "support_runtime_context_v1",
    grantId: ctx.grantId,
    supportActorUserId: ctx.supportActorUserId,
    organizationId: ctx.organizationId,
    teamId: ctx.teamId,
    mode: ctx.mode,
    reason: ctx.reason,
    expiresAtUtc: ctx.expiresAtUtc,
  };
}

/**
 * Re-validate a serialized context when the job runs. Re-reads the grant and
 * defers to `evaluateSupportAccess`. Returns the fresh context or `null` when
 * the grant has expired / been revoked / no longer covers the scope — the
 * job heals out safely rather than proceeding under a stale grant.
 */
export async function deserializeSupportContext(
  raw: SerializedSupportContext | null | undefined,
  client: PrismaClient = defaultPrisma,
  nowMs: number = Date.now(),
): Promise<ResolveSupportRuntimeResult> {
  if (!raw || raw.__kind !== "support_runtime_context_v1") {
    return { context: null, reason: "no_grant" };
  }
  const grant = await fetchGrantById(client, raw.grantId);
  if (!grant) return { context: null, reason: "grant_disappeared" };
  const evaluation = evaluateSupportAccess(grant, {
    organizationId: raw.organizationId,
    teamId: raw.teamId,
    nowMs,
  });
  if (!evaluation.active) {
    return {
      context: null,
      reason: (evaluation.reason as SupportRuntimeDenyReason) ?? "inactive",
    };
  }
  return { context: toContext(grant) };
}

// ===========================================================================
// Platform-context envelope projection.
// ===========================================================================

/**
 * The envelope's `supportAccess` section — present ONLY when an ACTIVE,
 * unexpired, unrevoked grant exists for the actor. Drives the persistent web
 * support banner. Always fails safe to `null` (no active support access).
 */
export type SupportAccessEnvelopeSection = {
  active: true;
  grantId: string;
  supportActorUserId: string;
  organizationId: string;
  organizationName: string | null;
  teamId: string | null;
  mode: SupportAccessLevel;
  reason: string;
  expiresAtUtc: string;
};

/**
 * Project the actor's active support grant into the envelope section. When
 * `organizationId` is omitted the most recent ACTIVE grant for the actor is
 * used. Returns `null` (heals out) on no grant, expiry, revocation, or any
 * error — the banner simply does not render.
 */
export async function buildSupportAccessEnvelopeSection(
  input: { supportActorUserId: string; organizationId?: string; nowMs?: number },
  client: PrismaClient = defaultPrisma,
): Promise<SupportAccessEnvelopeSection | null> {
  const nowMs = input.nowMs ?? Date.now();
  try {
    const grant = await client.supportAccessGrant.findFirst({
      where: {
        supportUserId: input.supportActorUserId,
        status: "ACTIVE",
        ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      },
      orderBy: { startedAtUtc: "desc" },
      select: {
        id: true,
        supportUserId: true,
        organizationId: true,
        teamId: true,
        reason: true,
        accessLevel: true,
        status: true,
        expiresAtUtc: true,
        revokedAtUtc: true,
        organization: { select: { name: true } },
      },
    });
    if (!grant) return null;
    const evaluation = evaluateSupportAccess(grant as unknown as GrantRow, {
      organizationId: grant.organizationId,
      nowMs,
    });
    if (!evaluation.active) return null;
    return {
      active: true,
      grantId: grant.id,
      supportActorUserId: grant.supportUserId,
      organizationId: grant.organizationId,
      organizationName:
        (grant as unknown as { organization?: { name?: string | null } })
          .organization?.name ?? null,
      teamId: grant.teamId,
      mode: grant.accessLevel as SupportAccessLevel,
      reason: grant.reason,
      expiresAtUtc: grant.expiresAtUtc.toISOString(),
    };
  } catch {
    // Table not yet applied at runtime, or any transient failure → the
    // banner heals out. Support access is fail-closed by construction.
    return null;
  }
}
