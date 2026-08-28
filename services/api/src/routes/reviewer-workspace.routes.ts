/**
 * PROOVRA Phase 2A — Reviewer Workspace routes.
 *
 *   GET   /v1/reviewer/workspace                      — workspace projection
 *   GET   /v1/reviewer/metrics                         — team metrics
 *
 *   GET   /v1/coding/schemas                           — list workspace schemas
 *   POST  /v1/coding/schemas                           — author DRAFT schema
 *   GET   /v1/coding/schemas/:id                       — read schema + fields
 *   POST  /v1/coding/schemas/:id/publish               — DRAFT → PUBLISHED
 *   POST  /v1/coding/schemas/:id/archive               — → ARCHIVED
 *   POST  /v1/coding/schemas/seed-defaults             — install 6 pre-built schemas
 *
 *   GET   /v1/reviewer/work/:workflowId/coding         — current values + coverage
 *   POST  /v1/reviewer/work/:workflowId/code           — write a coding value
 *   POST  /v1/reviewer/work/:workflowId/disagree       — file a disagreement
 *
 *   GET   /v1/reviewer/disagreements                   — list disagreements
 *   POST  /v1/reviewer/disagreements/:id/transition    — state-machine move
 *
 *   GET   /v1/reviewer/qc/samples                      — list QC samples
 *   POST  /v1/reviewer/qc/samples/:id/assign           — assign sample
 *   POST  /v1/reviewer/qc/samples/:id/verdict          — render QC verdict
 *
 * Hard rules:
 *   * Every route is workspace-anchored. Personal-space callers receive
 *     a bounded 403 with `denial: "WORKSPACE_NOT_FOUND"`.
 *   * Bounded denial reasons via shared REVIEWER_DENIAL_REASONS.
 *   * Capability-gated: each handler validates the caller's
 *     reviewer-role capability before mutating.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  CODING_FIELD_TYPES,
  CODING_SCHEMA_CATEGORIES,
  DISAGREEMENT_STATES,
  QC_FAILURE_REASONS,
  QC_VERDICTS,
  REVIEWER_VERDICTS,
  type ReviewerCapability,
  type ReviewerDenialReason,
} from "@proovra/shared";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import {
  evaluateAuthorizedWorkspace,
  evaluateCurrentWorkspace,
} from "../middleware/authorize.js";
import { assertFeatureEntitlement } from "../services/packaging/entitlement.service.js";

import {
  archiveSchema,
  bindSchemaToWorkflow,
  createSchema,
  getSchema,
  listSchemas,
  publishSchema,
  seedDefaultSchemas,
} from "../services/reviewer-workspace/coding-schema.service.js";
import {
  evaluateRequiredFieldsCoverage,
  readCodingValuesForWorkflow,
  writeCodingValue,
} from "../services/reviewer-workspace/coding-value.service.js";
import {
  fileDisagreement,
  listDisagreements,
  transitionDisagreement,
} from "../services/reviewer-workspace/reviewer-disagreement.service.js";
import {
  assignSample,
  listSamples,
  renderQcVerdict,
} from "../services/reviewer-workspace/qc-sample.service.js";
import {
  bulkResolveAnnotations,
  listAnnotationsForEvidence,
  postAnnotationReply,
  resolveAnnotation,
} from "../services/reviewer-workspace/annotation-workspace.service.js";
import {
  bulkAssign,
  bulkCode,
  bulkDecide,
} from "../services/reviewer-workspace/bulk-operations.service.js";
import {
  callerHasCapability,
  resolveReviewerRole,
} from "../services/reviewer-workspace/reviewer-roles.js";
import { projectReviewerWorkspace } from "../services/reviewer-workspace/reviewer-workspace.service.js";
import { getReviewerMetricsTeam } from "../services/reviewer-workspace/reviewer-metrics.service.js";

// =============================================================================
// Helpers
// =============================================================================

async function resolveTeam(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{
  teamId: string;
  userId: string;
  workspaceRole: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER" | null;
  isPlatformAdmin: boolean;
} | null> {
  const q = z.object({ teamId: z.string().uuid().optional() }).safeParse(
    req.query ?? {},
  );
  if (!q.success) {
    reply.code(400).send({
      error: {
        code: "INVALID_QUERY",
        message: "teamId must be a valid UUID.",
      },
    });
    return null;
  }

  const userId = getAuthUserId(req);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { platformRole: true },
  });

  // PHASE 12 CORRECTIVE PASS §1.3 (2026-08-06) — the workspace is chosen by
  // the CLIENT when it names one, and otherwise by the operator's pointer;
  // either way it is only a CANDIDATE. The canonical primitive then decides,
  // so the two inputs are indistinguishable to the authorization outcome —
  // which is the property that makes accepting a client-supplied `?teamId=`
  // safe at all.
  //
  // What this replaces: the P0 remediation of 2026-07-21 correctly added an
  // ACTIVE-membership check here, but as a SECOND authority. It did not check
  // member access expiry, did not check the workspace kind, and did not check
  // parent-Organization lifecycle — so a reviewer inside a SUSPENDED customer
  // Organization kept full access to this operational surface. Delegating to
  // the canonical chain closes all three, and the surface-specific rule
  // (no Personal Space) is retained against the PROVEN kind.
  const resolved = q.data.teamId
    ? await evaluateAuthorizedWorkspace(req, {
        workspaceId: q.data.teamId,
        permission: "evidence.read",
        antiEnumeration: false,
      })
    : await evaluateCurrentWorkspace(req, {
        permission: "evidence.read",
        antiEnumeration: false,
      });
  if (!resolved.allowed) {
    // Bounded envelope preserved verbatim: a caller who cannot enter the
    // workspace learns only that there is no workspace for them here.
    reply
      .code(403)
      .send({
        denial:
          resolved.reasonCode === "missing_team_id"
            ? "WORKSPACE_NOT_FOUND"
            : "NOT_PERMITTED",
      });
    return null;
  }
  if (resolved.context.workspaceKind === "PERSONAL") {
    reply.code(403).send({ denial: "WORKSPACE_NOT_FOUND" });
    return null;
  }

  return {
    teamId: resolved.context.workspaceId,
    userId,
    // The PROVEN canonical role, mapped back to this surface's DB-role
    // vocabulary. The inverse of `mapTeamRoleToCanonical`, which is
    // OWNER→OWNER, ADMIN→ADMIN, **MEMBER→REVIEWER**, VIEWER→VIEWER.
    //
    // Worth spelling out, because the first draft of this mapped
    // `CONTRIBUTOR→MEMBER` and left `REVIEWER` untouched. `CONTRIBUTOR` is a
    // canonical role this DB enum has no member for, so the branch never fired,
    // and every ordinary DB `MEMBER` came back as the string `"REVIEWER"` —
    // outside this surface's declared union. The reviewer-workflow lifecycle
    // proof caught it as a 403 where a reviewer had always been served 200.
    workspaceRole:
      resolved.context.workspaceRole === "REVIEWER"
        ? "MEMBER"
        : (resolved.context.workspaceRole as
            | "OWNER"
            | "ADMIN"
            | "MEMBER"
            | "VIEWER"),
    // ADM-001 (2026-08-27) — compare against the ONE value that means platform
    // admin, not against "any non-empty string".
    //
    // `platformRole.length > 0` was a latent widening: it happened to be
    // equivalent only because `"admin"` is currently the sole value any writer
    // persists. The moment a second, LESSER platform role exists (`"support"`,
    // `"readonly"`) it would silently confer full reviewer elevation on it —
    // the kind of grant nobody writes down and nobody reviews. An earlier
    // revision of this line already coerced a MISSING user row to `true`, so
    // this expression has a history of being wrong in the permissive direction.
    isPlatformAdmin: user?.platformRole === "admin",
  };
}

function denyWith(
  reply: FastifyReply,
  status: number,
  denial: ReviewerDenialReason,
): FastifyReply {
  return reply.code(status).send({ denial });
}

function denyNoPermission(reply: FastifyReply): FastifyReply {
  return reply.code(403).send({ denial: "NOT_PERMITTED" });
}

function requireCap(
  ctx: { workspaceRole: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER" | null; isPlatformAdmin: boolean },
  cap: ReviewerCapability,
): boolean {
  const r = resolveReviewerRole({
    workspaceRole: ctx.workspaceRole,
    isPlatformAdmin: ctx.isPlatformAdmin,
  });
  return callerHasCapability(r, cap);
}

// =============================================================================
// Schemas
// =============================================================================

const CodingFieldBody = z.object({
  slug: z.string().min(1).max(80),
  label: z.string().min(1).max(180),
  fieldType: z.enum(CODING_FIELD_TYPES),
  required: z.boolean(),
  orderIndex: z.number().int().min(0),
  helpText: z.string().max(240).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});

const CreateSchemaBody = z.object({
  slug: z.string().min(1).max(80),
  label: z.string().min(1).max(180),
  category: z.enum(CODING_SCHEMA_CATEGORIES),
  description: z.string().max(600).optional(),
  fields: z.array(CodingFieldBody).min(1).max(50),
});

const WriteCodingValueBody = z.object({
  fieldId: z.string().uuid(),
  value: z.record(z.string(), z.unknown()),
  rationale: z.string().max(240).optional(),
});

const FileDisagreementBody = z.object({
  originalDecisionId: z.string().uuid(),
  rationale: z.string().min(1).max(600),
});

const TransitionDisagreementBody = z.object({
  to: z.enum(DISAGREEMENT_STATES),
  verdict: z.enum(REVIEWER_VERDICTS).optional(),
  rationale: z.string().max(600).optional(),
});

const AssignQcBody = z.object({
  qcReviewerUserId: z.string().uuid(),
});

const QcVerdictBody = z.object({
  verdict: z.enum(QC_VERDICTS),
  failureReason: z.enum(QC_FAILURE_REASONS).optional(),
  rationale: z.string().max(600).optional(),
});

// =============================================================================
// Routes
// =============================================================================

export async function reviewerWorkspaceRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /v1/reviewer/workspace
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/reviewer/workspace",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveTeam(req, reply);
      if (!ctx) return reply;
      const projection = await projectReviewerWorkspace({
        teamId: ctx.teamId,
        userId: ctx.userId,
        workspaceRole: ctx.workspaceRole,
        isPlatformAdmin: ctx.isPlatformAdmin,
      });
      if (!projection) return denyNoPermission(reply);
      return reply.code(200).send({ workspace: projection });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/reviewer/metrics
  //
  // Phase 5 RBAC hardening — team-wide reviewer performance metrics are
  // not appropriate for the base REVIEWER role (who only see their own
  // queue). Gate behind `review.assign`, which is granted to SUPERVISOR
  // and REVIEW_ADMIN via the reviewer-roles resolver — i.e. workspace
  // ADMIN and OWNER, the operators who legitimately need a team-wide
  // view. This reuses the existing requireCap + REVIEWER_CAPABILITIES
  // registry; no new permission is introduced.
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/reviewer/metrics",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveTeam(req, reply);
      if (!ctx) return reply;
      if (!requireCap(ctx, "review.assign")) return denyNoPermission(reply);
      const metrics = await getReviewerMetricsTeam({ teamId: ctx.teamId });
      return reply.code(200).send({ metrics });
    },
  );

  // ---------------------------------------------------------------------------
  // CODING SCHEMAS
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/coding/schemas",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveTeam(req, reply);
      if (!ctx) return reply;
      // P0 remediation (2026-07-21) — explicit read capability (defense in
      // depth on top of the fail-closed resolveTeam membership gate).
      if (!requireCap(ctx, "review.code")) return denyNoPermission(reply);
      const q = z
        .object({
          status: z.string().optional(),
          category: z.enum(CODING_SCHEMA_CATEGORIES).optional(),
        })
        .parse(req.query ?? {});
      const schemas = await listSchemas({
        teamId: ctx.teamId,
        status: q.status ?? null,
        category: q.category ?? null,
      });
      return reply.code(200).send({ schemas });
    },
  );

  app.post(
    "/v1/coding/schemas",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveTeam(req, reply);
      if (!ctx) return reply;
      // I6 — FEATURE_REVIEWER_WORKSPACE gate (minimal coverage, one rep mutation).
      try {
        const feOk = await assertFeatureEntitlement({ prisma, teamId: ctx.teamId, key: "FEATURE_REVIEWER_WORKSPACE", actorUserId: ctx.userId });
        if (!feOk.ok) return reply.code(403).send({ denial: "ENTITLEMENT_REQUIRED", entitlement: "FEATURE_REVIEWER_WORKSPACE" });
      } catch { /* engine failure must not break route */ }
      if (!requireCap(ctx, "review.schema.author")) return denyNoPermission(reply);
      const body = CreateSchemaBody.parse(req.body);
      const res = await createSchema({
        teamId: ctx.teamId,
        authorUserId: ctx.userId,
        slug: body.slug,
        label: body.label,
        category: body.category,
        description: body.description,
        fields: body.fields,
      });
      if (!res.ok) return denyWith(reply, 409, res.denial);
      return reply.code(201).send({ schemaId: res.schemaId, version: res.version });
    },
  );

  app.get(
    "/v1/coding/schemas/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveTeam(req, reply);
      if (!ctx) return reply;
      // P0 remediation (2026-07-21) — explicit read capability (defense in
      // depth on top of the fail-closed resolveTeam membership gate).
      if (!requireCap(ctx, "review.code")) return denyNoPermission(reply);
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const schema = await getSchema({ teamId: ctx.teamId, schemaId: id });
      if (!schema) return denyWith(reply, 404, "SCHEMA_NOT_FOUND");
      return reply.code(200).send({ schema });
    },
  );

  app.post(
    "/v1/coding/schemas/:id/publish",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveTeam(req, reply);
      if (!ctx) return reply;
      if (!requireCap(ctx, "review.schema.author")) return denyNoPermission(reply);
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const res = await publishSchema({ teamId: ctx.teamId, schemaId: id });
      if (!res.ok) return denyWith(reply, 409, res.denial);
      return reply.code(200).send({ publishedVersion: res.publishedVersion });
    },
  );

  app.post(
    "/v1/coding/schemas/:id/archive",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveTeam(req, reply);
      if (!ctx) return reply;
      if (!requireCap(ctx, "review.schema.author")) return denyNoPermission(reply);
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const res = await archiveSchema({ teamId: ctx.teamId, schemaId: id });
      if (!res.ok) return denyWith(reply, 409, res.denial);
      return reply.code(200).send({ ok: true });
    },
  );

  app.post(
    "/v1/coding/schemas/seed-defaults",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveTeam(req, reply);
      if (!ctx) return reply;
      if (!requireCap(ctx, "review.schema.author")) return denyNoPermission(reply);
      // Phase O — Sentry NODE-1P safety net. The repair migration
      // 20270802000000_phase_sentry_batch_schema_drift_repair adds the
      // missing R7 reviewer-workspace columns. Until that migration
      // ships everywhere, a stale-schema DB will raise Prisma
      // P2022/P2021 from the underlying create. The route degrades
      // honestly instead of 500ing — operator sees a bounded
      // SCHEMA_NOT_READY reason and re-triggers seed once the
      // migration is applied.
      try {
        const result = await seedDefaultSchemas({
          teamId: ctx.teamId,
          authorUserId: ctx.userId,
        });
        return reply.code(200).send(result);
      } catch (err) {
        const code =
          err && typeof err === "object" && "code" in err
            ? String((err as { code?: unknown }).code ?? "")
            : "";
        if (code === "P2022" || code === "P2021") {
          return reply.code(200).send({
            created: 0,
            updated: 0,
            existing: 0,
            failed: 0,
            degraded: true,
            reason: "SCHEMA_NOT_READY",
          });
        }
        throw err;
      }
    },
  );

  app.post(
    "/v1/reviewer/work/:workflowId/bind-schema",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveTeam(req, reply);
      if (!ctx) return reply;
      if (!requireCap(ctx, "review.assign")) return denyNoPermission(reply);
      const { workflowId } = z
        .object({ workflowId: z.string().uuid() })
        .parse(req.params);
      const { schemaId } = z
        .object({ schemaId: z.string().uuid() })
        .parse(req.body);
      const res = await bindSchemaToWorkflow({
        teamId: ctx.teamId,
        workflowId,
        schemaId,
      });
      if (!res.ok) return denyWith(reply, 409, res.denial);
      return reply.code(200).send({ ok: true });
    },
  );

  // ---------------------------------------------------------------------------
  // CODING VALUES
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/reviewer/work/:workflowId/coding",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveTeam(req, reply);
      if (!ctx) return reply;
      const { workflowId } = z
        .object({ workflowId: z.string().uuid() })
        .parse(req.params);
      const [values, coverage] = await Promise.all([
        readCodingValuesForWorkflow({ teamId: ctx.teamId, workflowId }),
        evaluateRequiredFieldsCoverage({ teamId: ctx.teamId, workflowId }),
      ]);
      return reply.code(200).send({ values, coverage });
    },
  );

  app.post(
    "/v1/reviewer/work/:workflowId/code",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveTeam(req, reply);
      if (!ctx) return reply;
      if (!requireCap(ctx, "review.code")) return denyNoPermission(reply);
      const { workflowId } = z
        .object({ workflowId: z.string().uuid() })
        .parse(req.params);
      const body = WriteCodingValueBody.parse(req.body);
      const res = await writeCodingValue({
        teamId: ctx.teamId,
        workflowId,
        fieldId: body.fieldId,
        value: body.value,
        authorUserId: ctx.userId,
        rationale: body.rationale,
      });
      if (!res.ok) return denyWith(reply, 409, res.denial);
      return reply.code(200).send({ codingValueId: res.codingValueId });
    },
  );

  // ---------------------------------------------------------------------------
  // DISAGREEMENTS
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/reviewer/disagreements",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveTeam(req, reply);
      if (!ctx) return reply;
      const q = z
        .object({
          state: z.enum(DISAGREEMENT_STATES).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
          mine: z.string().optional(),
        })
        .parse(req.query ?? {});
      const rows = await listDisagreements({
        teamId: ctx.teamId,
        state: q.state,
        forUserId: q.mine === "true" ? ctx.userId : undefined,
        limit: q.limit,
      });
      return reply.code(200).send({ disagreements: rows });
    },
  );

  app.post(
    "/v1/reviewer/work/:workflowId/disagree",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveTeam(req, reply);
      if (!ctx) return reply;
      if (!requireCap(ctx, "review.disagree")) return denyNoPermission(reply);
      const { workflowId } = z
        .object({ workflowId: z.string().uuid() })
        .parse(req.params);
      const body = FileDisagreementBody.parse(req.body);
      const res = await fileDisagreement({
        teamId: ctx.teamId,
        workflowId,
        originalDecisionId: body.originalDecisionId,
        challengerUserId: ctx.userId,
        rationale: body.rationale,
      });
      if (!res.ok) return denyWith(reply, 409, res.denial);
      return reply.code(201).send({ disagreementId: res.disagreementId });
    },
  );

  app.post(
    "/v1/reviewer/disagreements/:id/transition",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveTeam(req, reply);
      if (!ctx) return reply;
      if (!requireCap(ctx, "review.adjudicate")) return denyNoPermission(reply);
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = TransitionDisagreementBody.parse(req.body);
      const res = await transitionDisagreement({
        teamId: ctx.teamId,
        disagreementId: id,
        to: body.to,
        actorUserId: ctx.userId,
        verdict: body.verdict,
        rationale: body.rationale,
      });
      if (!res.ok) return denyWith(reply, 409, res.denial);
      return reply.code(200).send({ ok: true });
    },
  );

  // ---------------------------------------------------------------------------
  // QC SAMPLES
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/reviewer/qc/samples",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveTeam(req, reply);
      if (!ctx) return reply;
      const q = z
        .object({
          state: z.string().optional(),
          mine: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});
      const rows = await listSamples({
        teamId: ctx.teamId,
        qcReviewerUserId: q.mine === "true" ? ctx.userId : undefined,
        state: q.state,
        limit: q.limit,
      });
      return reply.code(200).send({ samples: rows });
    },
  );

  app.post(
    "/v1/reviewer/qc/samples/:id/assign",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveTeam(req, reply);
      if (!ctx) return reply;
      if (!requireCap(ctx, "review.assign")) return denyNoPermission(reply);
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = AssignQcBody.parse(req.body);
      const res = await assignSample({
        teamId: ctx.teamId,
        sampleId: id,
        qcReviewerUserId: body.qcReviewerUserId,
      });
      if (!res.ok) return denyWith(reply, 409, res.denial);
      return reply.code(200).send({ ok: true });
    },
  );

  app.post(
    "/v1/reviewer/qc/samples/:id/verdict",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveTeam(req, reply);
      if (!ctx) return reply;
      if (!requireCap(ctx, "review.qc.verdict")) return denyNoPermission(reply);
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = QcVerdictBody.parse(req.body);
      const res = await renderQcVerdict({
        teamId: ctx.teamId,
        sampleId: id,
        actorUserId: ctx.userId,
        verdict: body.verdict,
        failureReason: body.failureReason,
        rationale: body.rationale,
      });
      if (!res.ok) return denyWith(reply, 409, res.denial);
      return reply.code(200).send({ ok: true });
    },
  );

  // ---------------------------------------------------------------------------
  // PHASE 2A CLOSURE — Annotation Workspace
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/reviewer/evidence/:evidenceId/annotations",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveTeam(req, reply);
      if (!ctx) return reply;
      const { evidenceId } = z
        .object({ evidenceId: z.string().uuid() })
        .parse(req.params);
      const res = await listAnnotationsForEvidence({
        teamId: ctx.teamId,
        evidenceId,
      });
      if (!res.ok) return denyWith(reply, 404, "EVIDENCE_NOT_FOUND" as never);
      return reply.code(200).send({ annotations: res.annotations });
    },
  );

  app.post(
    "/v1/reviewer/annotations/:id/reply",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveTeam(req, reply);
      if (!ctx) return reply;
      if (!requireCap(ctx, "review.annotate")) return denyNoPermission(reply);
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({ body: z.string().min(1).max(2000) })
        .parse(req.body);
      const res = await postAnnotationReply({
        teamId: ctx.teamId,
        parentAnnotationId: id,
        authorUserId: ctx.userId,
        body: body.body,
      });
      if (!res.ok) return denyWith(reply, 409, res.denial as never);
      return reply.code(201).send({ annotationId: res.annotationId });
    },
  );

  app.post(
    "/v1/reviewer/annotations/:id/resolve",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveTeam(req, reply);
      if (!ctx) return reply;
      if (!requireCap(ctx, "review.annotate")) return denyNoPermission(reply);
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const res = await resolveAnnotation({
        teamId: ctx.teamId,
        annotationId: id,
        actorUserId: ctx.userId,
      });
      if (!res.ok) return denyWith(reply, 409, res.denial as never);
      return reply.code(200).send({ ok: true });
    },
  );

  app.post(
    "/v1/reviewer/annotations/bulk-resolve",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveTeam(req, reply);
      if (!ctx) return reply;
      if (!requireCap(ctx, "review.annotate")) return denyNoPermission(reply);
      const body = z
        .object({ annotationIds: z.array(z.string().uuid()).max(200) })
        .parse(req.body);
      const res = await bulkResolveAnnotations({
        teamId: ctx.teamId,
        annotationIds: body.annotationIds,
        actorUserId: ctx.userId,
      });
      if (!res.ok) return denyWith(reply, 409, res.denial as never);
      return reply.code(200).send({ resolved: res.resolved });
    },
  );

  // ---------------------------------------------------------------------------
  // PHASE 2A CLOSURE — Bulk operations
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/reviewer/bulk/assign",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveTeam(req, reply);
      if (!ctx) return reply;
      if (!requireCap(ctx, "review.bulk") || !requireCap(ctx, "review.assign")) {
        return denyNoPermission(reply);
      }
      const body = z
        .object({
          assigneeUserId: z.string().uuid(),
          workflowIds: z.array(z.string().uuid()).min(1).max(100),
        })
        .parse(req.body);
      const res = await bulkAssign({
        teamId: ctx.teamId,
        actorUserId: ctx.userId,
        assigneeUserId: body.assigneeUserId,
        workflowIds: body.workflowIds,
      });
      if (!res.ok) return denyWith(reply, 409, res.denial);
      return reply.code(200).send(res);
    },
  );

  app.post(
    "/v1/reviewer/bulk/decide",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveTeam(req, reply);
      if (!ctx) return reply;
      if (!requireCap(ctx, "review.bulk") || !requireCap(ctx, "review.decide")) {
        return denyNoPermission(reply);
      }
      const body = z
        .object({
          verdict: z.enum(REVIEWER_VERDICTS),
          rationale: z.string().max(240).optional(),
          workflowIds: z.array(z.string().uuid()).min(1).max(100),
        })
        .parse(req.body);
      const res = await bulkDecide({
        teamId: ctx.teamId,
        actorUserId: ctx.userId,
        verdict: body.verdict,
        rationale: body.rationale,
        workflowIds: body.workflowIds,
      });
      if (!res.ok) return denyWith(reply, 409, res.denial);
      return reply.code(200).send(res);
    },
  );

  app.post(
    "/v1/reviewer/bulk/code",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveTeam(req, reply);
      if (!ctx) return reply;
      if (!requireCap(ctx, "review.bulk") || !requireCap(ctx, "review.code")) {
        return denyNoPermission(reply);
      }
      const body = z
        .object({
          fieldSlug: z.string().min(1).max(80),
          value: z.record(z.string(), z.unknown()),
          workflowIds: z.array(z.string().uuid()).min(1).max(100),
        })
        .parse(req.body);
      const res = await bulkCode({
        teamId: ctx.teamId,
        actorUserId: ctx.userId,
        fieldSlug: body.fieldSlug,
        value: body.value,
        workflowIds: body.workflowIds,
      });
      if (!res.ok) return denyWith(reply, 409, res.denial);
      return reply.code(200).send(res);
    },
  );
}
