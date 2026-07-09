import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { createErrorResponse, ErrorCode } from "../errors.js";
import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";
import {
  buildPlatformTimeline,
  type TimelineSeverity,
  type TimelineSource,
} from "../services/admin/timeline.service.js";

/**
 * PROOVRA Platform Admin (item J) — Global PLATFORM Timeline route.
 *
 * READ-ONLY, PLATFORM-ADMIN only. Exposes a single merged chronological feed
 * across platform-operational sources (admin audit, org audit, security
 * events, operational incidents, selected billing/team analytics events).
 *
 * TENANT_SCOPE_EXCEPTION: platform_admin_global
 *   This route DELIBERATELY reads across every tenant. It is gated by
 *   `requirePlatformAdmin`; no per-workspace scope is applied. The exception
 *   is intentional and mirrors admin-security.routes.ts. It surfaces NO
 *   secrets, NO raw/hashed IPs, NO tokens, and NO free-form metadata.
 *
 * SEPARATION: this is the PLATFORM operational timeline. It is NOT the
 * evidence custody timeline — the service never reads Evidence custody chains.
 */

const SOURCES = [
  "admin_audit",
  "organization_audit",
  "security_event",
  "operational_incident",
  "analytics_event",
] as const;

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().trim().min(1).max(64).optional(),
  source: z.enum(SOURCES).optional(),
  severity: z.enum(["critical", "high", "medium", "low"]).optional(),
  organizationId: z.string().uuid().optional(),
});

export async function adminTimelineRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /v1/admin/timeline — merged platform operational timeline.
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/admin/timeline",
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      const parsed = querySchema.safeParse(req.query ?? {});
      if (!parsed.success) {
        return reply.code(400).send(
          createErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            req.id,
            { reason: parsed.error.message },
            "Invalid timeline query",
          ),
        );
      }

      const { limit, cursor, source, severity, organizationId } = parsed.data;

      const result = await buildPlatformTimeline({
        limit,
        cursor: cursor ?? null,
        source: (source as TimelineSource | undefined) ?? null,
        severity: (severity as TimelineSeverity | undefined) ?? null,
        organizationId: organizationId ?? null,
      });

      return reply.code(200).send(result);
    },
  );
}

export default adminTimelineRoutes;
