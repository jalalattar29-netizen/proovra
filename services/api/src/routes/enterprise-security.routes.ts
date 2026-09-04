/**
 * PHASE 10 §10.4/§10.6/§10.8 (2026-07-23) — authorized production routes for
 * advanced enterprise identity. Every route goes through canonical
 * authorization (`authorizeOrFail`, `identity.org_policy.*`) + step-up for
 * high-risk changes, and calls ONLY the canonical services (no direct
 * membership/lifecycle/policy writes here).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { authorizeOrFail } from "../middleware/authorize.js";
import { authorizeWithEmergencyOverlay } from "../middleware/authorize-emergency.js";
import { requireAuth } from "../middleware/auth.js";
// PHASE 12B C10 — Support Access / Break-Glass are INTERNAL STAFF capabilities.
// Platform-staff status is resolved from persistence, never from a request field.
import { isPlatformAdmin } from "../services/platform-admin.service.js";
// PHASE 10 HARDENING FIX 1 (2026-07-23) — the support-context token must be
// bound to the EXACT authenticated session minting it.
import { getAuthSessionId, getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { checkOrgAccess } from "../services/organization/org-access.js";
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";
import {
  resolveOrgPolicyByOrgId,
  applySecurityPolicyPatch,
  checkHighSecurityReadiness,
  activateHighSecurityMode,
  orgCanonicalTeamId,
} from "../services/identity/org-security-policy.service.js";
import {
  activateBreakGlass,
  revokeBreakGlass,
} from "../services/identity/break-glass.service.js";
import {
  startSupportAccess,
  revokeSupportAccess,
} from "../services/identity/support-access.service.js";
import { emergencyOrgRevoke } from "../services/access-control/session-quarantine.service.js";
// PHASE 10 CLOSURE FIX 1 (2026-07-23) — server-authoritative support-context
// entry. Reads-only: re-validates the caller's grant against the DB, then
// mints the opaque signed token the canonical authorize path verifies.
import { validateGrantForSupportContextEntry } from "../services/identity/support-runtime.service.js";
import {
  signSupportContextToken,
  SUPPORT_CONTEXT_TOKEN_TTL_SECONDS,
} from "../services/identity/support-context-token.service.js";

function ip(req: FastifyRequest): string | null {
  return (req.ip as string | undefined) ?? null;
}

// PHASE 12 CORRECTION 1 (2026-07-28) — OrganizationSecurityPolicy is keyed and
// resolved by the AUTHORITATIVE organizationId. The public route no longer
// accepts a teamId compatibility shape; org-admin authorization + the org-keyed
// canonical service are the single authority. Every workspace in the org shares
// the ONE policy.
const OrgQuery = z.object({ organizationId: z.string().uuid() });
const PatchBody = z.object({
  organizationId: z.string().uuid(),
  // Optimistic concurrency — the client sends the version it read; a stale value
  // is rejected 409 with ZERO mutation.
  expectedPolicyVersion: z.number().int().nonnegative().optional(),
  ssoRequired: z.boolean().optional(),
  managedIdentityRequired: z.boolean().optional(),
  noPersonalSpace: z.boolean().optional(),
  maxSessionAgeSeconds: z.number().int().positive().max(86_400).nullable().optional(),
  idleTimeoutSeconds: z.number().int().positive().max(86_400).nullable().optional(),
  concurrentSessionLimit: z.number().int().positive().max(1000).nullable().optional(),
  stepUpIntervalSeconds: z.number().int().positive().max(86_400).nullable().optional(),
  allowedAuthMethods: z.array(z.enum(["PASSWORD", "OAUTH", "SSO"])).optional(),
  // PHASE 12B WAVE 1.2 — fields folded from the DELETED legacy
  // PUT /v1/identity/policy writer. One versioned, step-up-gated authority.
  mfaRequiredFlag: z.boolean().optional(),
  allowedEmailDomains: z.array(z.string().min(1).max(253)).max(100).optional(),
  restrictedIpRanges: z.array(z.string().min(1).max(64)).max(100).optional(),
  reviewerSessionTimeoutSeconds: z.number().int().positive().max(86_400).nullable().optional(),
  contributorSessionTimeoutSeconds: z.number().int().positive().max(86_400).nullable().optional(),
  ssoReadyFlag: z.boolean().optional(),
  scimReadyFlag: z.boolean().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

/**
 * Org-admin authorization for the OrganizationSecurityPolicy surface. Uses the
 * canonical org-access check (ORG_ADMIN+). Anti-enumeration: a non-member /
 * unknown org both yield 404 (identical to not-found). Returns the actor id.
 */
