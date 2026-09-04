// Read-only admin surface for Contact Sales submissions.
//
// Mirrors the demo-requests admin shape but intentionally minimal in
// this phase: list + detail + status patch only. No follow-up, no
// routing, no re-send. Operators triage from the table view.
//
// TENANT_SCOPE_EXCEPTION: platform_admin_global
//   These routes are the platform-admin-only global lead queue for
//   the marketing-side Contact Sales form. They are intentionally NOT
//   workspace / team scoped — `contact_sales_requests` rows have no
//   `team_id` foreign key by design (the visitor is anonymous at
//   submission time and no workspace exists yet). Every endpoint is
//   gated by `requirePlatformAdmin`, which restricts access to
//   PROOVRA platform operators identified by their global admin role
//   on the user record. The handlers never read tenant evidence,
//   cases, reports, or any per-team data — only the standalone
//   `contact_sales_requests` table. Every PATCH writes a
//   `platform_audit_log` entry with the canonical chain hash so
//   admin actions remain auditable. Cross-team data exposure is
//   structurally impossible because the schema has no tenant
//   dimension for this table.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
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

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  status: z
    .enum(["NEW", "REVIEWED", "CONTACTED", "QUALIFIED", "REJECTED", "ARCHIVED"])
    .optional(),
  priority: z.enum(["LOW", "NORMAL", "HIGH"]).optional(),
  isSpam: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  search: z.string().trim().max(200).optional(),
});

const STATUS = z.enum(["NEW", "REVIEWED", "CONTACTED", "QUALIFIED", "REJECTED", "ARCHIVED"]);

const updateBodySchema = z.object({
  status: STATUS.optional(),
  priority: z.enum(["LOW", "NORMAL", "HIGH"]).optional(),
  notes: z.string().max(5000).nullable().optional(),
  /**
   * The status the operator was LOOKING AT when they clicked.
   *
   * Two operators triaging the same queue is normal, and the second click
   * used to win silently: the page showed NEW, the row had become REJECTED
   * under it, and "mark contacted" reopened a rejected request without
   * anyone knowing. When this is sent and no longer matches the row, the
   * change is refused with `stale_status` and the page reloads.
   */
  expectedStatus: STATUS.optional(),
});

function readUserAgent(req: FastifyRequest): string | undefined {
  const value = req.headers["user-agent"];
  return Array.isArray(value) ? value[0] : value;
}

