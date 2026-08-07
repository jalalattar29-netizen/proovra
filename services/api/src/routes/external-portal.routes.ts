/**
 * PROOVRA Phase 2B — External Reviewer Portal routes.
 *
 * Two families:
 *
 *   1. Internal (authenticated PROOVRA operator) — invitation
 *      management. Lives under /v1/external-review/invitations.
 *
 *   2. Portal (token-authenticated reviewer) — session +
 *      dashboard + work + comments + decisions + activity. Lives
 *      under /v1/portal/*.
 *
 * TENANT_SCOPE_EXCEPTION: public_verify_token_readonly
 *   The portal family is intentionally not gated by the standard
 *   `authorizeOrFail` helper. The external reviewer is anonymous in
 *   the PROOVRA tenant sense — the workspace anchor is the grant's
 *   teamId, validated on every request. Every Prisma write filters
 *   on `teamId` resolved from the grant.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  BULK_INVITATION_MAX_ROWS,
  EXTERNAL_DECISION_VERDICTS,
  EXTERNAL_REVIEWER_ROLES,
  WATERMARK_POLICIES,
  type ExternalPortalCapability,
} from "@proovra/shared";

import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
// PHASE 12 REMEDIATION — SEC-001 (2026-08-06). The ONE authorization
// authority for every internal (operator-side) route in this file. See the
// block comment where `resolveInternalTeam` used to live.
import {
  assertMintedAuthorizedWorkspaceContext,
  authorizeCurrentWorkspaceOrFail,
  type AuthorizedWorkspaceContext,
} from "../middleware/authorize.js";
import {
  organizationLifecycleApplies,
  resolveWorkspaceKind,
} from "../services/identity/workspace-kind.js";
// Phase 3 blocker closure — issuing/rotating/revealing an external-
// reviewer grant can expose sensitive evidence to an OUTSIDE reviewer,
// so these mutations must require a fresh step-up on top of the RBAC
// capability gate.
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";
import { externalPortalCapabilitiesForRole } from "@proovra/shared";
import { assertFeatureEntitlement } from "../services/packaging/entitlement.service.js";

import {
  emitPortalSessionRevoked,
  endPortalSession,
  establishPortalSession,
} from "../services/external-review/portal-session.service.js";
// PHASE 5 §8.5 (2026-07-22) — grant→workflow resource-scope binding.
import { resolveWorkflowInGrantScope } from "../services/external-review/portal-scope.service.js";
import {
  acceptInvitation,
  issueInvitation,
  listInvitationsForTeam,
  revokeInvitation,
} from "../services/external-review/portal-invitation.service.js";
import { projectPortalDashboard } from "../services/external-review/portal-projection.service.js";
import {
  emitPortalActivity,
  listPortalActivity,
} from "../services/external-review/portal-activity.service.js";
import {
  listExternalDecisionsForWorkflow,
  submitExternalDecision,
} from "../services/external-review/portal-decisions.service.js";
import {
  listCommentsForWorkflow,
  postCommentInWorkflow,
} from "../services/external-review/portal-comments.service.js";
import {
  deliverInvitationEmail,
  listDeliveriesForGrant,
} from "../services/external-review/portal-invitation-email.service.js";
import {
  bulkIssueInvitations,
  bulkRevokeInvitations,
  resendInvitationEmail,
} from "../services/external-review/portal-bulk-invitations.service.js";
import {
  completePortalSsoFlow,
  startPortalSsoFlow,
} from "../services/external-review/portal-sso.service.js";
import { rotateExternalReviewGrantToken } from "../services/external-review/external-review-grant.service.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const IssueInvitationBody = z.object({
  reviewerEmail: z.string().email().max(320),
  reviewerDisplayName: z.string().max(200).optional(),
  organization: z.string().max(180).optional(),
  role: z.enum(EXTERNAL_REVIEWER_ROLES),
  watermarkPolicy: z.enum(WATERMARK_POLICIES).optional(),
  mfaRequired: z.boolean().optional(),
  scope: z.object({
    kind: z.enum(["EVIDENCE", "CASE", "PACKAGE"]),
    evidenceId: z.string().uuid().optional(),
    caseId: z.string().uuid().optional(),
    packageId: z.string().uuid().optional(),
  }),
  expiresAtUtc: z.string().datetime(),
  allowOriginalDownload: z.boolean().optional(),
  allowPackageDownload: z.boolean().optional(),
  safeNote: z.string().max(500).optional(),
});

const PortalAuthBody = z.object({
  token: z.string().min(8).max(256),
  mfaToken: z.string().min(1).max(16).optional(),
  existingSessionId: z.string().max(80).optional(),
});

const SubmitDecisionBody = z.object({
  verdict: z.enum(EXTERNAL_DECISION_VERDICTS),
  rationale: z.string().max(600).optional(),
});

const PostCommentBody = z.object({
  body: z.string().min(1).max(4000),
  parentCommentId: z.string().uuid().optional(),
});

// Phase 2B Closure — bulk + SSO request schemas.

const BulkRowSchema = z.object({
  inviteEmail: z.string().email().max(320),
  displayName: z.string().max(200).optional(),
  organization: z.string().max(180).optional(),
  role: z.enum(EXTERNAL_REVIEWER_ROLES).optional(),
  watermarkPolicy: z.enum(WATERMARK_POLICIES).optional(),
  mfaRequired: z.boolean().optional(),
  scope: z
    .object({
      kind: z.enum(["EVIDENCE", "CASE", "PACKAGE"]),
      evidenceId: z.string().uuid().optional(),
      caseId: z.string().uuid().optional(),
      packageId: z.string().uuid().optional(),
    })
    .optional(),
});

const BulkIssueBody = z.object({
  expiresAtUtc: z.string().datetime(),
  defaultRole: z.enum(EXTERNAL_REVIEWER_ROLES).optional(),
  defaultWatermarkPolicy: z.enum(WATERMARK_POLICIES).optional(),
  defaultMfaRequired: z.boolean().optional(),
  defaultScope: z
    .object({
      kind: z.enum(["EVIDENCE", "CASE", "PACKAGE"]),
      evidenceId: z.string().uuid().optional(),
      caseId: z.string().uuid().optional(),
      packageId: z.string().uuid().optional(),
    })
    .optional(),
  rows: z.array(BulkRowSchema).min(1).max(BULK_INVITATION_MAX_ROWS),
});

const BulkRevokeBody = z.object({
  grantIds: z
    .array(z.string().uuid())
    .min(1)
    .max(BULK_INVITATION_MAX_ROWS),
  reason: z.string().max(400).optional(),
});

const SsoStartBody = z.object({
  ssoConnectionId: z.string().uuid().optional(),
  acsUrl: z.string().url().max(400),
  spEntityId: z.string().min(1).max(400),
});

const SsoCallbackBody = z.object({
  grantId: z.string().uuid(),
  samlResponseBase64: z.string().min(1).max(200_000),
  expectedInResponseTo: z.string().max(200).nullable().optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * PHASE 12 REMEDIATION — SEC-001 (2026-08-06).
 *
 * `resolveInternalTeam` USED TO LIVE HERE. It was the CRITICAL finding of the
 * Phase-12 focused-reachability audit, and it is DELETED, not patched.
 *
 * What it did:
 *   read `User.currentWorkspaceId` -> load the Team -> deny only when the
 *   pointer was null, the team was missing, or the team was Personal -> read
 *   a TeamMember row WITHOUT a status predicate -> return
 *   `{ teamId, userId, workspaceRole: membership?.role ?? null }`.
 *
 * Why that was a cross-tenant path:
 *   it returned SUCCESS for a caller with NO membership row at all (the role
 *   simply became `null`) and for a caller whose row was SUSPENDED or
 *   REVOKED (the stored role was returned verbatim). Four of the twelve
 *   internal routes then never called `requireCap`, so nothing downstream
 *   re-checked anything. A user removed from workspace W, whose last
 *   selected context was W, could enumerate W's external-reviewer
 *   invitations plus their delivery and activity records, and could trigger
 *   an outbound invitation email on W's behalf.
 *
 * The replacement is the canonical primitive
 * `authorizeCurrentWorkspaceOrFail` (middleware/authorize.ts). It treats
 * `User.currentWorkspaceId` as what it is — a NAVIGATION HINT supplying a
 * CANDIDATE workspace id — and then revalidates identity, workspace
 * existence, workspace kind, EXPLICIT membership, membership status, access
 * expiry, parent-Organization lifecycle, the canonical permission, and the
 * support-access runtime guard against the database on every request.
 *
 * Consequences that are now structural rather than conventional:
 *   * every one of the twelve routes carries an EXPLICIT canonical
 *     permission — including the four that previously carried none;
 *   * a null role is unrepresentable (`ctx.workspaceRole` is CanonicalRole);
 *   * nonexistent, revoked, suspended, foreign and org-suspended contexts
 *     all conceal identically as 404 (anti-enumeration defaults on);
 *   * NO invitation row is read before authorization completes;
 *   * NO outbound effect is reachable before authorization completes.
 *
 * The reviewer-capability matrix (`resolveReviewerRole` /
 * `callerHasCapability`) is no longer used as a GATE here. It was a
 * second policy vocabulary layered on a role this file resolved for itself;
 * each route's gate is now a canonical `Permission` chosen to match the
 * sibling review/reviewer surfaces, so there is one authority, not two.
 */