async function requireOrgPolicyAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
  organizationId: string,
): Promise<{ actorUserId: string } | null> {
  const actorUserId = getAuthUserId(req);
  const access = await checkOrgAccess(prisma, { orgId: organizationId, userId: actorUserId, minRole: "ORG_ADMIN" });
  if (access.kind !== "ok") {
    await reply.code(404).send({ error: { code: "NOT_FOUND" } });
    return null;
  }
  return { actorUserId };
}

/**
 * PHASE 12B C10 — PLATFORM-STAFF gate for Support Access and Break-Glass.
 *
 * These are restricted INTERNAL STAFF capabilities, not ordinary
 * Organization-admin features. Before this change the whole family gated on
 * `identity.org_policy.manage` — a CUSTOMER capability. Any org admin holding
 * it in their own workspace could mint a support-access grant over their own
 * Organization, or activate break-glass, purely by calling the API: the
 * "support actor is a distinct identity" invariant the schema comment asserts
 * was not actually enforced at the authorization layer.
 *
 * The gate is now: platform staff (`isPlatformAdmin`) AND, for the routes that
 * still need a workspace anchor, the canonical `authorizeOrFail` chain. Staff
 * status is resolved from the persisted `User.platformRole` / the env allowlist
 * — never from a request field, and (since ADM-001, 2026-08-27) never from the
 * JWT `role` claim either: that claim is a login-time snapshot with a 30-day
 * lifetime, so a withdrawn grant would otherwise have kept minting support
 * grants over customer organizations for a month. `isPlatformAdmin` re-reads
 * the authoritative row on every request and fails closed.
 *
 * Denial is a flat 404 so a customer admin probing these paths cannot even
 * learn that the support surface exists.
 */
async function requirePlatformStaff(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ actorUserId: string } | null> {
  const actorUserId = getAuthUserId(req);
  const role =
    (req.user as { platformRole?: string | null; role?: string | null } | undefined)
      ?.platformRole ??
    (req.user as { role?: string | null } | undefined)?.role ??
    null;
  const staff = await isPlatformAdmin(actorUserId, role);
  if (!staff) {
    await reply.code(404).send({ error: { code: "NOT_FOUND" } });
    return null;
  }
  return { actorUserId };
}

/**
 * PHASE 12B C10 — secret-free projection of a support-access grant. Never
 * includes the support-context token, the signing material, or any customer
 * payload; only the dual identity (support actor + customer Organization), the
 * bounded scope, the reason, and the lifecycle timestamps an auditor needs.
 */
