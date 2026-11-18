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

import { getAuthUserId } from "../../auth.js";
import { prisma as defaultPrisma } from "../../db.js";
import { evaluateAuthorize } from "../../middleware/authorize.js";
import { caseClosedTo, evidenceClosedTo } from "../access/record-reach.js";

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
  // B2A-F-07 (free audit 0ea0) — every case and evidence-request link was
  // concealed as 404 because these families had no entry. Their read routes
  // authorize `evidence.read` in the persisted workspace (GET /v1/cases/:id via
  // resolveCaseRecordAccess, GET /v1/evidence-requests/:id via
  // requireRequestMember; no evidence_request.read capability exists) and then
  // narrow by the restricted-case rule — the same reach check below.
  cases: "evidence.read" as Permission,
  investigation: "evidence.read" as Permission,
  "evidence-requests": "evidence.read" as Permission,
};

/**
 * B2A-F-07 — families no id-bearing page exists for: `review` and
 * `audit-transparency` are plain section paths, so an id names nothing the
 * resolver can bind to a workspace. Answered as an explicit unsupported type
 * (the answer depends on the TYPE alone, so it reveals nothing about the id).
 */
export const DEEP_LINK_UNSUPPORTED_TYPES: ReadonlySet<InternalResourceType> = new Set<InternalResourceType>([
  "review",
  "audit-transparency",
]);

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
    case "reports": {
      // B2A-F-07 — a report id binds to its parent Evidence's workspace.
      const report = await client.report.findUnique({
        where: { id },
        select: { evidence: { select: { teamId: true } } },
      });
      return report?.evidence?.teamId ?? null;
    }
    case "review":
    case "audit-transparency":
      // No id-bearing page (DEEP_LINK_UNSUPPORTED_TYPES): nothing to bind.
      return null;
  }
}

/**
 * B2A-F-07 — the restricted-case narrowing each family's read route applies
 * after the workspace decision (record-reach.ts): a record, case, request or
 * report closed to the caller answers like one that does not exist.
 */
async function resourceClosedTo(
  client: PrismaClient,
  type: InternalResourceType,
  id: string,
  userId: string,
): Promise<boolean> {
  switch (type) {
    case "evidence":
      return evidenceClosedTo(id, userId, client);
    case "cases":
    case "investigation":
      return caseClosedTo(id, userId, client);
    case "evidence-requests": {
      const row = await client.evidenceRequest.findUnique({
        where: { id },
        select: { evidenceId: true, caseId: true },
      });
      if (!row) return true;
      return (
        (row.evidenceId !== null && (await evidenceClosedTo(row.evidenceId, userId, client))) ||
        (row.caseId !== null && (await caseClosedTo(row.caseId, userId, client)))
      );
    }
    case "reports": {
      const report = await client.report.findUnique({ where: { id }, select: { evidenceId: true } });
      if (!report) return true;
      return evidenceClosedTo(report.evidenceId, userId, client);
    }
    default:
      return true;
  }
}

export type DeepLinkDecision =
  | { ok: true; actorUserId: string; teamId: string; resourceType: InternalResourceType; resourceId: string }
  | { ok: false; reason: "not_found" | "context_mismatch" | "unauthorized"; httpStatus: 404 }
  /** B2A-F-07 — a family with no id-bearing page (by TYPE; reveals nothing about the id). */
  | { ok: false; reason: "unsupported_type"; httpStatus: 422 };

/**
 * PRO-N1-10 — a legacy personal-scope record (Evidence.teamId NULL) is its
 * OWNER's own (the inbox scope rule, me-inbox.routes.ts): it resolves to the
 * owner's Personal workspace, for the owner only. Anyone else gets the same
 * concealed not_found as a missing record. Reports bind through their record.
 */
async function legacyPersonalRecordTeamId(
  client: PrismaClient,
  req: FastifyRequest,
  type: InternalResourceType,
  id: string,
): Promise<string | null> {
  if (type !== "evidence" && type !== "reports") return null;
  let actorUserId: string;
  try {
    actorUserId = getAuthUserId(req);
  } catch {
    return null;
  }
  const owner =
    type === "evidence"
      ? await client.evidence.findUnique({ where: { id }, select: { teamId: true, ownerUserId: true } })
      : (await client.report.findUnique({ where: { id }, select: { evidence: { select: { teamId: true, ownerUserId: true } } } }))
          ?.evidence ?? null;
  if (!owner || owner.teamId !== null || owner.ownerUserId !== actorUserId) return null;
  const personal = await client.team.findFirst({
    where: { ownerUserId: actorUserId, isPersonal: true },
    select: { id: true },
  });
  return personal?.id ?? null;
}

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
  if (DEEP_LINK_UNSUPPORTED_TYPES.has(input.resourceType)) {
    return { ok: false, reason: "unsupported_type", httpStatus: 422 };
  }
  const teamId =
    (await resolveResourceTeamId(client, input.resourceType, input.resourceId)) ??
    (await legacyPersonalRecordTeamId(client, req, input.resourceType, input.resourceId));
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
  // B2A-F-07 — workspace access is necessary, never sufficient: the family's
  // restricted-case reach decides too (fail closed on an unreadable answer).
  const closed = await resourceClosedTo(client, input.resourceType, input.resourceId, outcome.actorUserId).catch(
    () => true,
  );
  if (closed) return { ok: false, reason: "unauthorized", httpStatus: 404 };
  return {
    ok: true,
    actorUserId: outcome.actorUserId,
    teamId: outcome.teamId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
  };
}
