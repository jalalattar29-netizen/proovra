/**
 * PHASE 10 §10.8 (2026-07-23) — DUAL-IDENTITY support access.
 *
 * The ONE support-access authority. A support actor operates within an
 * explicit customer Organization/Workspace scope for a bounded window, with a
 * visible banner and immutable audit — NEVER an invisible impersonation token
 * minted as the customer user. READ_ONLY / minimal by default; destructive,
 * legal-hold, retention, ownership, security-policy and billing actions are
 * DENIED (ELEVATED requires a separate explicit capability this service never
 * mints). Automatic expiry/revocation.
 *
 * SCHEMA READINESS: `support_access_grants` arrives with 20271001000000
 * (authored, NOT applied). The generated client types the model; before the
 * table exists at runtime the write throws (P2021) → FAILS CLOSED.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";

export type SupportAccessLevel = "READ_ONLY" | "ELEVATED";

/** Actions support access may NEVER perform (even ELEVATED needs a separate cap). */
export const SUPPORT_FORBIDDEN_ACTIONS = [
  "evidence.delete",
  "evidence.destroy",
  "legal_hold.remove",
  "retention.weaken",
  "membership.owner_change",
  "membership.change",
  "security_policy.update",
  "billing.change",
  "break_glass.create",
] as const;

export type SupportAccessGrant = {
  id: string;
  supportUserId: string;
  organizationId: string;
  teamId: string | null;
  reason: string;
  accessLevel: SupportAccessLevel;
  status: "ACTIVE" | "EXPIRED" | "REVOKED";
  startedAtUtc: Date;
  expiresAtUtc: Date;
  revokedAtUtc: Date | null;
};

export const SUPPORT_ACCESS_MAX_DURATION_MS = 8 * 60 * 60 * 1000; // 8 hours

/** §10.8 — is a grant currently usable + does it cover the requested scope? */
export function evaluateSupportAccess(
  grant: Pick<SupportAccessGrant, "status" | "expiresAtUtc" | "revokedAtUtc" | "organizationId" | "teamId">,
  input: { organizationId: string; teamId?: string | null; nowMs: number },
): { active: boolean; reason?: string } {
  if (grant.status === "REVOKED" || grant.revokedAtUtc) return { active: false, reason: "revoked" };
  if (grant.expiresAtUtc.getTime() <= input.nowMs) return { active: false, reason: "expired" };
  if (grant.status !== "ACTIVE") return { active: false, reason: "inactive" };
  if (grant.organizationId !== input.organizationId) return { active: false, reason: "org_scope_mismatch" };
  // A workspace-narrowed grant does not cover other workspaces.
  if (grant.teamId && input.teamId && grant.teamId !== input.teamId) {
    return { active: false, reason: "workspace_scope_mismatch" };
  }
  return { active: true };
}

/** §10.8 — an action's permission under a support grant (default read-only). */
export function evaluateSupportActionAllowed(
  grant: Pick<SupportAccessGrant, "accessLevel">,
  action: string,
): { allowed: boolean; reason?: string } {
  if ((SUPPORT_FORBIDDEN_ACTIONS as readonly string[]).includes(action)) {
    return { allowed: false, reason: "support_forbidden_action" };
  }
  // READ_ONLY grants may only perform read/diagnostic actions.
  if (grant.accessLevel === "READ_ONLY" && !/\.(read|list|view|get|diagnos)/.test(action)) {
    return { allowed: false, reason: "support_read_only" };
  }
  return { allowed: true };
}

export type StartSupportAccessInput = {
  supportUserId: string;
  organizationId: string;
  teamId?: string | null;
  reason: string;
  accessLevel?: SupportAccessLevel;
  approvedByUserId?: string | null;
  durationMs?: number;
  nowMs?: number;
};

export type SupportAccessError = Error & { statusCode: number; code: string };
function saError(code: string, message: string): SupportAccessError {
  const e = new Error(message) as SupportAccessError;
  e.statusCode = 403;
  e.code = code;
  return e;
}

/**
 * §10.8 — start a support-access session. Fails closed without a reason;
 * ELEVATED requires an explicit approver; the actor is a DISTINCT identity
 * (never the customer user — enforced by the caller passing a support actor).
 * The banner is driven off the ACTIVE grant by the context layer.
 */
export async function startSupportAccess(
  input: StartSupportAccessInput,
  client: PrismaClient = defaultPrisma,
): Promise<SupportAccessGrant> {
  if (!input.reason || input.reason.trim().length < 8) {
    throw saError("SUPPORT_REASON_REQUIRED", "A substantive reason is required for support access.");
  }
  const accessLevel = input.accessLevel ?? "READ_ONLY";
  if (accessLevel === "ELEVATED" && !input.approvedByUserId) {
    throw saError("SUPPORT_APPROVAL_REQUIRED", "Elevated support access requires explicit customer/admin approval.");
  }
  const now = input.nowMs ?? Date.now();
  const durationMs = Math.min(input.durationMs ?? SUPPORT_ACCESS_MAX_DURATION_MS, SUPPORT_ACCESS_MAX_DURATION_MS);
  const expiresAtUtc = new Date(now + durationMs);

  // Typed delegate. If the table is not yet applied at runtime the create
  // throws (P2021) → FAIL CLOSED, never a silent grant.
  const row = await client.supportAccessGrant.create({
    data: {
      supportUserId: input.supportUserId,
      organizationId: input.organizationId,
      teamId: input.teamId ?? null,
      reason: input.reason.slice(0, 600),
      accessLevel,
      approvedByUserId: input.approvedByUserId ?? null,
      status: "ACTIVE",
      startedAtUtc: new Date(now),
      expiresAtUtc,
    },
  });

  await emitTenantAudit({
    action: "identity.support_access.started",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.supportUserId, // DUAL IDENTITY: support actor
    supportActorUserId: input.supportUserId,
    organizationId: input.organizationId,
    workspaceId: input.teamId ?? null,
    resourceType: "organization",
    resourceId: input.organizationId,
    metadata: {
      grantId: row.id,
      accessLevel,
      approvedByUserId: input.approvedByUserId ?? null,
      expiresAtUtc: expiresAtUtc.toISOString(),
    },
  }, client).catch(() => null);

  return {
    id: row.id,
    supportUserId: row.supportUserId,
    organizationId: row.organizationId,
    teamId: row.teamId,
    reason: row.reason,
    accessLevel: row.accessLevel as SupportAccessLevel,
    status: "ACTIVE",
    startedAtUtc: row.startedAtUtc,
    expiresAtUtc: row.expiresAtUtc,
    revokedAtUtc: null,
  };
}

export async function revokeSupportAccess(
  input: { grantId: string; revokedByUserId: string },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  // Persisted grant scope (never the request) for the audit's tenant columns.
  const grant = await client.supportAccessGrant.findUnique({
    where: { id: input.grantId },
    select: { organizationId: true, teamId: true, supportUserId: true },
  });
  await client.supportAccessGrant.updateMany({
    where: { id: input.grantId, status: "ACTIVE" },
    data: { status: "REVOKED", revokedAtUtc: new Date() },
  });
  await emitTenantAudit({
    action: "identity.support_access.revoked",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.revokedByUserId,
    supportActorUserId: grant?.supportUserId ?? null,
    organizationId: grant?.organizationId ?? null,
    workspaceId: grant?.teamId ?? null,
    resourceType: "support_access_grant",
    resourceId: input.grantId,
    metadata: { grantId: input.grantId },
  }, client).catch(() => null);
}
