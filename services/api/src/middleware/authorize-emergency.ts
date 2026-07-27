/**
 * PHASE 10 §10.6 Step 4 — BREAK-GLASS runtime authorization COMPOSITION.
 *
 * The single composition point between the canonical authorize helper
 * (`authorizeOrFail` / `evaluateAuthorize`, middleware/authorize.ts) and the
 * ONE break-glass authority (`evaluateEmergencyAccess`,
 * services/identity/break-glass.service.ts). It ADDS a bounded emergency
 * OVERLAY — it does NOT re-implement authorization and does NOT create a second
 * authorization engine.
 *
 * Runtime chain enforced here:
 *   authenticated actor
 *     → explicit emergency entry (grantId + step-up reference BOTH present)
 *     → server-verified step-up reference (bound to the grant)
 *     → active exact grant (ACTIVE, not expired, not revoked)  ─┐
 *     → Organization binding (grant.organizationId == request org)│  evaluateEmergencyAccess
 *     → actor binding (grant.emergencyUserId == actor)           │  (the ONE authority)
 *     → RESTRICTED capability overlay (bounded allowlist)       ─┘
 *     → canonical authorization surface (bounded reason, fail-closed, audited)
 *     → operation
 *     → critical immutable audit (inside the evaluator)
 *
 * When NO explicit emergency entry is present the request is a NORMAL request:
 * this helper delegates verbatim to `authorizeOrFail` (the canonical path is
 * untouched). Break-glass NEVER silently broadens a normal request.
 *
 * FAILS CLOSED on any ambiguity or infra error.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { Permission } from "@proovra/shared";

import { getAuthUserId } from "../auth.js";
import { authorizeOrFail } from "./authorize.js";
import {
  evaluateEmergencyAccess,
  type EmergencyDenyReason,
} from "../services/identity/break-glass.service.js";

export type EmergencyAuthorizeOptions = {
  /** Workspace/team id for the canonical (non-emergency) path. */
  teamId: string | null | undefined;
  /** Organization the request targets — the grant MUST be bound to it. */
  organizationId: string;
  /** Canonical permission for the normal (non-emergency) path. */
  permission: Permission;
  /** The canonical action string evaluated against the capability overlay. */
  action: string;
  /** Explicit emergency entry: the exact grant id (null → normal request). */
  grantId?: string | null;
  /** Server-verified step-up reference for the emergency entry. */
  stepUpProofId?: string | null;
  nowMs?: number;
  /** Optional prisma client (dependency-injection seam; defaults inside the evaluator). */
  client?: PrismaClient;
};

export type EmergencyAuthorizedContext = {
  actorUserId: string;
  teamId: string | null;
  organizationId: string;
  /** True when access was granted through the break-glass overlay. */
  viaEmergency: boolean;
  emergencyCapability?: "read" | "operate";
};

/**
 * The bounded 403 reason codes the emergency overlay surfaces. Operators never
 * see free-text — only these codes (a superset of the evaluator's denial
 * vocabulary plus the missing-actor route concern).
 */
export const EMERGENCY_DENIAL_CODES: readonly (EmergencyDenyReason | "missing_actor")[] = [
  "missing_actor",
  "invalid_input",
  "schema_unavailable",
  "grant_not_found",
  "grant_revoked",
  "grant_expired",
  "grant_inactive",
  "org_scope_mismatch",
  "actor_mismatch",
  "step_up_mismatch",
  "forbidden_action",
  "read_only",
  "capability_not_permitted",
];

/**
 * Compose the emergency overlay with the canonical authorize helper.
 *
 * - No explicit emergency entry (no grantId OR no step-up reference) → delegate
 *   to the canonical `authorizeOrFail` unchanged.
 * - Explicit emergency entry → require an authenticated actor, then defer the
 *   entire decision to `evaluateEmergencyAccess` (the ONE authority, which
 *   audits every allow/deny at critical severity). On allow, return the
 *   emergency-authorized context WITHOUT minting ordinary membership.
 *
 * Returns the authorized context, or `null` after having sent the canonical
 * bounded deny response.
 */
export async function authorizeWithEmergencyOverlay(
  req: FastifyRequest,
  reply: FastifyReply,
  options: EmergencyAuthorizeOptions,
): Promise<EmergencyAuthorizedContext | null> {
  const isEmergencyEntry = !!options.grantId && !!options.stepUpProofId;

  // NORMAL request — the canonical path is authoritative and untouched.
  if (!isEmergencyEntry) {
    const normal = await authorizeOrFail(req, reply, {
      teamId: options.teamId,
      permission: options.permission,
    });
    if (!normal) return null;
    return {
      actorUserId: normal.actorUserId,
      teamId: normal.teamId,
      organizationId: options.organizationId,
      viaEmergency: false,
    };
  }

  // EMERGENCY request — authenticated actor is mandatory.
  let actorUserId: string;
  try {
    actorUserId = getAuthUserId(req);
  } catch {
    reply.code(401).send({ error: { code: "unauthenticated" } });
    return null;
  }

  const decision = await evaluateEmergencyAccess(
    options.grantId as string,
    {
      actorUserId,
      organizationId: options.organizationId,
      action: options.action,
      stepUpProofId: options.stepUpProofId ?? null,
      nowMs: options.nowMs,
    },
    options.client,
  );

  if (!decision.allowed) {
    // Bounded reason code only — never a raw error message. 503 for infra/schema
    // unavailability (fail-closed retry posture), 403 for every policy denial.
    const httpStatus = decision.reason === "schema_unavailable" ? 503 : 403;
    reply.code(httpStatus).send({
      error: { code: "break_glass_denied", reason: decision.reason },
    });
    return null;
  }

  return {
    actorUserId: decision.actorUserId,
    teamId: options.teamId ?? null,
    organizationId: decision.organizationId,
    viaEmergency: true,
    emergencyCapability: decision.capability,
  };
}
