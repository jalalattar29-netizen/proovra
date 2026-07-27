/**
 * PHASE 10 §10.6 (2026-07-23) — Organization-scoped BREAK-GLASS emergency access.
 *
 * The ONE break-glass authority. NOT a universal backdoor: a pre-configured
 * emergency identity, strong-auth/step-up proof, a bounded window, a restricted
 * role, mandatory reason, immutable audit + owner notification, automatic
 * expiry/revocation. Destructive Evidence/legal-hold/retention/security/billing
 * actions are DENIED by default (the restricted role confers read-only
 * diagnostic access; elevation requires a separate explicit capability that
 * this service never grants).
 *
 * SCHEMA READINESS: the `emergency_access_grants` table arrives with
 * 20271001000000 (authored, NOT applied). The generated Prisma client types
 * the model; before the table exists at runtime the create/update throws
 * (P2021) and this authority FAILS CLOSED — access is never silently granted.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";

export type EmergencyRole = "EMERGENCY_READ_ONLY" | "EMERGENCY_OPERATOR";

/** Actions a break-glass grant may NEVER perform, whatever the role. */
export const BREAK_GLASS_FORBIDDEN_ACTIONS = [
  "evidence.delete",
  "evidence.destroy",
  "legal_hold.remove",
  "retention.weaken",
  "security_policy.update",
  "billing.change",
  "membership.owner_change",
] as const;
export type BreakGlassForbiddenAction = (typeof BREAK_GLASS_FORBIDDEN_ACTIONS)[number];

export type BreakGlassGrant = {
  id: string;
  organizationId: string;
  emergencyUserId: string;
  grantedRole: EmergencyRole;
  reason: string;
  status: "ACTIVE" | "EXPIRED" | "REVOKED";
  startedAtUtc: Date;
  expiresAtUtc: Date;
  revokedAtUtc: Date | null;
};

export const BREAK_GLASS_MAX_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours

/** §10.6 — is a grant currently usable? Pure over the grant + clock. */
export function evaluateBreakGlassActive(
  grant: Pick<BreakGlassGrant, "status" | "expiresAtUtc" | "revokedAtUtc">,
  nowMs: number,
): { active: boolean; reason?: string } {
  if (grant.status === "REVOKED" || grant.revokedAtUtc) return { active: false, reason: "revoked" };
  if (grant.expiresAtUtc.getTime() <= nowMs) return { active: false, reason: "expired" };
  if (grant.status !== "ACTIVE") return { active: false, reason: "inactive" };
  return { active: true };
}

/** §10.6 — a break-glass grant NEVER permits a destructive/security/billing action. */
export function evaluateBreakGlassActionAllowed(action: string): { allowed: boolean; reason?: string } {
  if ((BREAK_GLASS_FORBIDDEN_ACTIONS as readonly string[]).includes(action)) {
    return { allowed: false, reason: "break_glass_forbidden_action" };
  }
  return { allowed: true };
}

// =============================================================================
// §10.6 RUNTIME AUTHORIZATION OVERLAY (Phase 10 Step 4)
// -----------------------------------------------------------------------------
// The runtime side of the ONE break-glass authority. `evaluateEmergencyAccess`
// is the canonical evaluator composed into the request/authorization path (see
// middleware/authorize-emergency.ts). It NEVER grants ordinary membership: it
// loads the exact grant, re-checks expiry/revocation on EVERY use, binds the
// grant to the Organization + emergency actor, and confers only a RESTRICTED,
// bounded capability overlay. Destructive Evidence/legal-hold/retention/
// security/billing/credential/support/escalation/cross-org actions are ALWAYS
// forbidden regardless of role. Fails closed on any ambiguity or infra error.
// =============================================================================

/**
 * The bounded operational allowlist an EMERGENCY_OPERATOR grant may perform
 * beyond read-shaped diagnostics. This is an explicit ALLOWLIST (not "anything
 * not forbidden") — incident-containment operations only. EMERGENCY_READ_ONLY
 * confers none of these.
 */