function projectSupportGrant(row: {
  id: string;
  supportUserId: string;
  organizationId: string;
  teamId: string | null;
  reason: string;
  accessLevel: string;
  status: string;
  approvedByUserId: string | null;
  startedAtUtc: Date;
  expiresAtUtc: Date;
  revokedAtUtc: Date | null;
}) {
  return {
    id: row.id,
    supportUserId: row.supportUserId,
    organizationId: row.organizationId,
    teamId: row.teamId,
    reason: row.reason,
    accessLevel: row.accessLevel,
    status: row.status,
    approvedByUserId: row.approvedByUserId,
    startedAtUtc: row.startedAtUtc.toISOString(),
    expiresAtUtc: row.expiresAtUtc.toISOString(),
    revokedAtUtc: row.revokedAtUtc?.toISOString() ?? null,
    // Derived, not stored — the staff console renders live state rather than
    // recomputing expiry from clocks it does not control.
    expired: row.revokedAtUtc === null && row.expiresAtUtc.getTime() <= Date.now(),
    /*
     * THE ANSWER TO "WHO CAN REACH CUSTOMER DATA RIGHT NOW".
     *
     * `status` is the stored column, and nothing sweeps it the moment a window
     * closes — so a grant that lapsed a second ago still reads ACTIVE there.
     * The sibling break-glass projection already derives this; this one did
     * not, and the support-access console is exactly where a stale ACTIVE is
     * most misleading. Same helper, so the two surfaces cannot disagree about
     * what "active" means.
     */
    effectiveStatus: effectiveGrantStatus(row),
  };
}

/**
 * PHASE 12B C10 — secret-free projection of a break-glass grant.
 * `stepUpProofId` is deliberately reduced to a boolean: the proof EXISTS is the
 * auditable fact; the challenge id itself is strong-auth material and is never
 * projected to any client.
 */
function projectEmergencyGrant(row: {
  id: string;
  organizationId: string;
  emergencyUserId: string;
  grantedRole: string;
  reason: string;
  status: string;
  requestedByUserId: string;
  stepUpProofId: string | null;
  startedAtUtc: Date;
  expiresAtUtc: Date;
  revokedAtUtc: Date | null;
  revokedByUserId: string | null;
}) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    emergencyUserId: row.emergencyUserId,
    grantedRole: row.grantedRole,
    reason: row.reason,
    status: row.status,
    requestedByUserId: row.requestedByUserId,
    stepUpProofRecorded: row.stepUpProofId !== null,
    startedAtUtc: row.startedAtUtc.toISOString(),
    expiresAtUtc: row.expiresAtUtc.toISOString(),
    revokedAtUtc: row.revokedAtUtc?.toISOString() ?? null,
    revokedByUserId: row.revokedByUserId,
    expired: row.revokedAtUtc === null && row.expiresAtUtc.getTime() <= Date.now(),
    /**
     * THE STATUS AN OPERATOR SHOULD ACT ON.
     *
     * `status` is the STORED word, and nothing sweeps it when a grant's window
     * simply runs out — so a lapsed grant sat in the column as ACTIVE while
     * the `expired` boolean beside it said otherwise. One row, two answers,
     * and a staff console that listed emergency access as live hours after it
     * had stopped being live.
     *
     * The stored value is kept, because it records what a writer last decided
     * and a REVOKED grant must never be softened into merely EXPIRED. This is
     * the derived one, and it is what the list filters on.
     */
    effectiveStatus: effectiveGrantStatus(row),
  };
}

/**
 * ACTIVE only while the window is open; otherwise EXPIRED. A revocation is a
 * decision and outranks the clock.
 */
function effectiveGrantStatus(row: {
  status: string;
  expiresAtUtc: Date;
  revokedAtUtc: Date | null;
}): "ACTIVE" | "REVOKED" | "EXPIRED" {
  if (row.status === "REVOKED" || row.revokedAtUtc !== null) return "REVOKED";
  if (row.expiresAtUtc.getTime() <= Date.now()) return "EXPIRED";
  return row.status === "ACTIVE" ? "ACTIVE" : "EXPIRED";
}

/**
 * The database predicate for an EFFECTIVE status.
 *
 * Filtering on the stored column alone is what let `?status=ACTIVE` answer
 * with grants whose window had closed. Expiry is a function of time, so the
 * clock has to appear in the query rather than only in the projection.
 */
function grantStatusWhere(status: "ACTIVE" | "REVOKED" | "EXPIRED" | undefined, now: Date) {
  if (status === "ACTIVE") return { status: "ACTIVE", expiresAtUtc: { gt: now } };
  if (status === "REVOKED") return { status: "REVOKED" };
  if (status === "EXPIRED") {
    return {
      OR: [
        { status: "EXPIRED" },
        // Never swept, but lapsed: expired in every sense that matters.
        { status: "ACTIVE", expiresAtUtc: { lte: now } },
      ],
    };
  }
  return {};
}

