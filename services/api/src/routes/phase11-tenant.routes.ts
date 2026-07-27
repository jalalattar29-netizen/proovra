/**
 * PHASE 11 — production entry points that ESTABLISH the canonical authorities:
 *   POST /v1/deep-link/resolve   → the ONE deep-link resolution consumer
 *   GET  /v1/audit/tenant        → the ONE authorized tenant-audit query/export
 *
 * These do NOT re-implement policy: they compose `resolveDeepLink` (which itself
 * composes canonical authorization = lifecycle + live Org policy + ACTIVE
 * membership + capability) and `queryTenantAudit` (scope-pinned, DB-filtered).
 * Every outcome — allow and deny — emits ONE canonical tenant-audit envelope.
 * Denials use the anti-enumeration 404 and mutate nothing.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { INTERNAL_RESOURCE_TYPES, type InternalResourceType } from "@proovra/shared";

import { getAuthUserId } from "../auth.js";
import { requireAuth } from "../middleware/auth.js";
import { authorizeOrFail } from "../middleware/authorize.js";
import { resolveDeepLink } from "../services/identity/deep-link-resolution.service.js";
import { emitTenantAudit, queryTenantAudit } from "../services/audit/tenant-audit.service.js";

function sessionHash(req: FastifyRequest): string | null {
  return (req as FastifyRequest & { user?: { sessionIdHash?: string } }).user?.sessionIdHash ?? null;
}
function authMethod(req: FastifyRequest): string | null {
  return (req as FastifyRequest & { user?: { authMethod?: string } }).user?.authMethod ?? null;
}

export async function phase11TenantRoutes(app: FastifyInstance) {
  // ── §2 — canonical deep-link resolution (the ONE production consumer) ──────
  const ResolveBody = z.object({
    resourceType: z.enum(INTERNAL_RESOURCE_TYPES as unknown as [string, ...string[]]),
    resourceId: z.string().min(1).max(200),
    declaredWorkspaceId: z.string().uuid().nullable().optional(),
  });
  app.post("/v1/deep-link/resolve", { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = ResolveBody.parse(req.body ?? {});
    let actorUserId: string | null = null;
    try { actorUserId = getAuthUserId(req); } catch { actorUserId = null; }

    const decision = await resolveDeepLink(req, {
      resourceType: body.resourceType as InternalResourceType,
      resourceId: body.resourceId,
      declaredWorkspaceId: body.declaredWorkspaceId ?? null,
    });

    if (!decision.ok) {
      // Anti-enumeration: every denial is a bounded 404 — never leak existence
      // or the specific reason. Audit the denial (bounded reason only).
      await emitTenantAudit({
        action: "deep_link.resolve",
        outcome: "denied",
        denialReason: decision.reason,
        sourceApp: "API",
        actorUserId,
        sessionRefHash: sessionHash(req),
        authMethod: authMethod(req),
        resourceType: body.resourceType,
        resourceId: body.resourceId,
      }).catch(() => undefined);
      return reply.code(404).send({ error: { code: "not_found" } });
    }

    await emitTenantAudit({
      action: "deep_link.resolve",
      outcome: "success",
      sourceApp: "API",
      actorUserId: decision.actorUserId,
      workspaceId: decision.teamId,
      sessionRefHash: sessionHash(req),
      authMethod: authMethod(req),
      resourceType: decision.resourceType,
      resourceId: decision.resourceId,
    }).catch(() => undefined);

    // The authoritative Workspace comes from the PERSISTED resource — the client
    // navigates to it; it never carried authoritative tenant truth in the URL.
    return reply.send({ ok: true, workspaceId: decision.teamId, resourceType: decision.resourceType, resourceId: decision.resourceId });
  });

  // ── §4 — the ONE authorized tenant-audit query/export surface ─────────────
  const AuditQuery = z.object({
    teamId: z.string().uuid(),
    action: z.string().max(120).optional(),
    outcome: z.enum(["success", "denied", "error"]).optional(),
    resourceType: z.string().max(64).optional(),
    fromUtc: z.string().datetime().optional(),
    untilUtc: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursorId: z.string().uuid().optional(),
    export: z.coerce.boolean().optional(),
  });
  app.get("/v1/audit/tenant", { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const q = AuditQuery.parse(req.query ?? {});
    // Authorization BEFORE the query — the caller must hold the audit capability
    // on the PROVEN Workspace. Export shares the exact same gate + query.
    const auth = await authorizeOrFail(req, reply, {
      teamId: q.teamId,
      permission: (q.export ? "audit.export" : "audit.read") as never,
    });
    if (!auth) return; // authorizeOrFail already sent the canonical deny

    const page = await queryTenantAudit({
      scope: { kind: "WORKSPACE", workspaceId: auth.teamId }, // the PROVEN scope, never a client-declared tenant
      action: q.action ?? null,
      outcome: q.outcome ?? null,
      resourceType: q.resourceType ?? null,
      occurredFromUtc: q.fromUtc ? new Date(q.fromUtc) : null,
      occurredUntilUtc: q.untilUtc ? new Date(q.untilUtc) : null,
      limit: q.limit,
      cursorId: q.cursorId ?? null,
    });
    return reply.send(page);
  });
}
