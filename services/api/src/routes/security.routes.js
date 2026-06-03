/**
 * Phase 11 — Security operations routes.
 *
 *   GET  /v1/security/summary?teamId         — counts (scans + events)
 *   GET  /v1/security/scans?teamId&status    — workspace scan list
 *   GET  /v1/security/events?teamId&severity — workspace security event list
 *
 * All routes:
 *   - require authentication AND workspace membership
 *   - require OWNER/ADMIN role (security ops are admin-only)
 *   - NEVER surface raw payloads, keys, ciphertexts, or scanner internals
 *   - NEVER leak data from a different workspace
 *
 * Public verify, external intake, and report-v2 do NOT read these.
 */
import { z } from "zod";
import { FILE_SECURITY_SCAN_STATUSES, SECURITY_EVENT_SEVERITIES, SECURITY_EVENT_TYPES, } from "@proovra/shared";
import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { countScansByTeam, isMalwareScanningEnabled, listScansForTeam, projectFileSecurityScan, } from "../services/security/file-security-scan.service.js";
import { countSecurityEventsByTeam, listSecurityEvents, projectSecurityEvent, } from "../services/security/security-event.service.js";
async function requireAdminMember(req, reply, teamId) {
    const userId = getAuthUserId(req);
    const membership = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId, userId } },
    });
    if (!membership) {
        reply.code(404).send({ error: { code: "not_found" } });
        return null;
    }
    if (membership.role !== "OWNER" && membership.role !== "ADMIN") {
        // 404 (not 403) — security ops surface should not enumerate roles.
        reply.code(404).send({ error: { code: "not_found" } });
        return null;
    }
    return { userId };
}
export async function securityRoutes(app) {
    app.get("/v1/security/summary", { preHandler: requireAuth }, async (req, reply) => {
        const query = z
            .object({
            teamId: z.string().uuid(),
            sinceDays: z.coerce.number().int().min(1).max(365).optional(),
        })
            .parse(req.query ?? {});
        const ok = await requireAdminMember(req, reply, query.teamId);
        if (!ok)
            return;
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
    });
    app.get("/v1/security/scans", { preHandler: requireAuth }, async (req, reply) => {
        const query = z
            .object({
            teamId: z.string().uuid(),
            status: z.enum(FILE_SECURITY_SCAN_STATUSES).optional(),
            limit: z.coerce.number().int().min(1).max(200).optional(),
        })
            .parse(req.query ?? {});
        const ok = await requireAdminMember(req, reply, query.teamId);
        if (!ok)
            return;
        const rows = await listScansForTeam({
            teamId: query.teamId,
            status: query.status,
            limit: query.limit,
        });
        return reply
            .code(200)
            .send({ scans: rows.map(projectFileSecurityScan) });
    });
    app.get("/v1/security/events", { preHandler: requireAuth }, async (req, reply) => {
        const query = z
            .object({
            teamId: z.string().uuid(),
            severity: z.enum(SECURITY_EVENT_SEVERITIES).optional(),
            eventType: z.enum(SECURITY_EVENT_TYPES).optional(),
            limit: z.coerce.number().int().min(1).max(500).optional(),
        })
            .parse(req.query ?? {});
        const ok = await requireAdminMember(req, reply, query.teamId);
        if (!ok)
            return;
        const rows = await listSecurityEvents({
            teamId: query.teamId,
            severity: query.severity,
            eventType: query.eventType,
            limit: query.limit,
        });
        return reply
            .code(200)
            .send({ events: rows.map(projectSecurityEvent) });
    });
}
