/**
 * Phase G3.1 — Operator notification preferences routes.
 *
 *   GET /v1/me/notification-preferences?teamId=...
 *   PUT /v1/me/notification-preferences
 *
 * Per-(user, workspace, type, channel) toggle list + upsert. The
 * route layer enforces workspace membership; the service layer
 * performs the bounded enum check + persistence.
 *
 * Hard rules:
 *   * Read + write are caller-scoped — the userId is always
 *     `getAuthUserId(req)`. Operators cannot set another user's
 *     preferences.
 *   * Workspace membership gate via `requireMember(teamId)` — 404
 *     for non-members (anti-enumeration).
 *   * Bounded vocabulary via Zod schema. Anything outside the
 *     `NOTIFICATION_PREFERENCE_TYPES` / `NOTIFICATION_PREFERENCE_CHANNELS`
 *     enums is rejected.
 *   * Audit-friendly: every PUT emits a bounded security event so
 *     governance admins can review unusual disable patterns. Reads
 *     emit no audit.
 */
import { z } from "zod";
import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { NOTIFICATION_PREFERENCE_CHANNELS, NOTIFICATION_PREFERENCE_TYPES, listNotificationPreferences, upsertNotificationPreference, } from "../services/notifications/notification-preferences.service.js";
import { safeEmitSecurityEvent } from "../services/security/security-event.service.js";
async function requireMember(req, reply, teamId) {
    const userId = getAuthUserId(req);
    const membership = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId, userId } },
    });
    if (!membership) {
        reply.code(404).send({ error: { code: "not_found" } });
        return null;
    }
    return { userId };
}
const PreferenceTypeSchema = z.enum(NOTIFICATION_PREFERENCE_TYPES);
const PreferenceChannelSchema = z.enum(NOTIFICATION_PREFERENCE_CHANNELS);
const PutBody = z.object({
    teamId: z.string().uuid(),
    preferenceType: PreferenceTypeSchema,
    channel: PreferenceChannelSchema,
    enabled: z.boolean(),
});
export async function notificationPreferencesRoutes(app) {
    // ---------------------------------------------------------------------
    // GET /v1/me/notification-preferences?teamId=...
    //
    // Returns the caller's explicit preference rows for the workspace,
    // plus the bounded vocabulary (so the UI can render all 7 toggles
    // even when no row exists yet).
    // ---------------------------------------------------------------------
    app.get("/v1/me/notification-preferences", { preHandler: requireAuth }, async (req, reply) => {
        const query = z
            .object({ teamId: z.string().uuid() })
            .parse(req.query ?? {});
        const ok = await requireMember(req, reply, query.teamId);
        if (!ok)
            return;
        const preferences = await listNotificationPreferences({
            userId: ok.userId,
            teamId: query.teamId,
        });
        return reply.code(200).send({
            teamId: query.teamId,
            preferences,
            catalog: {
                preferenceTypes: NOTIFICATION_PREFERENCE_TYPES,
                channels: NOTIFICATION_PREFERENCE_CHANNELS,
                // The defaults the absence of a row implies. Surfaced so
                // the UI doesn't need to duplicate the defaultEnabledForChannel
                // logic.
                defaults: {
                    IN_APP: true,
                    EMAIL: false,
                },
            },
        });
    });
    // ---------------------------------------------------------------------
    // PUT /v1/me/notification-preferences
    //
    // Upserts a single preference toggle. The route enforces workspace
    // membership; the service enforces bounded vocabulary.
    // ---------------------------------------------------------------------
    app.put("/v1/me/notification-preferences", { preHandler: requireAuth }, async (req, reply) => {
        const body = PutBody.parse(req.body ?? {});
        const ok = await requireMember(req, reply, body.teamId);
        if (!ok)
            return;
        const result = await upsertNotificationPreference({
            userId: ok.userId,
            teamId: body.teamId,
            preferenceType: body.preferenceType,
            channel: body.channel,
            enabled: body.enabled,
        });
        // Audit emission — bounded, no PII. Governance admins can
        // notice unusual disable patterns (e.g. a reviewer disabling
        // ESCALATION emails right before an incident).
        safeEmitSecurityEvent({
            teamId: body.teamId,
            eventType: "notification_preference_updated",
            severity: "INFO",
            details: {
                preferenceType: body.preferenceType,
                channel: body.channel,
                enabled: body.enabled,
            },
        });
        return reply.code(200).send({ preference: result });
    });
}