/** Bounded denial shape preserved for existing portal clients. */
function denyNoPermission(reply: FastifyReply): FastifyReply {
  return reply.code(403).send({ denial: "NOT_PERMITTED" });
}

/**
 * PHASE 12 REMEDIATION — SEC-001, TIER PRESERVATION (2026-08-06).
 *
 * The migration off `requireCap` must not WIDEN access, and without this
 * floor it would have.
 *
 * The two vocabularies do not agree on who holds "review.assign":
 *
 *   reviewer-capability matrix   review.assign -> SUPERVISOR + REVIEW_ADMIN
 *                                (i.e. workspace ADMIN + OWNER only)
 *   canonical Permission catalog review.assign -> OWNER + ADMIN + REVIEWER
 *                                (REVIEWER is the canonical mapping of the
 *                                 DB `MEMBER` role)
 *
 * Gating purely on the canonical permission would therefore have let a plain
 * workspace MEMBER issue, revoke, resend and bulk-manage external-reviewer
 * invitations — access they did not have before. That is a loosening, and it
 * is exactly what this remediation forbids.
 *
 * So the admission set is preserved EXACTLY: the canonical primitive proves
 * identity, ACTIVE membership, access expiry, workspace kind,
 * Organization lifecycle, the permission and the support-access guard; this
 * floor then re-applies the ADMINISTRATIVE TIER the reviewer matrix
 * expressed. It is NOT a second policy authority — it reads
 * `ctx.workspaceRole`, the PROVEN canonical role on the authorization proof,
 * rather than re-deriving a role from a fresh query.
 *
 * One deliberate TIGHTENING is retained: the former helper granted
 * REVIEW_ADMIN to any session whose `User.platformRole` was non-null, so a
 * platform admin bypassed the workspace tier entirely. That bypass is gone,
 * matching the platform-admin-bypass removals already applied to
 * `automation.routes.ts`, `automation-webhooks.routes.ts` and
 * `analytics-operations.routes.ts`.
 */
