/**
 * Phase 18 — Enterprise communications routes.
 *
 *   POST   /v1/communications/verify/start                   — session-auth
 *   POST   /v1/communications/verify/check                   — session-auth
 *   GET    /v1/communications/messages?teamId&filters        — session-auth
 *   GET    /v1/communications/health?teamId                  — session-auth
 *   POST   /v1/communications/messages/:id/cancel-retry      — session-auth
 *   POST   /v1/communications/messages/:id/retry             — session-auth
 *   POST   /v1/communications/preferences                    — session-auth
 *   POST   /v1/communications/process-retries                — INTEGRATION_CRON_SECRET
 *   POST   /v1/communications/webhooks/twilio/status         — Twilio signature
 *   POST   /v1/communications/webhooks/twilio/inbound        — Twilio signature
 *
 * Authentication:
 *   - All operator routes use `requireAuth` (session). 404 for non-
 *     members (anti-enumeration); identity.* permission denial follows
 *     the Phase 17 access-policy engine where applicable.
 *   - Webhook routes have NO session auth — they're protected by Twilio
 *     signature validation. Invalid signature → 403 + security event.
 *   - process-retries uses INTEGRATION_CRON_SECRET (same secret as
 *     existing retry sweepers).
 *
 * Privacy:
 *   - No route returns the raw phone, the OTP code, or any provider
 *     secret. Every response shape is a safe projection.
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";
import * as prismaPkg from "@prisma/client";
import {
  type CommunicationChannel,
  type CommunicationPurpose,
  type CommunicationStatus,
  COMMUNICATION_CHANNELS,
  COMMUNICATION_PURPOSES,
  COMMUNICATION_STATUSES,
  isPhoneChannel,
  isRetryEligibleCommunicationPurpose,
  normaliseToE164,
  parseInboundCommand,
} from "@proovra/shared";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireIntegrationCronSecret } from "../middleware/cron-secret.js";
import { evaluateMemberAccess } from "../services/identity/access-policy.service.js";
import { safeEmitSecurityEvent } from "../services/security/security-event.service.js";
import {
  buildProviderHealthSnapshot,
  getMessagingProvider,
} from "../services/communications/provider-registry.js";
import {
  dispatchPendingMessage,
  projectCommunicationMessage,
} from "../services/communications/communication.service.js";
import {
  VerificationError,
  checkVerification,
  projectVerificationAttempt,
  startVerification,
} from "../services/communications/verification.service.js";
import {
  applyInboundOptIn,
  applyInboundOptOut,
  upsertContactPreference,
  upsertUserPreference,
} from "../services/communications/communication-preference.service.js";

const TeamIdQuery = z.object({ teamId: z.string().uuid() });
const ParamsId = z.object({ id: z.string().uuid() });

function requestIp(req: FastifyRequest): string | null {
  const raw = (req.ip ?? "").trim();
  return raw.length > 0 ? raw : null;
}

function requestUa(req: FastifyRequest): string | null {
  const raw = req.headers["user-agent"];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 512) : null;
}

/**
 * 404-on-non-member + identity.* permission gate. Mirrors the Phase 17
 * pattern so the surface is consistent across ops UIs.
 */
async function requireCommunicationsActor(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
  permission: "identity.org_policy.read" | "identity.org_policy.manage" | "identity.member.read",
): Promise<{ userId: string } | null> {
  const userId = getAuthUserId(req);
  const member = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { id: true },
  });
  if (!member) {
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  const decision = await evaluateMemberAccess({
    teamId,
    userId,
    permission,
  });
  if (!decision.allowed) {
    reply.code(403).send({
      error: {
        code: "permission_denied",
        reason: decision.reason,
        detail: decision.detail ?? null,
      },
    });
    return null;
  }
  return { userId };
}

function handleVerificationError(reply: FastifyReply, err: unknown): boolean {
  if (err instanceof VerificationError) {
    // Generic responses — never leak which exact branch failed.
    if (err.code === "feature_disabled") {
      reply.code(503).send({ error: { code: "feature_disabled" } });
      return true;
    }
    if (err.code === "invalid_phone") {
      reply.code(400).send({ error: { code: "invalid_phone" } });
      return true;
    }
    if (
      err.code === "verification_check_failed" ||
      err.code === "verification_not_found" ||
      err.code === "verification_expired" ||
      err.code === "verification_check_exhausted"
    ) {
      // Bucket every check failure into one response shape so an
      // attacker cannot tell the difference between "wrong code" and
      // "no active verification".
      reply.code(400).send({ status: "denied" });
      return true;
    }
    reply.code(502).send({ error: { code: "provider_error" } });
    return true;
  }
  return false;
}