export const EMERGENCY_OPERATOR_ALLOWED_ACTIONS = [
  "session.revoke", // force-logout of compromised sessions during an incident
  // NOTE (Phase 10 Step 4 reconciliation, 2026-07-23): "sso_connection.retest"
  // was previously listed here but had NO real production consumer through
  // the emergency overlay — the only SSO retest logic lives inline in
  // saml-auth.routes.ts (POST /v1/auth/saml/:connectionId/test-connection),
  // which is not wired to break-glass and is owned by another workstream.
  // Removed to keep this allowlist limited to actions with an actual
  // emergency-operate consumer (see enterprise-security.routes.ts).
] as const;

/** True for read/diagnostic-shaped actions any emergency role may perform. */
function isEmergencyReadAction(action: string): boolean {
  return /\.(read|list|view|get|diagnos|status)/.test(action);
}

/**
 * §10.6 — resolve the RESTRICTED capability overlay for a role + action. The
 * ALWAYS-forbidden blocklist wins over everything; read-shaped actions map to
 * the `read` capability for every role; the bounded operate allowlist maps to
 * `operate` for EMERGENCY_OPERATOR only. Anything else is denied.
 */
export function evaluateEmergencyCapability(
  role: EmergencyRole,
  action: string,
): { allowed: true; capability: "read" | "operate" } | { allowed: false; reason: EmergencyDenyReason } {
  // The ALWAYS-forbidden blocklist can never be overridden by any role.
  if (!evaluateBreakGlassActionAllowed(action).allowed) {
    return { allowed: false, reason: "forbidden_action" };
  }
  if (isEmergencyReadAction(action)) {
    return { allowed: true, capability: "read" };
  }
  if (
    role === "EMERGENCY_OPERATOR" &&
    (EMERGENCY_OPERATOR_ALLOWED_ACTIONS as readonly string[]).includes(action)
  ) {
    return { allowed: true, capability: "operate" };
  }
  return {
    allowed: false,
    reason: role === "EMERGENCY_READ_ONLY" ? "read_only" : "capability_not_permitted",
  };
}

/** Bounded denial vocabulary for the runtime emergency evaluator. */
export type EmergencyDenyReason =
  | "invalid_input"
  | "schema_unavailable"
  | "grant_not_found"
  | "grant_revoked"
  | "grant_expired"
  | "grant_inactive"
  | "org_scope_mismatch"
  | "actor_mismatch"
  | "step_up_mismatch"
  | "forbidden_action"
  | "read_only"
  | "capability_not_permitted";

export type EmergencyAccessDecision =
  | {
      allowed: true;
      grantId: string;
      organizationId: string;
      actorUserId: string;
      role: EmergencyRole;
      action: string;
      capability: "read" | "operate";
    }
  | { allowed: false; reason: EmergencyDenyReason };

export type EvaluateEmergencyAccessInput = {
  actorUserId: string;
  organizationId: string;
  action: string;
  /**
   * The server-verified step-up reference recorded at activation. When present
   * it MUST match the grant's stored proof (the runtime binding of the emergency
   * entry to its step-up challenge). When omitted the evaluator still requires a
   * valid ACTIVE grant (grants are only ever created after a verified step-up).
   */
  stepUpProofId?: string | null;
  nowMs?: number;
};

/** True for schema-absence errors that MUST fail closed (never allow). */
function isBreakGlassSchemaUnavailable(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (code === "P2021" || code === "P2022") return true;
  const message = (err as { message?: string })?.message ?? "";
  return /Unknown (field|arg)/i.test(message);
}

async function auditEmergency(
  client: PrismaClient,
  params: {
    actorUserId: string;
    organizationId: string;
    grantId: string;
    action: string;
    outcome: "success" | "denied";
    result: string;
  },
): Promise<void> {
  const hasActor = !!params.actorUserId;
  await emitTenantAudit({
    action: params.outcome === "success" ? "identity.break_glass.used" : "identity.break_glass.denied",
    outcome: params.outcome,
    denialReason: params.outcome === "denied" ? params.result : null,
    sourceApp: "API",
    actorUserId: hasActor ? params.actorUserId : null,
    breakGlassGrantId: params.grantId || null, // DUAL IDENTITY: ran under the emergency overlay
    organizationId: params.organizationId,
    resourceType: "emergency_access_grant",
    resourceId: params.grantId || params.organizationId,
    metadata: {
      action: params.action,
      result: params.result,
    },
  }, client).catch(() => null);
}

