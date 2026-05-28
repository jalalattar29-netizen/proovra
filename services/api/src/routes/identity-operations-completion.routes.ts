/**
 * Phase P1.1 — Identity operations completion routes.
 *
 * Closes the four honest-scope follow-ups from P1:
 *
 *   1. SCIM drift detection + reconciliation:
 *      GET  /v1/scim/reconciliation/preview?teamId=...
 *      POST /v1/scim/reconciliation/execute
 *      GET  /v1/scim/sync-failures?teamId=...
 *      POST /v1/scim/sync-failures/:id/replay
 *
 *   2. Visual SAML attribute mapping:
 *      GET  /v1/saml/mapping/schema
 *      GET  /v1/saml/mapping/current?teamId=...&connectionId=...
 *      POST /v1/saml/mapping/preview
 *      PUT  /v1/saml/mapping
 *
 *   3. SSO health dashboard:
 *      GET  /v1/sso/health?teamId=...
 *
 *   4. Bounded session identity timeline:
 *      GET  /v1/identity/sessions/:sessionId/timeline?teamId=...
 *
 * Hard rules:
 *   * Every endpoint requires auth.
 *   * Every endpoint is workspace-scoped (`teamId` mandatory).
 *   * Caller must be an ACTIVE TeamMember with identity-admin
 *     capability; non-members get a 404 (anti-enumeration).
 *   * Destructive endpoints route through `requireStepUpForSensitiveAction`.
 *   * No secrets or raw assertions in responses.
 *   * Audit event emission lives in the service layer.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { prisma } from "../db.js";
import { getAuthUserId } from "../auth.js";
import { requireAuth } from "../middleware/auth.js";
import { safeEmitSecurityEvent } from "../services/security/security-event.service.js";
import {
  detectScimDrift,
  executeScimReconciliation,
  listScimSyncFailures,
  replayScimSyncFailure,
} from "../services/access-control/scim-reconciliation.service.js";
import {
  buildSsoHealthSnapshot,
  type SsoHealthSnapshot,
} from "../services/security/sso-health.service.js";
import {
  getSamlMappingSchema,
  getCurrentSamlMapping,
  previewSamlMapping,
  updateSamlMapping,
  SAML_MAPPING_PRIVILEGE_PURPOSE,
} from "../services/security/saml-mapping.service.js";
import {
  buildIdentitySessionTimeline,
  type IdentitySessionTimeline,
} from "../services/security/session-timeline.service.js";
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";
import { bump } from "../services/ops/metrics.service.js";

// ---------------------------------------------------------------------------
// Common admin gate (workspace-scoped, anti-enumeration 404)
// ---------------------------------------------------------------------------

type AdminContext = { userId: string };

async function requireIdentityAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<AdminContext | null> {
  const userId = getAuthUserId(req);
  const member = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { id: true, status: true, role: true },
  });
  if (!member) {
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  if (member.status !== "ACTIVE") {
    reply.code(403).send({ error: { code: "member_inactive" } });
    return null;
  }
  // Identity operations require OWNER or ADMIN. The Phase 17 access
  // policy engine could also grant identity-delegated permission, but
  // for the P1.1 completion surface we keep the gate tight to role.
  if (member.role !== "OWNER" && member.role !== "ADMIN") {
    reply.code(403).send({
      error: {
        code: "permission_denied",
        reason: "identity_ops_require_admin_role",
      },
    });
    return null;
  }
  return { userId };
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

export async function identityOperationsCompletionRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------
  // SCIM drift preview
  // ---------------------------------------------------------------------
  app.get(
    "/v1/scim/reconciliation/preview",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ctx = await requireIdentityAdmin(req, reply, q.teamId);
      if (!ctx) return;
      const report = await detectScimDrift({
        teamId: q.teamId,
        actorUserId: ctx.userId,
      });
      return reply.code(200).send({ report });
    },
  );

  // ---------------------------------------------------------------------
  // SCIM drift execute (step-up gated)
  // ---------------------------------------------------------------------
  app.post(
    "/v1/scim/reconciliation/execute",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({
          teamId: z.string().uuid(),
          previewId: z.string().min(1).max(200),
          itemIds: z.array(z.string().min(1).max(200)).min(1).max(200),
        })
        .parse(req.body ?? {});
      const ctx = await requireIdentityAdmin(req, reply, body.teamId);
      if (!ctx) return;

      // Step-up gate. Reconciliation can demote members + revoke
      // tokens — destructive. Always require step-up.
      const stepUp = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: body.teamId,
        userId: ctx.userId,
        purpose: "SCIM_RECONCILIATION_EXECUTE",
        resourceKind: "scim_reconciliation_preview",
        resourceId: body.previewId,
      });
      if (stepUp.sent) return;

      const result = await executeScimReconciliation({
        teamId: body.teamId,
        actorUserId: ctx.userId,
        previewId: body.previewId,
        itemIds: body.itemIds,
      });
      if (!result.ok) {
        return reply.code(409).send({ error: { code: result.code, message: result.message } });
      }
      return reply.code(200).send({ result });
    },
  );

  // ---------------------------------------------------------------------
  // SCIM failed-sync list + replay
  // ---------------------------------------------------------------------
  app.get(
    "/v1/scim/sync-failures",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({
          teamId: z.string().uuid(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});
      const ctx = await requireIdentityAdmin(req, reply, q.teamId);
      if (!ctx) return;
      const failures = await listScimSyncFailures({
        teamId: q.teamId,
        limit: q.limit,
      });
      return reply.code(200).send({ failures });
    },
  );

  app.post(
    "/v1/scim/sync-failures/:id/replay",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({ teamId: z.string().uuid() })
        .parse(req.body ?? {});
      const ctx = await requireIdentityAdmin(req, reply, body.teamId);
      if (!ctx) return;
      const result = await replayScimSyncFailure({
        teamId: body.teamId,
        failureId: params.id,
        actorUserId: ctx.userId,
      });
      if (!result.ok) {
        const statusCode = result.code === "not_found" ? 404 : 409;
        return reply
          .code(statusCode)
          .send({ error: { code: result.code, message: result.message } });
      }
      return reply.code(200).send({ result });
    },
  );

  // ---------------------------------------------------------------------
  // SAML mapping — schema / current / preview / update
  // ---------------------------------------------------------------------
  app.get(
    "/v1/saml/mapping/schema",
    { preHandler: requireAuth },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      // Schema is workspace-independent (it describes the SHAPE of the
      // mapping configuration, not a specific workspace's values).
      // Auth is still required to avoid enumeration.
      const schema = getSamlMappingSchema();
      return reply.code(200).send({ schema });
    },
  );

  app.get(
    "/v1/saml/mapping/current",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({
          teamId: z.string().uuid(),
          connectionId: z.string().uuid(),
        })
        .parse(req.query ?? {});
      const ctx = await requireIdentityAdmin(req, reply, q.teamId);
      if (!ctx) return;
      const current = await getCurrentSamlMapping({
        teamId: q.teamId,
        connectionId: q.connectionId,
      });
      if (!current) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      return reply.code(200).send({ current });
    },
  );

  app.post(
    "/v1/saml/mapping/preview",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({
          teamId: z.string().uuid(),
          connectionId: z.string().uuid(),
          mapping: z
            .object({
              email: z.string().min(1).max(200).nullable().optional(),
              name: z.string().min(1).max(200).nullable().optional(),
              externalId: z.string().min(1).max(200).nullable().optional(),
              groupClaim: z.string().min(1).max(200).nullable().optional(),
              defaultRole: z
                .enum(["MEMBER", "VIEWER"])
                .nullable()
                .optional(),
              groupRoleMap: z
                .array(
                  z.object({
                    group: z.string().min(1).max(200),
                    role: z.enum(["OWNER", "ADMIN", "MEMBER", "VIEWER"]),
                  }),
                )
                .max(50)
                .nullable()
                .optional(),
            })
            .strict(),
          sampleAttributes: z
            .record(z.string(), z.string().max(1000))
            .optional(),
        })
        .parse(req.body ?? {});
      const ctx = await requireIdentityAdmin(req, reply, body.teamId);
      if (!ctx) return;
      const preview = await previewSamlMapping({
        teamId: body.teamId,
        connectionId: body.connectionId,
        actorUserId: ctx.userId,
        mapping: body.mapping,
        sampleAttributes: body.sampleAttributes ?? {},
      });
      if (!preview.ok) {
        return reply
          .code(400)
          .send({ error: { code: preview.code, message: preview.message } });
      }
      return reply.code(200).send({ preview });
    },
  );

  app.put(
    "/v1/saml/mapping",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({
          teamId: z.string().uuid(),
          connectionId: z.string().uuid(),
          mapping: z
            .object({
              email: z.string().min(1).max(200).nullable().optional(),
              name: z.string().min(1).max(200).nullable().optional(),
              externalId: z.string().min(1).max(200).nullable().optional(),
              groupClaim: z.string().min(1).max(200).nullable().optional(),
              defaultRole: z
                .enum(["MEMBER", "VIEWER"])
                .nullable()
                .optional(),
              groupRoleMap: z
                .array(
                  z.object({
                    group: z.string().min(1).max(200),
                    role: z.enum(["OWNER", "ADMIN", "MEMBER", "VIEWER"]),
                  }),
                )
                .max(50)
                .nullable()
                .optional(),
            })
            .strict(),
          /**
           * Frontend-provided assertion that the operator has reviewed
           * the preview. The backend uses this to require step-up
           * when the mapping would grant elevated privileges.
           */
          acknowledgePrivilegeImpact: z.boolean().optional(),
        })
        .parse(req.body ?? {});
      const ctx = await requireIdentityAdmin(req, reply, body.teamId);
      if (!ctx) return;

      // Re-run the preview server-side to determine if the new
      // mapping introduces privilege-affecting changes.
      const preview = await previewSamlMapping({
        teamId: body.teamId,
        connectionId: body.connectionId,
        actorUserId: ctx.userId,
        mapping: body.mapping,
        sampleAttributes: {},
      });
      if (!preview.ok) {
        return reply
          .code(400)
          .send({ error: { code: preview.code, message: preview.message } });
      }

      // Step-up gate for privilege-affecting mappings.
      if (preview.preview.privilegeAffecting) {
        const stepUp = await requireStepUpForSensitiveAction({
          req,
          reply,
          teamId: body.teamId,
          userId: ctx.userId,
          purpose: SAML_MAPPING_PRIVILEGE_PURPOSE,
          resourceKind: "saml_connection",
          resourceId: body.connectionId,
        });
        if (stepUp.sent) return;
      }

      const result = await updateSamlMapping({
        teamId: body.teamId,
        connectionId: body.connectionId,
        actorUserId: ctx.userId,
        mapping: body.mapping,
        privilegeAffecting: preview.preview.privilegeAffecting,
      });
      if (!result.ok) {
        return reply
          .code(400)
          .send({ error: { code: result.code, message: result.message } });
      }
      return reply.code(200).send({ result });
    },
  );

  // ---------------------------------------------------------------------
  // SSO health snapshot
  // ---------------------------------------------------------------------
  app.get(
    "/v1/sso/health",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ctx = await requireIdentityAdmin(req, reply, q.teamId);
      if (!ctx) return;
      const snapshot: SsoHealthSnapshot = await buildSsoHealthSnapshot({
        teamId: q.teamId,
      });
      bump("sso_health_checked_total");
      if (snapshot.overallStatus === "DEGRADED") {
        bump("sso_health_degraded_total");
      }
      safeEmitSecurityEvent({
        teamId: q.teamId,
        eventType: "sso_health_checked",
        severity: snapshot.overallStatus === "DEGRADED" ? "WARNING" : "INFO",
        details: {
          actorUserId: ctx.userId,
          overallStatus: snapshot.overallStatus,
          connectionCount: snapshot.connections.length,
        },
      });
      return reply.code(200).send({ snapshot });
    },
  );

  // ---------------------------------------------------------------------
  // Bounded session identity timeline
  // ---------------------------------------------------------------------
  app.get(
    "/v1/identity/sessions/:sessionId/timeline",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z
        .object({ sessionId: z.string().uuid() })
        .parse(req.params);
      const q = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ctx = await requireIdentityAdmin(req, reply, q.teamId);
      if (!ctx) return;
      const timeline: IdentitySessionTimeline =
        await buildIdentitySessionTimeline({
          teamId: q.teamId,
          sessionId: params.sessionId,
          actorUserId: ctx.userId,
        });
      bump("identity_session_timeline_viewed_total");
      safeEmitSecurityEvent({
        teamId: q.teamId,
        eventType: "identity_session_timeline_viewed",
        severity: "INFO",
        details: {
          actorUserId: ctx.userId,
          sessionId: params.sessionId,
          eventCount: timeline.events.length,
        },
      });
      return reply.code(200).send({ timeline });
    },
  );
}