export async function adminContactSalesRoutes(app: FastifyInstance) {
  app.get(
    "/v1/admin/contact-sales",
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      const query = listQuerySchema.safeParse(req.query);
      if (!query.success) {
        return reply
          .code(400)
          .send(createErrorResponse(ErrorCode.VALIDATION_ERROR, "Invalid query"));
      }

      const where: Record<string, unknown> = {};
      if (query.data.status) where.status = query.data.status;
      if (query.data.priority) where.priority = query.data.priority;
      if (typeof query.data.isSpam === "boolean") where.isSpam = query.data.isSpam;
      if (query.data.search) {
        const s = query.data.search;
        where.OR = [
          { workEmail: { contains: s.toLowerCase() } },
          { fullName: { contains: s, mode: "insensitive" } },
          { organization: { contains: s, mode: "insensitive" } },
        ];
      }

      const [rows, total, summary] = await Promise.all([
        prisma.contactSalesRequest.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: query.data.limit,
          select: {
            id: true,
            fullName: true,
            workEmail: true,
            organization: true,
            jobTitle: true,
            country: true,
            teamSize: true,
            discussionTopic: true,
            stage: true,
            deploymentTimeline: true,
            estimatedUsers: true,
            sourcePage: true,
            sourcePath: true,
            status: true,
            priority: true,
            isSpam: true,
            emailSentAt: true,
            reviewedAt: true,
            reviewedByUserId: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
        prisma.contactSalesRequest.count({ where }),
        prisma.contactSalesRequest.groupBy({
          by: ["status"],
          _count: { status: true },
        }),
      ]);

      const summaryByStatus = {
        NEW: 0,
        REVIEWED: 0,
        CONTACTED: 0,
        QUALIFIED: 0,
        REJECTED: 0,
        ARCHIVED: 0,
      } as Record<string, number>;
      for (const row of summary) {
        summaryByStatus[row.status] = row._count.status;
      }

      return reply.send({
        ok: true,
        data: {
          items: rows,
          total,
          summary: summaryByStatus,
        },
      });
    }
  );

  app.get(
    "/v1/admin/contact-sales/:id",
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      const params = z
        .object({ id: z.string().uuid() })
        .safeParse(req.params);
      if (!params.success) {
        return reply
          .code(400)
          .send(createErrorResponse(ErrorCode.VALIDATION_ERROR, "Invalid id"));
      }

      const row = await prisma.contactSalesRequest.findUnique({
        where: { id: params.data.id },
      });
      if (!row) {
        return reply
          .code(404)
          .send(createErrorResponse(ErrorCode.NOT_FOUND, "Not found"));
      }

      return reply.send({ ok: true, data: row });
    }
  );

  app.patch(
    "/v1/admin/contact-sales/:id",
    { preHandler: requirePlatformAdmin },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z
        .object({ id: z.string().uuid() })
        .safeParse(req.params);
      if (!params.success) {
        return reply
          .code(400)
          .send(createErrorResponse(ErrorCode.VALIDATION_ERROR, "Invalid id"));
      }
      const body = updateBodySchema.safeParse(req.body);
      if (!body.success) {
        return reply
          .code(400)
          .send(createErrorResponse(ErrorCode.VALIDATION_ERROR, "Invalid body"));
      }

      const existing = await prisma.contactSalesRequest.findUnique({
        where: { id: params.data.id },
      });
      if (!existing) {
        return reply
          .code(404)
          .send(createErrorResponse(ErrorCode.NOT_FOUND, "Not found"));
      }

      // `req.user.sub` is what requireAuth populates. This used to read
      // `req.userId`, which nothing ever sets — so every reviewedByUserId was
      // null and every audit row on this route named no actor. Found by the
      // transition proof, not by the code that had been reading it for a year.
      const userId = req.user?.sub ?? null;
      const from = existing.status as CommercialRequestStatus;

      /**
       * A status change is a TRANSITION, and only the edges in the shared
       * table are transitions. The API is the authority here — the page
       * offers only allowed moves, but a page is not a guard.
       *
       * A refusal is audited too: an operator who keeps hitting 409 is either
       * racing a colleague or working from a stale tab, and both are worth
       * seeing in the log.
       */
      const refuse = async (
        code: string,
        message: string,
        extra: Record<string, unknown>,
      ) => {
        await emitPlatformAudit({
          action: "ADMIN_CONTACT_SALES_UPDATE",
          outcome: "denied",
          sourceApp: "API",
          actorUserId: userId ?? null,
          actorAuthority: "PLATFORM_ADMIN",
          resourceType: "contact_sales_request",
          resourceId: existing.id,
          targetDisplay: existing.organization,
          // PHASE 5 §2 — a refusal records what was ASKED FOR and leaves
          // `resultingState` null, because storage did not change. Writing the
          // current status into `resultingState` here would make a refused
          // transition read as a successful no-op.
          previousState: from,
          requestedState:
            typeof extra["to"] === "string"
              ? (extra["to"] as string)
              : typeof body.data.status === "string"
                ? body.data.status
                : null,
          reasonCode: code,
          correlationId: req.id,
          metadata: { reason: code, ...extra },
        });
        return reply.code(409).send({
          error: { code, message, requestId: req.id, details: extra },
        });
      };

      if (body.data.expectedStatus !== undefined && body.data.expectedStatus !== from) {
        return refuse(
          COMMERCIAL_TRANSITION_REFUSALS.STALE,
          "This inquiry changed since you loaded it. Reload to see its current status.",
          { expected: body.data.expectedStatus, actual: from },
        );
      }

      const to =
        body.data.status !== undefined && body.data.status !== from
          ? (body.data.status as CommercialRequestStatus)
          : null;
      if (to !== null && commercialTransitionRule(from, to) === null) {
        return refuse(
          COMMERCIAL_TRANSITION_REFUSALS.NOT_ALLOWED,
          `An inquiry cannot move from ${from} to ${to}.`,
          { from, to },
        );
      }

      const reviewed =
        to !== null
          ? { reviewedAt: new Date(), reviewedByUserId: userId ?? null }
          : {};

      /**
       * Compare-and-set on the status the transition was validated against.
       * A plain `update` lets two concurrent PATCHes both succeed, the second
       * silently overwriting the first; matching on the status read above
       * means exactly one of them changes the row and the other is told it
       * is stale.
       */
      const changed = await prisma.contactSalesRequest.updateMany({
        where: { id: params.data.id, status: existing.status },
        data: {
          ...(to !== null ? { status: to } : {}),
          priority: body.data.priority,
          notes: body.data.notes ?? undefined,
          ...reviewed,
        },
      });
      if (changed.count === 0) {
        return refuse(
          COMMERCIAL_TRANSITION_REFUSALS.STALE,
          "Another operator changed this inquiry at the same time. Reload to see its current status.",
          { expected: from },
        );
      }
      const updated = await prisma.contactSalesRequest.findUniqueOrThrow({
        where: { id: params.data.id },
      });

      await emitPlatformAudit({
        // PHASE 5 §4 — this stays `success`, and the distinction is carried by
        // the STATE fields rather than by the outcome.
        //
        // A notes-or-priority-only PATCH really does change the row: the
        // compare-and-set updated it. Calling that `no_op` would tell an
        // operator looking for "who edited this note" that nothing happened.
        // `no_op` is for a request that changed nothing AT ALL, which on this
        // route is already a 409 refusal rather than a 200.
        //
        // What the row says instead is that no TRANSITION occurred:
        // `requestedState` is null and `previousState` equals `resultingState`.
        action: "ADMIN_CONTACT_SALES_UPDATE",
        outcome: "success",
        sourceApp: "API",
        actorUserId: userId ?? null,
        actorAuthority: "PLATFORM_ADMIN",
        resourceType: "contact_sales_request",
        resourceId: existing.id,
        // Named by who asked, not by an id an operator would have to resolve.
        targetDisplay: existing.organization,
        // PHASE 5 §2 — the three states come from three DIFFERENT sources, and
        // that is the point. `from` is the status read from storage BEFORE the
        // compare-and-set; `to` is what the request asked for; `updated.status`
        // is re-read from storage AFTER it. Deriving the resulting state from
        // the request intent would make a lost compare-and-set indistinguishable
        // from a winning one.
        previousState: from,
        requestedState: to,
        resultingState: updated.status,
        reasonCode: to !== null ? "OPERATOR_TRANSITION" : "NO_STATUS_CHANGE",
        correlationId: req.id,
        metadata: {
          ipAddress: req.ip ?? null,
          userAgent: readUserAgent(req) ?? null,
          previous: {
            status: existing.status,
            priority: existing.priority,
          },
          next: {
            status: updated.status,
            priority: updated.priority,
          },
          ...(to !== null ? { transition: { from, to } } : {}),
        },
      });

      return reply.send({ ok: true, data: updated });
    }
  );
}
