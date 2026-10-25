/**
 * ONE DELEGATED-ADMINISTRATION AUTHORITY (members audit DOM-09, owner decision
 * 2026-10-25).
 *
 * There were two: tiered "delegated admin grants" (GLOBAL_ADMIN … COMPLIANCE_
 * OFFICER) checked by a route middleware of their own, and member DELEGATED
 * SCOPES (GOVERNANCE_ADMIN, IDENTITY_ADMIN, …) folded into the canonical
 * permission engine. Both could be written and both were enforced, on
 * different routes, so who could do what depended on which model a route
 * happened to consult.
 *
 * The canonical authorization decision is the permission engine
 * (`authorize.ts`): a member's effective permissions are their role's, plus
 * capability grants, plus their delegated scopes. That is the one authority
 * kept. Routes that asked for a tier now ask the engine for the permission of
 * their domain, through this pre-handler — the same workspace resolution the
 * tier guard used (the caller's current workspace), the same refusal shape
 * family, the same audit event.
 */
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { Permission } from "@proovra/shared";

import { getAuthUserId } from "../auth.js";
import { evaluateCurrentWorkspace } from "./authorize.js";
import { emitTrustEvent } from "../services/trust/trust-and-governance-audit.service.js";

export function requireWorkspacePermission(permission: Permission): preHandlerHookHandler {
  return async function workspacePermissionGuard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    let userId: string | null = null;
    try {
      userId = getAuthUserId(req);
    } catch {
      reply.code(403).send({ denial: "PERMISSION_REQUIRED", permission });
      return;
    }
    const outcome = await evaluateCurrentWorkspace(req, { permission });
    if (outcome.allowed) return;
    const membership = await evaluateCurrentWorkspace(req, { permission: "evidence.read" });
    if (membership.allowed) {
      try {
        await emitTrustEvent({
          teamId: membership.context.workspaceId,
          code: "POLICY_VIOLATION",
          actorUserId: userId,
          reason: `permission_required:${permission}`,
        });
      } catch {
        // Audit emission must never break the request path.
      }
    }
    reply.code(403).send({ denial: "PERMISSION_REQUIRED", permission });
  };
}
