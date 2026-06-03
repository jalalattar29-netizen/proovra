/**
 * Phase 8.5 — Authenticated notification admin routes.
 *
 *   GET   /v1/notifications/deliveries                — list (workspace-scoped, filtered)
 *   GET   /v1/notifications/deliveries/:id            — fetch one
 *   POST  /v1/notifications/deliveries/:id/resend     — manual resend
 *   POST  /v1/notifications/process-retries           — admin trigger for the sweeper
 *   POST  /v1/notifications/run-reminders             — admin trigger for reminders
 *
 * All routes require authentication AND workspace membership. The list /
 * get / resend routes scope to the caller's workspace via the request's
 * teamId. Process-retries and run-reminders are workspace-agnostic but
 * still require auth — they are designed to be called by a cron job or
 * platform admin and act on every team's eligible rows.
 */
import { z } from "zod";
import { NOTIFICATION_CHANNELS, NOTIFICATION_DELIVERY_STATUSES, NOTIFICATION_EVENT_TYPES, NOTIFICATION_PROVIDERS, } from "@proovra/shared";
import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireNotificationCronSecret } from "../middleware/cron-secret.js";
import { getNotificationDelivery, listNotificationDeliveries, processDueNotificationRetries, projectNotificationDelivery, resendNotificationDelivery, } from "../services/notifications/index.js";
import { runReminderScheduler } from "../services/notifications/reminder-scheduler.js";
const ParamsId = z.object({ id: z.string().uuid() });
async function requireMember(req, reply, teamId) {
    const userId = getAuthUserId(req);
    const membership = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId, userId } },
    });
    if (!membership) {
        reply.code(403).send({ message: "Not a member of the workspace" });
        return null;
    }
    return { userId };
}
export async function notificationsRoutes(app) {
    // GET /v1/notifications/deliveries
    app.get("/v1/notifications/deliveries", { preHandler: requireAuth }, async (req, reply) => {
        const query = z
            .object({
            teamId: z.string().uuid(),
            evidenceRequestId: z.string().uuid().optional(),
            status: z.enum(NOTIFICATION_DELIVERY_STATUSES).optional(),
            eventType: z.enum(NOTIFICATION_EVENT_TYPES).optional(),
            recipient: z.string().max(512).optional(),
            channel: z.enum(NOTIFICATION_CHANNELS).optional(),
            provider: z.enum(NOTIFICATION_PROVIDERS).optional(),
            createdAfter: z.string().datetime().optional(),
            createdBefore: z.string().datetime().optional(),
            limit: z.coerce.number().int().min(1).max(200).optional(),
            maskRecipient: z.union([z.literal("true"), z.literal("false")]).optional(),
        })
            .parse(req.query ?? {});
        const ok = await requireMember(req, reply, query.teamId);
        if (!ok)
            return;
        const rows = await listNotificationDeliveries({
            teamId: query.teamId,
            evidenceRequestId: query.evidenceRequestId,
            status: query.status,
            eventType: query.eventType,
            recipient: query.recipient,
            channel: query.channel,
            provider: query.provider,
            createdAfter: query.createdAfter
                ? new Date(query.createdAfter)
                : undefined,
            createdBefore: query.createdBefore
                ? new Date(query.createdBefore)
                : undefined,
            limit: query.limit,
        });
        const mask = query.maskRecipient === "true";
        return reply.code(200).send({
            deliveries: rows.map((r) => projectNotificationDelivery(r, { maskRecipient: mask })),
        });
    });
    // GET /v1/notifications/deliveries/:id
    app.get("/v1/notifications/deliveries/:id", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const query = z
            .object({ teamId: z.string().uuid() })
            .parse(req.query ?? {});
        const ok = await requireMember(req, reply, query.teamId);
        if (!ok)
            return;
        const row = await getNotificationDelivery(id, query.teamId);
        if (!row) {
            return reply.code(404).send({ error: { code: "not_found" } });
        }
        return reply
            .code(200)
            .send({ delivery: projectNotificationDelivery(row) });
    });
    // POST /v1/notifications/deliveries/:id/resend
    app.post("/v1/notifications/deliveries/:id/resend", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const body = z
            .object({
            teamId: z.string().uuid(),
            force: z.boolean().optional(),
        })
            .parse(req.body ?? {});
        const ok = await requireMember(req, reply, body.teamId);
        if (!ok)
            return;
        const result = await resendNotificationDelivery({
            id,
            teamId: body.teamId,
            actorUserId: ok.userId,
            force: body.force ?? false,
        });
        switch (result.outcome) {
            case "resent":
                return reply.code(200).send({
                    delivery: result.delivery
                        ? projectNotificationDelivery(result.delivery)
                        : null,
                    outcome: result.outcome,
                });
            case "blocked_already_sent":
                return reply.code(409).send({ error: { code: result.outcome } });
            case "not_found":
                return reply.code(404).send({ error: { code: result.outcome } });
            case "skipped_terminal":
                return reply.code(409).send({ error: { code: result.outcome } });
            case "failed_to_dispatch":
                // The row exists; the resend attempt failed. Surface 200 with
                // the (failed) projection so the operator sees the new state.
                return reply.code(200).send({
                    delivery: result.delivery
                        ? projectNotificationDelivery(result.delivery)
                        : null,
                    outcome: result.outcome,
                });
        }
    });
    // POST /v1/notifications/process-retries
    //
    // Workspace-agnostic admin trigger for the retry sweeper. Designed to
    // be called by an external scheduler (cron / k8s CronJob / Vercel
    // cron). Auth ensures only an authenticated workspace member can
    // invoke it (we deliberately do not gate on a single platform-admin
    // role because the sweep is idempotent and safe to call repeatedly).
    app.post("/v1/notifications/process-retries", async (req, reply) => {
        // Phase 10 — cron secret protection. The auth handler runs inside
        // the secret check so the fallback non-production path can require
        // OWNER/ADMIN.
        const ok = await requireNotificationCronSecret(req, reply);
        if (!ok)
            return;
        const body = z
            .object({ batchSize: z.number().int().min(1).max(500).optional() })
            .parse(req.body ?? {});
        const summary = await processDueNotificationRetries({
            batchSize: body.batchSize,
        });
        return reply.code(200).send({ summary });
    });
    // POST /v1/notifications/run-reminders
    app.post("/v1/notifications/run-reminders", async (req, reply) => {
        const ok = await requireNotificationCronSecret(req, reply);
        if (!ok)
            return;
        const body = z
            .object({ batchSize: z.number().int().min(1).max(500).optional() })
            .parse(req.body ?? {});
        const summary = await runReminderScheduler({
            batchSize: body.batchSize,
        });
        return reply.code(200).send({ summary });
    });
}
