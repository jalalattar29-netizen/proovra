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

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_DELIVERY_STATUSES,
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_PROVIDERS,
} from "@proovra/shared";

import { prisma } from "../db.js";
import { authorizeOrFail } from "../middleware/authorize.js";
import { requireAuth } from "../middleware/auth.js";
import { requireNotificationCronSecret } from "../middleware/cron-secret.js";
import {
  getNotificationDelivery,
  listNotificationDeliveries,
  processDueNotificationRetries,
  projectNotificationDelivery,
  resendNotificationDelivery,
} from "../services/notifications/index.js";
import { resolveRecipientContactDisclosure } from "../services/privacy/recipient-contact-disclosure.js";
import { safeEmitSecurityEvent } from "../services/security/security-event.service.js";
import { runReminderScheduler } from "../services/notifications/reminder-scheduler.js";
import { runDigestScheduler } from "../services/notifications/digest-scheduler.js";

const ParamsId = z.object({ id: z.string().uuid() });

/**
 * The outbound delivery log is an ORGANIZATION OPERATIONS/ADMIN
 * debugging surface (raw recipients, provider error text, retry
 * controls, cron diagnostics). Access requires BOTH:
 *   1. an ORGANIZATION workspace — Personal users get contextual
 *      delivery status inside the originating workflow (evidence
 *      request / intake), never the global log; owning a personal
 *      workspace is deliberately NOT sufficient authorization, and
 *   2. workspace OWNER or ADMIN role.
 */
async function requireMember(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<{ userId: string } | null> {
  // PHASE 1 AUTHORIZATION CLOSURE (2026-07-21) — canonical authorization
  // (ACTIVE membership + org lifecycle + notification.delivery.read + fail-
  // closed + anti-enumeration) BEFORE the surface-specific business rules
  // below (org-only + OWNER/ADMIN). The informational read then enforces
  // those rules.
  const outcome = await authorizeOrFail(req, reply, {
    teamId,
    permission: "notification.delivery.read",
    antiEnumeration: true,
  });
  if (!outcome) return null;
  const userId = outcome.actorUserId;
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { role: true, team: { select: { isPersonal: true } } },
  });
  if (!membership) {
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  if (membership.team?.isPersonal === true) {
    reply.code(403).send({
      message:
        "The delivery log is an organization operations surface. Delivery status for your own workflows appears on the originating request.",
    });
    return null;
  }
  if (membership.role !== "OWNER" && membership.role !== "ADMIN") {
    reply.code(403).send({
      message:
        "The notification delivery log is limited to workspace owners and admins.",
    });
    return null;
  }
  return { userId };
}

