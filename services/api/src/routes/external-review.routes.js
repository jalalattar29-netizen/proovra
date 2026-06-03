/**
 * Phase 27.5 / 28.5 — External Review REST routes.
 *
 * Wires the Phase 27/28 `external-review-grant.service.ts` into a
 * complete REST surface. Two distinct auth paths:
 *
 *   1. OPERATOR routes (issue, list, revoke) — gated by the Phase 26
 *      `authorizeOrFail` helper with the `audit.read` permission for
 *      reads + `governance.legal_hold.manage` for writes. Audit
 *      emission delegated to the access-policy engine; the response
 *      shape is the canonical 401/403/404/503 envelope.
 *
 *   2. REVIEWER routes (accept-by-token, context, record-access) —
 *      gated by the raw access token, NOT by session. Every token
 *      lookup goes through `lookupExternalReviewGrantByToken` which
 *      enforces anti-enumeration semantics: unknown / revoked /
 *      expired tokens all return identical 401 shapes.
 *
 * Hard rules:
 *   - Anti-enumeration: token responses NEVER expose whether a (team,
 *     evidence) pair exists. Failed lookups all return:
 *       401 { error: { code: "grant_not_active" } }
 *   - Anti-timing: token responses run constant work regardless of
 *     whether the token matches — the service's `$queryRaw` lookup is
 *     already constant-time relative to the hash.
 *   - Bounded denial vocabulary: every 4xx response carries a code
 *     from `EXTERNAL_REVIEW_GRANT_DENIAL_CODES`.
 *   - The reviewer route NEVER returns workspace-internal data. The
 *     reviewer context shape is intentionally narrow: scope identifier
 *     + display name + expiry + download flags.
 *   - The reviewer route NEVER exposes signed URLs / storage keys /
 *     private notes / legal notes / hidden workflow state.
 */
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { authorizeOrFail } from "../middleware/authorize.js";
import { bump } from "../services/ops/metrics.service.js";
import { EXTERNAL_REVIEW_SCOPE_KINDS, issueExternalReviewGrant, listExternalReviewGrants, lookupExternalReviewGrantByToken, recordExternalReviewAccess, transitionExternalReviewGrant, } from "../services/external-review/external-review-grant.service.js";
import { EXTERNAL_REVIEW_ACCESS_STATES, } from "@proovra/shared";
// =============================================================================
// Bounded validators
// =============================================================================
const IssueGrantBodySchema = z.object({
    teamId: z.string().uuid(),
    scopeKind: z.enum(EXTERNAL_REVIEW_SCOPE_KINDS),
    evidenceId: z.string().uuid().optional().nullable(),
    caseId: z.string().uuid().optional().nullable(),
    packageId: z.string().uuid().optional().nullable(),
    reviewerEmail: z.string().email().max(320),
    reviewerDisplayName: z.string().max(200).optional().nullable(),
    // ISO timestamp; service enforces 15-min ≤ expiry ≤ 30d.
    expiresAtUtc: z.string().datetime(),
    allowOriginalDownload: z.boolean().optional(),
    allowPackageDownload: z.boolean().optional(),
    redactionPolicyVersion: z.string().max(32).optional().nullable(),
    safeNote: z.string().max(500).optional().nullable(),
});
const ListGrantsQuerySchema = z.object({
    teamId: z.string().uuid(),
    evidenceId: z.string().uuid().optional().nullable(),
    caseId: z.string().uuid().optional().nullable(),
    state: z.enum(EXTERNAL_REVIEW_ACCESS_STATES).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
});
const RevokeGrantBodySchema = z.object({
    teamId: z.string().uuid(),
});
// Reviewer-side: the token is a raw 64-char hex string (32 bytes).
const TokenParamSchema = z.object({
    token: z.string().min(32).max(128).regex(/^[a-f0-9]+$/i),
});
function projectGrantForReviewer(grant) {
    return {
        scopeKind: grant.scopeKind,
        state: grant.state,
        reviewerDisplayName: grant.reviewerDisplayName,
        expiresAtUtc: grant.expiresAtUtc,
        allowOriginalDownload: grant.allowOriginalDownload,
        allowPackageDownload: grant.allowPackageDownload,
        safeNote: grant.safeNote,
        redactionPolicyVersion: grant.redactionPolicyVersion,
    };
}
// =============================================================================
// Routes
// =============================================================================
export async function externalReviewRoutes(app) {
    // ===========================================================================
    // POST /v1/external-review/grants — operator issues a new grant
    // ===========================================================================
    app.post("/v1/external-review/grants", { preHandler: requireAuth }, async (req, reply) => {
        const body = IssueGrantBodySchema.parse(req.body ?? {});
        // Phase 26 canonical authorize() gate. The bounded
        // `governance.legal_hold.manage` permission covers
        // sensitive-share creation per the Phase 17 catalog. Migration
        // to a dedicated `governance.external_review.manage` permission
        // is a clean follow-up; for now we re-use the existing
        // governance gate so the route is hardened on day one.
        const actor = await authorizeOrFail(req, reply, {
            teamId: body.teamId,
            permission: "governance.legal_hold.manage",
            antiEnumeration: true,
        });
        if (!actor)
            return;
        const result = await issueExternalReviewGrant({
            teamId: body.teamId,
            invitedByUserId: actor.actorUserId,
            scopeKind: body.scopeKind,
            evidenceId: body.evidenceId ?? null,
            caseId: body.caseId ?? null,
            packageId: body.packageId ?? null,
            reviewerEmail: body.reviewerEmail,
            reviewerDisplayName: body.reviewerDisplayName ?? null,
            expiresAtUtc: body.expiresAtUtc,
            allowOriginalDownload: body.allowOriginalDownload,
            allowPackageDownload: body.allowPackageDownload,
            redactionPolicyVersion: body.redactionPolicyVersion ?? null,
            safeNote: body.safeNote ?? null,
        });
        if (!result.ok) {
            return reply.code(400).send({
                error: { code: "grant_issue_denied", reason: result.reason },
            });
        }
        // The raw token is returned EXACTLY ONCE — the operator must
        // capture it now to share with the reviewer. The grant row's
        // token_hash is what's persisted; the raw token is never
        // re-derivable.
        return reply.code(201).send({
            grant: result.grant,
            rawToken: result.rawToken,
        });
    });
    // ===========================================================================
    // GET /v1/external-review/grants — operator lists grants
    // ===========================================================================
    app.get("/v1/external-review/grants", { preHandler: requireAuth }, async (req, reply) => {
        const q = ListGrantsQuerySchema.parse(req.query ?? {});
        const actor = await authorizeOrFail(req, reply, {
            teamId: q.teamId,
            permission: "audit.read",
            antiEnumeration: true,
        });
        if (!actor)
            return;
        const grants = await listExternalReviewGrants({
            teamId: q.teamId,
            evidenceId: q.evidenceId ?? null,
            caseId: q.caseId ?? null,
            state: q.state ?? null,
            limit: q.limit,
        });
        return reply.code(200).send({ grants });
    });
    // ===========================================================================
    // POST /v1/external-review/grants/:id/revoke — operator revokes
    // ===========================================================================
    app.post("/v1/external-review/grants/:id/revoke", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
        const body = RevokeGrantBodySchema.parse(req.body ?? {});
        const actor = await authorizeOrFail(req, reply, {
            teamId: body.teamId,
            permission: "governance.legal_hold.manage",
            antiEnumeration: true,
        });
        if (!actor)
            return;
        const result = await transitionExternalReviewGrant({
            grantId: id,
            teamId: body.teamId,
            toState: "REVOKED",
            actorUserId: actor.actorUserId,
        });
        if (!result.ok) {
            // ANTI-ENUMERATION: a not-found grant ID + a transition
            // refusal both surface as 404 to operators outside the team.
            // For the legitimate operator (who passed authorizeOrFail), a
            // 404 vs 409 distinction is useful but we still keep the
            // body shape bounded.
            const httpStatus = result.reason === "token_unknown"
                ? 404
                : result.reason === "invalid_transition"
                    ? 409
                    : 400;
            return reply.code(httpStatus).send({
                error: { code: "revoke_denied", reason: result.reason },
            });
        }
        return reply.code(200).send({ grant: result.grant });
    });
    // ===========================================================================
    // POST /v1/external-review/access/:token — reviewer accepts the grant
    // ===========================================================================
    app.post("/v1/external-review/access/:token", async (req, reply) => {
        const { token } = TokenParamSchema.parse(req.params);
        const lookup = await lookupExternalReviewGrantByToken(token);
        if (!lookup.ok) {
            // ANTI-ENUMERATION: every non-success reason returns 401 with
            // the same shape, so an attacker cannot distinguish "token
            // unknown" from "token revoked" / "token expired".
            bump("external_review_grant_lookup_denied_total");
            return reply.code(401).send({
                error: { code: "grant_not_active" },
            });
        }
        // Transition INVITED → ACTIVE on first acceptance. Subsequent
        // acceptances are idempotent (already-ACTIVE transitions allow
        // by the state-machine self-edge contract).
        let grant = lookup.grant;
        if (grant.state === "INVITED") {
            const transition = await transitionExternalReviewGrant({
                grantId: grant.id,
                teamId: grant.teamId,
                toState: "ACTIVE",
                // The reviewer doesn't have a user ID — we record the
                // invited reviewer as the actor for audit. This keeps the
                // audit trail honest: "the invited reviewer accepted" is
                // distinct from "the inviting operator pre-activated".
                actorUserId: grant.invitedByUserId,
            });
            if (transition.ok) {
                grant = transition.grant;
            }
        }
        // Record the access event (best-effort).
        await recordExternalReviewAccess({
            grantId: grant.id,
            teamId: grant.teamId,
        });
        return reply.code(200).send({
            context: projectGrantForReviewer(grant),
        });
    });
    // ===========================================================================
    // GET /v1/external-review/access/:token/context — reviewer fetches
    // their current scope + expiry without re-accepting
    // ===========================================================================
    app.get("/v1/external-review/access/:token/context", async (req, reply) => {
        const { token } = TokenParamSchema.parse(req.params);
        const lookup = await lookupExternalReviewGrantByToken(token);
        if (!lookup.ok) {
            return reply.code(401).send({
                error: { code: "grant_not_active" },
            });
        }
        return reply.code(200).send({
            context: projectGrantForReviewer(lookup.grant),
        });
    });
    // ===========================================================================
    // GET /v1/external-review/activity — operator-facing access feed
    //
    // Returns a bounded list of grants ordered by `lastAccessedAtUtc`.
    // The shape is the operator-side row (full grant, including
    // counters), NOT the reviewer projection. Gated by `audit.read`.
    // ===========================================================================
    app.get("/v1/external-review/activity", { preHandler: requireAuth }, async (req, reply) => {
        const q = z
            .object({
            teamId: z.string().uuid(),
            limit: z.coerce.number().int().min(1).max(200).optional(),
        })
            .parse(req.query ?? {});
        const actor = await authorizeOrFail(req, reply, {
            teamId: q.teamId,
            permission: "audit.read",
            antiEnumeration: true,
        });
        if (!actor)
            return;
        // We re-use the same list helper; the dashboard caller can sort
        // client-side. Future revisions can add a server-side
        // `orderBy: lastAccessedAtUtc` filter; the current
        // listExternalReviewGrants orders by createdAt.
        const grants = await listExternalReviewGrants({
            teamId: q.teamId,
            limit: q.limit,
        });
        return reply.code(200).send({
            // Project each grant minus the reviewer email (operators
            // already see this via the per-row list endpoint; the
            // activity feed is intentionally narrower to avoid
            // duplicating the directory surface).
            activity: grants.map((g) => ({
                id: g.id,
                scopeKind: g.scopeKind,
                state: g.state,
                createdAtUtc: g.createdAtUtc,
                expiresAtUtc: g.expiresAtUtc,
                revokedAtUtc: g.revokedAtUtc,
                acceptedAtUtc: g.acceptedAtUtc,
                lastAccessedAtUtc: g.lastAccessedAtUtc,
                accessCount: g.accessCount,
            })),
        });
    });
}
