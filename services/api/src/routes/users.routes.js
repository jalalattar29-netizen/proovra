import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { getUserLegalAcceptanceStatus, recordLegalAcceptances } from "../services/legal-acceptance.service.js";
// Final-D5-PT2 — legacy session/password helpers retired (see bottom of
// file). The canonical surface lives in `identity-security.routes.ts`,
// backed by `email-password-auth.service.ts::changePasswordForUser` and
// the session-revocation services.
import { safeEmitSecurityEvent } from "../services/security/security-event.service.js";
const LegalAcceptanceBody = z.object({
    source: z.string().min(1).max(64).optional(),
    acceptances: z
        .array(z.object({
        policyKey: z.string().min(1).max(64),
        policyVersion: z.string().min(1).max(32),
    }))
        .min(1),
});
const CookieConsentBody = z.object({
    consentVersion: z.string().min(1).max(32),
    necessary: z.boolean().optional(),
    preferences: z.boolean().optional(),
    analytics: z.boolean().optional(),
    marketing: z.boolean().optional(),
});
function pickMe(u) {
    return {
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        firstName: u.firstName,
        lastName: u.lastName,
        avatarUrl: u.avatarUrl,
        locale: u.locale,
        timezone: u.timezone,
        country: u.country,
        bio: u.bio,
        provider: u.provider,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
        // Hotfix — the web app (reviewer-ops, governance, intake-links, and
        // every "operator console" page) reads
        // `response.user.currentWorkspaceId` to scope its API calls. The
        // field was previously dropped here, so those pages saw
        // `currentWorkspaceId === undefined` and rendered the
        // "Switch to a workspace" empty state EVEN WHEN the user had an
        // active workspace selected on the server. /home didn't depend on
        // this field (it uses session-scoped queries directly) so the
        // regression only manifested on consoles. The User model already
        // stores the value (`User.currentWorkspaceId @map("current_workspace_id")`).
        // Returning `null` when the user has no workspace is the right
        // semantic; that lets the canonical "no workspace" message fire
        // only when it's actually true.
        currentWorkspaceId: u.currentWorkspaceId ?? null,
        ...(u.platformRole === "admin" ? { role: "admin" } : {}),
    };
}
function readUserAgent(req) {
    const ua = req.headers["user-agent"];
    return Array.isArray(ua) ? ua[0] ?? null : ua ?? null;
}
export async function usersRoutes(app) {
    app.get("/v1/users/me", { preHandler: requireAuth }, async (req) => {
        const userId = req.user.sub;
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user)
            return { user: null };
        return { user: pickMe(user) };
    });
    app.patch("/v1/users/me", { preHandler: requireAuth }, async (req) => {
        const userId = req.user.sub;
        const body = (req.body ?? {});
        const data = {};
        const setStr = (key, max) => {
            const v = body[key];
            if (typeof v === "string")
                data[key] = v.trim().slice(0, max);
            if (v === null)
                data[key] = null;
        };
        setStr("displayName", 120);
        setStr("firstName", 80);
        setStr("lastName", 80);
        setStr("avatarUrl", 512);
        setStr("locale", 12);
        setStr("timezone", 64);
        if (typeof body.country === "string") {
            const trimmed = body.country.trim();
            data.country = trimmed.length > 0 ? trimmed.slice(0, 120) : null;
        }
        else if (body.country === null) {
            data.country = null;
        }
        if (typeof body.bio === "string")
            data.bio = body.bio.trim().slice(0, 280);
        if (body.bio === null)
            data.bio = null;
        const updated = await prisma.user.update({
            where: { id: userId },
            data,
        });
        return { user: pickMe(updated) };
    });
    app.get("/v1/users/legal-status", { preHandler: requireAuth }, async (req) => {
        const userId = req.user.sub;
        const status = await getUserLegalAcceptanceStatus({ userId });
        return {
            ok: status.ok,
            requiresReacceptance: status.requiresReacceptance,
            missingPolicies: status.missingPolicies,
            acceptedVersions: status.acceptedVersions,
            requiredVersions: status.requiredVersions,
        };
    });
    app.get("/v1/users/legal-acceptance", { preHandler: requireAuth }, async (req) => {
        const userId = req.user.sub;
        const items = await prisma.userLegalAcceptance.findMany({
            where: { userId },
            orderBy: { acceptedAt: "desc" },
            select: {
                id: true,
                policyKey: true,
                policyVersion: true,
                acceptedAt: true,
                source: true,
            },
        });
        return { items };
    });
    app.post("/v1/users/legal-acceptance", { preHandler: requireAuth }, async (req) => {
        const userId = req.user.sub;
        const body = LegalAcceptanceBody.parse(req.body);
        await recordLegalAcceptances({
            userId,
            acceptances: body.acceptances,
            source: body.source ?? "web",
            req,
        });
        const items = await prisma.userLegalAcceptance.findMany({
            where: { userId },
            orderBy: { acceptedAt: "desc" },
            select: {
                id: true,
                policyKey: true,
                policyVersion: true,
                acceptedAt: true,
                source: true,
            },
        });
        return { ok: true, items };
    });
    app.get("/v1/users/cookie-consent/latest", { preHandler: requireAuth }, async (req) => {
        const userId = req.user.sub;
        const latest = await prisma.cookieConsentRecord.findFirst({
            where: { userId },
            orderBy: { createdAt: "desc" },
        });
        return {
            record: latest
                ? {
                    id: latest.id,
                    consentVersion: latest.consentVersion,
                    necessary: latest.necessary,
                    preferences: latest.preferences,
                    analytics: latest.analytics,
                    marketing: latest.marketing,
                    createdAt: latest.createdAt,
                    updatedAt: latest.updatedAt,
                }
                : null,
        };
    });
    app.post("/v1/users/cookie-consent", { preHandler: requireAuth }, async (req) => {
        const userId = req.user.sub;
        const body = CookieConsentBody.parse(req.body);
        const created = await prisma.cookieConsentRecord.create({
            data: {
                userId,
                consentVersion: body.consentVersion,
                necessary: body.necessary ?? true,
                preferences: body.preferences ?? false,
                analytics: body.analytics ?? false,
                marketing: body.marketing ?? false,
                source: "web",
                ipAddress: req.ip ?? null,
                userAgent: readUserAgent(req) ?? null,
            },
        });
        return {
            ok: true,
            record: {
                id: created.id,
                consentVersion: created.consentVersion,
                necessary: created.necessary,
                preferences: created.preferences,
                analytics: created.analytics,
                marketing: created.marketing,
                createdAt: created.createdAt,
                updatedAt: created.updatedAt,
            },
        };
    });
    // ===========================================================================
    // Phase Final-D5-PT2 — Legacy personal-security surface RETIRED.
    //
    // The three endpoints below used to live here:
    //
    //   GET    /v1/users/me/sessions
    //   DELETE /v1/users/me/sessions/:id
    //   POST   /v1/users/me/password/change
    //
    // They were a parallel implementation alongside the canonical Phase 19
    // identity-security surface:
    //
    //   GET    /v1/identity-security/my-sessions
    //   POST   /v1/identity-security/my-sessions/revoke-others
    //   POST   /v1/identity-security/sessions/revoke  (operator)
    //   POST   /v1/identity-security/password
    //
    // The Final-D5 closure (this session) shipped the canonical surface
    // and a real Security Center UI. Leaving the legacy endpoints alive
    // left two ways for a caller to mutate the same auth state — the same
    // parallel-surface security finding-shape that justified the A-3
    // retirement of `/v1/api-keys*`. So they are now retired:
    //
    //   - All three handlers return HTTP 410 Gone with
    //     `code: "PERSONAL_SECURITY_LEGACY_RETIRED"`.
    //   - Each retired call emits a security event so SOC sees attempted
    //     use and can spot stuck FE callers.
    //   - Callers are redirected to `/v1/identity-security/*` via the
    //     `canonicalSurface` payload field.
    //
    // The legacy `AccountSecurityCard.tsx` (which was the only FE caller)
    // is deleted in the same phase; `/settings/security/page.tsx` now
    // links to `/security-center` instead.
    // ===========================================================================
    const LEGACY_RETIRED_BODY = {
        code: "PERSONAL_SECURITY_LEGACY_RETIRED",
        detail: "The legacy /v1/users/me personal-security surface has been retired. " +
            "Use /v1/identity-security/* (canonical Security Center surface). " +
            "See docs/operations/audit-closure-ledger.md → D-5 / Final-D5-PT2.",
        canonicalPassword: "/v1/identity-security/password",
        canonicalSessionsList: "/v1/identity-security/my-sessions",
        canonicalSessionsRevokeOthers: "/v1/identity-security/my-sessions/revoke-others",
    };
    function emitPersonalSecurityLegacyEvent(req, legacyAction) {
        const userId = req?.user?.sub ?? null;
        // Re-use the existing `high_risk_action_blocked` taxonomy: a call
        // to a retired auth-mutation endpoint IS a high-risk action that
        // we are blocking. The `details.reason` field discriminates this
        // case from other high-risk blocks for SOC + audit.
        safeEmitSecurityEvent({
            teamId: null,
            eventType: "high_risk_action_blocked",
            severity: "WARNING",
            details: {
                actorUserId: userId,
                reason: "personal_security_legacy_endpoint_called",
                legacyAction,
                method: req.method,
                canonicalSurface: "/v1/identity-security/*",
            },
        });
    }
    app.get("/v1/users/me/sessions", { preHandler: requireAuth }, async (req, reply) => {
        emitPersonalSecurityLegacyEvent(req, "sessions_list");
        return reply.code(410).send(LEGACY_RETIRED_BODY);
    });
    app.delete("/v1/users/me/sessions/:id", { preHandler: requireAuth }, async (req, reply) => {
        emitPersonalSecurityLegacyEvent(req, "session_revoke");
        return reply.code(410).send(LEGACY_RETIRED_BODY);
    });
    app.post("/v1/users/me/password/change", { preHandler: requireAuth }, async (req, reply) => {
        emitPersonalSecurityLegacyEvent(req, "password_change");
        return reply.code(410).send(LEGACY_RETIRED_BODY);
    });
}