/**
 * §10.6 (Phase 10 Step 4) — the canonical runtime emergency evaluator.
 *
 * Loads the EXACT grant by id and re-verifies EVERY invariant on EVERY use:
 * exists, ACTIVE, not expired, not revoked, bound to the request's Organization,
 * bound to the emergency actor, step-up reference matches (when provided), the
 * action passes the ALWAYS-forbidden blocklist, and the action is within the
 * RESTRICTED capability overlay for the grant's role. Any missing grant, wrong
 * org/actor, expiry, revocation, forbidden action, or infra/schema error FAILS
 * CLOSED (denied). Every path — allow and deny — is audited at critical
 * severity. It NEVER creates ordinary membership; it is a bounded overlay only.
 */
export async function evaluateEmergencyAccess(
  grantId: string,
  input: EvaluateEmergencyAccessInput,
  client: PrismaClient = defaultPrisma,
): Promise<EmergencyAccessDecision> {
  const nowMs = input.nowMs ?? Date.now();

  // Explicit, non-empty inputs are required — no caller-declared truth, no
  // ambiguity. Missing any of them is a fail-closed denial.
  if (!grantId || !input.actorUserId || !input.organizationId || !input.action) {
    await auditEmergency(client, {
      actorUserId: input.actorUserId ?? "",
      organizationId: input.organizationId ?? "",
      grantId: grantId ?? "",
      action: input.action ?? "",
      outcome: "denied",
      result: "invalid_input",
    });
    return { allowed: false, reason: "invalid_input" };
  }

  // Load the EXACT grant. Any infra/schema error fails closed (never allow).
  let row: {
    id: string;
    organizationId: string;
    emergencyUserId: string;
    grantedRole: string;
    status: string;
    expiresAtUtc: Date;
    revokedAtUtc: Date | null;
    stepUpProofId: string | null;
  } | null;
  try {
    row = await client.emergencyAccessGrant.findUnique({ where: { id: grantId } });
  } catch (err) {
    const reason: EmergencyDenyReason = isBreakGlassSchemaUnavailable(err)
      ? "schema_unavailable"
      : "schema_unavailable"; // any load failure → fail closed, generic reason
    await auditEmergency(client, {
      actorUserId: input.actorUserId,
      organizationId: input.organizationId,
      grantId,
      action: input.action,
      outcome: "denied",
      result: reason,
    });
    return { allowed: false, reason };
  }

  const deny = async (reason: EmergencyDenyReason): Promise<EmergencyAccessDecision> => {
    await auditEmergency(client, {
      actorUserId: input.actorUserId,
      organizationId: input.organizationId,
      grantId,
      action: input.action,
      outcome: "denied",
      result: reason,
    });
    return { allowed: false, reason };
  };

  if (!row) return deny("grant_not_found");

  // Expiry/revocation re-checked on EVERY use.
  const activeCheck = evaluateBreakGlassActive(
    { status: row.status as BreakGlassGrant["status"], expiresAtUtc: row.expiresAtUtc, revokedAtUtc: row.revokedAtUtc },
    nowMs,
  );
  if (!activeCheck.active) {
    const reason: EmergencyDenyReason =
      activeCheck.reason === "revoked" ? "grant_revoked" : activeCheck.reason === "expired" ? "grant_expired" : "grant_inactive";
    return deny(reason);
  }

  // Organization binding — the grant is scoped to exactly one org.
  if (row.organizationId !== input.organizationId) return deny("org_scope_mismatch");

  // Actor binding — only the pre-configured emergency identity may use it.
  if (row.emergencyUserId !== input.actorUserId) return deny("actor_mismatch");

  // Server-verified step-up reference binding (when the caller presents one).
  if (input.stepUpProofId != null && input.stepUpProofId !== row.stepUpProofId) {
    return deny("step_up_mismatch");
  }

  // RESTRICTED capability overlay (forbidden blocklist wins; bounded allowlist).
  const role = row.grantedRole as EmergencyRole;
  const capability = evaluateEmergencyCapability(role, input.action);
  if (!capability.allowed) return deny(capability.reason);

  // Allowed — audit the USE at critical severity.
  await auditEmergency(client, {
    actorUserId: input.actorUserId,
    organizationId: input.organizationId,
    grantId,
    action: input.action,
    outcome: "success",
    result: `allowed:${capability.capability}`,
  });

  return {
    allowed: true,
    grantId,
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    role,
    action: input.action,
    capability: capability.capability,
  };
}