export async function notificationsRoutes(app: FastifyInstance) {
  // GET /v1/notifications/deliveries
  app.get(
    "/v1/notifications/deliveries",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
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
        })
        .parse(req.query ?? {});

      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;

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

      /*
       * The client used to choose this with `?maskRecipient=true`, which
       * meant raw addresses by default for anyone who did not opt in. The
       * server decides now, through the same recipient-contact authority the
       * intake surfaces use — this log carries External Intake recipients
       * among others, and one data class cannot have two rules.
       */
      const disclosure = await resolveRecipientContactDisclosure(req, {
        teamId: query.teamId,
      });
      /*
       * This log EXISTS to show raw recipients — it is the org's outbound
       * delivery debugging surface — so a REVEALED caller still gets them.
       * What changed is that the disclosure is recorded, the same way the
       * per-link reveal is. One event per request, not per row: the operator
       * opened the log once, and a hundred rows is one act.
       *
       * Nothing is recorded when the read disclosed nothing, so an empty log
       * or a masked read does not manufacture audit noise.
       */
      if (disclosure === "REVEALED" && rows.length > 0) {
        safeEmitSecurityEvent({
          teamId: query.teamId,
          eventType: "workflow_intake_recipient_contact_revealed",
          severity: "WARNING",
          details: {
            actorUserId: ok.userId,
            surface: "notification_delivery_log",
            disclosureType: "recipient_contact",
            deliveryCount: rows.length,
            intakeLinkCount: rows.filter((r) => r.intakeLinkId).length,
          },
        });
      }

      return reply.code(200).send({
        deliveries: rows.map((r) =>
          projectNotificationDelivery(r, { disclosure }),
        ),
      });
    },
  );

  // GET /v1/notifications/deliveries/:id
  app.get(
    "/v1/notifications/deliveries/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const query = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;

      const row = await getNotificationDelivery(id, query.teamId);
      if (!row) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      const disclosure = await resolveRecipientContactDisclosure(req, {
        teamId: query.teamId,
      });
      if (disclosure === "REVEALED") {
        safeEmitSecurityEvent({
          teamId: query.teamId,
          eventType: "workflow_intake_recipient_contact_revealed",
          severity: "WARNING",
          details: {
            actorUserId: ok.userId,
            surface: "notification_delivery_detail",
            disclosureType: "recipient_contact",
            deliveryId: row.id,
            intakeLinkId: row.intakeLinkId,
          },
        });
      }
      return reply
        .code(200)
        .send({ delivery: projectNotificationDelivery(row, { disclosure }) });
    },
  );

  // POST /v1/notifications/deliveries/:id/resend
  app.post(
    "/v1/notifications/deliveries/:id/resend",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          force: z.boolean().optional(),
        })
        .parse(req.body ?? {});

      const ok = await requireMember(req, reply, body.teamId);
      if (!ok) return;

      const result = await resendNotificationDelivery({
        id,
        teamId: body.teamId,
        actorUserId: ok.userId,
        force: body.force ?? false,
      });

      // Same decision as the read surfaces, so an operator does not see the
      // recipient one way on the detail and another way after a resend.
      const disclosure = await resolveRecipientContactDisclosure(req, {
        teamId: body.teamId,
      });

      switch (result.outcome) {
        case "resent":
          return reply.code(200).send({
            delivery: result.delivery
              ? projectNotificationDelivery(result.delivery, { disclosure })
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
              ? projectNotificationDelivery(result.delivery, { disclosure })
              : null,
            outcome: result.outcome,
          });
      }
    },
  );

  // POST /v1/notifications/process-retries
  //
  // Workspace-agnostic admin trigger for the retry sweeper. Designed to
  // be called by an external scheduler (cron / k8s CronJob / Vercel
  // cron). Auth ensures only an authenticated workspace member can
  // invoke it (we deliberately do not gate on a single platform-admin
  // role because the sweep is idempotent and safe to call repeatedly).
  app.post(
    "/v1/notifications/process-retries",
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Phase 10 — cron secret protection. The auth handler runs inside
      // the secret check so the fallback non-production path can require
      // OWNER/ADMIN.
      const ok = await requireNotificationCronSecret(req, reply);
      if (!ok) return;
      const body = z
        .object({ batchSize: z.number().int().min(1).max(500).optional() })
        .parse(req.body ?? {});
      const summary = await processDueNotificationRetries({
        batchSize: body.batchSize,
      });
      return reply.code(200).send({ summary });
    },
  );

  // POST /v1/notifications/run-reminders
  app.post(
    "/v1/notifications/run-reminders",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ok = await requireNotificationCronSecret(req, reply);
      if (!ok) return;
      const body = z
        .object({ batchSize: z.number().int().min(1).max(500).optional() })
        .parse(req.body ?? {});
      const summary = await runReminderScheduler({
        batchSize: body.batchSize,
      });
      return reply.code(200).send({ summary });
    },
  );

  // POST /v1/notifications/run-digests
  //
  // Operations Center digest scheduler (hourly/daily/weekly email
  // digests per user preference, quiet-hours + timezone aware,
  // idempotent per bucket). Same cron-secret trigger pattern as
  // run-reminders — no second worker architecture.
  app.post(
    "/v1/notifications/run-digests",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ok = await requireNotificationCronSecret(req, reply);
      if (!ok) return;
      const body = z
        .object({ maxGroups: z.number().int().min(1).max(2000).optional() })
        .parse(req.body ?? {});
      const summary = await runDigestScheduler({
        maxGroups: body.maxGroups,
      });
      // Migration-order safety — a refused run (schedule schema not
      // provisioned) is an operator-visible 503, not a fake success.
      if (summary.unavailableReason) {
        return reply.code(503).send({
          error: {
            code: "digest_unavailable",
            reason: summary.unavailableReason,
          },
          summary,
        });
      }
      return reply.code(200).send({ summary });
    },
  );
}
