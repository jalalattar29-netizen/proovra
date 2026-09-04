import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  COMMERCIAL_TRANSITION_REFUSALS,
  commercialTransitionRule,
  type CommercialRequestStatus,
} from "@proovra/shared";
import { prisma } from "../db.js";
import { createErrorResponse, ErrorCode } from "../errors.js";
import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";
import { emitPlatformAudit } from "../services/audit/tenant-audit.service.js";
import {
  processDueDemoFollowUps,
  sendDemoFollowUpById,
} from "../services/demo-follow-up.service.js";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  status: z
    .enum(["NEW", "REVIEWED", "CONTACTED", "QUALIFIED", "REJECTED", "ARCHIVED"])
    .optional(),
  priority: z.enum(["LOW", "NORMAL", "HIGH"]).optional(),
  leadQuality: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
  leadTrack: z.enum(["DISCOVERY", "SALES", "ENTERPRISE"]).optional(),
  recommendedAction: z
    .enum(["reply_with_resources", "offer_demo", "route_enterprise"])
    .optional(),
  routingTarget: z
    .enum(["AUTO_RESOURCES", "AUTO_BOOKING", "MANUAL_SALES", "ENTERPRISE_DESK"])
    .optional(),
  followUpStatus: z
    .enum(["ACTIVE", "PAUSED", "COMPLETED", "REPLIED", "STOPPED"])
    .optional(),
  isSpam: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((value) => {
      if (value === undefined) return undefined;
      return value === "true";
    }),
  search: z.string().trim().max(200).optional(),
});

const updateBodySchema = z.object({
  status: z
    .enum(["NEW", "REVIEWED", "CONTACTED", "QUALIFIED", "REJECTED", "ARCHIVED"])
    .optional(),
  priority: z.enum(["LOW", "NORMAL", "HIGH"]).optional(),
  notes: z.string().max(5000).nullable().optional(),
  followUpStatus: z
    .enum(["ACTIVE", "PAUSED", "COMPLETED", "REPLIED", "STOPPED"])
    .optional(),
  nextFollowUpAt: z.string().datetime().nullable().optional(),
  /**
   * The status the operator was looking at when they saved. Refused with
   * `stale_status` when it no longer matches the row — see the shared
   * transition table for why a second operator's click must not win silently.
   */
  expectedStatus: z
    .enum(["NEW", "REVIEWED", "CONTACTED", "QUALIFIED", "REJECTED", "ARCHIVED"])
    .optional(),
});

const routeBodySchema = z.object({
  routingTarget: z.enum([
    "AUTO_RESOURCES",
    "AUTO_BOOKING",
    "MANUAL_SALES",
    "ENTERPRISE_DESK",
  ]),
  routingReason: z.string().trim().max(255).optional().nullable(),
});

const followUpSendBodySchema = z.object({
  step: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
});

const runFollowUpBodySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
});

function readUserAgent(req: {
  headers: Record<string, string | string[] | undefined>;
}): string | undefined {
  const value = req.headers["user-agent"];
  return Array.isArray(value) ? value[0] : value;
}

function readIp(req: { ip?: string }): string | undefined {
  return req.ip;
}