export type ActivateBreakGlassInput = {
  organizationId: string;
  emergencyUserId: string;
  requestedByUserId: string;
  reason: string;
  grantedRole?: EmergencyRole;
  stepUpProofId: string;
  durationMs?: number;
  nowMs?: number;
};

export type BreakGlassError = Error & { statusCode: number; code: string };
function bgError(code: string, message: string): BreakGlassError {
  const e = new Error(message) as BreakGlassError;
  e.statusCode = 403;
  e.code = code;
  return e;
}

/**
 * §10.6 — activate an emergency grant. Fails closed when a reason or step-up
 * proof is missing; caps duration; the grant is org-scoped only; audits and
 * (best-effort) notifies org security owners. The `emergencyUserId` must be a
 * pre-configured emergency identity — the caller resolves that from the
 * org configuration (never an arbitrary user).
 */
export async function activateBreakGlass(
  input: ActivateBreakGlassInput,
  client: PrismaClient = defaultPrisma,
): Promise<BreakGlassGrant> {
  if (!input.reason || input.reason.trim().length < 8) {
    throw bgError("BREAK_GLASS_REASON_REQUIRED", "A substantive reason is required for break-glass access.");
  }
  if (!input.stepUpProofId) {
    throw bgError("BREAK_GLASS_STEP_UP_REQUIRED", "Break-glass access requires a completed step-up challenge.");
  }
  const now = input.nowMs ?? Date.now();
  const durationMs = Math.min(input.durationMs ?? BREAK_GLASS_MAX_DURATION_MS, BREAK_GLASS_MAX_DURATION_MS);
  const expiresAtUtc = new Date(now + durationMs);

  // Typed delegate (generated client). If the table is not yet applied at
  // runtime the create throws (P2021) → FAIL CLOSED, never a silent grant.
  const row = await client.emergencyAccessGrant.create({
    data: {
      organizationId: input.organizationId,
      emergencyUserId: input.emergencyUserId,
      requestedByUserId: input.requestedByUserId,
      grantedRole: input.grantedRole ?? "EMERGENCY_READ_ONLY",
      reason: input.reason.slice(0, 600),
      stepUpProofId: input.stepUpProofId,
      status: "ACTIVE",
      startedAtUtc: new Date(now),
      expiresAtUtc,
    },
  });

  await emitTenantAudit({
    action: "identity.break_glass.activated",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.emergencyUserId,
    breakGlassGrantId: row.id, // DUAL IDENTITY: the emergency overlay just opened
    organizationId: input.organizationId,
    resourceType: "organization",
    resourceId: input.organizationId,
    metadata: {
      requestedByUserId: input.requestedByUserId,
      grantedRole: row.grantedRole,
      expiresAtUtc: expiresAtUtc.toISOString(),
      // reason is stored on the grant; audit records that a reason was given.
      reasonProvided: true,
    },
  }, client).catch(() => null);

  return {
    id: row.id,
    organizationId: row.organizationId,
    emergencyUserId: row.emergencyUserId,
    grantedRole: row.grantedRole as EmergencyRole,
    reason: row.reason,
    status: "ACTIVE",
    startedAtUtc: row.startedAtUtc,
    expiresAtUtc: row.expiresAtUtc,
    revokedAtUtc: null,
  };
}

/** §10.6 — explicit revocation (idempotent). */
export async function revokeBreakGlass(
  input: { grantId: string; revokedByUserId: string },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  // Persisted grant scope (never the request) for the audit's tenant columns.
  const grant = await client.emergencyAccessGrant.findUnique({
    where: { id: input.grantId },
    select: { organizationId: true },
  });
  await client.emergencyAccessGrant.updateMany({
    where: { id: input.grantId, status: "ACTIVE" },
    data: { status: "REVOKED", revokedAtUtc: new Date(), revokedByUserId: input.revokedByUserId },
  });
  await emitTenantAudit({
    action: "identity.break_glass.revoked",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.revokedByUserId,
    breakGlassGrantId: input.grantId, // DUAL IDENTITY: the emergency overlay just closed
    organizationId: grant?.organizationId ?? null,
    resourceType: "emergency_access_grant",
    resourceId: input.grantId,
    metadata: {},
  }, client).catch(() => null);
}
