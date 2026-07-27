/**
 * PROOVRA Phase 3A — Redaction RBAC + capability gate.
 *
 * Bounded server-side authority check. The capability matrix lives
 * in the shared package (`REDACTION_CAPABILITY_MATRIX`); this
 * service maps a workspace user → effective redaction roles via
 * the existing platform RBAC engine.
 *
 * Hard rules:
 *   * NEVER UI-only. Every redaction route preHandler calls
 *     `assertRedactionCapability` BEFORE touching the database.
 *   * Capabilities are checked against the workspace-anchored
 *     `(userId, teamId)` pair — no cross-tenant escalation.
 *   * Workspace operators with the OWNER / ADMIN canonical role
 *     are automatically granted REDACTION_ADMINISTRATOR. Reviewer
 *     roles map to REDACTION_REVIEWER. Approver-grade roles
 *     (e.g. EVIDENCE_APPROVER, REVIEWER_LEAD) map to
 *     REDACTION_APPROVER.
 *   * Per-workspace explicit overrides (a future TeamMember
 *     capability grant) take precedence — but the implementation
 *     is bounded so the role mapping below is the source of truth
 *     until that store lands.
 */

import type { PrismaClient } from "@prisma/client";
import {
  REDACTION_CAPABILITY_MATRIX,
  teamMemberStatusGrantsAccess,
  type RedactionCapability,
  type RedactionDenialReason,
  type RedactionRole,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RedactionRbacContext = {
  userId: string;
  teamId: string;
  roles: ReadonlySet<RedactionRole>;
  capabilities: ReadonlySet<RedactionCapability>;
};

export type AssertResult =
  | { ok: true; ctx: RedactionRbacContext }
  | { ok: false; denial: RedactionDenialReason };

// ---------------------------------------------------------------------------
// Role resolution
// ---------------------------------------------------------------------------

const PLATFORM_ROLE_TO_REDACTION: ReadonlyArray<{
  match: ReadonlyArray<string>;
  grants: ReadonlyArray<RedactionRole>;
}> = [
  {
    match: ["OWNER", "ADMIN", "WORKSPACE_ADMIN"],
    grants: ["REDACTION_ADMINISTRATOR"],
  },
  {
    match: [
      "REVIEWER_LEAD",
      "EVIDENCE_APPROVER",
      "REVIEW_APPROVER",
      "COMPLIANCE_LEAD",
    ],
    grants: ["REDACTION_APPROVER"],
  },
  {
    match: ["REVIEWER", "EVIDENCE_REVIEWER", "ANALYST", "OPERATOR"],
    grants: ["REDACTION_REVIEWER"],
  },
];

/**
 * Resolve the (workspace, user) pair to a bounded redaction role
 * set. Refuses non-members of the workspace.
 */
export async function resolveRedactionRoles(
  prisma: PrismaClient,
  userId: string,
  teamId: string,
): Promise<ReadonlySet<RedactionRole>> {
  // Workspace membership check — bounded to the existing TeamMember
  // table. If the user is not a member of the team we return the
  // empty set and the higher-level gate refuses with NOT_PERMITTED.
  const member = await prisma.teamMember.findFirst({
    where: { userId, teamId },
    select: { role: true, status: true },
  });
  // PHASE 1 AUTHORIZATION CLOSURE (2026-07-21) — status-aware. Only an ACTIVE
  // membership resolves to any redaction role; a SUSPENDED / REVOKED member
  // gets the empty set (fail-closed), so the higher-level gate refuses with
  // NOT_PERMITTED — the same outcome as a non-member.
  if (!member || !teamMemberStatusGrantsAccess(member.status)) return new Set();
  const roleString = String(member.role ?? "").toUpperCase();
  const granted = new Set<RedactionRole>();
  for (const rule of PLATFORM_ROLE_TO_REDACTION) {
    if (rule.match.some((m) => roleString.includes(m))) {
      for (const r of rule.grants) granted.add(r);
    }
  }
  // The OWNER / ADMIN of a workspace also picks up the lower
  // redaction roles so the matrix is monotonic.
  if (granted.has("REDACTION_ADMINISTRATOR")) {
    granted.add("REDACTION_APPROVER");
    granted.add("REDACTION_REVIEWER");
  }
  if (granted.has("REDACTION_APPROVER")) {
    granted.add("REDACTION_REVIEWER");
  }
  return granted;
}

function effectiveCapabilities(
  roles: ReadonlySet<RedactionRole>,
): ReadonlySet<RedactionCapability> {
  const caps = new Set<RedactionCapability>();
  for (const role of roles) {
    for (const cap of REDACTION_CAPABILITY_MATRIX[role]) {
      caps.add(cap);
    }
  }
  return caps;
}

/**
 * Build a bounded redaction RBAC context. Always returns a context;
 * callers must `assertCapability` before performing the actual
 * action.
 */
export async function buildRedactionContext(
  userId: string,
  teamId: string,
  prismaClient: PrismaClient = defaultPrisma,
): Promise<RedactionRbacContext> {
  const roles = await resolveRedactionRoles(prismaClient, userId, teamId);
  return {
    userId,
    teamId,
    roles,
    capabilities: effectiveCapabilities(roles),
  };
}

/**
 * Server-side gate. Returns `{ ok: false, denial: "NOT_PERMITTED" }`
 * when the actor does not have the requested capability. Routes
 * call this BEFORE touching any redaction table.
 */
export async function assertRedactionCapability(input: {
  prisma?: PrismaClient;
  userId: string;
  teamId: string;
  capability: RedactionCapability;
}): Promise<AssertResult> {
  const ctx = await buildRedactionContext(
    input.userId,
    input.teamId,
    input.prisma ?? defaultPrisma,
  );
  if (!ctx.capabilities.has(input.capability)) {
    return { ok: false, denial: "NOT_PERMITTED" };
  }
  return { ok: true, ctx };
}