function envString(name: string): string | undefined {
  const value = process.env[name];
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

function readHeaderValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

function isValidInternalKey(req: FastifyRequest): boolean {
  const configured = envString("INTERNAL_API_KEY");
  if (!configured) return false;

  const provided = readHeaderValue(
    req.headers as Record<string, string | string[] | undefined>,
    "x-internal-key"
  )?.trim();

  return !!provided && provided === configured;
}

async function requirePlatformAdminOrInternalKey(
  req: FastifyRequest,
  reply: FastifyReply
) {
  if (isValidInternalKey(req)) {
    return;
  }

  return requirePlatformAdmin(req, reply);
}

function isTerminalStatus(status: string): boolean {
  return (
    status === "QUALIFIED" ||
    status === "REJECTED" ||
    status === "ARCHIVED"
  );
}

export async function adminDemoRequestsRoutes(app: FastifyInstance) {
  app.get(
    "/v1/admin/demo-requests",
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      const parsed = listQuerySchema.safeParse(req.query ?? {});
      if (!parsed.success) {
        return reply.code(400).send(
          createErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            req.id,
            { reason: parsed.error.message },
            "Invalid demo requests query"
          )
        );
      }

      const {
        limit,
        status,
        priority,
        leadQuality,
        leadTrack,
        recommendedAction,
        routingTarget,
        followUpStatus,
        isSpam,
        search,
      } = parsed.data;

      const where = {
        ...(status ? { status } : {}),
        ...(priority ? { priority } : {}),
        ...(leadQuality ? { leadQuality } : {}),
        ...(leadTrack ? { leadTrack } : {}),
        ...(recommendedAction ? { recommendedAction } : {}),
        ...(routingTarget ? { routingTarget } : {}),
        ...(followUpStatus ? { followUpStatus } : {}),
        ...(typeof isSpam === "boolean" ? { isSpam } : {}),
        ...(search
          ? {
              OR: [
                { fullName: { contains: search, mode: "insensitive" as const } },
                { workEmail: { contains: search, mode: "insensitive" as const } },
                { organization: { contains: search, mode: "insensitive" as const } },
                { jobTitle: { contains: search, mode: "insensitive" as const } },
                { country: { contains: search, mode: "insensitive" as const } },
                { source: { contains: search, mode: "insensitive" as const } },
                { useCase: { contains: search, mode: "insensitive" as const } },
                {
                  routingReason: {
                    contains: search,
                    mode: "insensitive" as const,
                  },
                },
              ],
            }
          : {}),
      };

      const [items, counts] = await Promise.all([
        prisma.demoRequest.findMany({
          where,
          orderBy: [{ createdAt: "desc" }],
          take: limit,
          select: {
            id: true,
            fullName: true,
            workEmail: true,
            organization: true,
            jobTitle: true,
            country: true,
            teamSize: true,
            source: true,
            sourcePath: true,
            status: true,
            priority: true,
            leadQuality: true,
            leadTrack: true,
            recommendedAction: true,
            responseSlaHours: true,
            qualificationScore: true,
            routingTarget: true,
            routingReason: true,
            routedAt: true,
            followUpStatus: true,
            followUpStep: true,
            nextFollowUpAt: true,
            lastFollowUpSentAt: true,
            lastFollowUpTemplateKey: true,
            firstRespondedAt: true,
            contactedAt: true,
            contactedByUserId: true,
            spamScore: true,
            isSpam: true,
            emailSentAt: true,
            autoReplySentAt: true,
            reviewedAt: true,
            reviewedByUserId: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
        prisma.demoRequest.groupBy({
          by: ["status"],
          _count: { _all: true },
        }),
      ]);

      void emitPlatformAudit({
        action: "admin.demo_requests.list",
        outcome: "success",
        sourceApp: "API",
        actorUserId: req.user?.sub ?? null,
        resourceType: "demo_request",
        resourceId: null,
        correlationId: req.id,
        metadata: {
          limit,
          status: status ?? null,
          priority: priority ?? null,
          leadQuality: leadQuality ?? null,
          leadTrack: leadTrack ?? null,
          recommendedAction: recommendedAction ?? null,
          routingTarget: routingTarget ?? null,
          followUpStatus: followUpStatus ?? null,
          isSpam: typeof isSpam === "boolean" ? isSpam : null,
          search: search ?? null,
          resultCount: items.length,
          ipAddress: readIp(req),
          userAgent: readUserAgent(req),
        },
      }).catch(() => null);

      const statusSummary = {
        NEW: 0,
        REVIEWED: 0,
        CONTACTED: 0,
        QUALIFIED: 0,
        REJECTED: 0,
        ARCHIVED: 0,
      };

      for (const row of counts) {
        statusSummary[row.status] = row._count._all;
      }

      return reply.code(200).send({
        items,
        summary: statusSummary,
      });
    }
  );

  app.get(
    "/v1/admin/demo-requests/:id",
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      const params = req.params as { id?: string };
      const id = typeof params.id === "string" ? params.id : "";

      if (!id) {
        return reply.code(400).send(
          createErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            req.id,
            { field: "id", reason: "Missing demo request id" },
            "Missing demo request id"
          )
        );
      }

      const item = await prisma.demoRequest.findUnique({
        where: { id },
        select: {
          id: true,
          fullName: true,
          workEmail: true,
          organization: true,
          jobTitle: true,
          country: true,
          teamSize: true,
          useCase: true,
          message: true,
          source: true,
          sourcePath: true,
          referrer: true,
          utmSource: true,
          utmMedium: true,
          utmCampaign: true,
          utmTerm: true,
          utmContent: true,
          status: true,
          priority: true,
          leadQuality: true,
          leadTrack: true,
          recommendedAction: true,
          responseSlaHours: true,
          qualificationScore: true,
          qualificationReasons: true,
          routingTarget: true,
          routingReason: true,
          routedAt: true,
          routedByUserId: true,
          followUpStatus: true,
          followUpStep: true,
          nextFollowUpAt: true,
          lastFollowUpSentAt: true,
          lastFollowUpTemplateKey: true,
          followUpStoppedAt: true,
          firstRespondedAt: true,
          contactedAt: true,
          contactedByUserId: true,
          spamScore: true,
          spamReasons: true,
          isSpam: true,
          emailSentAt: true,
          autoReplySentAt: true,
          webhookSentAt: true,
          reviewedAt: true,
          reviewedByUserId: true,
          notes: true,
          ipAddress: true,
          userAgent: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      if (!item) {
        return reply.code(404).send(
          createErrorResponse(
            ErrorCode.NOT_FOUND,
            req.id,
            undefined,
            "Demo request not found"
          )
        );
      }

      void emitPlatformAudit({
        action: "admin.demo_requests.view",
        outcome: "success",
        sourceApp: "API",
        actorUserId: req.user?.sub ?? null,
        resourceType: "demo_request",
        resourceId: item.id,
        correlationId: req.id,
        metadata: {
          demoRequestId: item.id,
          status: item.status,
          priority: item.priority,
          leadQuality: item.leadQuality,
          leadTrack: item.leadTrack,
          recommendedAction: item.recommendedAction,
          routingTarget: item.routingTarget,
          followUpStatus: item.followUpStatus,
          isSpam: item.isSpam,
          ipAddress: readIp(req),
          userAgent: readUserAgent(req),
        },
      }).catch(() => null);

      return reply.code(200).send({ item });
    }
  );

  app.patch(
    "/v1/admin/demo-requests/:id",
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      const params = req.params as { id?: string };
      const id = typeof params.id === "string" ? params.id : "";

      if (!id) {
        return reply.code(400).send(
          createErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            req.id,
            { field: "id", reason: "Missing demo request id" },
            "Missing demo request id"
          )
        );
      }

      const parsed = updateBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send(
          createErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            req.id,
            { reason: parsed.error.message },
            "Invalid demo request update payload"
          )
        );
      }

      const existing = await prisma.demoRequest.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          priority: true,
          notes: true,
          reviewedAt: true,
          reviewedByUserId: true,
          organization: true,
          fullName: true,
          contactedAt: true,
          contactedByUserId: true,
          firstRespondedAt: true,
          followUpStatus: true,
          followUpStoppedAt: true,
          nextFollowUpAt: true,
        },
      });

      if (!existing) {
        return reply.code(404).send(
          createErrorResponse(
            ErrorCode.NOT_FOUND,
            req.id,
            undefined,
            "Demo request not found"
          )
        );
      }

      /**
       * Status changes are transitions from the shared table; anything else
       * is refused, and a save made against a status the row no longer holds
       * is refused as stale. Both refusals are audited: a stream of 409s is a
       * racing colleague or a stale tab, and either is worth seeing.
       */
      const from = existing.status as CommercialRequestStatus;
      const refuse = async (
        code: string,
        message: string,
        extra: Record<string, unknown>,
      ) => {
        await emitPlatformAudit({
          action: "admin.demo_requests.update",
          outcome: "denied",
          sourceApp: "API",
          actorUserId: req.user?.sub ?? null,
          actorAuthority: "PLATFORM_ADMIN",
          resourceType: "demo_request",
          resourceId: existing.id,
          targetDisplay: existing.organization ?? existing.fullName ?? null,
          // PHASE 5 §2 — what was asked for, and NO resulting state. Storage
          // did not change, and recording the current status as the result
          // would make a refusal read as a deliberate no-op.
          previousState: from,
          requestedState:
            typeof extra["to"] === "string"
              ? (extra["to"] as string)
              : (parsed.data.status ?? null),
          reasonCode: code,
          correlationId: req.id,
          metadata: { demoRequestId: existing.id, reason: code, ...extra },
        }).catch(() => null);
        return reply.code(409).send({
          error: { code, message, requestId: req.id, details: extra },
        });
      };
      if (parsed.data.expectedStatus !== undefined && parsed.data.expectedStatus !== from) {
        return refuse(
          COMMERCIAL_TRANSITION_REFUSALS.STALE,
          "This demo request changed since you loaded it. Reload to see its current status.",
          { expected: parsed.data.expectedStatus, actual: from },
        );
      }
      if (
        parsed.data.status !== undefined &&
        parsed.data.status !== from &&
        commercialTransitionRule(from, parsed.data.status as CommercialRequestStatus) === null
      ) {
        return refuse(
          COMMERCIAL_TRANSITION_REFUSALS.NOT_ALLOWED,
          `A demo request cannot move from ${from} to ${parsed.data.status}.`,
          { from, to: parsed.data.status },
        );
      }

      const nextStatus = parsed.data.status ?? existing.status;
      const nextPriority = parsed.data.priority ?? existing.priority;
      const nextNotes =
        parsed.data.notes === undefined ? existing.notes : parsed.data.notes;

      const now = new Date();

      const data: Record<string, unknown> = {
        status: nextStatus,
        priority: nextPriority,
        notes: nextNotes,
      };

      const shouldStampReviewed =
        parsed.data.status !== undefined &&
        parsed.data.status !== "NEW" &&
        existing.reviewedAt == null;

      if (shouldStampReviewed) {
        data.reviewedAt = now;
        data.reviewedByUserId = req.user!.sub;
      }

      if (nextStatus === "CONTACTED" && existing.contactedAt == null) {
        data.contactedAt = now;
        data.contactedByUserId = req.user!.sub;
        data.firstRespondedAt = existing.firstRespondedAt ?? now;
      }

      if (parsed.data.followUpStatus !== undefined) {
        data.followUpStatus = parsed.data.followUpStatus;

        if (parsed.data.followUpStatus === "STOPPED") {
          data.followUpStoppedAt = existing.followUpStoppedAt ?? now;
          data.nextFollowUpAt = null;
        } else if (parsed.data.followUpStatus === "ACTIVE") {
          data.followUpStoppedAt = null;
        } else if (
          parsed.data.followUpStatus === "PAUSED" ||
          parsed.data.followUpStatus === "COMPLETED" ||
          parsed.data.followUpStatus === "REPLIED"
        ) {
          data.nextFollowUpAt = null;
        }
      }

      if (parsed.data.nextFollowUpAt !== undefined) {
        data.nextFollowUpAt = parsed.data.nextFollowUpAt
          ? new Date(parsed.data.nextFollowUpAt)
          : null;
      }

      if (isTerminalStatus(nextStatus)) {
        if (nextStatus === "QUALIFIED") {
          data.followUpStatus = "COMPLETED";
          data.nextFollowUpAt = null;
          data.followUpStoppedAt = null;
        } else {
          data.followUpStatus = "STOPPED";
          data.nextFollowUpAt = null;
          data.followUpStoppedAt = existing.followUpStoppedAt ?? now;
        }
      }

      /**
       * Compare-and-set on the status the transition was validated against,
       * so two concurrent saves cannot both succeed with the second silently
       * overwriting the first.
       */
      const changed = await prisma.demoRequest.updateMany({
        where: { id, status: existing.status },
        data,
      });
      if (changed.count === 0) {
        return refuse(
          COMMERCIAL_TRANSITION_REFUSALS.STALE,
          "Another operator changed this demo request at the same time. Reload to see its current status.",
          { expected: from },
        );
      }
      const updated = await prisma.demoRequest.findUniqueOrThrow({
        where: { id },
        select: {
          id: true,
          status: true,
          priority: true,
          notes: true,
          reviewedAt: true,
          reviewedByUserId: true,
          organization: true,
          fullName: true,
          contactedAt: true,
          contactedByUserId: true,
          firstRespondedAt: true,
          followUpStatus: true,
          nextFollowUpAt: true,
          followUpStoppedAt: true,
          updatedAt: true,
        },
      });

      void emitPlatformAudit({
        action: "admin.demo_requests.update",
        outcome: "success",
        sourceApp: "API",
        actorUserId: req.user?.sub ?? null,
        actorAuthority: "PLATFORM_ADMIN",
        resourceType: "demo_request",
        resourceId: updated.id,
        targetDisplay: updated.organization ?? updated.fullName ?? null,
        // PHASE 5 §2 — `existing.status` is storage BEFORE, `updated.status` is
        // storage re-read AFTER. Neither is derived from the request body: a
        // resulting state taken from intent cannot tell a winning
        // compare-and-set from a losing one.
        previousState: existing.status,
        requestedState: parsed.data.status ?? null,
        resultingState: updated.status,
        reasonCode:
          parsed.data.status && parsed.data.status !== existing.status
            ? "OPERATOR_TRANSITION"
            : "NO_STATUS_CHANGE",
        correlationId: req.id,
        metadata: {
          demoRequestId: updated.id,
          previousStatus: existing.status,
          nextStatus: updated.status,
          previousPriority: existing.priority,
          nextPriority: updated.priority,
          previousFollowUpStatus: existing.followUpStatus,
          nextFollowUpStatus: updated.followUpStatus,
          notesChanged: existing.notes !== updated.notes,
          ipAddress: readIp(req),
          userAgent: readUserAgent(req),
        },
      }).catch(() => null);

      return reply.code(200).send({
        ok: true,
        item: updated,
      });
    }
  );

  app.post(
    "/v1/admin/demo-requests/:id/route",
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      const params = req.params as { id?: string };
      const id = typeof params.id === "string" ? params.id : "";

      if (!id) {
        return reply.code(400).send(
          createErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            req.id,
            { field: "id", reason: "Missing demo request id" },
            "Missing demo request id"
          )
        );
      }

      const parsed = routeBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send(
          createErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            req.id,
            { reason: parsed.error.message },
            "Invalid routing payload"
          )
        );
      }

      const existing = await prisma.demoRequest.findUnique({
        where: { id },
        select: {
          id: true,
          routingTarget: true,
          routingReason: true,
        },
      });

      if (!existing) {
        return reply.code(404).send(
          createErrorResponse(
            ErrorCode.NOT_FOUND,
            req.id,
            undefined,
            "Demo request not found"
          )
        );
      }

      const updated = await prisma.demoRequest.update({
        where: { id },
        data: {
          routingTarget: parsed.data.routingTarget,
          routingReason: parsed.data.routingReason ?? null,
          routedAt: new Date(),
          routedByUserId: req.user!.sub,
        },
        select: {
          id: true,
          routingTarget: true,
          routingReason: true,
          routedAt: true,
          routedByUserId: true,
          updatedAt: true,
        },
      });

      void emitPlatformAudit({
        action: "admin.demo_requests.route",
        outcome: "success",
        sourceApp: "API",
        actorUserId: req.user?.sub ?? null,
        resourceType: "demo_request",
        resourceId: updated.id,
        correlationId: req.id,
        metadata: {
          demoRequestId: updated.id,
          previousRoutingTarget: existing.routingTarget,
          nextRoutingTarget: updated.routingTarget,
          previousRoutingReason: existing.routingReason,
          nextRoutingReason: updated.routingReason,
          ipAddress: readIp(req),
          userAgent: readUserAgent(req),
        },
      }).catch(() => null);

      return reply.code(200).send({
        ok: true,
        item: updated,
      });
    }
  );

  app.post(
    "/v1/admin/demo-requests/:id/follow-up/send",
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      const params = req.params as { id?: string };
      const id = typeof params.id === "string" ? params.id : "";

      if (!id) {
        return reply.code(400).send(
          createErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            req.id,
            { field: "id", reason: "Missing demo request id" },
            "Missing demo request id"
          )
        );
      }

      const parsed = followUpSendBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send(
          createErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            req.id,
            { reason: parsed.error.message },
            "Invalid follow-up payload"
          )
        );
      }

      try {
        const item = await sendDemoFollowUpById({
          demoRequestId: id,
          actorUserId: req.user!.sub,
          forceStep: parsed.data.step,
        });

        void emitPlatformAudit({
          /*
           * PHASE 5 §3 (family A) — ACCEPTED BY A PROVIDER IS NOT DELIVERED.
           *
           * This row is written only after `sendDemoFollowUpById` has an
           * ACKNOWLEDGED provider outcome — an earlier phase already closed
           * the worse defect, where the step advanced regardless and a
           * prospect was recorded as having received a follow-up they never
           * got. But an acknowledgement is the provider saying it accepted
           * the message, not the recipient having received it, and this is
           * the row an operator reads when a prospect says they heard
           * nothing.
           *
           * The state fields say exactly that: the follow-up step really did
           * advance in storage (`resultingState`), and the reason names the
           * boundary the system can actually attest to. Confirmed delivery,
           * if it is ever known, arrives later from the provider webhook and
           * is a different event.
           */
          action: "admin.demo_requests.follow_up_send",
          outcome: "success",
          sourceApp: "API",
          actorUserId: req.user?.sub ?? null,
          actorAuthority: "PLATFORM_ADMIN",
          resourceType: "demo_request",
          resourceId: item.id,
          targetDisplay: item.organization ?? null,
          previousState: `STEP_${Math.max((item.followUpStep ?? 1) - 1, 0)}`,
          requestedState: `STEP_${item.followUpStep ?? 0}`,
          resultingState: `STEP_${item.followUpStep ?? 0}`,
          reasonCode: "PROVIDER_ACKNOWLEDGED_NOT_CONFIRMED_DELIVERED",
          correlationId: req.id,
          metadata: {
            demoRequestId: item.id,
            followUpStep: item.followUpStep,
            followUpStatus: item.followUpStatus,
            nextFollowUpAt: item.nextFollowUpAt,
            templateKey: item.lastFollowUpTemplateKey,
            ipAddress: readIp(req),
            userAgent: readUserAgent(req),
          },
        }).catch(() => null);

        return reply.code(200).send({
          ok: true,
          item,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "UNKNOWN_ERROR";
        return reply.code(400).send(
          createErrorResponse(
            ErrorCode.INVALID_REQUEST,
            req.id,
            { reason },
            "Unable to send follow-up"
          )
        );
      }
    }
  );

  app.post(
    "/v1/admin/demo-requests/follow-up/run",
    { preHandler: requirePlatformAdminOrInternalKey },
    async (req, reply) => {
      const parsed = runFollowUpBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send(
          createErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            req.id,
            { reason: parsed.error.message },
            "Invalid follow-up run payload"
          )
        );
      }

      const internalCall = isValidInternalKey(req);
      const actorUserId = internalCall ? null : (req.user?.sub ?? null);

      const result = await processDueDemoFollowUps({
        limit: parsed.data.limit,
        actorUserId,
      });

      void emitPlatformAudit({
        /*
         * PHASE 5 §4 — a batch where SOME sends failed is neither a success
         * nor an error, and calling it one of the two loses the fact an
         * operator needs. `error` on a run that delivered nine of ten reads as
         * a total failure; `success` on the same run hides the one that did
         * not go out. `partial` is the canonical word for exactly this.
         *
         * The service actor is also renamed to the `worker:` prefix the actor
         * derivation understands, so an internally-triggered run is typed
         * WORKER rather than falling through to SERVICE.
         */
        action: "admin.demo_requests.follow_up_run",
        outcome:
          result.failed > 0
            ? result.sent > 0
              ? "partial"
              : "error"
            : "success",
        sourceApp: internalCall ? "SYSTEM" : "API",
        actorUserId,
        actorAuthority: internalCall ? null : "PLATFORM_ADMIN",
        serviceActor: internalCall ? "worker:demo-follow-up" : null,
        actorDisplay: internalCall ? "Demo follow-up worker" : null,
        resourceType: "demo_request",
        resourceId: null,
        targetDisplay: "Due demo follow-ups",
        requestedState: `PROCESS_UP_TO_${parsed.data.limit}`,
        resultingState: `SENT_${result.sent}_FAILED_${result.failed}`,
        reasonCode: internalCall ? "SCHEDULED_RUN" : "OPERATOR_TRIGGERED_RUN",
        correlationId: req.id,
        metadata: {
          processed: result.processed,
          sent: result.sent,
          failed: result.failed,
          limit: parsed.data.limit,
          trigger: internalCall ? "internal_worker" : "admin_manual",
          ipAddress: readIp(req),
          userAgent: readUserAgent(req),
        },
      }).catch(() => null);

      return reply.code(200).send({
        ok: true,
        result,
      });
    }
  );
}