/**
 * PHASE 12 CORRECTIVE PASS 3 §2.1 — BINDING, NOT ONLY PROVENANCE.
 *
 * These two helpers turn a field on the context into a TIER decision, so a
 * fabricated context reaching them would fabricate the tier. Pass 2 added
 * `assertMintedContext`, which refuses any object the canonical chain did not
 * produce — necessary, and not sufficient. Provenance alone accepts a GENUINE
 * context minted for a DIFFERENT workspace, so a handler holding two contexts,
 * or one that resolved the wrong one, would read a real OWNER role for the
 * wrong tenant.
 *
 * The expected workspace is now required and checked. Every call site already
 * knows it — it is `ctx.workspaceId` from the gate at the top of the handler —
 * so this costs nothing and closes the one gap provenance leaves open.
 */
function isAdministrativeTier(
  ctx: AuthorizedWorkspaceContext,
  expectedWorkspaceId: string,
): boolean {
  const proven = assertMintedAuthorizedWorkspaceContext(ctx, {
    workspaceId: expectedWorkspaceId,
  });
  return proven.workspaceRole === "OWNER" || proven.workspaceRole === "ADMIN";
}

/** REVIEW_ADMIN tier — workspace OWNER only (break-glass split-of-duty). */
function isOwnerTier(
  ctx: AuthorizedWorkspaceContext,
  expectedWorkspaceId: string,
): boolean {
  return (
    assertMintedAuthorizedWorkspaceContext(ctx, {
      workspaceId: expectedWorkspaceId,
    }).workspaceRole === "OWNER"
  );
}

/**
 * PHASE 12 REMEDIATION — lifecycle gate for the TOKEN_SCOPED portal routes,
 * which have no member context to authorize against but must still refuse to
 * operate inside a dead workspace.
 *
 * Reuses the canonical classifier (`resolveWorkspaceKind` +
 * `organizationLifecycleApplies`) — it does NOT re-derive what an
 * ORGANIZATION workspace is, and it does NOT invent a second lifecycle rule.
 * Fails CLOSED on an unloadable row, an unprovable kind, or any read error.
 */
