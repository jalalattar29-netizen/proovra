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
// PHASE 10 HARDENING FIX 1 (2026-07-23) — the support-context token must be
// bound to the EXACT authenticated session minting it.
import { getAuthSessionId } from "../auth.js";
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";
import {
  resolveOrganizationPolicy,
  applySecurityPolicyPatch,
  checkHighSecurityReadiness,
  activateHighSecurityMode,
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

const TeamQuery = z.object({ teamId: z.string().uuid() });
const PatchBody = z.object({
  teamId: z.string().uuid(),
  ssoRequired: z.boolean().optional(),
  managedIdentityRequired: z.boolean().optional(),
  noPersonalSpace: z.boolean().optional(),
  maxSessionAgeSeconds: z.number().int().positive().max(86_400).nullable().optional(),
  idleTimeoutSeconds: z.number().int().positive().max(86_400).nullable().optional(),
  concurrentSessionLimit: z.number().int().positive().max(1000).nullable().optional(),
  stepUpIntervalSeconds: z.number().int().positive().max(86_400).nullable().optional(),
  allowedAuthMethods: z.array(z.enum(["PASSWORD", "OAUTH", "SSO"])).optional(),
});

export async function enterpriseSecurityRoutes(app: FastifyInstance) {
  // ── §10.1 read policy ────────────────────────────────────────────────
  app.get("/v1/security-policy", { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const q = TeamQuery.parse(req.query ?? {});
    const auth = await authorizeOrFail(req, reply, { teamId: q.teamId, permission: "identity.org_policy.read" });
    if (!auth) return;
    // §1.3 — discriminated result: NOT_APPLICABLE for Personal/OWNED/SYSTEM (no
    // fabricated policy fields); ORGANIZATION exposes the persisted policy.
    const resolution = await resolveOrganizationPolicy(q.teamId);
    if (resolution.applicability !== "ORGANIZATION") {
      return reply.send({ applicability: "NOT_APPLICABLE", reason: resolution.reason, policy: null });
    }
    return reply.send({ applicability: "ORGANIZATION", organizationId: resolution.organizationId, policy: resolution.policy });
  });

  // ── §10.1/§10.2/§10.7 patch policy (versioned; step-up for high-risk) ──
  app.patch("/v1/security-policy", { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = PatchBody.parse(req.body ?? {});
    const auth = await authorizeOrFail(req, reply, { teamId: body.teamId, permission: "identity.org_policy.manage" });
    if (!auth) return;
    const gate = await requireStepUpForSensitiveAction({ req, reply, teamId: body.teamId, userId: auth.actorUserId, purpose: "ORG_SECURITY_POLICY_UPDATE" });
    if (gate.sent) return;
    const { teamId, ...patch } = body;
    const policy = await applySecurityPolicyPatch({ teamId, actorUserId: auth.actorUserId, patch, ipAddress: ip(req), userAgent: (req.headers["user-agent"] as string) ?? null });
    return reply.send({ policy });
  });

  // ── §10.4 high-security readiness (dry-run prerequisite check) ─────────
  app.get("/v1/security-policy/high-security/readiness", { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const q = TeamQuery.parse(req.query ?? {});
    const auth = await authorizeOrFail(req, reply, { teamId: q.teamId, permission: "identity.org_policy.manage" });
    if (!auth) return;
    return reply.send(await checkHighSecurityReadiness(q.teamId));
  });

  // ── §10.4 high-security ATOMIC activation (step-up; zero partial) ──────
  app.post("/v1/security-policy/high-security/activate", { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = TeamQuery.parse(req.body ?? {});
    const auth = await authorizeOrFail(req, reply, { teamId: body.teamId, permission: "identity.org_policy.manage" });
    if (!auth) return;
    const gate = await requireStepUpForSensitiveAction({ req, reply, teamId: body.teamId, userId: auth.actorUserId, purpose: "ORG_SECURITY_POLICY_UPDATE" });
    if (gate.sent) return;
    const result = await activateHighSecurityMode({ teamId: body.teamId, actorUserId: auth.actorUserId, ipAddress: ip(req), userAgent: (req.headers["user-agent"] as string) ?? null });
    if (!result.ok) {
      return reply.code(409).send({ error: { code: "HIGH_SECURITY_PREREQUISITES_UNMET", missing: result.missing } });
    }
    return reply.send({ policy: result.policy, affectedSessionUserCount: result.affectedSessionUserCount });
  });

  // ── §10.6 break-glass activate / revoke ───────────────────────────────
  const BreakGlassBody = z.object({ teamId: z.string().uuid(), organizationId: z.string().uuid(), emergencyUserId: z.string().uuid(), reason: z.string().min(8).max(600), grantedRole: z.enum(["EMERGENCY_READ_ONLY", "EMERGENCY_OPERATOR"]).optional() });
  app.post("/v1/break-glass/activate", { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = BreakGlassBody.parse(req.body ?? {});
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
    const auth = await authorizeOrFail(req, reply, { teamId: body.teamId, permission: "identity.org_policy.manage" });
    if (!auth) return;
    await revokeBreakGlass({ grantId: body.grantId, revokedByUserId: auth.actorUserId });
    return reply.send({ ok: true });
  });

  // ── §10.8 support-access start / revoke ───────────────────────────────
  const SupportBody = z.object({ teamId: z.string().uuid(), organizationId: z.string().uuid(), reason: z.string().min(8).max(600), scopeTeamId: z.string().uuid().nullable().optional(), accessLevel: z.enum(["READ_ONLY", "ELEVATED"]).optional(), approvedByUserId: z.string().uuid().nullable().optional() });
  app.post("/v1/support-access/start", { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = SupportBody.parse(req.body ?? {});
    // The support ACTOR is the authenticated support user; authorization is
    // the platform support capability (org_policy.manage as the closest
    // existing org-security capability). The subject is the customer org.
    const auth = await authorizeOrFail(req, reply, { teamId: body.teamId, permission: "identity.org_policy.manage" });
    if (!auth) return;
    try {
      const grant = await startSupportAccess({ supportUserId: auth.actorUserId, organizationId: body.organizationId, teamId: body.scopeTeamId ?? null, reason: body.reason, accessLevel: body.accessLevel, approvedByUserId: body.approvedByUserId ?? null });
      return reply.send({ grant: { id: grant.id, accessLevel: grant.accessLevel, expiresAtUtc: grant.expiresAtUtc } });
    } catch (err) {
      const e = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(e.statusCode ?? 500).send({ error: { code: e.code ?? "SUPPORT_ACCESS_FAILED", message: e.message } });
    }
  });
  app.post("/v1/support-access/revoke", { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = z.object({ teamId: z.string().uuid(), grantId: z.string().uuid() }).parse(req.body ?? {});
    const auth = await authorizeOrFail(req, reply, { teamId: body.teamId, permission: "identity.org_policy.manage" });
    if (!auth) return;
    await revokeSupportAccess({ grantId: body.grantId, revokedByUserId: auth.actorUserId });
    return reply.send({ ok: true });
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
      // Same capability gate as /start and /revoke — the closest existing
      // org-security capability for the platform support actor.
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
