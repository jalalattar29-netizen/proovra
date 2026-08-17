/**
 * Phase 19 / PHASE 13 — the request-layer helpers the identity-security route
 * family shares.
 *
 * These moved out of `identity-security.routes.ts` when the NEW-058 contact
 * factor enrolment routes were extracted into their own plugin. They live in a
 * module of their own rather than being exported from one route file and
 * imported by the other, so neither route module depends on the other and no
 * import cycle can form.
 *
 * Nothing here is business logic. Each function answers a question about the
 * REQUEST — who is calling, from where, may they act in this workspace — and
 * every lifecycle and security rule stays in its service.
 */

import type { FastifyReply, FastifyRequest } from "fastify";

import { getAuthUserId } from "../auth.js";
import { emitPlatformAudit } from "../services/audit/tenant-audit.service.js";
import { prisma } from "../db.js";
import { evaluateMemberAccess } from "../services/identity/access-policy.service.js";

/**
 * PHASE 11 §3 Batch B — D-5 personal Security Center surfaces carry NO
 * teamId (operator's own account scope; see the section comment above) →
 * genuinely GLOBAL platform events, routed through `emitPlatformAudit`.
 */
export function auditIdentitySecurityEvent(
  req: FastifyRequest,
  params: {
    userId: string;
    action: string;
    outcome: "success" | "failure" | "blocked";
    resourceType: string;
    resourceId: string;
    metadata?: Record<string, unknown>;
    ip: string | null;
    ua: string | null;
  },
): void {
  const outcome =
    params.outcome === "failure" ? "error" : params.outcome === "blocked" ? "denied" : "success";
  const reason = params.metadata?.["reason"];
  void emitPlatformAudit({
    action: params.action,
    outcome,
    denialReason: outcome !== "success" ? (typeof reason === "string" ? reason : params.action) : null,
    sourceApp: "API",
    actorUserId: params.userId,
    resourceType: params.resourceType,
    resourceId: params.resourceId,
    correlationId: req.id,
    metadata: { ...(params.metadata ?? {}), ipAddress: params.ip, userAgent: params.ua },
  }).catch(() => null);
}

export function requestIp(req: FastifyRequest): string | null {
  const raw = (req.ip ?? "").trim();
  return raw.length > 0 ? raw : null;
}

export function requestUa(req: FastifyRequest): string | null {
  const raw = req.headers["user-agent"];
  if (typeof raw !== "string") return null;
  return raw.trim().slice(0, 512) || null;
}

/**
 * Anti-enumeration: 404 for non-members. Then permission gate against
 * the supplied identity.* permission via Phase 17 access-policy.
 */
export async function requireSecurityActor(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
  permission:
    | "identity.org_policy.read"
    | "identity.org_policy.manage"
    | "identity.member.read"
    | "identity.access_review.action",
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
