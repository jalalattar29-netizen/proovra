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
import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { hasDelegatedTier } from "../services/governance/delegated-admin.service.js";
import { emitTrustEvent } from "../services/trust/trust-and-governance-audit.service.js";
function normaliseTiers(tier) {
    return Array.isArray(tier)
        ? tier
        : [tier];
}
async function resolveTeamId(userId) {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { currentWorkspaceId: true },
    });
    return user?.currentWorkspaceId ?? null;
}
async function emitDenialEvent(input) {
    if (!input.teamId)
        return;
    try {
        await emitTrustEvent({
            teamId: input.teamId,
            code: "POLICY_VIOLATION",
            actorUserId: input.actorUserId,
            reason: `delegated_tier_required:${input.requiredTier}`,
        });
    }
    catch {
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
export function requireDelegatedTier(tier) {
    const tiers = normaliseTiers(tier);
    // Pre-compute the "primary" required tier we surface to the
    // caller on denial — the strongest tier in the set is the most
    // informative thing to tell the client.
    const primaryTier = tiers[0] ?? "ORG_ADMIN";
    return async function delegatedTierGuard(req, reply) {
        let userId;
        try {
            userId = getAuthUserId(req);
        }
        catch {
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
        const teamId = await resolveTeamId(userId);
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
            if (ok)
                return;
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
export function requireDelegatedTierAny(tiers) {
    if (tiers.length === 0) {
        // An empty OR-set can never be satisfied. Make the failure mode
        // explicit at registration time rather than silently rejecting
        // every request.
        throw new Error("requireDelegatedTierAny: tiers array must contain at least one tier");
    }
    return requireDelegatedTier(tiers);
}