export async function enterpriseSecurityRoutes(app: FastifyInstance) {
  // ── §10.1 read policy (org-keyed) ────────────────────────────────────
  app.get("/v1/security-policy", { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const q = OrgQuery.parse(req.query ?? {});
    const auth = await requireOrgPolicyAdmin(req, reply, q.organizationId);
    if (!auth) return;
    // Discriminated result: NOT_APPLICABLE for SYSTEM/non-CUSTOMER orgs; a
    // CUSTOMER org with NO provisioned policy FAILS CLOSED (503
    // POLICY_NOT_PROVISIONED — the editor provisions v1 explicitly via PATCH).
    try {
      const resolution = await resolveOrgPolicyByOrgId(q.organizationId);
      if (resolution.applicability !== "ORGANIZATION") {
        return reply.send({ applicability: "NOT_APPLICABLE", reason: resolution.reason, policy: null });
      }
      return reply.send({ applicability: "ORGANIZATION", organizationId: resolution.organizationId, policy: resolution.policy });
    } catch (err) {
      if ((err as { code?: string }).code === "POLICY_NOT_PROVISIONED") {
        return reply.code(503).send({ error: { code: "POLICY_NOT_PROVISIONED" } });
      }
      throw err;
    }
  });

  // ── §10.1/§10.2/§10.7 patch policy (versioned; optimistic; step-up) ──
  app.patch("/v1/security-policy", { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = PatchBody.parse(req.body ?? {});
    const auth = await requireOrgPolicyAdmin(req, reply, body.organizationId);
    if (!auth) return;
    // Step-up binds to the org's canonical team (challenge anchor only — never a
    // policy decision key).
    const bindTeamId = await orgCanonicalTeamId(body.organizationId);
    if (bindTeamId) {
      const gate = await requireStepUpForSensitiveAction({ req, reply, teamId: bindTeamId, userId: auth.actorUserId, purpose: "ORG_SECURITY_POLICY_UPDATE" });
      if (gate.sent) return;
    }
    const { organizationId, expectedPolicyVersion, ...patch } = body;
    try {
      const policy = await applySecurityPolicyPatch({ organizationId, expectedPolicyVersion: expectedPolicyVersion ?? null, actorUserId: auth.actorUserId, patch, ipAddress: ip(req), userAgent: (req.headers["user-agent"] as string) ?? null });
      return reply.send({ policy });
    } catch (err) {
      const e = err as { statusCode?: number; code?: string; details?: unknown };
      if (e.code === "POLICY_VERSION_CONFLICT") return reply.code(409).send({ error: { code: e.code, details: e.details } });
      if (e.code === "ORG_SECURITY_POLICY_NOT_APPLICABLE") return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      throw err;
    }
  });

  // ── §10.4 high-security readiness (org-wide dry-run) ──────────────────
  app.get("/v1/security-policy/high-security/readiness", { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const q = OrgQuery.parse(req.query ?? {});
    const auth = await requireOrgPolicyAdmin(req, reply, q.organizationId);
    if (!auth) return;
    return reply.send(await checkHighSecurityReadiness(q.organizationId));
  });

  // ── §10.4 high-security ATOMIC activation (step-up; zero partial) ──────
  app.post("/v1/security-policy/high-security/activate", { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = OrgQuery.parse(req.body ?? {});
    const auth = await requireOrgPolicyAdmin(req, reply, body.organizationId);
    if (!auth) return;
    const bindTeamId = await orgCanonicalTeamId(body.organizationId);
    if (bindTeamId) {
      const gate = await requireStepUpForSensitiveAction({ req, reply, teamId: bindTeamId, userId: auth.actorUserId, purpose: "ORG_SECURITY_POLICY_UPDATE" });
      if (gate.sent) return;
    }
    const result = await activateHighSecurityMode({ organizationId: body.organizationId, actorUserId: auth.actorUserId, ipAddress: ip(req), userAgent: (req.headers["user-agent"] as string) ?? null });
    if (!result.ok) {
      return reply.code(409).send({ error: { code: "HIGH_SECURITY_PREREQUISITES_UNMET", missing: result.missing } });
    }
    return reply.send({ policy: result.policy, affectedSessionUserCount: result.affectedSessionUserCount });
  });

  // ── §10.6 break-glass activate / revoke ───────────────────────────────
  const BreakGlassBody = z.object({ teamId: z.string().uuid(), organizationId: z.string().uuid(), emergencyUserId: z.string().uuid(), reason: z.string().min(8).max(600), grantedRole: z.enum(["EMERGENCY_READ_ONLY", "EMERGENCY_OPERATOR"]).optional() });
  app.post("/v1/break-glass/activate", { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = BreakGlassBody.parse(req.body ?? {});
    // PHASE 12B C10 — platform staff FIRST (a customer org admin must not be
    // able to activate break-glass over their own Organization), then the
    // canonical workspace authorization chain for the anchor team.
    if (!(await requirePlatformStaff(req, reply))) return;
    const auth = await authorizeOrFail(req, reply, { teamId: body.teamId, permission: "identity.org_policy.manage" });
    if (!auth) return;
    const gate = await requireStepUpForSensitiveAction({ req, reply, teamId: body.teamId, userId: auth.actorUserId, purpose: "ORG_SECURITY_POLICY_UPDATE" });
    if (gate.sent) return;
    // §0B — the SERVER-VERIFIED challenge id (bound to actor+org+purpose by
    // consumeApprovedChallenge), never a raw client header, is the proof.
    const stepUpProofId = gate.verifiedChallengeId;
    try {
      const grant = await activateBreakGlass({ organizationId: body.organizationId, emergencyUserId: body.emergencyUserId, requestedByUserId: auth.actorUserId, reason: body.reason, grantedRole: body.grantedRole, stepUpProofId });
      return reply.send({ grant: { id: grant.id, grantedRole: grant.grantedRole, expiresAtUtc: grant.expiresAtUtc } });
    } catch (err) {
      const e = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(e.statusCode ?? 500).send({ error: { code: e.code ?? "BREAK_GLASS_FAILED", message: e.message } });
    }
  });
  app.post("/v1/break-glass/revoke", { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = z.object({ teamId: z.string().uuid(), grantId: z.string().uuid() }).parse(req.body ?? {});
    if (!(await requirePlatformStaff(req, reply))) return;
    const auth = await authorizeOrFail(req, reply, { teamId: body.teamId, permission: "identity.org_policy.manage" });
    if (!auth) return;
    // PHASE 12B C10 — revocation is the CONTAINMENT direction, so it is
    // deliberately NOT step-up gated: an incident responder must be able to cut
    // emergency access without a second factor round-trip. It is still
    // platform-staff gated and audited by the canonical service.
    await revokeBreakGlass({ grantId: body.grantId, revokedByUserId: auth.actorUserId });
    return reply.send({ ok: true });
  });

  // ── PHASE 12B C10 — break-glass grant LIFECYCLE read (staff console) ────
  // There was no read authority, so the staff surface could mint and revoke
  // emergency access but never SEE it. Secret-free projection; the step-up
  // proof id is reduced to a boolean.
  app.get("/v1/break-glass/grants", { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const q = z
      .object({
        organizationId: z.string().uuid().optional(),
        status: z.enum(["ACTIVE", "REVOKED", "EXPIRED"]).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      })
      .parse(req.query ?? {});
    if (!(await requirePlatformStaff(req, reply))) return;
    const rows = await prisma.emergencyAccessGrant.findMany({
      where: {
        ...(q.organizationId ? { organizationId: q.organizationId } : {}),
        // Effective status, so a lapsed grant is never answered as ACTIVE.
        ...grantStatusWhere(q.status, new Date()),
      },
      orderBy: [{ startedAtUtc: "desc" }, { id: "desc" }],
      take: Math.min(q.limit ?? 50, 200),
    });
    return reply.send({ grants: rows.map(projectEmergencyGrant) });
  });

  // ── §10.8 support-access start / revoke ───────────────────────────────
  const SupportBody = z.object({ teamId: z.string().uuid(), organizationId: z.string().uuid(), reason: z.string().min(8).max(600), scopeTeamId: z.string().uuid().nullable().optional(), accessLevel: z.enum(["READ_ONLY", "ELEVATED"]).optional(), approvedByUserId: z.string().uuid().nullable().optional() });
  app.post("/v1/support-access/start", { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = SupportBody.parse(req.body ?? {});
    // PHASE 12B C10 — the support ACTOR must be PLATFORM STAFF. The previous
    // gate was `identity.org_policy.manage` alone, a CUSTOMER capability, so a
    // customer org admin could mint a support grant over their own Organization
    // and then enter support context with it.
    if (!(await requirePlatformStaff(req, reply))) return;
    const auth = await authorizeOrFail(req, reply, { teamId: body.teamId, permission: "identity.org_policy.manage" });
    if (!auth) return;
    // PHASE 12B C10 — `approvedByUserId` arrives from the request, so it must be
    // VERIFIED, not recorded on trust: an unverified value would let the support
    // actor fabricate a customer approval in the audit trail. The approver must
    // be a real ORG_ADMIN of the customer Organization being accessed.
    if (body.approvedByUserId) {
      const approverAccess = await checkOrgAccess(prisma, {
        orgId: body.organizationId,
        userId: body.approvedByUserId,
        minRole: "ORG_ADMIN",
      });
      if (approverAccess.kind !== "ok") {
        return reply.code(400).send({
          error: { code: "SUPPORT_ACCESS_APPROVER_INVALID" },
        });
      }
    }
    // The support actor can never be their own customer-side approver.
    if (body.approvedByUserId && body.approvedByUserId === auth.actorUserId) {
      return reply.code(400).send({
        error: { code: "SUPPORT_ACCESS_APPROVER_INVALID" },
      });
    }
    try {
      const grant = await startSupportAccess({ supportUserId: auth.actorUserId, organizationId: body.organizationId, teamId: body.scopeTeamId ?? null, reason: body.reason, accessLevel: body.accessLevel, approvedByUserId: body.approvedByUserId ?? null });
      return reply.send({ grant: { id: grant.id, accessLevel: grant.accessLevel, expiresAtUtc: grant.expiresAtUtc } });
    } catch (err) {
      const e = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(e.statusCode ?? 500).send({ error: { code: e.code ?? "SUPPORT_ACCESS_FAILED", message: e.message } });
    }
  });
  app.post("/v1/support-access/revoke", { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    /*
     * REVOCATION IS A PLATFORM ACTION, AND THE CALLER DOES NOT PICK ITS GATE.
     *
     * This ran `authorizeOrFail` on `body.teamId` — a workspace the CALLER
     * names — and demanded `identity.org_policy.manage` in it. Platform staff
     * are not members of their customers' workspaces, so the people whose job
     * this is were refused 403 while the field that decided it was supplied by
     * the request. A caller-controlled value must never choose whether
     * authority applies, and killing live support access into customer data
     * must never be the leg that is hardest to reach.
     *
     * `teamId` is still accepted for audit context and step-up anchoring; it
     * is no longer the authority. The authority is platform staff, and the
     * actor recorded is the authenticated staff user.
     */
    const body = z.object({ teamId: z.string().uuid().optional(), grantId: z.string().uuid() }).parse(req.body ?? {});
    const staff = await requirePlatformStaff(req, reply);
    if (!staff) return;
    await revokeSupportAccess({ grantId: body.grantId, revokedByUserId: staff.actorUserId });
    return reply.send({ ok: true });
  });

  // ── PHASE 12B C10 — support-access grant LIFECYCLE read (staff console) ──
  // Secret-free: the support-context TOKEN is never projected here. It exists
  // only in the /enter response and lives in memory on the staff client.
  app.get("/v1/support-access/grants", { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const q = z
      .object({
        organizationId: z.string().uuid().optional(),
        status: z.enum(["ACTIVE", "REVOKED", "EXPIRED"]).optional(),
        mine: z.enum(["true", "false"]).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      })
      .parse(req.query ?? {});
    const staff = await requirePlatformStaff(req, reply);
    if (!staff) return;
    // ONE predicate for the rows and the count. Two separately-built filters
    // is how a list and its total drift apart under a filter change.
    const where = {
      ...(q.organizationId ? { organizationId: q.organizationId } : {}),
      /*
       * The clock is part of the filter, not only part of the projection.
       *
       * Filtering on the stored column alone made `?status=ACTIVE` answer with
       * grants whose window had already closed, and `?status=EXPIRED` miss
       * them — so the one question this console exists to answer, "show me
       * live access into customer data", returned access that was already
       * dead and hid access that was. Same predicate the break-glass surface
       * uses, so the two cannot drift.
       */
      ...grantStatusWhere(q.status, new Date()),
      // Default view is the caller's OWN grants — those are the only ones they
      // can actually enter context with.
      ...(q.mine === "false" ? {} : { supportUserId: staff.actorUserId }),
    };
    const limit = Math.min(q.limit ?? 50, 200);
    const [rows, total] = await Promise.all([
      prisma.supportAccessGrant.findMany({
        where,
        orderBy: [{ startedAtUtc: "desc" }, { id: "desc" }],
        take: limit,
      }),
      prisma.supportAccessGrant.count({ where }),
    ]);
    // `total` and `limit` are SIBLINGS of `grants`: the page can now say
    // "Showing 50 of 137" instead of "50 support grants", and no caller that
    // only reads `grants` sees a different shape.
    return reply.send({
      grants: rows.map(projectSupportGrant),
      total,
      limit,
    });
  });

  // ── §10.6 Step 4 — break-glass EMERGENCY OPERATE (CONSUMES a grant) ─────
  // The runtime COMPOSITION point: an incident responder presenting an ACTIVE
  // EMERGENCY_OPERATOR grant + server-verified step-up performs a RESTRICTED
  // containment operation. Authorization runs through the bounded emergency
  // OVERLAY over canonical authorize (`authorizeWithEmergencyOverlay`), whose
  // decision is deferred entirely to the ONE break-glass authority. The action
  // string is matched against the operator allowlist there; destructive
  // Evidence / legal-hold / retention / billing actions are NEVER on it. With
  // no emergency entry the overlay delegates verbatim to canonical authorize.
  const EmergencyRevokeBody = z.object({
    teamId: z.string().uuid(),
    organizationId: z.string().uuid(),
    grantId: z.string().uuid(),
    stepUpProofId: z.string().min(1),
    reason: z.string().min(8).max(600),
  });
  app.post("/v1/break-glass/emergency/sessions/revoke", { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = EmergencyRevokeBody.parse(req.body ?? {});
    if (!(await requirePlatformStaff(req, reply))) return;
    const authz = await authorizeWithEmergencyOverlay(req, reply, {
      teamId: body.teamId,
      organizationId: body.organizationId,
      permission: "identity.org_policy.manage",
      action: "session.revoke",
      grantId: body.grantId,
      stepUpProofId: body.stepUpProofId,
    });
    if (!authz) return; // overlay already sent the bounded deny/401/503
    // On allow, perform the canonical containment operation. No membership is
    // minted; the overlay audited the emergency decision at critical severity.
    const result = await emergencyOrgRevoke({ teamId: body.teamId, actorUserId: authz.actorUserId, reason: body.reason });
    return reply.send({ viaEmergency: authz.viaEmergency, capability: authz.emergencyCapability ?? null, ...result });
  });

  // ── §10.8 CLOSURE FIX 1 / HARDENING FIX 1 — server-authoritative
  // support-context ENTRY ─────────────────────────────────────────────────
  // The support actor explicitly enters Support context for a grant they
  // already hold (minted by `/v1/support-access/start` above). The server
  // re-validates that EXACT grant against the DB — ACTIVE, unexpired,
  // unrevoked, `supportUserId` === the authenticated caller — and, ONLY on
  // success, mints an OPAQUE signed token BOUND to the caller's CURRENT
  // authenticated session (`getAuthSessionId` — the hashed `sid` claim
  // `requireAuth` already resolved onto `req.user`). This route performs NO
  // grant mutation (read-only); the grant authority stays entirely in
  // support-access.service.ts. The returned token is what the client
  // attaches as `x-proovra-support-context` on subsequent requests — it
  // REPLACES the deleted client-controlled `x-proovra-support-mode` boolean.
  // Mode / scope / org / workspace / action / approval are NEVER carried in
  // the token; every one of those is re-resolved from the persisted grant
  // by `applySupportAccessGuard` (support-runtime.service.ts) on every
  // subsequent request. `middleware/authorize.ts` requires the token's
  // `sessionIdHash` to match the PRESENTING request's session — minting
  // here from a different session than the one that later presents the
  // token always fails closed.
  const SupportEnterBody = z.object({
    teamId: z.string().uuid(),
    grantId: z.string().uuid(),
  });
  app.post(
    "/v1/support-access/enter",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = SupportEnterBody.parse(req.body ?? {});
      // PHASE 12B C10 — platform staff first, then the same capability gate as
      // /start and /revoke.
      if (!(await requirePlatformStaff(req, reply))) return;
      const auth = await authorizeOrFail(req, reply, {
        teamId: body.teamId,
        permission: "identity.org_policy.manage",
      });
      if (!auth) return;
      // Fail closed BEFORE any grant read: a request whose session cannot
      // be resolved (e.g. a pre-Phase-19 token with no `sid`) can never
      // mint a session-bound token — there is nothing to bind it to.
      let sessionIdHash: string;
      try {
        sessionIdHash = getAuthSessionId(req);
      } catch {
        return reply.code(403).send({
          error: { code: "SUPPORT_CONTEXT_ENTRY_DENIED", reason: "session_unresolved" },
        });
      }
      const validated = await validateGrantForSupportContextEntry({
        actorUserId: auth.actorUserId,
        grantId: body.grantId,
      });
      if (!validated.valid) {
        return reply.code(403).send({
          error: { code: "SUPPORT_CONTEXT_ENTRY_DENIED", reason: validated.reason },
        });
      }
      const token = signSupportContextToken({
        grantId: validated.grant.id,
        supportUserId: validated.grant.supportUserId,
        sessionIdHash,
      });
      return reply.send({
        supportContextToken: token,
        expiresInSeconds: SUPPORT_CONTEXT_TOKEN_TTL_SECONDS,
      });
    },
  );

  // ── §10.8 Step 5 — support runtime PER-REQUEST GUARD ───────────────────
  // Support-access ENFORCEMENT is NOT a client-called oracle. It runs
  // server-side on the canonical authorization path (`evaluateAuthorize` →
  // `applySupportAccessGuard`, middleware/authorize.ts) for EVERY authorized
  // operation, with the action SERVER-DERIVED from the route permission and
  // the grant SERVER-PINNED by the caller's opaque support-context token
  // (never a client-controlled boolean — see CLOSURE FIX 1, 2026-07-23). The
  // former `/v1/support-access/authorize-action` oracle was removed
  // (2026-07-23) so authorization enforcement is never delegated to the
  // client. See phase-10-support-enforcement.test.ts for the behavioral
  // coverage.
}
