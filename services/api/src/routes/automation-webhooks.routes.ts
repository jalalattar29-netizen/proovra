/**
 * Phase E3.2 — Webhook destination + delivery routes.
 *
 *   GET    /v1/automation/webhooks?teamId=                  — list destinations
 *   POST   /v1/automation/webhooks                          — create destination
 *   PATCH  /v1/automation/webhooks/:id                      — update destination
 *   POST   /v1/automation/webhooks/:id/enable               — enable
 *   POST   /v1/automation/webhooks/:id/disable              — disable
 *   POST   /v1/automation/webhooks/:id/rotate-secret        — rotate signing secret
 *   GET    /v1/automation/webhook-deliveries?teamId=        — list deliveries
 *
 * Hard rules:
 *   - Every endpoint requires authentication + team membership.
 *   - VIEW endpoints require `AUTOMATION_VIEW`; MANAGE endpoints require
 *     `AUTOMATION_MANAGE` (reuses the E3 capability set).
 *   - URL is validated at create + update (HTTPS-only + SSRF blocklist).
 *   - The webhook signing secret is returned EXACTLY ONCE: by
 *     POST /v1/automation/webhooks (create) and POST /v1/automation/
 *     webhooks/:id/rotate-secret. No other endpoint returns it.
 *   - Audit emission for create/update/disable/rotate.
 *   - Per-team destination cap enforced (WEBHOOK_MAX_DESTINATIONS_PER_TEAM).
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";

import { authorizeOrFail } from "../middleware/authorize.js";
import type { Permission } from "@proovra/shared";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { safeEmitSecurityEvent } from "../services/security/security-event.service.js";
import {
  createDestinationSecret,
  validateDestinationUrlStatic,
  WEBHOOK_MAX_DESTINATIONS_PER_TEAM,
} from "../services/automation/automation-webhook.service.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ParamsId = z.object({ id: z.string().uuid() });
const TeamIdQuery = z.object({ teamId: z.string().uuid() });

const CreateBody = z.object({
  teamId: z.string().uuid(),
  name: z.string().min(1).max(120),
  url: z.string().min(8).max(600),
});

const UpdateBody = z.object({
  name: z.string().min(1).max(120).optional(),
  url: z.string().min(8).max(600).optional(),
});

const ListDeliveriesQuery = z.object({
  teamId: z.string().uuid(),
  destinationId: z.string().uuid().optional(),
  status: z
    .enum(["PENDING", "DELIVERING", "SUCCEEDED", "FAILED", "SKIPPED"])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

type Capability = "AUTOMATION_VIEW" | "AUTOMATION_MANAGE";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// PHASE 1 AUTHORIZATION CLOSURE (2026-07-21) — automation webhooks are an
// integration/config surface; both viewing and managing them map to the
// canonical `integration.webhook.manage` capability (held by OWNER + ADMIN).
const CAPABILITY_TO_PERMISSION: Record<Capability, Permission> = {
  AUTOMATION_VIEW: "integration.webhook.manage",
  AUTOMATION_MANAGE: "integration.webhook.manage",
};

/**
 * PHASE 1 AUTHORIZATION CLOSURE (2026-07-21) — canonical authorization.
 * Routes through authorizeOrFail (ACTIVE membership + org lifecycle +
 * capability + fail-closed + anti-enumeration 404). REPLACES the former
 * `resolveCapabilities({ isPlatformAdmin })` path — a platform admin now has
 * NO special standing; they must be an ACTIVE member holding the capability.
 */
async function requireTeamCapability(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
  capability: Capability,
): Promise<{ userId: string } | null> {
  const outcome = await authorizeOrFail(req, reply, {
    teamId,
    permission: CAPABILITY_TO_PERMISSION[capability],
    antiEnumeration: true,
  });
  return outcome ? { userId: outcome.actorUserId } : null;
}

/**
 * Project a webhook destination row to the public shape. The secret
 * is NEVER returned by this function — the plaintext is only ever
 * returned by `createDestination` / `rotateSecret` via the one-time
 * `revealedSecret` field.
 */
function projectDestination(row: {
  id: string;
  teamId: string;
  name: string;
  url: string;
  urlOrigin: string;
  secretFingerprint: string;
  enabled: boolean;
  createdByUserId: string;
  updatedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
  disabledAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  failureCount: number;
}): Record<string, unknown> {
  return {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    url: row.url,
    urlOrigin: row.urlOrigin,
    secretFingerprint: row.secretFingerprint,
    enabled: row.enabled,
    createdByUserId: row.createdByUserId,
    updatedByUserId: row.updatedByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    disabledAt: row.disabledAt?.toISOString() ?? null,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastFailureAt: row.lastFailureAt?.toISOString() ?? null,
    failureCount: row.failureCount,
  };
}

