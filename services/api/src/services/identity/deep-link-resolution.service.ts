/**
 * PHASE 11 — THE ONE canonical deep-link resolution authority.
 *
 * A URL / deep link is NEVER authoritative tenant truth. This service composes
 * the ALREADY-CONVERGED authorities to turn an incoming resource locator into an
 * authorized outcome — it does NOT re-implement authorization, classification,
 * lifecycle, policy, membership, or session context:
 *
 *   parse canonical destination (shared tenant-url parser, at the route)
 *     → load the PERSISTED resource → derive its authoritative Workspace (teamId)
 *     → validate any URL-declared workspace matches persistence (no override)
 *     → evaluateAuthorize (canonical authz = lifecycle + live Org policy +
 *       ACTIVE membership + capability, all fail-closed per Phase 10)
 *     → decision.
 *
 * Every denial (missing resource, declared-context mismatch, unauthorized) is
 * returned as a bounded reason the route maps to the canonical anti-enumeration
 * 404 — the client can never tell "not found" from "not yours". Zero context
 * mutation on denial. Organization-session establishment + Phase-7 context
 * safety are applied by the caller AFTER `ok:true` (they own `reply`/render).
 */

import type { FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { InternalResourceType, Permission } from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { evaluateAuthorize } from "../../middleware/authorize.js";

/**
 * Canonical read capability per resource family (server-derived, never client).
 * Only families with a single unambiguous read capability are defaulted here;
 * families whose authz is governed by a dedicated matrix (e.g. Cases via
 * case-permission.service) require the caller to pass its own `permission` — a
 * missing capability fails CLOSED (concealed 404), never opens access.
 */
const RESOURCE_READ_PERMISSION: Partial<Record<InternalResourceType, Permission>> = {
  evidence: "evidence.read" as Permission,
  reports: "evidence.read" as Permission,
  review: "evidence.read" as Permission,
};

/**
 * Resolve the AUTHORITATIVE Workspace (teamId) from the PERSISTED resource — the
 * single source of tenant truth. Returns null when the resource does not exist
 * or carries no workspace binding (→ concealed not_found).
 */
async function resolveResourceTeamId(
  client: PrismaClient,
  type: InternalResourceType,
  id: string,
): Promise<string | null> {
  switch (type) {
    case "evidence":
      return (await client.evidence.findUnique({ where: { id }, select: { teamId: true } }))?.teamId ?? null;
    case "cases":
    case "investigation":
      return (await client.case.findUnique({ where: { id }, select: { teamId: true } }))?.teamId ?? null;
    case "evidence-requests":
      return (await client.evidenceRequest.findUnique({ where: { id }, select: { teamId: true } }))?.teamId ?? null;
    case "reports":
    case "review":
    case "audit-transparency":
      // Reports/review derive their workspace from the parent Evidence; a bare
      // report/review id resolves through Evidence when the caller supplies the
      // evidence workspace. Not directly workspace-bound here → concealed.
      return null;
  }
}

export type DeepLinkDecision =
  | { ok: true; actorUserId: string; teamId: string; resourceType: InternalResourceType; resourceId: string }
  | { ok: false; reason: "not_found" | "context_mismatch" | "unauthorized"; httpStatus: 404 };

/**
 * The canonical deep-link decision. `declaredWorkspaceId` (if a URL/query
 * carried one) MUST equal the resource's persisted Workspace — a client cannot
 * override the binding; a mismatch is concealed. `permission` defaults to the
 * resource family's read capability but a caller performing a stronger op may
 * pass its own.
 */
export async function resolveDeepLink(
  req: FastifyRequest,
  input: {
    resourceType: InternalResourceType;
    resourceId: string;
    declaredWorkspaceId?: string | null;
    permission?: Permission;
  },
  client: PrismaClient = defaultPrisma,
): Promise<DeepLinkDecision> {
  const teamId = await resolveResourceTeamId(client, input.resourceType, input.resourceId);
  if (!teamId) return { ok: false, reason: "not_found", httpStatus: 404 };

  // URL-declared context must MATCH persistence (never override it).
  if (input.declaredWorkspaceId && input.declaredWorkspaceId !== teamId) {
    return { ok: false, reason: "context_mismatch", httpStatus: 404 };
  }

  const permission = input.permission ?? RESOURCE_READ_PERMISSION[input.resourceType];
  if (!permission) return { ok: false, reason: "not_found", httpStatus: 404 };

  const outcome = await evaluateAuthorize(req, { teamId, permission });
  if (!outcome.allowed) {
    // Anti-enumeration: any authz denial (lifecycle/policy/membership/capability)
    // conceals as 404 — never leak existence or the specific reason to the client.
    return { ok: false, reason: "unauthorized", httpStatus: 404 };
  }
  return {
    ok: true,
    actorUserId: outcome.actorUserId,
    teamId: outcome.teamId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
  };
}