async function isLiveOperatingWorkspace(teamId: string): Promise<boolean> {
  try {
    const team = await prisma.team.findUnique({
      where: { id: teamId },
      select: {
        isPersonal: true,
        workspaceKind: true,
        billingPlan: true,
        organization: { select: { status: true } },
      },
    });
    if (!team) return false;
    const kind = resolveWorkspaceKind({
      workspaceKind: team.workspaceKind,
      isPersonal: team.isPersonal,
      billingPlan: team.billingPlan,
      teamLoaded: true,
    });
    if (kind === "UNKNOWN") return false;
    if (organizationLifecycleApplies(kind)) {
      return team.organization?.status === "ACTIVE";
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the portal session. Token + optional sessionId are read
 * from the `Authorization: Bearer <token>` header and
 * `x-portal-session` header respectively.
 */
async function resolvePortalSession(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<
  | {
      grantId: string;
      teamId: string;
      sessionId: string;
      reviewerEmail: string;
      reviewerDisplayName: string | null;
      role: string;
      capabilities: ReadonlySet<ExternalPortalCapability>;
      expiresAtUtc: Date;
      scopeKind: "EVIDENCE" | "CASE" | "PACKAGE";
      evidenceId: string | null;
      caseId: string | null;
      packageId: string | null;
      organization: string | null;
      watermarkPolicy: string;
      mfaRequired: boolean;
      inactivityTimeoutMs: number;
      maxSessionMs: number;
    }
  | null
> {
  const header = req.headers["authorization"] ?? req.headers["Authorization"];
  const sessionHeader = req.headers["x-portal-session"];
  const raw =
    typeof header === "string" && header.startsWith("Bearer ")
      ? header.slice(7)
      : null;
  if (!raw) {
    reply.code(401).send({ denial: "TOKEN_INVALID" });
    return null;
  }
  const sess = await establishPortalSession({
    rawToken: raw,
    existingSessionId:
      typeof sessionHeader === "string" ? sessionHeader : null,
    ip: req.ip,
    userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
  });
  if (!sess.ok) {
    reply.code(401).send({ denial: sess.denial });
    return null;
  }
  const s = sess.session;
  const caps = externalPortalCapabilitiesForRole(
    s.role as never,
  ) as ReadonlySet<ExternalPortalCapability>;
  return {
    grantId: s.grantId,
    teamId: s.teamId,
    sessionId: s.sessionId,
    reviewerEmail: s.reviewerEmail,
    reviewerDisplayName: s.reviewerDisplayName,
    role: s.role,
    capabilities: caps,
    expiresAtUtc: s.expiresAtUtc,
    scopeKind: s.scopeKind,
    evidenceId: s.evidenceId,
    caseId: s.caseId,
    packageId: s.packageId,
    organization: s.organization,
    watermarkPolicy: s.watermarkPolicy,
    mfaRequired: s.mfaRequired,
    inactivityTimeoutMs: s.inactivityTimeoutMs,
    maxSessionMs: s.maxSessionMs,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function externalPortalRoutes(app: FastifyInstance) {
  // =========================================================================
  // INTERNAL — Invitation management
  // =========================================================================

  // SEC-001 — previously UNCAPPED. `review.queue.read` is the canonical
  // read permission the sibling reviewer/review-operations surfaces use for
  // enumerating workspace review work; an external-reviewer invitation list
  // is exactly that. VIEWER and CONTRIBUTOR do not hold it.
  app.get(
    "/v1/external-review/invitations",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await authorizeCurrentWorkspaceOrFail(req, reply, {
        permission: "review.queue.read",
      });
      if (!ctx) return reply;
      const rows = await listInvitationsForTeam({ teamId: ctx.workspaceId });
      return reply.code(200).send({ invitations: rows });
    },
  );

  app.post(
    "/v1/external-review/invitations",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Issuing an external-reviewer invitation is a queue-assignment-tier
      // action; `review.assign` is the canonical permission behind it
      // (OWNER/ADMIN/REVIEWER hold it, VIEWER does not) and it is now
      // enforced by the primitive BEFORE any workspace data is touched.
      const ctx = await authorizeCurrentWorkspaceOrFail(req, reply, {
        permission: "review.assign",
      });
      if (!ctx) return reply;
      if (!isAdministrativeTier(ctx, ctx.workspaceId)) return denyNoPermission(reply);
      // I6 — FEATURE_EXTERNAL_PORTAL gate (minimal coverage, one rep mutation).
      try {
        const feOk = await assertFeatureEntitlement({ prisma, teamId: ctx.workspaceId, key: "FEATURE_EXTERNAL_PORTAL", actorUserId: ctx.userId });
        if (!feOk.ok) return reply.code(403).send({ denial: "ENTITLEMENT_REQUIRED", entitlement: "FEATURE_EXTERNAL_PORTAL" });
      } catch { /* engine failure must not break route */ }
      const body = IssueInvitationBody.parse(req.body);
      // STEP-UP: issuing an invitation grants an outside reviewer access
      // to sensitive evidence — require a fresh step-up AFTER the RBAC
      // capability gate, BEFORE the mutation.
      const gate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: ctx.workspaceId,
        userId: ctx.userId,
        purpose: "EXTERNAL_REVIEW_GRANT_ISSUE",
        resourceKind: "external_review_grant",
        resourceId:
          body.scope.evidenceId ??
          body.scope.caseId ??
          body.scope.packageId ??
          null,
      });
      if (gate.sent) return;
      const res = await issueInvitation({
        teamId: ctx.workspaceId,
        invitedByUserId: ctx.userId,
        reviewerEmail: body.reviewerEmail,
        reviewerDisplayName: body.reviewerDisplayName,
        organization: body.organization,
        role: body.role,
        watermarkPolicy: body.watermarkPolicy,
        mfaRequired: body.mfaRequired,
        scope: body.scope,
        expiresAtUtc: body.expiresAtUtc,
        allowOriginalDownload: body.allowOriginalDownload,
        allowPackageDownload: body.allowPackageDownload,
        safeNote: body.safeNote,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(201).send({
        grantId: res.grantId,
        role: res.role,
        // Raw token returned EXACTLY ONCE; never re-derivable.
        rawToken: res.rawToken,
      });
    },
  );

  app.post(
    "/v1/external-review/invitations/:id/revoke",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Same tier as invitation issue.
      const ctx = await authorizeCurrentWorkspaceOrFail(req, reply, {
        permission: "review.assign",
      });
      if (!ctx) return reply;
      if (!isAdministrativeTier(ctx, ctx.workspaceId)) return denyNoPermission(reply);
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const res = await revokeInvitation({
        teamId: ctx.workspaceId,
        grantId: id,
        revokedByUserId: ctx.userId,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(200).send({ ok: true });
    },
  );

  app.get(
    "/v1/external-review/invitations/:id/activity",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // SEC-001 — previously UNCAPPED. Reading an invitation's activity
      // trail is a review-queue read.
      const ctx = await authorizeCurrentWorkspaceOrFail(req, reply, {
        permission: "review.queue.read",
      });
      if (!ctx) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const rows = await listPortalActivity({
        teamId: ctx.workspaceId,
        grantId: id,
        limit: 200,
      });
      return reply.code(200).send({ activity: rows });
    },
  );

  // ---------------------------------------------------------------------------
  // Phase 2B Closure — bulk invitation orchestration + delivery audit
  // ---------------------------------------------------------------------------

  app.post(
    "/v1/external-review/invitations/bulk",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Bulk issuance can never be a WEAKER gate than the single-issue path,
      // so it enforces the same canonical `review.assign` primary permission
      // and additionally requires `review.escalate` — the canonical
      // permission the reviewer matrix uses for the supervisor tier that the
      // former `review.bulk` reviewer-capability denoted. VIEWER and
      // CONTRIBUTOR hold neither.
      const ctx = await authorizeCurrentWorkspaceOrFail(req, reply, {
        permission: "review.assign",
      });
      if (!ctx) return reply;
      if (!isAdministrativeTier(ctx, ctx.workspaceId)) return denyNoPermission(reply);
      // STEP-UP: bulk issuance grants multiple outside reviewers access
      // to sensitive evidence — require a fresh step-up AFTER the RBAC
      // capability gate, BEFORE the mutation.
      const bulkGate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: ctx.workspaceId,
        userId: ctx.userId,
        purpose: "EXTERNAL_REVIEW_GRANT_ISSUE",
        resourceKind: "external_review_grant_bulk",
        resourceId: null,
      });
      if (bulkGate.sent) return;
      const body = BulkIssueBody.parse(req.body);

      const team = await prisma.team.findUnique({
        where: { id: ctx.workspaceId },
        select: { name: true },
      });
      const user = await prisma.user.findUnique({
        where: { id: ctx.userId },
        select: { displayName: true, email: true },
      });
      const res = await bulkIssueInvitations({
        teamId: ctx.workspaceId,
        invitedByUserId: ctx.userId,
        inviterDisplayName:
          user?.displayName ?? user?.email ?? "PROOVRA operator",
        workspaceName: team?.name ?? "PROOVRA workspace",
        expiresAtUtc: body.expiresAtUtc,
        defaultRole: body.defaultRole,
        defaultWatermarkPolicy: body.defaultWatermarkPolicy,
        defaultMfaRequired: body.defaultMfaRequired,
        defaultScope: body.defaultScope,
        rows: body.rows,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(201).send({
        bulkBatchId: res.bulkBatchId,
        rows: res.rows,
        summary: res.summary,
      });
    },
  );

  app.post(
    "/v1/external-review/invitations/bulk/revoke",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Bulk revoke shares the bulk-issue gate exactly.
      const ctx = await authorizeCurrentWorkspaceOrFail(req, reply, {
        permission: "review.assign",
      });
      if (!ctx) return reply;
      if (!isAdministrativeTier(ctx, ctx.workspaceId)) return denyNoPermission(reply);
      const body = BulkRevokeBody.parse(req.body);
      const res = await bulkRevokeInvitations({
        teamId: ctx.workspaceId,
        revokedByUserId: ctx.userId,
        grantIds: body.grantIds,
        reason: body.reason,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply
        .code(200)
        .send({ bulkBatchId: res.bulkBatchId, rows: res.rows });
    },
  );

  // ---------------------------------------------------------------------------
  // Phase 2B Closure — break-glass token reveal (operator-only).
  //
  // Rotates the grant's token hash and returns a fresh raw token EXACTLY
  // ONCE. The standard enterprise flow is the Resend-backed invitation
  // email; this path exists for the bounded fallback case where the
  // reviewer cannot receive the email.
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/external-review/invitations/:id/reveal-token",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Break-glass token rotation returns a raw bearer token EXACTLY ONCE —
      // the most sensitive mutation on this surface. `review.sla.configure`
      // is the canonical permission held by OWNER ONLY; ADMIN does not hold
      // it. That preserves exactly the split-of-duty the former
      // `review.sampling.policy` reviewer-capability expressed (REVIEW_ADMIN
      // yes, SUPERVISOR no) without a second policy vocabulary.
      const ctx = await authorizeCurrentWorkspaceOrFail(req, reply, {
        permission: "review.sla.configure",
      });
      if (!ctx) return reply;
      if (!isOwnerTier(ctx, ctx.workspaceId)) return denyNoPermission(reply);
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      // STEP-UP: break-glass reveal ROTATES the grant token and returns a
      // fresh raw bearer token — the most sensitive mutation on this
      // surface. Require a fresh step-up AFTER the RBAC capability gate,
      // BEFORE the rotate.
      const revealGate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: ctx.workspaceId,
        userId: ctx.userId,
        purpose: "EXTERNAL_REVIEW_GRANT_ISSUE",
        resourceKind: "external_review_grant_reveal",
        resourceId: id,
      });
      if (revealGate.sent) return;
      const body = z
        .object({ reason: z.string().min(10).max(400) })
        .parse(req.body);
      const res = await rotateExternalReviewGrantToken({
        grantId: id,
        teamId: ctx.workspaceId,
        actorUserId: ctx.userId,
        reason: body.reason,
      });
      if (!res.ok) {
        return reply.code(409).send({ denial: res.reason });
      }
      await emitPortalActivity({
        teamId: ctx.workspaceId,
        grantId: id,
        code: "GRANT_RESENT",
        payload: {
          path: "break_glass_reveal",
          actorUserId: ctx.userId,
          reasonPreview: body.reason.slice(0, 80),
        },
      });
      return reply.code(200).send({
        grantId: id,
        rawToken: res.rawToken,
      });
    },
  );

  app.post(
    "/v1/external-review/invitations/:id/resend",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Resending an invitation email is the same operational tier as
      // issuing one, and it now ROTATES the grant token server-side, so the
      // gate must not be weaker than the issue path.
      const ctx = await authorizeCurrentWorkspaceOrFail(req, reply, {
        permission: "review.assign",
      });
      if (!ctx) return reply;
      if (!isAdministrativeTier(ctx, ctx.workspaceId)) return denyNoPermission(reply);
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const team = await prisma.team.findUnique({
        where: { id: ctx.workspaceId },
        select: { name: true },
      });
      const user = await prisma.user.findUnique({
        where: { id: ctx.userId },
        select: { displayName: true, email: true },
      });
      const res = await resendInvitationEmail({
        teamId: ctx.workspaceId,
        grantId: id,
        actorUserId: ctx.userId,
        inviterDisplayName:
          user?.displayName ?? user?.email ?? "PROOVRA operator",
        workspaceName: team?.name ?? "PROOVRA workspace",
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(200).send({
        deliveryId: res.deliveryId,
        attempt: res.attempt,
      });
    },
  );

  app.get(
    "/v1/external-review/invitations/:id/delivery",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // SEC-001 — previously UNCAPPED. Delivery records name the reviewer's
      // email address and the invitation's send history; reading them is a
      // review-queue read.
      const ctx = await authorizeCurrentWorkspaceOrFail(req, reply, {
        permission: "review.queue.read",
      });
      if (!ctx) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const rows = await listDeliveriesForGrant({
        teamId: ctx.workspaceId,
        grantId: id,
      });
      return reply.code(200).send({
        deliveries: rows.map((r) => ({
          id: r.id,
          status: r.status,
          provider: r.provider,
          recipientEmail: r.recipientEmail,
          subject: r.subject,
          attempt: r.attempt,
          queuedAtUtc: r.queuedAtUtc.toISOString(),
          sentAtUtc: r.sentAtUtc?.toISOString() ?? null,
          deliveredAtUtc: r.deliveredAtUtc?.toISOString() ?? null,
          openedAtUtc: r.openedAtUtc?.toISOString() ?? null,
          failedAtUtc: r.failedAtUtc?.toISOString() ?? null,
          revokedAtUtc: r.revokedAtUtc?.toISOString() ?? null,
          expiredAtUtc: r.expiredAtUtc?.toISOString() ?? null,
          failureReason: r.failureReason,
          bulkBatchId: r.bulkBatchId,
        })),
      });
    },
  );

  // =========================================================================
  // PORTAL — Token-authenticated reviewer surface
  // =========================================================================

  app.post(
    "/v1/portal/auth",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = PortalAuthBody.parse(req.body);
      const sess = await establishPortalSession({
        rawToken: body.token,
        mfaToken: body.mfaToken ?? null,
        existingSessionId: body.existingSessionId ?? null,
        ip: req.ip,
        userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
      });
      if (!sess.ok) return reply.code(401).send({ denial: sess.denial });
      // Best-effort flip INVITED → ACTIVE on first arrival.
      await acceptInvitation({
        teamId: sess.session.teamId,
        grantId: sess.session.grantId,
      }).catch(() => {
        // Non-fatal — grant may already be ACTIVE.
      });
      return reply.code(200).send({
        sessionId: sess.session.sessionId,
        newLogin: sess.newLogin,
        // Echo the bounded role for the client; full projection comes
        // via /v1/portal/dashboard.
        reviewerEmail: sess.session.reviewerEmail,
        role: sess.session.role,
        expiresAtUtc: sess.session.expiresAtUtc.toISOString(),
      });
    },
  );

  app.post(
    "/v1/portal/logout",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const s = await resolvePortalSession(req, reply);
      if (!s) return reply;
      await endPortalSession({
        teamId: s.teamId,
        grantId: s.grantId,
        sessionId: s.sessionId,
        ip: req.ip,
        userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
      });
      return reply.code(200).send({ ok: true });
    },
  );

  app.get(
    "/v1/portal/dashboard",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const s = await resolvePortalSession(req, reply);
      if (!s) return reply;
      const projection = await projectPortalDashboard({ session: s as never });
      return reply.code(200).send({ portal: projection });
    },
  );

  // PHASE 5 §8.5 (2026-07-22) — every workflow-scoped portal route must
  // prove the workflow belongs to the GRANT'S resource scope (evidence /
  // case / package), not merely the workspace. Out-of-scope and
  // nonexistent workflows return the same denial (no enumeration).
  const requireWorkflowInScope = async (
    s: {
      teamId: string;
      scopeKind: "EVIDENCE" | "CASE" | "PACKAGE";
      evidenceId: string | null;
      caseId: string | null;
      packageId: string | null;
    },
    workflowId: string,
    reply: FastifyReply,
  ): Promise<boolean> => {
    const scoped = await resolveWorkflowInGrantScope({
      scope: {
        teamId: s.teamId,
        scopeKind: s.scopeKind,
        evidenceId: s.evidenceId,
        caseId: s.caseId,
        packageId: s.packageId,
      },
      workflowId,
    });
    if (!scoped.ok) {
      await reply.code(403).send({ denial: "OUT_OF_SCOPE" });
      return false;
    }
    return true;
  };

  app.get(
    "/v1/portal/work/:workflowId/comments",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const s = await resolvePortalSession(req, reply);
      if (!s) return reply;
      // §8.5 — reads are capability-gated too (previously session-only).
      if (
        !s.capabilities.has("portal.comment") &&
        !s.capabilities.has("portal.history.read")
      ) {
        return reply.code(403).send({ denial: "NOT_PERMITTED" });
      }
      const { workflowId } = z
        .object({ workflowId: z.string().uuid() })
        .parse(req.params);
      if (!(await requireWorkflowInScope(s, workflowId, reply))) return reply;
      const rows = await listCommentsForWorkflow({
        teamId: s.teamId,
        workflowId,
      });
      return reply.code(200).send({ comments: rows });
    },
  );

  app.post(
    "/v1/portal/work/:workflowId/comments",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const s = await resolvePortalSession(req, reply);
      if (!s) return reply;
      if (!s.capabilities.has("portal.comment")) {
        return reply.code(403).send({ denial: "NOT_PERMITTED" });
      }
      const { workflowId } = z
        .object({ workflowId: z.string().uuid() })
        .parse(req.params);
      if (!(await requireWorkflowInScope(s, workflowId, reply))) return reply;
      const body = PostCommentBody.parse(req.body);
      const res = await postCommentInWorkflow({
        teamId: s.teamId,
        grantId: s.grantId,
        workflowId,
        parentCommentId: body.parentCommentId ?? null,
        body: body.body,
        authorEmail: s.reviewerEmail,
        authorDisplay: s.reviewerDisplayName,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(201).send({ commentId: res.commentId });
    },
  );

  app.post(
    "/v1/portal/work/:workflowId/decision",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const s = await resolvePortalSession(req, reply);
      if (!s) return reply;
      if (!s.capabilities.has("portal.decide")) {
        return reply.code(403).send({ denial: "NOT_PERMITTED" });
      }
      const { workflowId } = z
        .object({ workflowId: z.string().uuid() })
        .parse(req.params);
      if (!(await requireWorkflowInScope(s, workflowId, reply))) return reply;
      const body = SubmitDecisionBody.parse(req.body);
      const res = await submitExternalDecision({
        teamId: s.teamId,
        grantId: s.grantId,
        workflowId,
        reviewerEmail: s.reviewerEmail,
        reviewerDisplay: s.reviewerDisplayName,
        verdict: body.verdict,
        rationale: body.rationale,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(200).send({
        decisionId: res.decisionId,
        replaced: res.replaced,
      });
    },
  );

  app.get(
    "/v1/portal/work/:workflowId/decisions",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const s = await resolvePortalSession(req, reply);
      if (!s) return reply;
      // §8.5 — reads are capability-gated too (previously session-only).
      if (
        !s.capabilities.has("portal.decide") &&
        !s.capabilities.has("portal.history.read")
      ) {
        return reply.code(403).send({ denial: "NOT_PERMITTED" });
      }
      const { workflowId } = z
        .object({ workflowId: z.string().uuid() })
        .parse(req.params);
      if (!(await requireWorkflowInScope(s, workflowId, reply))) return reply;
      const rows = await listExternalDecisionsForWorkflow({
        teamId: s.teamId,
        workflowId,
      });
      return reply.code(200).send({ decisions: rows });
    },
  );

  app.post(
    "/v1/portal/work/:workflowId/view",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const s = await resolvePortalSession(req, reply);
      if (!s) return reply;
      const { workflowId } = z
        .object({ workflowId: z.string().uuid() })
        .parse(req.params);
      if (!(await requireWorkflowInScope(s, workflowId, reply))) return reply;
      await emitPortalActivity({
        teamId: s.teamId,
        grantId: s.grantId,
        sessionId: s.sessionId,
        code: "REVIEW_OPENED",
        payload: { workflowId },
        ip: req.ip,
        userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
      });
      return reply.code(200).send({ ok: true });
    },
  );

  app.get(
    "/v1/portal/activity",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const s = await resolvePortalSession(req, reply);
      if (!s) return reply;
      if (!s.capabilities.has("portal.history.read")) {
        return reply.code(403).send({ denial: "NOT_PERMITTED" });
      }
      const rows = await listPortalActivity({
        teamId: s.teamId,
        grantId: s.grantId,
        limit: 200,
      });
      return reply.code(200).send({ activity: rows });
    },
  );

  // -------------------------------------------------------------------------
  // Phase 2B Closure — Portal SSO federation
  //
  // Reviewer-initiated SAML flow: the reviewer hits /v1/portal/sso/start with
  // a grantId, we build an AuthnRequest, redirect them to the IdP. The IdP
  // posts the assertion back to /v1/portal/sso/callback which validates and
  // binds the SSO identity to the grant.
  // -------------------------------------------------------------------------

  app.post(
    "/v1/portal/sso/start/:grantId",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { grantId } = z
        .object({ grantId: z.string().uuid() })
        .parse(req.params);
      const body = SsoStartBody.parse(req.body);

      // Resolve the workspace anchor from the role assignment (the
      // reviewer is unauthenticated at this point — we trust the
      // grantId path param and look up the corresponding workspace).
      const role = await prisma.externalReviewerRoleAssignment.findFirst({
        where: { id: grantId },
        select: { teamId: true },
      });
      if (!role) {
        return reply.code(404).send({ denial: "INVITE_NOT_FOUND" });
      }
      const res = await startPortalSsoFlow({
        teamId: role.teamId,
        grantId,
        ssoConnectionIdOverride: body.ssoConnectionId,
        spEntityId: body.spEntityId,
        acsUrl: body.acsUrl,
        ip: req.ip,
        userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(200).send({
        redirectUrl: res.redirectUrl,
        requestId: res.requestId,
        relayState: res.relayState,
        connectionId: res.connectionId,
      });
    },
  );

  /**
   * PHASE 12 REMEDIATION — SEC-001, route 10 of 12 (2026-08-06).
   *
   * CLASSIFIED: TOKEN_SCOPED / ASSERTION_SCOPED authorization. This route is
   * deliberately NOT migrated to `AuthorizedWorkspaceContext`, and that is a
   * correctness requirement, not an omission:
   *
   *   the actor is an EXTERNAL REVIEWER completing a SAML flow. They have no
   *   PROOVRA identity, no `User` row, and therefore no TeamMember row to
   *   authorize against. Requiring workspace membership here would make the
   *   external-reviewer SSO product impossible, not safer.
   *
   * What IS server-owned, and now verified:
   *   * the workspace anchor is derived from the GRANT, never from the
   *     request body — `role.teamId` below, not a caller-supplied teamId;
   *   * the SAML assertion itself is the credential, validated in
   *     `completePortalSsoFlow`;
   *   * ADDED HERE: the anchoring workspace must be a LIVE operating
   *     context. A grant belonging to a closed workspace, or to an
   *     ORGANIZATION workspace whose parent CUSTOMER Organization is
   *     SUSPENDED or ARCHIVED, must not complete a federation — otherwise
   *     org suspension fails OPEN on this surface, which is the same
   *     lifecycle defect AUTH-001 describes on the member-authorized side.
   *     A dead context conceals as INVITE_NOT_FOUND, identical to a
   *     nonexistent grant (no enumeration).
   */
  app.post(
    "/v1/portal/sso/callback",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = SsoCallbackBody.parse(req.body);

      const role = await prisma.externalReviewerRoleAssignment.findFirst({
        where: { id: body.grantId },
        select: { teamId: true },
      });
      if (!role) {
        return reply.code(404).send({ denial: "INVITE_NOT_FOUND" });
      }
      if (!(await isLiveOperatingWorkspace(role.teamId))) {
        return reply.code(404).send({ denial: "INVITE_NOT_FOUND" });
      }
      const res = await completePortalSsoFlow({
        teamId: role.teamId,
        grantId: body.grantId,
        samlResponseBase64: body.samlResponseBase64,
        expectedInResponseTo: body.expectedInResponseTo ?? null,
        ip: req.ip,
        userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
      });
      if (!res.ok) {
        return reply.code(401).send({
          denial: res.denial,
          samlCategory: res.samlCategory ?? null,
        });
      }
      return reply.code(200).send({
        ok: true,
        grantId: res.grantId,
        authMethod: res.authMethod,
        assertion: res.assertion,
      });
    },
  );

  // -------------------------------------------------------------------------
  // Phase 2B Closure — operator-initiated session revoke
  //
  // Emits PORTAL_SESSION_REVOKED so the reviewer's next request will fail
  // closed at the grant-state machine. This is a bounded operator action —
  // the actual revoke flows through revokeInvitation; this endpoint
  // additionally stamps the session lifecycle event.
  // -------------------------------------------------------------------------

  app.post(
    "/v1/external-review/invitations/:id/sessions/revoke",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Operator-initiated session revoke is the same tier as invitation
      // revoke.
      const ctx = await authorizeCurrentWorkspaceOrFail(req, reply, {
        permission: "review.assign",
      });
      if (!ctx) return reply;
      if (!isAdministrativeTier(ctx, ctx.workspaceId)) return denyNoPermission(reply);
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({
          sessionId: z.string().max(80).optional(),
          reason: z
            .enum(["OPERATOR_REVOKE", "GRANT_REVOKED", "GRANT_EXPIRED"])
            .optional(),
        })
        .parse(req.body ?? {});
      await emitPortalSessionRevoked({
        teamId: ctx.workspaceId,
        grantId: id,
        sessionId: body.sessionId ?? "unknown",
        reason: body.reason ?? "OPERATOR_REVOKE",
        ip: req.ip,
        userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
      });
      return reply.code(200).send({ ok: true });
    },
  );

  // -------------------------------------------------------------------------
  // Explicit single-invitation email send.
  //
  // PHASE 12 REMEDIATION — SEC-001 + §4.3 (2026-08-06).
  //
  // Two defects removed here:
  //
  //   1. AUTHORIZATION. The route was UNCAPPED and resolved its workspace
  //      from the stale `User.currentWorkspaceId` pointer, so a removed or
  //      suspended member could trigger an outbound email on the workspace's
  //      behalf — an irreversible external side effect performed by a
  //      non-member. It now runs the canonical primitive with an explicit
  //      SEND capability (`review.assign`, the same tier as issuing an
  //      invitation) BEFORE any invitation row is read.
  //
  //   2. CALLER-SUPPLIED TOKEN TRUTH. The body carried `rawToken` and the
  //      server mailed whatever string it was given. Delivery truth is now
  //      entirely server-owned: `deliverInvitationEmail` loads the
  //      invitation, re-proves its workspace and live state, MINTS a
  //      successor token server-side, persists only its hash (atomically
  //      superseding the predecessor), builds the acceptance URL itself,
  //      records a durable delivery intent, sends through the canonical
  //      transport under a durable delivery-derived idempotency key, and
  //      records a bounded outcome. The request body can no longer influence
  //      what credential the reviewer receives.
  // -------------------------------------------------------------------------

  app.post(
    "/v1/external-review/invitations/:id/send-email",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await authorizeCurrentWorkspaceOrFail(req, reply, {
        permission: "review.assign",
      });
      if (!ctx) return reply;
      if (!isAdministrativeTier(ctx, ctx.workspaceId)) return denyNoPermission(reply);
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      // `rawToken` is GONE from the accepted shape. A client that still
      // sends it is not rejected (extra keys are ignored by this schema) but
      // the value can never reach the transport.
      const body = z
        .object({
          inviterDisplayName: z.string().max(200).optional(),
          workspaceName: z.string().max(200).optional(),
        })
        .parse(req.body ?? {});

      const team = await prisma.team.findUnique({
        where: { id: ctx.workspaceId },
        select: { name: true },
      });
      const user = await prisma.user.findUnique({
        where: { id: ctx.userId },
        select: { displayName: true, email: true },
      });

      const res = await deliverInvitationEmail({
        teamId: ctx.workspaceId,
        grantId: id,
        actorUserId: ctx.userId,
        inviterDisplayName:
          body.inviterDisplayName ??
          user?.displayName ??
          user?.email ??
          "PROOVRA operator",
        workspaceName: body.workspaceName ?? team?.name ?? "PROOVRA workspace",
        reason: "Operator sent the external-reviewer invitation email.",
      });
      if (!res.ok) {
        if (res.denial === "INVITE_NOT_FOUND") {
          return reply.code(404).send({ denial: "INVITE_NOT_FOUND" });
        }
        return reply.code(502).send({
          denial: "POLICY_REJECTED",
          deliveryId: res.deliveryId,
          failureReason: res.failureReason,
        });
      }
      return reply.code(200).send({
        deliveryId: res.deliveryId,
        status: res.status,
        providerMessageId: res.providerMessageId,
      });
    },
  );
}