function projectDelivery(row: {
  id: string;
  teamId: string;
  runId: string;
  destinationId: string;
  status: string;
  attemptCount: number;
  responseStatus: number;
  failureReason: string | null;
  lastAttemptAt: Date | null;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    id: row.id,
    teamId: row.teamId,
    runId: row.runId,
    destinationId: row.destinationId,
    status: row.status,
    attemptCount: row.attemptCount,
    responseStatus: row.responseStatus,
    failureReason: row.failureReason,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function automationWebhooksRoutes(
  app: FastifyInstance,
): Promise<void> {
  // -----------------------------------------------------------------
  // GET /v1/automation/webhooks?teamId=
  // -----------------------------------------------------------------
  app.get(
    "/v1/automation/webhooks",
    { preHandler: requireAuth },
    async (req, reply) => {
      const q = TeamIdQuery.safeParse(req.query);
      if (!q.success) {
        return reply
          .code(400)
          .send({ message: "Invalid query", issues: q.error.issues });
      }
      const member = await requireTeamCapability(
        req,
        reply,
        q.data.teamId,
        "AUTOMATION_VIEW",
      );
      if (!member) return;
      const rows = await prisma.automationWebhookDestination.findMany({
        where: { teamId: q.data.teamId },
        orderBy: [{ enabled: "desc" }, { updatedAt: "desc" }],
      });
      reply.send({
        destinations: rows.map(projectDestination),
        limits: {
          maxDestinationsPerTeam: WEBHOOK_MAX_DESTINATIONS_PER_TEAM,
        },
      });
    },
  );

  // -----------------------------------------------------------------
  // POST /v1/automation/webhooks
  // -----------------------------------------------------------------
  app.post(
    "/v1/automation/webhooks",
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = CreateBody.safeParse(req.body);
      if (!body.success) {
        return reply
          .code(400)
          .send({ message: "Invalid body", issues: body.error.issues });
      }
      const member = await requireTeamCapability(
        req,
        reply,
        body.data.teamId,
        "AUTOMATION_MANAGE",
      );
      if (!member) return;

      // URL validation: HTTPS + SSRF blocklist (static checks; DNS
      // rebinding defence happens again at delivery time).
      const urlCheck = validateDestinationUrlStatic(body.data.url);
      if (!urlCheck.ok) {
        return reply.code(400).send({
          message: "Invalid destination URL",
          error: { code: "url_rejected", reason: urlCheck.reason },
        });
      }

      // Per-team destination cap.
      const existing = await prisma.automationWebhookDestination.count({
        where: { teamId: body.data.teamId },
      });
      if (existing >= WEBHOOK_MAX_DESTINATIONS_PER_TEAM) {
        return reply.code(409).send({
          message: "Destination limit reached for workspace",
          error: {
            code: "destination_limit",
            limit: WEBHOOK_MAX_DESTINATIONS_PER_TEAM,
          },
        });
      }

      // Generate one-time secret.
      const secret = createDestinationSecret();

      let created;
      try {
        created = await prisma.automationWebhookDestination.create({
          data: {
            teamId: body.data.teamId,
            name: body.data.name,
            url: body.data.url,
            urlOrigin: urlCheck.origin,
            encryptedSecret: secret.storedEnvelope,
            secretFingerprint: secret.fingerprint,
            enabled: false, // always created disabled (operator must explicitly enable)
            createdByUserId: member.userId,
            updatedByUserId: member.userId,
          },
        });
      } catch (err) {
        const e = err as { code?: string };
        if (e?.code === "P2002") {
          return reply.code(409).send({
            message: "Destination already exists for this origin",
            error: { code: "destination_origin_conflict" },
          });
        }
        throw err;
      }

      safeEmitSecurityEvent({
        teamId: body.data.teamId,
        eventType: "automation_webhook_destination_created",
        severity: "INFO",
        details: {
          destinationId: created.id,
          urlOrigin: urlCheck.origin,
          actorUserId: member.userId,
        },
      });

      // ONE-TIME reveal of the plaintext secret. After this response
      // the secret is irretrievable.
      reply.code(201).send({
        ...projectDestination(created),
        revealedSecret: secret.plaintext,
        revealedSecretNotice:
          "Store this secret now — it will never be shown again. Rotate via the /rotate-secret endpoint if lost.",
      });
    },
  );

  // -----------------------------------------------------------------
  // PATCH /v1/automation/webhooks/:id
  // -----------------------------------------------------------------
  app.patch(
    "/v1/automation/webhooks/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      const params = ParamsId.safeParse(req.params);
      const body = UpdateBody.safeParse(req.body);
      if (!params.success) return reply.code(400).send({ message: "Invalid id" });
      if (!body.success) {
        return reply
          .code(400)
          .send({ message: "Invalid body", issues: body.error.issues });
      }
      const existing = await prisma.automationWebhookDestination.findUnique({
        where: { id: params.data.id },
      });
      if (!existing) return reply.code(404).send({ message: "Not found" });
      const member = await requireTeamCapability(
        req,
        reply,
        existing.teamId,
        "AUTOMATION_MANAGE",
      );
      if (!member) return;

      const data: Record<string, unknown> = {
        updatedByUserId: member.userId,
      };
      if (body.data.name !== undefined) data.name = body.data.name;
      if (body.data.url !== undefined) {
        const urlCheck = validateDestinationUrlStatic(body.data.url);
        if (!urlCheck.ok) {
          return reply.code(400).send({
            message: "Invalid destination URL",
            error: { code: "url_rejected", reason: urlCheck.reason },
          });
        }
        data.url = body.data.url;
        data.urlOrigin = urlCheck.origin;
      }
      const updated = await prisma.automationWebhookDestination.update({
        where: { id: existing.id },
        data,
      });
      safeEmitSecurityEvent({
        teamId: existing.teamId,
        eventType: "automation_webhook_destination_updated",
        severity: "INFO",
        details: {
          destinationId: existing.id,
          actorUserId: member.userId,
          urlChanged: body.data.url !== undefined,
        },
      });
      reply.send(projectDestination(updated));
    },
  );

  // -----------------------------------------------------------------
  // POST /v1/automation/webhooks/:id/enable
  // POST /v1/automation/webhooks/:id/disable
  // -----------------------------------------------------------------
  const transitionEnabled = async (
    req: FastifyRequest,
    reply: FastifyReply,
    enabled: boolean,
  ): Promise<void> => {
    const params = ParamsId.safeParse(req.params);
    if (!params.success) {
      reply.code(400).send({ message: "Invalid id" });
      return;
    }
    const existing = await prisma.automationWebhookDestination.findUnique({
      where: { id: params.data.id },
    });
    if (!existing) {
      reply.code(404).send({ message: "Not found" });
      return;
    }
    const member = await requireTeamCapability(
      req,
      reply,
      existing.teamId,
      "AUTOMATION_MANAGE",
    );
    if (!member) return;
    const updated = await prisma.automationWebhookDestination.update({
      where: { id: existing.id },
      data: {
        enabled,
        disabledAt: enabled ? null : new Date(),
        updatedByUserId: member.userId,
      },
    });
    if (!enabled) {
      safeEmitSecurityEvent({
        teamId: existing.teamId,
        eventType: "automation_webhook_destination_disabled",
        severity: "INFO",
        details: {
          destinationId: existing.id,
          actorUserId: member.userId,
        },
      });
    }
    reply.send(projectDestination(updated));
  };

  app.post(
    "/v1/automation/webhooks/:id/enable",
    { preHandler: requireAuth },
    (req, reply) => transitionEnabled(req, reply, true),
  );
  app.post(
    "/v1/automation/webhooks/:id/disable",
    { preHandler: requireAuth },
    (req, reply) => transitionEnabled(req, reply, false),
  );

  // -----------------------------------------------------------------
  // POST /v1/automation/webhooks/:id/rotate-secret
  //
  // Generates a fresh secret + returns it ONCE in the response. The
  // old secret is immediately invalidated server-side; any in-flight
  // delivery signed with the old secret will still verify because the
  // delivery already happened — only future deliveries use the new
  // secret.
  // -----------------------------------------------------------------
  app.post(
    "/v1/automation/webhooks/:id/rotate-secret",
    { preHandler: requireAuth },
    async (req, reply) => {
      const params = ParamsId.safeParse(req.params);
      if (!params.success) return reply.code(400).send({ message: "Invalid id" });
      const existing = await prisma.automationWebhookDestination.findUnique({
        where: { id: params.data.id },
      });
      if (!existing) return reply.code(404).send({ message: "Not found" });
      const member = await requireTeamCapability(
        req,
        reply,
        existing.teamId,
        "AUTOMATION_MANAGE",
      );
      if (!member) return;

      const fresh = createDestinationSecret();
      const updated = await prisma.automationWebhookDestination.update({
        where: { id: existing.id },
        data: {
          encryptedSecret: fresh.storedEnvelope,
          secretFingerprint: fresh.fingerprint,
          updatedByUserId: member.userId,
        },
      });
      safeEmitSecurityEvent({
        teamId: existing.teamId,
        eventType: "automation_webhook_secret_rotated",
        severity: "WARNING",
        details: {
          destinationId: existing.id,
          actorUserId: member.userId,
          newFingerprint: fresh.fingerprint,
        },
      });
      reply.send({
        ...projectDestination(updated),
        revealedSecret: fresh.plaintext,
        revealedSecretNotice:
          "Store this secret now — it will never be shown again.",
      });
    },
  );

  // -----------------------------------------------------------------
  // GET /v1/automation/webhook-deliveries?teamId=
  // -----------------------------------------------------------------
  app.get(
    "/v1/automation/webhook-deliveries",
    { preHandler: requireAuth },
    async (req, reply) => {
      const q = ListDeliveriesQuery.safeParse(req.query);
      if (!q.success) {
        return reply
          .code(400)
          .send({ message: "Invalid query", issues: q.error.issues });
      }
      const member = await requireTeamCapability(
        req,
        reply,
        q.data.teamId,
        "AUTOMATION_VIEW",
      );
      if (!member) return;
      const rows = await prisma.automationWebhookDelivery.findMany({
        where: {
          teamId: q.data.teamId,
          ...(q.data.destinationId
            ? { destinationId: q.data.destinationId }
            : {}),
          ...(q.data.status ? { status: q.data.status } : {}),
        },
        orderBy: [{ createdAt: "desc" }],
        take: q.data.limit,
      });
      reply.send({ deliveries: rows.map(projectDelivery) });
    },
  );
}
