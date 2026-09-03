/**
 * Phase 11 — Security operations routes.
 *
 *   GET  /v1/security/summary?teamId         — counts (scans + events)
 *   GET  /v1/security/scans?teamId&status    — workspace scan list
 *   GET  /v1/security/events?teamId&severity&eventType&limit&cursor
 *        — workspace security event list, one keyset page at a time;
 *          replies { events, nextCursor, hasMore }
 *
 * All routes:
 *   - require authentication AND workspace membership
 *   - require OWNER/ADMIN role (security ops are admin-only)
 *   - NEVER surface raw payloads, keys, ciphertexts, or scanner internals
 *   - NEVER leak data from a different workspace
 *
 * Public verify, external intake, and report-v2 do NOT read these.
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";
import {
  FILE_SECURITY_SCAN_STATUSES,
  SECURITY_EVENT_SEVERITIES,
  SECURITY_EVENT_TYPES,
  type FileSecurityScanStatus,
  type SecurityEventSeverity,
  type SecurityEventType,
} from "@proovra/shared";

import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { decodeKeysetCursor } from "../services/pagination/keyset-cursor.js";
import { authorizeOrFail } from "../middleware/authorize.js";
import {
  countScansByTeam,
  isMalwareScanningEnabled,
  listScansForTeam,
  projectFileSecurityScan,
} from "../services/security/file-security-scan.service.js";
import {
  countSecurityEventsByTeam,
  listSecurityEvents,
  projectSecurityEvent,
} from "../services/security/security-event.service.js";

/**
 * PHASE 1 AUTHORIZATION CLOSURE (2026-07-21) — canonical admin gate.
 * Routes through authorizeOrFail (ACTIVE membership + org lifecycle +
 * `identity.org_policy.read` capability + fail-closed + anti-enumeration),
 * THEN preserves the stricter OWNER/ADMIN-only restriction (identity.org_
 * policy.read is not admin-exclusive, so the role check remains, reading role
 * from an informational lookup). The security-ops surface returns 404 for
 * every denial so it never enumerates roles/records.
 */
async function requireAdminMember(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<{ userId: string } | null> {
  const outcome = await authorizeOrFail(req, reply, {
    teamId,
    permission: "identity.org_policy.read",
    antiEnumeration: true,
  });
  if (!outcome) return null;
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId: outcome.actorUserId } },
    select: { role: true },
  });
  if (!membership || (membership.role !== "OWNER" && membership.role !== "ADMIN")) {
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  return { userId: outcome.actorUserId };
}

export async function securityRoutes(app: FastifyInstance) {
  app.get(
    "/v1/security/summary",
    { preHandler: requireAuth },
    async (req, reply) => {
      const query = z
        .object({
          teamId: z.string().uuid(),
          sinceDays: z.coerce.number().int().min(1).max(365).optional(),
        })
        .parse(req.query ?? {});
      const ok = await requireAdminMember(req, reply, query.teamId);
      if (!ok) return;

      const [scanCounts, eventCounts] = await Promise.all([
        countScansByTeam({
          teamId: query.teamId,
          sinceDays: query.sinceDays,
        }),
        countSecurityEventsByTeam({
          teamId: query.teamId,
          sinceDays: query.sinceDays,
        }),
      ]);
      return reply.code(200).send({
        malwareScanningEnabled: isMalwareScanningEnabled(),
        scanCounts,
        eventCounts,
        sinceDays: query.sinceDays ?? 30,
      });
    },
  );

  app.get(
    "/v1/security/scans",
    { preHandler: requireAuth },
    async (req, reply) => {
      const query = z
        .object({
          teamId: z.string().uuid(),
          status: z.enum(FILE_SECURITY_SCAN_STATUSES).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});
      const ok = await requireAdminMember(req, reply, query.teamId);
      if (!ok) return;

      const rows = await listScansForTeam({
        teamId: query.teamId,
        status: query.status as FileSecurityScanStatus | undefined,
        limit: query.limit,
      });
      return reply
        .code(200)
        .send({ scans: rows.map(projectFileSecurityScan) });
    },
  );

  app.get(
    "/v1/security/events",
    { preHandler: requireAuth },
    async (req, reply) => {
      const query = z
        .object({
          teamId: z.string().uuid(),
          severity: z.enum(SECURITY_EVENT_SEVERITIES).optional(),
          eventType: z.enum(SECURITY_EVENT_TYPES).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
          /** Opaque keyset cursor from a previous page's `nextCursor`. */
          cursor: z.string().trim().min(1).max(512).optional(),
        })
        .parse(req.query ?? {});
      const ok = await requireAdminMember(req, reply, query.teamId);
      if (!ok) return;
      const after = decodeKeysetCursor(query.cursor);
      if (after === null) {
        return reply.code(400).send({
          error: { code: "validation_error", reason: "cursor does not decode" },
        });
      }

      const page = await listSecurityEvents({
        teamId: query.teamId,
        severity: query.severity as SecurityEventSeverity | undefined,
        eventType: query.eventType as SecurityEventType | undefined,
        limit: query.limit,
        ...(after ? { after } : {}),
      });
      return reply.code(200).send({
        events: page.rows.map(projectSecurityEvent),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      });
    },
  );
}
