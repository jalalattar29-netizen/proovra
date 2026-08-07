/**
 * PROOVRA Phase 4A Closure — Delegated-tier route guard.
 *
 * Fastify preHandler factories that gate a route on a delegated
 * admin tier (or an OR-set of tiers).
 *
 *   requireDelegatedTier(tier | tiers)   — single-tier or OR-set
 *   requireDelegatedTierAny(tiers)       — OR-set, scope-agnostic
 *
 * Both helpers:
 *   1. Resolve userId from the authenticated request.
 *   2. Resolve the current workspace (teamId) from the user row.
 *   3. Call hasDelegatedTier — which now honours implicit
 *      workspace-owner ORG_ADMIN — for each candidate tier.
 *   4. On denial: emit a POLICY_VIOLATION lifecycle event with
 *      reason="delegated_tier_required:<tier>" and 403 with
 *      `{ denial: "DELEGATED_ADMIN_REQUIRED", requiredTier }`.
 *   5. On success: pass through.
 *
 * These factories are scope-agnostic — they enforce the workspace-
 * wide tier check. Routes that need finer-grained scope (org /
 * department / workspace) call `hasDelegatedTier` directly with the
 * scope identifiers, after the route handler has resolved them.
 */

import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { DelegatedAdminTier } from "@proovra/shared";

import { getAuthUserId } from "../auth.js";
import { evaluateCurrentWorkspace } from "./authorize.js";
import { hasDelegatedTier } from "../services/governance/delegated-admin.service.js";
import { emitTrustEvent } from "../services/trust/trust-and-governance-audit.service.js";

type TierInput = DelegatedAdminTier | ReadonlyArray<DelegatedAdminTier>;

function normaliseTiers(
  tier: TierInput,
): ReadonlyArray<DelegatedAdminTier> {
  return Array.isArray(tier)
    ? (tier as ReadonlyArray<DelegatedAdminTier>)
    : [tier as DelegatedAdminTier];
}

/**
 * PHASE 12 CORRECTIVE PASS §1.3 (2026-08-06) — SEC-001-CLASS RESIDUE, FIXED.
 *
 * What was wrong
 * ---------------------------------------------------------------------------
 * This guard resolved the workspace from `User.currentWorkspaceId` alone and
 * then asked `hasDelegatedTier` whether the caller held the tier. That
 * question is answered from `DelegatedAdminGrant` rows and the implicit-owner
 * ladder — it says nothing about whether the caller is still a live member of
 * the workspace. So an operator who had been SUSPENDED or whose access had
 * EXPIRED, or whose parent Organization had been suspended, continued to pass
 * every delegated-tier route for as long as their grant row stayed ACTIVE and
 * their stale pointer kept naming the workspace. That is SEC-001 exactly: the
 * navigation pointer selecting the tenant, and grant EXISTENCE mistaken for
 * grant VALIDITY.
 *
 * The correction
 * ---------------------------------------------------------------------------
 * The pointer is now only a CANDIDATE. `evaluateAuthorizedWorkspace` — the
 * same canonical primitive every other migrated surface uses — revalidates it
 * in full (workspace existence, workspace kind, EXPLICIT membership,
 * membership status, access expiry, parent-Organization lifecycle, the
 * baseline permission, and the support-access guard) before this guard even
 * asks about tiers. Only then does `hasDelegatedTier` run, and it now runs on
 * a workspace the caller has been PROVEN to be entitled to be inside.
 *
 * The baseline permission is `evidence.read`, which every canonical role
 * holds. Admission is therefore not narrowed for any live member — the change
 * removes access only from callers who should already have had none.
 */
async function resolveAuthorizedTeamId(
  req: FastifyRequest,
): Promise<string | null> {
  const outcome = await evaluateCurrentWorkspace(req, {
    permission: "evidence.read",
  });
  if (outcome.allowed) return outcome.context.workspaceId;
  return null;
}

async function emitDenialEvent(input: {
  teamId: string | null;
  actorUserId: string | null;
  requiredTier: DelegatedAdminTier;
}): Promise<void> {
  if (!input.teamId) return;
  try {
    await emitTrustEvent({
      teamId: input.teamId,
      code: "POLICY_VIOLATION",
      actorUserId: input.actorUserId,
      reason: `delegated_tier_required:${input.requiredTier}`,
    });
  } catch {
    // Audit emission must never break the request path.
  }
}

/**
 * Gate a route on a single delegated admin tier — or, if an array
 * is passed, on the OR-set of those tiers (any one satisfies).
 *
 * Scope-agnostic: enforces the workspace-wide tier. Routes that need
 * scoped checks (org / department / workspace) should call
 * `hasDelegatedTier` directly inside the handler with the resolved
 * scope identifiers.
 */
export function requireDelegatedTier(
  tier: TierInput,
): preHandlerHookHandler {
  const tiers = normaliseTiers(tier);
  // Pre-compute the "primary" required tier we surface to the
  // caller on denial — the strongest tier in the set is the most
  // informative thing to tell the client.
  const primaryTier: DelegatedAdminTier =
    tiers[0] ?? ("ORG_ADMIN" as DelegatedAdminTier);

  return async function delegatedTierGuard(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    let userId: string;
    try {
      userId = getAuthUserId(req);
    } catch {
      // requireAuth should have run first; if it didn't, refuse.
      await emitDenialEvent({
        teamId: null,
        actorUserId: null,
        requiredTier: primaryTier,
      });
      reply.code(403).send({
        denial: "DELEGATED_ADMIN_REQUIRED",
        requiredTier: primaryTier,
      });
      return;
    }

    const teamId = await resolveAuthorizedTeamId(req);
    if (!teamId) {
      await emitDenialEvent({
        teamId: null,
        actorUserId: userId,
        requiredTier: primaryTier,
      });
      reply.code(403).send({
        denial: "DELEGATED_ADMIN_REQUIRED",
        requiredTier: primaryTier,
      });
      return;
    }

    for (const candidate of tiers) {
      const ok = await hasDelegatedTier({
        teamId,
        userId,
        requiredTier: candidate,
      });
      if (ok) return;
    }

    await emitDenialEvent({
      teamId,
      actorUserId: userId,
      requiredTier: primaryTier,
    });
    reply.code(403).send({
      denial: "DELEGATED_ADMIN_REQUIRED",
      requiredTier: primaryTier,
    });
  };
}

/**
 * Gate a route on an OR-set of delegated admin tiers — the request
 * passes if the caller holds ANY of the supplied tiers. Scope-
 * agnostic; see `requireDelegatedTier` for the scope contract.
 *
 * Equivalent to `requireDelegatedTier(tiers)` but spelled
 * explicitly so call-sites that always want OR-semantics read
 * clearly at the route registration line.
 */
export function requireDelegatedTierAny(
  tiers: ReadonlyArray<DelegatedAdminTier>,
): preHandlerHookHandler {
  if (tiers.length === 0) {
    // An empty OR-set can never be satisfied. Make the failure mode
    // explicit at registration time rather than silently rejecting
    // every request.
    throw new Error(
      "requireDelegatedTierAny: tiers array must contain at least one tier",
    );
  }
  return requireDelegatedTier(tiers);
}
