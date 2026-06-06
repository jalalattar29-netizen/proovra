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
  type ReviewerCapability,
} from "@proovra/shared";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { externalPortalCapabilitiesForRole } from "@proovra/shared";
import { assertFeatureEntitlement } from "../services/packaging/entitlement.service.js";
import {
  callerHasCapability,
  resolveReviewerRole,
} from "../services/reviewer-workspace/reviewer-roles.js";

import {
  emitPortalSessionRevoked,
  endPortalSession,
  establishPortalSession,
} from "../services/external-review/portal-session.service.js";
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
  listDeliveriesForGrant,
  sendInvitationEmail,
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

async function resolveInternalTeam(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{
  teamId: string;
  userId: string;
  workspaceRole: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER" | null;
  isPlatformAdmin: boolean;
} | null> {
  const userId = getAuthUserId(req);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { currentWorkspaceId: true, platformRole: true },
  });
  if (!user?.currentWorkspaceId) {
    reply.code(403).send({ denial: "WORKSPACE_NOT_FOUND" });
    return null;
  }
  const team = await prisma.team.findUnique({
    where: { id: user.currentWorkspaceId },
    select: { id: true, isPersonal: true },
  });
  if (!team || team.isPersonal) {
    reply.code(403).send({ denial: "WORKSPACE_NOT_FOUND" });
    return null;
  }
  const membership = await prisma.teamMember.findFirst({
    where: { teamId: team.id, userId },
    select: { role: true },
  });
  return {
    teamId: team.id,
    userId,
    workspaceRole: (membership?.role ?? null) as
      | "OWNER"
      | "ADMIN"
      | "MEMBER"
      | "VIEWER"
      | null,
    isPlatformAdmin: user.platformRole !== null,
  };
}

// Phase 5 RBAC hardening — local requireCap helper that reuses the
// canonical reviewer-workspace capability registry. The external-review
// admin surfaces (invitation issue / revoke / resend / bulk / break-glass
// reveal / session revoke) are operator-side actions that must be
// gated to the same SUPERVISOR/REVIEW_ADMIN-tier capabilities the
// reviewer-workspace routes already enforce. No new permission is
// introduced; the helper delegates to resolveReviewerRole +
// callerHasCapability so the matrix lives in exactly one place.
function requireCap(
  ctx: {
    workspaceRole: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER" | null;
    isPlatformAdmin: boolean;
  },
  cap: ReviewerCapability,
): boolean {
  const r = resolveReviewerRole({
    workspaceRole: ctx.workspaceRole,
    isPlatformAdmin: ctx.isPlatformAdmin,
  });
  return callerHasCapability(r, cap);
}