export async function communicationsRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  app.get(
    "/v1/communications/health",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = TeamIdQuery.parse(req.query ?? {});
      const actor = await requireCommunicationsActor(req, reply, q.teamId, "identity.member.read");
      if (!actor) return;
      const snapshot = buildProviderHealthSnapshot();
      return reply.code(200).send({ health: snapshot });
    },
  );

  // -------------------------------------------------------------------------
  // Messages list / cancel / retry
  // -------------------------------------------------------------------------

  app.get(
    "/v1/communications/messages",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({
          teamId: z.string().uuid(),
          channel: z.enum(COMMUNICATION_CHANNELS as unknown as [string, ...string[]]).optional(),
          purpose: z.enum(COMMUNICATION_PURPOSES as unknown as [string, ...string[]]).optional(),
          status: z.enum(COMMUNICATION_STATUSES as unknown as [string, ...string[]]).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        })
        .parse(req.query ?? {});
      const actor = await requireCommunicationsActor(req, reply, q.teamId, "identity.member.read");
      if (!actor) return;
      const rows = await prisma.communicationMessage.findMany({
        where: {
          teamId: q.teamId,
          ...(q.channel ? { channel: q.channel as prismaPkg.CommunicationChannel } : {}),
          ...(q.purpose ? { purpose: q.purpose as prismaPkg.CommunicationPurpose } : {}),
          ...(q.status ? { status: q.status as prismaPkg.CommunicationStatus } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: Math.min(Math.max(q.limit ?? 100, 1), 500),
      });
      return reply
        .code(200)
        .send({ messages: rows.map(projectCommunicationMessage) });
    },
  );

  app.post(
    "/v1/communications/messages/:id/cancel-retry",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = TeamIdQuery.parse(req.body ?? {});
      const actor = await requireCommunicationsActor(req, reply, body.teamId, "identity.org_policy.manage");
      if (!actor) return;
      const row = await prisma.communicationMessage.findFirst({
        where: { id, teamId: body.teamId },
        select: { id: true, status: true },
      });
      if (!row) {
        reply.code(404).send({ error: { code: "not_found" } });
        return;
      }
      if (row.status !== prismaPkg.CommunicationStatus.RETRY_SCHEDULED) {
        reply.code(409).send({ error: { code: "not_retry_scheduled" } });
        return;
      }
      const updated = await prisma.communicationMessage.update({
        where: { id: row.id },
        data: {
          status: prismaPkg.CommunicationStatus.CANCELLED,
          nextAttemptAtUtc: null,
        },
      });
      return reply
        .code(200)
        .send({ message: projectCommunicationMessage(updated) });
    },
  );

  app.post(
    "/v1/communications/messages/:id/retry",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = TeamIdQuery.parse(req.body ?? {});
      const actor = await requireCommunicationsActor(req, reply, body.teamId, "identity.org_policy.manage");
      if (!actor) return;
      const row = await prisma.communicationMessage.findFirst({
        where: { id, teamId: body.teamId },
        select: { id: true, status: true, purpose: true },
      });
      if (!row) {
        reply.code(404).send({ error: { code: "not_found" } });
        return;
      }
      if (
        row.status !== prismaPkg.CommunicationStatus.FAILED &&
        row.status !== prismaPkg.CommunicationStatus.RETRY_SCHEDULED
      ) {
        reply.code(409).send({ error: { code: "not_retryable" } });
        return;
      }
      if (
        !isRetryEligibleCommunicationPurpose(row.purpose as CommunicationPurpose)
      ) {
        reply.code(409).send({ error: { code: "purpose_not_retryable" } });
        return;
      }
      // Stamp the row back to QUEUED with nextAttemptAtUtc = now so the
      // cron processor picks it up immediately.
      const updated = await prisma.communicationMessage.update({
        where: { id: row.id },
        data: {
          status: prismaPkg.CommunicationStatus.RETRY_SCHEDULED,
          nextAttemptAtUtc: new Date(),
        },
      });
      return reply
        .code(200)
        .send({ message: projectCommunicationMessage(updated) });
    },
  );

  // -------------------------------------------------------------------------
  // Preferences
  // -------------------------------------------------------------------------

  const PreferenceBody = z.object({
    teamId: z.string().uuid(),
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("user"), userId: z.string().uuid() }),
      z.object({ kind: z.literal("contact"), phone: z.string().min(3).max(32) }),
    ]),
    smsOptOut: z.boolean().optional(),
    whatsappOptOut: z.boolean().optional(),
    preferredChannel: z
      .enum(COMMUNICATION_CHANNELS as unknown as [string, ...string[]])
      .nullable()
      .optional(),
    optOutReason: z.string().min(1).max(400).nullable().optional(),
  });

  app.post(
    "/v1/communications/preferences",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = PreferenceBody.parse(req.body ?? {});
      const actor = await requireCommunicationsActor(req, reply, body.teamId, "identity.org_policy.manage");
      if (!actor) return;
      try {
        if (body.target.kind === "user") {
          const pref = await upsertUserPreference({
            teamId: body.teamId,
            userId: body.target.userId,
            actorUserId: actor.userId,
            smsOptOut: body.smsOptOut,
            whatsappOptOut: body.whatsappOptOut,
            preferredChannel:
              body.preferredChannel === undefined
                ? undefined
                : (body.preferredChannel as CommunicationChannel | null),
          });
          return reply.code(200).send({ preference: pref });
        }
        const phone = normaliseToE164(body.target.phone);
        if (!phone) {
          reply.code(400).send({ error: { code: "invalid_phone" } });
          return;
        }
        const pref = await upsertContactPreference({
          teamId: body.teamId,
          phoneE164: phone,
          actorUserId: actor.userId,
          smsOptOut: body.smsOptOut,
          whatsappOptOut: body.whatsappOptOut,
          preferredChannel:
            body.preferredChannel === undefined
              ? undefined
              : (body.preferredChannel as CommunicationChannel | null),
          optOutReason: body.optOutReason ?? null,
        });
        return reply.code(200).send({ preference: pref });
      } catch (err) {
        req.log.error({ err }, "communications.preference upsert failed");
        reply.code(500).send({ error: { code: "internal_error" } });
      }
    },
  );

  // -------------------------------------------------------------------------
  // Verify (OTP)
  // -------------------------------------------------------------------------

  const VerifyStartBody = z.object({
    teamId: z.string().uuid(),
    channel: z.enum(["SMS", "WHATSAPP"]),
    phone: z.string().min(3).max(32),
    purpose: z.string().min(1).max(64).optional(),
  });

  app.post(
    "/v1/communications/verify/start",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = VerifyStartBody.parse(req.body ?? {});
      const actor = await requireCommunicationsActor(req, reply, body.teamId, "identity.member.read");
      if (!actor) return;
      try {
        const result = await startVerification({
          teamId: body.teamId,
          channel: body.channel,
          phoneE164OrRaw: body.phone,
          initiatedByUserId: actor.userId,
          purpose: body.purpose,
          ipAddress: requestIp(req),
          userAgent: requestUa(req),
        });
        return reply.code(200).send({
          status: result.status,
          attempt: projectVerificationAttempt(result.attempt),
        });
      } catch (err) {
        if (handleVerificationError(reply, err)) return;
        throw err;
      }
    },
  );

  const VerifyCheckBody = z.object({
    teamId: z.string().uuid(),
    phone: z.string().min(3).max(32),
    code: z.string().min(3).max(16),
  });

  app.post(
    "/v1/communications/verify/check",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = VerifyCheckBody.parse(req.body ?? {});
      const actor = await requireCommunicationsActor(req, reply, body.teamId, "identity.member.read");
      if (!actor) return;
      try {
        const result = await checkVerification({
          teamId: body.teamId,
          phoneE164OrRaw: body.phone,
          code: body.code,
          initiatedByUserId: actor.userId,
          ipAddress: requestIp(req),
          userAgent: requestUa(req),
        });
        // Generic response — never reveal which branch denied.
        if (result.status === "approved") {
          return reply
            .code(200)
            .send({ status: "approved", verificationId: result.attempt?.id ?? null });
        }
        return reply.code(400).send({ status: "denied" });
      } catch (err) {
        if (handleVerificationError(reply, err)) return;
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // Retry processor (cron)
  //
  // Protected by INTEGRATION_CRON_SECRET — same secret used by Phase 12
  // reliability sweepers and Phase 13 SLA sweep. Documented in env list.
  // -------------------------------------------------------------------------

  app.post(
    "/v1/communications/process-retries",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ok = await requireIntegrationCronSecret(req, reply);
      if (!ok) return;
      const now = new Date();
      const due = await prisma.communicationMessage.findMany({
        where: {
          status: prismaPkg.CommunicationStatus.RETRY_SCHEDULED,
          nextAttemptAtUtc: { lte: now },
        },
        select: { id: true },
        take: 100,
      });
      let processed = 0;
      let sent = 0;
      let failed = 0;
      let notEligible = 0;
      for (const m of due) {
        const result = await dispatchPendingMessage(m.id);
        processed += 1;
        if ("status" in result) {
          if (result.status === "sent" || result.status === "queued") sent += 1;
          else if (result.status === "not_eligible") notEligible += 1;
          else if (result.status === "failed") failed += 1;
        }
      }
      return reply
        .code(200)
        .send({ processed, sent, failed, notEligible });
    },
  );

  // -------------------------------------------------------------------------
  // Webhooks — Twilio status + inbound
  //
  // NO session auth. Twilio signature validation IS the auth. The
  // signature base includes the full URL Twilio called, so the route
  // must build the URL exactly as Twilio sees it. We honour the
  // X-Forwarded-Proto / Host headers because the API runs behind a
  // proxy in every deployment.
  // -------------------------------------------------------------------------

  app.post(
    "/v1/communications/webhooks/twilio/status",
    async (req: FastifyRequest, reply: FastifyReply) => {
      await handleTwilioWebhook(req, reply, "status");
    },
  );

  app.post(
    "/v1/communications/webhooks/twilio/inbound",
    async (req: FastifyRequest, reply: FastifyReply) => {
      await handleTwilioWebhook(req, reply, "inbound");
    },
  );
}

