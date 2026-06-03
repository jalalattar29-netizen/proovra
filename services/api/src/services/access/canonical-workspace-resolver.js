/**
 * PROOVRA Phase 3 — Canonical backend workspace + denial helpers.
 *
 * This module is the BACKEND mirror of the Phase 3 Stage 2/3 work on
 * the frontend:
 *
 *   - `useActiveWorkspaceId()` is the canonical FE workspace-id hook.
 *   - `accessStateToDenialReason()` + friends in
 *     `packages/shared/src/architecture/denial-vocabulary.ts` map UI
 *     vocabularies to a canonical `DenialReason`.
 *
 * Server-side, the same alignment work needs:
 *
 *   1. A canonical "what workspace is this request actually operating
 *      against?" reader that prefers an actor's explicit team header,
 *      falls back to the personal-team row, and returns a bounded
 *      `ActiveOperationalWorkspace` shape — so route handlers stop
 *      duplicating header parsing + personal-team lookup.
 *
 *   2. A canonical `AuthorizationDenialCode → DenialReason` mapper so
 *      every place that hands the backend's denial code back to the
 *      frontend produces consistent copy.
 *
 * Hard rules — enforced by Phase R12 contract tests:
 *
 *   - This module NEVER opens transactions, NEVER mutates anything,
 *     NEVER changes existing authorization decisions. It is an
 *     additive READ helper.
 *   - It NEVER weakens the existing route auth (the canonical
 *     `authorizeOrFail` / `evaluateMemberAccess` path remains the only
 *     authority).
 *   - It NEVER bypasses the Personal-First invariant (INV-2): a user
 *     without an explicit team header MUST still resolve to their
 *     personal team via the bootstrap row.
 *   - Phase 3 constitutional non-negotiables:
 *       * Team remains available to normal users (no Organization required).
 *       * Personal users remain fully supported.
 *       * No new workspace kind; no new architecture layer.
 *       * No global rename of `teamId` (the resolver returns `teamId`
 *         verbatim — schema-side rename is deferred to a later phase).
 *
 * Constitutional reference:
 *   docs/architecture/architecture-invariants.md  (INV-2, INV-3, INV-9)
 *   docs/architecture/proovra-domain-model.md
 *   docs/architecture/phase-3-runtime-refactor-readiness.md
 */
import { authorizationDenialCodeToDenialReason, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
// =============================================================================
// Header parsing
// =============================================================================
function readTeamIdHeader(req) {
    const raw = req.headers["x-team-id"];
    if (typeof raw === "string" && raw.length > 0)
        return raw;
    if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "string") {
        return raw[0];
    }
    // Fall back to query string + body — kept narrow to common shapes.
    const q = req.query?.teamId;
    if (typeof q === "string" && q.length > 0)
        return q;
    const b = req.body?.teamId;
    if (typeof b === "string" && b.length > 0)
        return b;
    return null;
}
// =============================================================================
// resolveActiveOperationalWorkspace
// =============================================================================
/**
 * Read the active operational workspace for the given actor.
 *
 * Resolution order (first match wins):
 *
 *   1. If the request carries an `x-team-id` (or `teamId`
 *      query/body) and the actor has an ACTIVE membership on that
 *      team, return that team with `source: "header"`. The
 *      membership check prevents header tampering.
 *
 *   2. If the actor has a personal-team row (`isPersonal=true`),
 *      return that team with `source: "personal-default"`. This is
 *      the PROOVRA Personal-First invariant.
 *
 *   3. If the actor has exactly one other ACTIVE team membership,
 *      return that team with `source: "single-membership"`. This is
 *      the legacy "single org" fallback for users whose personal
 *      bootstrap was skipped pre-rescue.
 *
 *   4. Otherwise return `null` — the caller should reply with the
 *      canonical `WORKSPACE_REQUIRED` denial via
 *      `mapAuthorizationDenial("missing_team_id")`.
 *
 * NEVER throws. NEVER opens a transaction. Reads from
 * `TeamMembership` + `Team` only.
 */
export async function resolveActiveOperationalWorkspace(req, actorUserId, client = defaultPrisma) {
    // Step 1: header takes precedence (when membership matches).
    const headerTeamId = readTeamIdHeader(req);
    if (headerTeamId) {
        try {
            const membership = await client.teamMember.findFirst({
                where: {
                    teamId: headerTeamId,
                    userId: actorUserId,
                    status: "ACTIVE",
                },
                select: { teamId: true, team: { select: { isPersonal: true } } },
            });
            if (membership) {
                return {
                    teamId: membership.teamId,
                    kind: membership.team?.isPersonal ? "PERSONAL" : "TEAM",
                    source: "header",
                };
            }
        }
        catch {
            // Fall through to defaults — we never fail the request on a
            // resolver read; the caller's authorize path will issue the
            // canonical denial.
        }
    }
    // Step 2: personal team default.
    try {
        const personal = await client.teamMember.findFirst({
            where: {
                userId: actorUserId,
                status: "ACTIVE",
                team: { isPersonal: true },
            },
            select: { teamId: true },
        });
        if (personal) {
            return {
                teamId: personal.teamId,
                kind: "PERSONAL",
                source: "personal-default",
            };
        }
    }
    catch {
        // Same fall-through rule.
    }
    // Step 3: single org fallback (pre-rescue accounts).
    try {
        const memberships = await client.teamMember.findMany({
            where: { userId: actorUserId, status: "ACTIVE" },
            select: { teamId: true, team: { select: { isPersonal: true } } },
            take: 2,
        });
        if (memberships.length === 1) {
            const m = memberships[0];
            return {
                teamId: m.teamId,
                kind: m.team?.isPersonal ? "PERSONAL" : "TEAM",
                source: "single-membership",
            };
        }
    }
    catch {
        // Final fall-through.
    }
    return null;
}
// =============================================================================
// mapAuthorizationDenial — canonical bridge
// =============================================================================
/**
 * Map a backend `AuthorizationDenialCode` (as emitted by
 * `services/api/src/middleware/authorize.ts`) onto the canonical
 * `DenialReason` defined in `@proovra/shared`.
 *
 * Pure passthrough to `authorizationDenialCodeToDenialReason`, kept
 * as a server-side re-export so server code can import a single
 * helper for both shapes:
 *
 *   import {
 *     resolveActiveOperationalWorkspace,
 *     mapAuthorizationDenial,
 *   } from "../services/access/canonical-workspace-resolver.js";
 *
 * Returns `null` for unknown codes; the caller should treat unknown
 * as `OPERATIONAL_ERROR` — never silently "ALLOW".
 */
export function mapAuthorizationDenial(code) {
    return authorizationDenialCodeToDenialReason(code);
}