function denyNoPermission(reply: FastifyReply): FastifyReply {
  return reply.code(403).send({ denial: "NOT_PERMITTED" });
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

  app.get(
    "/v1/external-review/invitations",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveInternalTeam(req, reply);
      if (!ctx) return reply;
      const rows = await listInvitationsForTeam({ teamId: ctx.teamId });
      return reply.code(200).send({ invitations: rows });
    },
  );

  app.post(
    "/v1/external-review/invitations",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveInternalTeam(req, reply);
      if (!ctx) return reply;
      // Phase 5 RBAC hardening — issuing an external-reviewer invitation
      // is a queue-assignment-tier action. Gate behind `review.assign`
      // (granted to SUPERVISOR + REVIEW_ADMIN reviewer roles, i.e.
      // workspace ADMIN + OWNER). Base REVIEWER and VIEWER receive 403.
      if (!requireCap(ctx, "review.assign")) return denyNoPermission(reply);
      // I6 — FEATURE_EXTERNAL_PORTAL gate (minimal coverage, one rep mutation).
      try {
        const feOk = await assertFeatureEntitlement({ prisma, teamId: ctx.teamId, key: "FEATURE_EXTERNAL_PORTAL", actorUserId: ctx.userId });
        if (!feOk.ok) return reply.code(403).send({ denial: "ENTITLEMENT_REQUIRED", entitlement: "FEATURE_EXTERNAL_PORTAL" });
      } catch { /* engine failure must not break route */ }
      const body = IssueInvitationBody.parse(req.body);
      const res = await issueInvitation({
        teamId: ctx.teamId,
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
      const ctx = await resolveInternalTeam(req, reply);
      if (!ctx) return reply;
      // Phase 5 RBAC hardening — same tier as invitation issue.
      if (!requireCap(ctx, "review.assign")) return denyNoPermission(reply);
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const res = await revokeInvitation({
        teamId: ctx.teamId,
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
      const ctx = await resolveInternalTeam(req, reply);
      if (!ctx) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const rows = await listPortalActivity({
        teamId: ctx.teamId,
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
      const ctx = await resolveInternalTeam(req, reply);
      if (!ctx) return reply;
      // Phase 5 RBAC hardening — bulk invitation issuance gates on
      // `review.bulk` (SUPERVISOR + REVIEW_ADMIN). Also require
      // `review.assign` so the bulk path can never be a weaker gate
      // than the single-issue path.
      if (!requireCap(ctx, "review.bulk") || !requireCap(ctx, "review.assign")) {
        return denyNoPermission(reply);
      }
      const body = BulkIssueBody.parse(req.body);

      const team = await prisma.team.findUnique({
        where: { id: ctx.teamId },
        select: { name: true },
      });
      const user = await prisma.user.findUnique({
        where: { id: ctx.userId },
        select: { displayName: true, email: true },
      });
      const res = await bulkIssueInvitations({
        teamId: ctx.teamId,
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
      const ctx = await resolveInternalTeam(req, reply);
      if (!ctx) return reply;
      // Phase 5 RBAC hardening — bulk revoke shares the same gate as
      // bulk issue: `review.bulk` + `review.assign`.
      if (!requireCap(ctx, "review.bulk") || !requireCap(ctx, "review.assign")) {
        return denyNoPermission(reply);
      }
      const body = BulkRevokeBody.parse(req.body);
      const res = await bulkRevokeInvitations({
        teamId: ctx.teamId,
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
      const ctx = await resolveInternalTeam(req, reply);
      if (!ctx) return reply;
      // Phase 5 RBAC hardening — break-glass token reveal returns a
      // raw bearer token EXACTLY ONCE; treat it as the most sensitive
      // mutation on the surface. Gate to the strongest available
      // reviewer capability: `review.sampling.policy`. In the default
      // resolver, only REVIEW_ADMIN (workspace OWNER, or an explicit
      // member-level reviewer-role override) carries this cap —
      // SUPERVISOR (workspace ADMIN) does NOT. This is intentional:
      // the surface already exists for the bounded fallback case where
      // the reviewer cannot receive the resend email; restricting it
      // to REVIEW_ADMIN preserves split-of-duty.
      if (!requireCap(ctx, "review.sampling.policy")) {
        return denyNoPermission(reply);
      }
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({ reason: z.string().min(10).max(400) })
        .parse(req.body);
      const res = await rotateExternalReviewGrantToken({
        grantId: id,
        teamId: ctx.teamId,
        actorUserId: ctx.userId,
        reason: body.reason,
      });
      if (!res.ok) {
        return reply.code(409).send({ denial: res.reason });
      }
      await emitPortalActivity({
        teamId: ctx.teamId,
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
      const ctx = await resolveInternalTeam(req, reply);
      if (!ctx) return reply;
      // Phase 5 RBAC hardening — resending an invitation email is the
      // same operational tier as issuing one.
      if (!requireCap(ctx, "review.assign")) return denyNoPermission(reply);
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const team = await prisma.team.findUnique({
        where: { id: ctx.teamId },
        select: { name: true },
      });
      const user = await prisma.user.findUnique({
        where: { id: ctx.userId },
        select: { displayName: true, email: true },
      });
      const res = await resendInvitationEmail({
        teamId: ctx.teamId,
        grantId: id,
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
      const ctx = await resolveInternalTeam(req, reply);
      if (!ctx) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const rows = await listDeliveriesForGrant({
        teamId: ctx.teamId,
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

  app.get(
    "/v1/portal/work/:workflowId/comments",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const s = await resolvePortalSession(req, reply);
      if (!s) return reply;
      const { workflowId } = z
        .object({ workflowId: z.string().uuid() })
        .parse(req.params);
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
      const { workflowId } = z
        .object({ workflowId: z.string().uuid() })
        .parse(req.params);
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
      const ctx = await resolveInternalTeam(req, reply);
      if (!ctx) return reply;
      // Phase 5 RBAC hardening — operator-initiated session revoke is
      // the same tier as invitation revoke.
      if (!requireCap(ctx, "review.assign")) return denyNoPermission(reply);
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
        teamId: ctx.teamId,
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
  // Phase 2B Closure — explicit single-invitation email send (used when
  // the operator clicks "Send invitation email" on the surface after a
  // raw token has already been issued out of band).
  // -------------------------------------------------------------------------

  app.post(
    "/v1/external-review/invitations/:id/send-email",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveInternalTeam(req, reply);
      if (!ctx) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({
          rawToken: z.string().min(8).max(256),
          inviterDisplayName: z.string().max(200).optional(),
          workspaceName: z.string().max(200).optional(),
        })
        .parse(req.body);

      const role = await prisma.externalReviewerRoleAssignment.findFirst({
        where: { teamId: ctx.teamId, id },
        select: {
          role: true,
          mfaRequired: true,
          inviteEmail: true,
          externalEmail: true,
          ssoConnectionId: true,
        },
      });
      if (!role) {
        return reply.code(404).send({ denial: "INVITE_NOT_FOUND" });
      }
      const grantRows = await prisma.$queryRaw<
        Array<{ expires_at_utc: Date }>
      >`
        SELECT "expires_at_utc"
          FROM "external_review_grants"
         WHERE "id" = ${id}::uuid
           AND "team_id" = ${ctx.teamId}::uuid
         LIMIT 1
      `;
      const grant = grantRows[0];
      if (!grant) {
        return reply.code(404).send({ denial: "INVITE_NOT_FOUND" });
      }

      const team = await prisma.team.findUnique({
        where: { id: ctx.teamId },
        select: { name: true },
      });
      const user = await prisma.user.findUnique({
        where: { id: ctx.userId },
        select: { displayName: true, email: true },
      });

      const res = await sendInvitationEmail({
        teamId: ctx.teamId,
        grantId: id,
        rawToken: body.rawToken,
        recipientEmail: role.inviteEmail ?? role.externalEmail,
        inviterDisplayName:
          body.inviterDisplayName ??
          user?.displayName ??
          user?.email ??
          "PROOVRA operator",
        workspaceName: body.workspaceName ?? team?.name ?? "PROOVRA workspace",
        role: role.role ?? "REVIEWER",
        expiresAtUtc: grant.expires_at_utc.toISOString(),
        mfaRequired: role.mfaRequired ?? false,
        ssoEnabled: role.ssoConnectionId !== null,
      });
      if (!res.ok) {
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