// -----------------------------------------------------------------------------
// Twilio webhook handler (shared between status + inbound routes)
// -----------------------------------------------------------------------------

async function handleTwilioWebhook(
  req: FastifyRequest,
  reply: FastifyReply,
  kind: "status" | "inbound",
): Promise<void> {
  const provider = getMessagingProvider();
  if (!provider.isConfigured()) {
    // We never tell the caller why — just refuse. An attacker probing
    // disabled environments gets a generic 403.
    reply.code(403).send({ error: { code: "forbidden" } });
    return;
  }

  // Twilio posts application/x-www-form-urlencoded. Fastify parses this
  // into a flat object on req.body by default.
  const rawBody = req.body;
  const fields: Record<string, string> = {};
  if (rawBody && typeof rawBody === "object") {
    for (const [k, v] of Object.entries(rawBody as Record<string, unknown>)) {
      if (typeof v === "string") fields[k] = v;
      else if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") {
        fields[k] = v[0] as string;
      }
    }
  }

  const signatureHeader =
    typeof req.headers["x-twilio-signature"] === "string"
      ? (req.headers["x-twilio-signature"] as string)
      : null;
  const fullUrl = buildPublicWebhookUrl(req);

  const valid = provider.verifyWebhookSignature({
    url: fullUrl,
    // Twilio's signature base is (url + sortedFormFields), not the raw
    // body. We pass an empty rawBody since the algorithm doesn't use it.
    rawBody: "",
    fields,
    signatureHeader,
  });
  if (!valid) {
    safeEmitSecurityEvent({
      teamId: null,
      eventType: "communication_webhook_invalid_signature",
      severity: "HIGH",
      details: {
        kind,
        ip: req.ip ?? null,
        // No body details — we don't trust the payload at all.
      },
    });
    // Phase 21 — bump the observability metric. The auto-incident
    // path on the SecurityEvent service handles burst aggregation
    // via the recordIncident fingerprint; the metric here gives
    // operators per-minute visibility for the /v1/ops/metrics
    // endpoint.
    void (async () => {
      try {
        const m = await import("../services/ops/metrics.service.js");
        m.bump("webhook_invalid_signature_total");
        m.bump("webhook_invalid_signature");
      } catch {
        /* metrics module unavailable in test context */
      }
    })();
    reply.code(403).send({ error: { code: "invalid_signature" } });
    return;
  }

  const parsed = provider.parseDeliveryWebhook({ fields });
  if (parsed.kind === "ignored") {
    reply.code(200).send({ status: "ignored" });
    return;
  }

  if (parsed.kind === "status") {
    const ev = parsed.event;
    // Locate the source row by provider + providerMessageId. Idempotency
    // is enforced by the unique index on
    // (provider, providerMessageId, status) — duplicate callbacks
    // collapse via try/catch.
    const row = await prisma.communicationMessage.findFirst({
      where: {
        provider: prismaPkg.CommunicationProvider.TWILIO,
        providerMessageId: ev.providerMessageId,
      },
      select: { id: true, teamId: true, status: true },
    });
    if (!row) {
      reply.code(200).send({ status: "unknown_message" });
      return;
    }
    try {
      await prisma.communicationMessage.update({
        where: { id: row.id },
        data: {
          status: ev.status as prismaPkg.CommunicationStatus,
          deliveredAtUtc:
            ev.status === "DELIVERED" ? ev.occurredAtUtc : undefined,
          failedAtUtc:
            ev.status === "FAILED" || ev.status === "UNDELIVERED"
              ? ev.occurredAtUtc
              : undefined,
          errorCode: ev.errorCode ?? undefined,
          errorMessage: ev.errorMessage ?? undefined,
        },
      });
    } catch {
      // Idempotency: duplicate (provider, sid, status) collapse silently.
    }
    reply.code(200).send({ status: "ok" });
    return;
  }

  // Inbound message — handle STOP/START. We need to determine the
  // teamId for this contact; the simplest path is to look up the most
  // recent outbound message we sent to this hash and use its teamId.
  const ev = parsed.event;
  const fromE164 = ev.fromE164 ? normaliseToE164(ev.fromE164) : null;
  const command = parseInboundCommand(ev.body);
  if (!fromE164) {
    reply.code(200).send({ status: "ignored", reason: "no_from" });
    return;
  }
  // We could write an INBOUND CommunicationMessage row here for full
  // audit; for Phase 18 we keep it tight and only handle STOP/START.
  if (command === "STOP") {
    // Best-effort: apply to every team that has talked to this hash.
    const { hashRecipientPhone } = await import(
      "../services/communications/communication.service.js"
    );
    const hash = hashRecipientPhone(fromE164);
    const teams = await prisma.communicationMessage.findMany({
      where: {
        recipientHash: hash,
        direction: prismaPkg.CommunicationDirection.OUTBOUND,
      },
      select: { teamId: true },
      distinct: ["teamId"],
    });
    for (const t of teams) {
      await applyInboundOptOut({
        teamId: t.teamId,
        phoneE164: fromE164,
        channel: ev.channel,
      });
    }
    reply.code(200).send({ status: "stop_applied", teams: teams.length });
    return;
  }
  if (command === "START") {
    const { hashRecipientPhone } = await import(
      "../services/communications/communication.service.js"
    );
    const hash = hashRecipientPhone(fromE164);
    const teams = await prisma.communicationMessage.findMany({
      where: {
        recipientHash: hash,
        direction: prismaPkg.CommunicationDirection.OUTBOUND,
      },
      select: { teamId: true },
      distinct: ["teamId"],
    });
    for (const t of teams) {
      await applyInboundOptIn({
        teamId: t.teamId,
        phoneE164: fromE164,
        channel: ev.channel,
      });
    }
    reply.code(200).send({ status: "start_applied", teams: teams.length });
    return;
  }
  reply.code(200).send({ status: "ignored" });
}

function buildPublicWebhookUrl(req: FastifyRequest): string {
  // Twilio includes the FULL URL it POSTed to in the signature base.
  // Reconstruct from forwarded headers when the API runs behind a
  // proxy.
  const forwardedProto = req.headers["x-forwarded-proto"];
  const forwardedHost =
    req.headers["x-forwarded-host"] ?? req.headers["host"];
  const proto =
    typeof forwardedProto === "string" && forwardedProto.length > 0
      ? forwardedProto.split(",")[0].trim()
      : req.protocol;
  const host =
    typeof forwardedHost === "string"
      ? forwardedHost
      : Array.isArray(forwardedHost) && forwardedHost[0]
        ? forwardedHost[0]
        : "";
  return `${proto}://${host}${req.url}`;
}

// Suppress unused warning for utility import — `isPhoneChannel` is
// re-exported for the integration wiring file.
void isPhoneChannel;
