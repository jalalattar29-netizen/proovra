/**
 * PROOVRA Phase 3A — Redaction Platform routes.
 *
 * Bounded HTTP surface for the enterprise redaction lifecycle.
 * Every route:
 *   * Requires `requireAuth`.
 *   * Resolves the operator's workspace via the existing
 *     `currentWorkspaceId` rail.
 *   * Calls `assertRedactionCapability` BEFORE touching any
 *     redaction table. Server-side gating — never UI-only.
 *   * Returns bounded denial codes from `REDACTION_DENIAL_REASONS`.
 *
 * Routes:
 *
 *   GET    /v1/redaction/projects
 *   POST   /v1/redaction/projects
 *   GET    /v1/redaction/projects/:id
 *   GET    /v1/redaction/projects/:id/activity
 *   POST   /v1/redaction/projects/:id/versions
 *   POST   /v1/redaction/versions/:id/regions
 *   DELETE /v1/redaction/regions/:id
 *   POST   /v1/redaction/versions/:id/detect
 *   GET    /v1/redaction/versions/:id/detections
 *   POST   /v1/redaction/detections/:id/decision
 *   POST   /v1/redaction/versions/:id/submit
 *   POST   /v1/redaction/versions/:id/approve
 *   POST   /v1/redaction/versions/:id/publish
 *   POST   /v1/redaction/versions/:id/derivative
 *   POST   /v1/redaction/derivatives/:id/mark-ready   (worker callback)
 *   POST   /v1/redaction/derivatives/:id/mark-failed  (worker callback)
 *   GET    /v1/redaction/derivatives/:id              (download metadata)
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  REDACTION_APPROVAL_VERDICTS,
  REDACTION_ARTIFACT_KINDS,
  REDACTION_DECISION_STATES,
  REDACTION_DETECTION_PROVIDERS,
  REDACTION_METHODS,
  REDACTION_REGION_KINDS,
  type RedactionDenialReason,
} from "@proovra/shared";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorizeOrFail } from "../middleware/authorize.js";
// Phase 3A redaction closure — publishing a redacted derivative is the
// irreversible, disclosure-shaping step of the redaction lifecycle, so it
// must require a fresh step-up (purpose REDACTION_PUBLISH) AFTER the
// redaction RBAC capability check and BEFORE the PUBLISHED transition. This
// reuses the existing enterprise step-up middleware — no second security
// system, and it NEVER gates viewing / authoring / detection / submit /
// approve / derivative-request.
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";
import { assertFeatureEntitlement } from "../services/packaging/entitlement.service.js";
import {
  extractPrismaDiagnostic,
  isPrismaTableOrColumnMissing,
} from "./_governance-error-bound.js";

import {
  emitRedactionActivity,
  listRedactionActivity,
} from "../services/redaction/redaction-activity.service.js";
import { assertRedactionCapability } from "../services/redaction/redaction-rbac.service.js";
import {
  createRedactionVersion,
  listRedactionProjectsForTeam,
  openRedactionProject,
  transitionRedactionVersion,
} from "../services/redaction/redaction-project.service.js";
import {
  addRedactionRegion,
  removeRedactionRegion,
} from "../services/redaction/redaction-region.service.js";
import {
  listRedactionDetectionsForVersion,
  runRedactionDetection,
} from "../services/redaction/redaction-detection.service.js";
import { recordDetectionDecision } from "../services/redaction/redaction-decision.service.js";
import { recordRedactionApproval } from "../services/redaction/redaction-approval.service.js";
import {
  getDerivativeForVersion,
  markDerivativeFailed,
  markDerivativeReady,
  requestRedactionDerivative,
} from "../services/redaction/redaction-derivative.service.js";
import {
  projectRedactionProject,
  summariseRedactionQueueForTeam,
} from "../services/redaction/redaction-projection.service.js";
import {
  REDACTION_BULK_DECISION_MAX_ROWS,
  bulkRecordDetectionDecisions,
} from "../services/redaction/redaction-decision-bulk.service.js";
import { buildRedactionProviderHealth } from "../services/redaction/redaction-provider-health.service.js";
import { buildRedactionDetectionManifest } from "../services/redaction/redaction-detection-manifest.service.js";
import {
  getRedactionDetectionPolicy,
  setRedactionDetectionPolicy,
} from "../services/redaction/redaction-policy.service.js";
import {
  archivePolicy,
  assignPolicyVersion,
  createPolicy,
  createPolicyVersion,
  listAssignmentsForScope,
  listAuditForPolicy,
  listPolicies,
  listPolicyVersions,
  resolveEffectivePolicy,
  revokePolicyAssignment,
  transitionPolicyVersion,
} from "../services/redaction/redaction-policy-store.service.js";
import {
  listVideoFrames,
  registerVideoFrameBatch,
} from "../services/redaction/video/video-frame.service.js";
import {
  decideVideoTrack,
  listVideoTracksForEvidence,
  mergeTracks,
  propagateRangeDecision,
  splitTrack,
} from "../services/redaction/video/video-track.service.js";
import { groupDetectionsIntoTracks } from "../services/redaction/video/video-tracking.service.js";
import { projectVideoTimeline } from "../services/redaction/video/video-timeline.service.js";

// ---------------------------------------------------------------------------
// Bounded request schemas
// ---------------------------------------------------------------------------

const OpenProjectBody = z.object({
  evidenceId: z.string().uuid(),
  artifactKind: z.enum(REDACTION_ARTIFACT_KINDS),
  title: z.string().max(200).optional(),
});

const CreateVersionBody = z.object({
  rationale: z.string().max(600).optional(),
});

const RegionBody = z.object({
  kind: z.enum(REDACTION_REGION_KINDS),
  method: z.enum(REDACTION_METHODS),
  geometry: z.record(z.string(), z.unknown()),
  rationale: z.string().max(600).optional(),
});

const DetectionRunBody = z.object({
  providers: z.array(z.enum(REDACTION_DETECTION_PROVIDERS)).min(1).max(8),
  inlineText: z.string().max(200_000).optional(),
});

const DetectionDecisionBody = z.object({
  decisionState: z.enum(REDACTION_DECISION_STATES),
  modifiedRegionGeometry: z.record(z.string(), z.unknown()).optional(),
  rationale: z.string().max(600).optional(),
});

const ApprovalBody = z.object({
  verdict: z.enum(REDACTION_APPROVAL_VERDICTS),
  rationale: z.string().max(600).optional(),
});

// Phase 3A Closure — bulk detection decisions
const BulkDecisionsBody = z.object({
  rows: z
    .array(
      z.object({
        detectionId: z.string().uuid(),
        decisionState: z.enum(["ACCEPTED", "REJECTED", "DEFERRED"]),
        rationale: z.string().max(600).optional(),
      }),
    )
    .min(1)
    .max(REDACTION_BULK_DECISION_MAX_ROWS),
});

// Phase 3A Closure — workspace detection-policy edit
const PolicyPatchBody = z.object({
  providers: z
    .record(z.enum(REDACTION_DETECTION_PROVIDERS), z.boolean())
    .optional(),
  kinds: z.record(z.string(), z.boolean()).optional(),
  description: z.string().max(600).nullable().optional(),
});

// Phase 3A Elite Closure — versioned policy CRUD
const PolicyCreateBody = z.object({
  name: z.string().min(1).max(180),
  description: z.string().max(600).optional(),
});

const PolicyDocumentSchema = z.object({
  schemaVersion: z.literal("PROOVRA_REDACTION_POLICY_V1"),
  providers: z.record(z.string(), z.boolean()).optional().default({}),
  kinds: z.record(z.string(), z.boolean()).optional().default({}),
  ruleActions: z
    .record(
      z.string(),
      z.enum([
        "DETECT_ONLY",
        "SUGGEST",
        "REQUIRE_APPROVAL",
        "BLOCK_PUBLICATION",
      ]),
    )
    .optional()
    .default({}),
  customRules: z
    .array(
      z.object({
        name: z.string().max(80),
        kind: z.string(),
        pattern: z.string().max(400),
        flags: z.string().regex(/^[imsu]*$/).optional(),
        rawConfidence: z.number().min(0).max(1),
        action: z.enum([
          "DETECT_ONLY",
          "SUGGEST",
          "REQUIRE_APPROVAL",
          "BLOCK_PUBLICATION",
        ]),
      }),
    )
    .max(200)
    .optional()
    .default([]),
});

const PolicyVersionCreateBody = z.object({
  rationale: z.string().max(600).optional(),
  document: PolicyDocumentSchema,
});

const PolicyVersionTransitionBody = z.object({
  toState: z.enum([
    "IN_REVIEW",
    "APPROVED",
    "PUBLISHED",
    "REJECTED",
    "SUPERSEDED",
    "ROLLED_BACK",
    "DRAFT",
  ]),
  rationale: z.string().max(600).optional(),
});

const PolicyAssignmentBody = z.object({
  policyVersionId: z.string().uuid(),
  scope: z.enum(["GLOBAL", "WORKSPACE", "CASE", "PROJECT"]),
  scopeTargetId: z.string().uuid().nullable().optional(),
  rationale: z.string().max(600).optional(),
});

// Phase 3A Elite Closure — video schemas
const FrameBatchBody = z.object({
  extractor: z.enum(["FFMPEG_SAMPLE", "FFMPEG_KEYFRAME", "OPERATOR_INLINE"]),
  samplePreset: z
    .enum([
      "EVERY_FRAME",
      "EVERY_500MS",
      "EVERY_1S",
      "EVERY_5S",
      "EVERY_KEYFRAME",
    ])
    .optional(),
  frames: z
    .array(
      z.object({
        frameIndex: z.number().int().nonnegative(),
        timestampMs: z.number().int().nonnegative(),
        storageBucket: z.string().max(180).optional(),
        storageKey: z.string().max(400).optional(),
        storageRegion: z.string().max(40).optional(),
        byteSize: z.number().int().nonnegative().optional(),
        contentType: z.string().max(120).optional(),
      }),
    )
    .max(5000),
});

const TrackDecisionBody = z.object({
  toState: z.enum(["ACCEPTED", "REJECTED", "MODIFIED"]),
  rationale: z.string().max(600).optional(),
});

const RangeDecisionBody = z.object({
  startFrame: z.number().int().nonnegative(),
  endFrame: z.number().int().nonnegative(),
  toState: z.enum(["ACCEPTED", "REJECTED"]),
  rationale: z.string().max(600).optional(),
});

const TrackMergeBody = z.object({
  trackIds: z.array(z.string().uuid()).min(2).max(50),
});

const TrackSplitBody = z.object({
  splitAfterFrame: z.number().int().nonnegative(),
});

const TrackGroupingBody = z.object({
  versionId: z.string().uuid().nullable().optional(),
  kind: z.enum([
    "FACE",
    "OBJECT",
    "TEXT",
    "LICENSE_PLATE",
    "SCREEN_CONTENT",
    "CUSTOM",
  ]),
  label: z.string().max(80).optional(),
  iouThreshold: z.number().min(0).max(1).optional(),
  detections: z
    .array(
      z.object({
        frameId: z.string().uuid(),
        frameIndex: z.number().int().nonnegative(),
        bbox: z.object({
          x: z.number().min(0).max(1),
          y: z.number().min(0).max(1),
          width: z.number().min(0).max(1),
          height: z.number().min(0).max(1),
        }),
        rawConfidence: z.number().min(0).max(1),
      }),
    )
    .max(5000),
});

const SubmitBody = z.object({
  rationale: z.string().max(600).optional(),
});

const PublishBody = z.object({
  rationale: z.string().max(600).optional(),
});

const DerivativeReadyBody = z.object({
  storageBucket: z.string().min(1).max(180),
  storageKey: z.string().min(1).max(400),
  storageRegion: z.string().max(40).optional(),
  byteSize: z.number().int().nonnegative(),
  fileSha256: z.string().min(64).max(64).regex(/^[0-9a-f]+$/),
  contentType: z.string().min(1).max(120),
  renderEngine: z.string().min(1).max(40),
});

const DerivativeFailedBody = z.object({
  failureReason: z.string().min(1).max(120),
  errorPreview: z.string().max(400).optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveWorkspace(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ teamId: string; userId: string } | null> {
  const userId = getAuthUserId(req);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { currentWorkspaceId: true },
  });
  if (!user?.currentWorkspaceId) {
    // No active workspace context — anti-enumeration 404 (consistent with the
    // canonical primitive's not-a-member path below).
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  // PHASE 1 AUTHORIZATION CLOSURE (2026-07-21) — the redaction RBAC
  // (assertRedactionCapability) must NOT be the sole authorization gate.
  // Route the active workspace through the canonical primitive FIRST, so
  // ACTIVE membership + parent-Organization lifecycle + fail-closed +
  // anti-enumeration are enforced before any redaction-capability check.
  // Redaction is an evidence-domain surface, so `evidence.read` is the base
  // membership capability every member holds; the fine-grained redaction tier
  // (view/author/review/approve/publish/administer) is enforced by the
  // subsequent `gate()` call. All redaction data queries are scoped to this
  // returned teamId, so the resource is bound to the authorized workspace.
  const authz = await authorizeOrFail(req, reply, {
    teamId: user.currentWorkspaceId,
    permission: "evidence.read",
    antiEnumeration: true,
  });
  if (!authz) return null;
  return { teamId: authz.teamId, userId: authz.actorUserId };
}

async function gate(
  reply: FastifyReply,
  ctx: { teamId: string; userId: string },
  capability:
    | "redaction.view"
    | "redaction.region.author"
    | "redaction.detection.run"
    | "redaction.detection.review"
    | "redaction.version.submit"
    | "redaction.version.approve"
    | "redaction.version.publish"
    | "redaction.derivative.download"
    | "redaction.administer",
): Promise<boolean> {
  const res = await assertRedactionCapability({
    userId: ctx.userId,
    teamId: ctx.teamId,
    capability,
  });
  if (!res.ok) {
    reply.code(403).send({ denial: res.denial });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function redactionRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // Reviewer-workspace integration — bounded summary endpoint that the
  // Reviewer landing page consumes for the redaction tile. NEVER per-
  // grant detail; counts only.
  // -------------------------------------------------------------------------

  app.get(
    "/v1/redaction/workspace/summary",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.view"))) return reply;
      const summary = await summariseRedactionQueueForTeam({
        teamId: ctx.teamId,
      });
      return reply.code(200).send({ summary });
    },
  );

  // -------------------------------------------------------------------------
  // Public verify-page badge — anonymous + workspace-anchored by
  // evidenceId. Exposes ONLY the existence + version ordinal +
  // published-at + approval count. NEVER region geometry,
  // NEVER detection text, NEVER rationale.
  // -------------------------------------------------------------------------

  app.get(
    "/v1/redaction/public/verify/:evidenceId",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { evidenceId } = z
        .object({ evidenceId: z.string().uuid() })
        .parse(req.params);
      const project = await prisma.redactionProject.findFirst({
        where: { evidenceId },
        select: {
          id: true,
          versions: {
            where: { state: "PUBLISHED" },
            select: {
              versionOrdinal: true,
              publishedAtUtc: true,
              approvals: { select: { id: true } },
            },
            orderBy: { publishedAtUtc: "desc" },
            take: 1,
          },
        },
      });
      const published = project?.versions[0] ?? null;
      // Phase 3A Elite Closure — bounded video provenance counts.
      // NEVER per-track geometry. NEVER detection text. Bounded
      // count-only.
      const acceptedTracksCount = await prisma.videoTrack.count({
        where: {
          teamId: project?.versions[0]?.publishedAtUtc
            ? undefined
            : undefined,
          evidenceId,
          state: "ACCEPTED",
        },
      });
      const totalFramesCount = await prisma.videoFrame.count({
        where: { evidenceId },
      });
      const badge = {
        hasPublishedDerivative: published !== null,
        publishedVersionOrdinal: published?.versionOrdinal ?? null,
        publishedAtUtc: published?.publishedAtUtc?.toISOString() ?? null,
        approvalCount: published?.approvals.length ?? 0,
        videoProvenance:
          totalFramesCount > 0
            ? {
                totalFrames: totalFramesCount,
                acceptedTracks: acceptedTracksCount,
              }
            : null,
        limitations: [
          "REDACTION_NEVER_MODIFIES_ORIGINAL",
          "REDACTION_DERIVATIVE_IS_NOT_ORIGINAL",
          "REDACTION_APPROVAL_IS_HUMAN_JUDGEMENT",
          "REDACTION_TRACKING_IS_PROVENANCE_ONLY",
        ],
      };
      return reply.code(200).send({ badge });
    },
  );

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  app.get(
    "/v1/redaction/projects",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.view"))) return reply;
      // Phase O Stream B — schema-drift safety net for NODE-1M
      // (redaction_projects.closed_at_utc missing on production until
      // the repair migration is applied). On Prisma P2021/P2022
      // return a bounded empty payload with `degraded: true`; other
      // errors propagate to the central handler so real bugs are NOT
      // swallowed.
      try {
        const rows = await listRedactionProjectsForTeam({ teamId: ctx.teamId });
        return reply.code(200).send({
          projects: rows.map((p) => ({
            id: p.id,
            evidenceId: p.evidenceId,
            artifactKind: p.artifactKind,
            title: p.title,
            state: p.state,
            createdAtUtc: p.createdAt.toISOString(),
            createdByUserId: p.createdByUserId,
          })),
        });
      } catch (err) {
        if (isPrismaTableOrColumnMissing(err)) {
          const diag = extractPrismaDiagnostic(err);
          reply.log.warn(
            {
              event: "redaction.projects.schema_not_ready",
              requestId: reply.request?.id ?? null,
              teamId: ctx.teamId,
              prismaName: diag.name,
              prismaCode: diag.code,
              missingColumn: diag.missingColumn,
              missingTable: diag.missingTable,
              modelName: diag.modelName,
              message: diag.message,
            },
            "GET /v1/redaction/projects degraded: schema not ready",
          );
          return reply.code(200).send({
            projects: [],
            degraded: true,
            reason: "SCHEMA_NOT_READY",
          });
        }
        throw err;
      }
    },
  );

  app.post(
    "/v1/redaction/projects",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      // I6 — FEATURE_REDACTION gate (minimal coverage, one rep mutation).
      try {
        const feOk = await assertFeatureEntitlement({ prisma, teamId: ctx.teamId, key: "FEATURE_REDACTION", actorUserId: ctx.userId });
        if (!feOk.ok) return reply.code(403).send({ denial: "ENTITLEMENT_REQUIRED", entitlement: "FEATURE_REDACTION" });
      } catch { /* engine failure must not break route */ }
      if (!(await gate(reply, ctx, "redaction.region.author"))) return reply;
      const body = OpenProjectBody.parse(req.body);
      const res = await openRedactionProject({
        teamId: ctx.teamId,
        evidenceId: body.evidenceId,
        artifactKind: body.artifactKind,
        title: body.title ?? null,
        createdByUserId: ctx.userId,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(res.opened ? 201 : 200).send({
        projectId: res.projectId,
        opened: res.opened,
      });
    },
  );

  app.get(
    "/v1/redaction/projects/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.view"))) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const res = await projectRedactionProject({
        teamId: ctx.teamId,
        projectId: id,
      });
      if (!res.ok) return reply.code(404).send({ denial: res.denial });
      return reply.code(200).send({ project: res.projection });
    },
  );

  app.get(
    "/v1/redaction/projects/:id/activity",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.view"))) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const rows = await listRedactionActivity({
        teamId: ctx.teamId,
        projectId: id,
      });
      return reply.code(200).send({ activity: rows });
    },
  );

  // -------------------------------------------------------------------------
  // Versions
  // -------------------------------------------------------------------------

  app.post(
    "/v1/redaction/projects/:id/versions",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.region.author"))) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = CreateVersionBody.parse(req.body ?? {});
      const res = await createRedactionVersion({
        teamId: ctx.teamId,
        projectId: id,
        authoredByUserId: ctx.userId,
        rationale: body.rationale ?? null,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(201).send({
        versionId: res.versionId,
        versionOrdinal: res.versionOrdinal,
      });
    },
  );

  app.post(
    "/v1/redaction/versions/:id/submit",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.version.submit"))) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = SubmitBody.parse(req.body ?? {});
      const res = await transitionRedactionVersion({
        teamId: ctx.teamId,
        versionId: id,
        toState: "IN_REVIEW",
        actorUserId: ctx.userId,
        rationale: body.rationale ?? null,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(200).send({ ok: true, from: res.from, to: res.to });
    },
  );

  app.post(
    "/v1/redaction/versions/:id/approve",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.version.approve"))) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = ApprovalBody.parse(req.body);
      const res = await recordRedactionApproval({
        teamId: ctx.teamId,
        versionId: id,
        verdict: body.verdict,
        rationale: body.rationale ?? null,
        approverUserId: ctx.userId,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(200).send({ approvalId: res.approvalId });
    },
  );

  app.post(
    "/v1/redaction/versions/:id/publish",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.version.publish"))) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = PublishBody.parse(req.body ?? {});

      // STEP-UP: publishing a redacted derivative is the irreversible,
      // disclosure-shaping step of the redaction lifecycle (it flips the
      // version + project to PUBLISHED so the verify badge / reports /
      // packages / derivative download treat that derivative as the
      // authoritative redacted artifact). Require a fresh step-up AFTER the
      // redaction RBAC capability gate, BEFORE the mutation. The middleware
      // consumes the challenge single-use; on failure it has already sent
      // 401 STEP_UP_REQUIRED (or 403 on CRITICAL risk) and we early-return.
      // The original evidence is NEVER touched — only the derivative-backed
      // version transitions.
      const gateResult = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: ctx.teamId,
        userId: ctx.userId,
        purpose: "REDACTION_PUBLISH",
        resourceKind: "redaction_derivative",
        resourceId: id,
      });
      if (gateResult.sent) return reply;

      // The step-up challenge id (consumed above) is recorded in the
      // VERSION_PUBLISHED audit row so the trail captures who authorised
      // the disclosure and that a fresh step-up passed. Bounded id only —
      // never the OTP / phone / session token.
      const stepUpHeader = req.headers["x-proovra-step-up-challenge-id"];
      const stepUpChallengeId =
        typeof stepUpHeader === "string"
          ? stepUpHeader.trim() || null
          : Array.isArray(stepUpHeader) && stepUpHeader[0]
            ? String(stepUpHeader[0]).trim() || null
            : null;

      // Publish requires a READY derivative — gate it here.
      const derivative = await prisma.redactionDerivative.findFirst({
        where: { teamId: ctx.teamId, versionId: id },
        select: { state: true },
      });
      if (!derivative || derivative.state !== "READY") {
        return reply
          .code(409)
          .send({ denial: "DERIVATIVE_NOT_READY" as RedactionDenialReason });
      }
      const res = await transitionRedactionVersion({
        teamId: ctx.teamId,
        versionId: id,
        toState: "PUBLISHED",
        actorUserId: ctx.userId,
        rationale: body.rationale ?? null,
        stepUpChallengeId,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(200).send({ ok: true });
    },
  );

  // -------------------------------------------------------------------------
  // Regions
  // -------------------------------------------------------------------------

  app.post(
    "/v1/redaction/versions/:id/regions",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.region.author"))) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = RegionBody.parse(req.body);
      const res = await addRedactionRegion({
        teamId: ctx.teamId,
        versionId: id,
        kind: body.kind,
        method: body.method,
        geometry: body.geometry,
        rationale: body.rationale ?? null,
        authoredByUserId: ctx.userId,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(201).send({ regionId: res.regionId });
    },
  );

  app.delete(
    "/v1/redaction/regions/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.region.author"))) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const res = await removeRedactionRegion({
        teamId: ctx.teamId,
        regionId: id,
        actorUserId: ctx.userId,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(200).send({ ok: true });
    },
  );

  // -------------------------------------------------------------------------
  // Detections
  // -------------------------------------------------------------------------

  app.post(
    "/v1/redaction/versions/:id/detect",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.detection.run"))) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = DetectionRunBody.parse(req.body);
      const res = await runRedactionDetection({
        teamId: ctx.teamId,
        versionId: id,
        providers: body.providers,
        inlineText: body.inlineText,
        actorUserId: ctx.userId,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(200).send({
        detectionCount: res.detectionCount,
        providerStates: res.providerStates,
      });
    },
  );

  app.get(
    "/v1/redaction/versions/:id/detections",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.view"))) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const rows = await listRedactionDetectionsForVersion({
        teamId: ctx.teamId,
        versionId: id,
      });
      return reply.code(200).send({ detections: rows });
    },
  );

  // -------------------------------------------------------------------------
  // Phase 3A Closure — bulk decisions, provider health, detection
  // manifest, workspace detection policy.
  // -------------------------------------------------------------------------

  app.post(
    "/v1/redaction/versions/:id/decisions/bulk",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.detection.review"))) return reply;
      // Bind to version for activity context — every row's detection
      // still validates its own (team, version) tuple inside
      // recordDetectionDecision.
      const { id: _versionId } = z
        .object({ id: z.string().uuid() })
        .parse(req.params);
      void _versionId;
      const body = BulkDecisionsBody.parse(req.body);
      const res = await bulkRecordDetectionDecisions({
        teamId: ctx.teamId,
        decidedByUserId: ctx.userId,
        rows: body.rows,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(200).send({ outcomes: res.outcomes });
    },
  );

  app.get(
    "/v1/redaction/providers/health",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.view"))) return reply;
      // Phase O Stream B — schema-drift safety net for NODE-1N
      // (redaction_policy_assignments.version_id missing on production
      // until the repair migration is applied). On Prisma P2021/P2022
      // return a bounded empty payload with `degraded: true`; other
      // errors propagate to the central handler so real bugs are NOT
      // swallowed.
      try {
        const rows = await buildRedactionProviderHealth({ teamId: ctx.teamId });
        return reply.code(200).send({ providers: rows });
      } catch (err) {
        if (isPrismaTableOrColumnMissing(err)) {
          const diag = extractPrismaDiagnostic(err);
          reply.log.warn(
            {
              event: "redaction.providers_health.schema_not_ready",
              requestId: reply.request?.id ?? null,
              teamId: ctx.teamId,
              prismaName: diag.name,
              prismaCode: diag.code,
              missingColumn: diag.missingColumn,
              missingTable: diag.missingTable,
              modelName: diag.modelName,
              message: diag.message,
            },
            "GET /v1/redaction/providers/health degraded: schema not ready",
          );
          return reply.code(200).send({
            providers: [],
            degraded: true,
            reason: "SCHEMA_NOT_READY",
          });
        }
        throw err;
      }
    },
  );

  app.get(
    "/v1/redaction/evidence/:evidenceId/detection-manifest",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.view"))) return reply;
      const { evidenceId } = z
        .object({ evidenceId: z.string().uuid() })
        .parse(req.params);
      const manifest = await buildRedactionDetectionManifest({
        teamId: ctx.teamId,
        evidenceId,
      });
      return reply.code(200).send({ manifest });
    },
  );

  app.get(
    "/v1/redaction/policy",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.view"))) return reply;
      const policy = await getRedactionDetectionPolicy({ teamId: ctx.teamId });
      return reply.code(200).send({ policy });
    },
  );

  // ---------------------------------------------------------------------------
  // Phase 3A Elite Closure — versioned Policy Management Console routes.
  // ---------------------------------------------------------------------------

  app.get(
    "/v1/redaction/policies",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.view"))) return reply;
      const rows = await listPolicies({ teamId: ctx.teamId });
      return reply.code(200).send({
        policies: rows.map((p: (typeof rows)[number]) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          createdByUserId: p.createdByUserId,
          createdAt: p.createdAt.toISOString(),
          archivedAt: p.archivedAt?.toISOString() ?? null,
        })),
      });
    },
  );

  app.post(
    "/v1/redaction/policies",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.administer"))) return reply;
      const body = PolicyCreateBody.parse(req.body);
      const res = await createPolicy({
        teamId: ctx.teamId,
        name: body.name,
        description: body.description ?? null,
        createdByUserId: ctx.userId,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(201).send({ policyId: res.policyId });
    },
  );

  app.delete(
    "/v1/redaction/policies/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.administer"))) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const res = await archivePolicy({
        teamId: ctx.teamId,
        policyId: id,
        actorUserId: ctx.userId,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(200).send({ ok: true });
    },
  );

  app.get(
    "/v1/redaction/policies/:id/versions",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.view"))) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const rows = await listPolicyVersions({
        teamId: ctx.teamId,
        policyId: id,
      });
      return reply.code(200).send({
        versions: rows.map((v: (typeof rows)[number]) => ({
          id: v.id,
          versionOrdinal: v.versionOrdinal,
          state: v.state,
          authoredByUserId: v.authoredByUserId,
          approvedByUserId: v.approvedByUserId,
          createdAt: v.createdAt.toISOString(),
          submittedAtUtc: v.submittedAtUtc?.toISOString() ?? null,
          approvedAtUtc: v.approvedAtUtc?.toISOString() ?? null,
          publishedAtUtc: v.publishedAtUtc?.toISOString() ?? null,
          supersededAtUtc: v.supersededAtUtc?.toISOString() ?? null,
          rationale: v.rationale,
          document: {
            schemaVersion: "PROOVRA_REDACTION_POLICY_V1",
            providers: v.providers,
            kinds: v.kinds,
            ruleActions: v.ruleActions,
            customRules: v.customRules,
          },
        })),
      });
    },
  );

  app.post(
    "/v1/redaction/policies/:id/versions",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.administer"))) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = PolicyVersionCreateBody.parse(req.body);
      const res = await createPolicyVersion({
        teamId: ctx.teamId,
        policyId: id,
        authoredByUserId: ctx.userId,
        rationale: body.rationale ?? null,
        document: body.document as never,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(201).send({
        policyVersionId: res.policyVersionId,
        versionOrdinal: res.versionOrdinal,
      });
    },
  );

  app.post(
    "/v1/redaction/policy-versions/:id/transition",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.administer"))) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = PolicyVersionTransitionBody.parse(req.body);
      const res = await transitionPolicyVersion({
        teamId: ctx.teamId,
        policyVersionId: id,
        toState: body.toState,
        actorUserId: ctx.userId,
        rationale: body.rationale ?? null,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(200).send({ ok: true, from: res.from, to: res.to });
    },
  );

  app.post(
    "/v1/redaction/policies/:id/assignments",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.administer"))) return reply;
      const { id: _id } = z.object({ id: z.string().uuid() }).parse(req.params);
      void _id;
      const body = PolicyAssignmentBody.parse(req.body);
      const res = await assignPolicyVersion({
        teamId: ctx.teamId,
        policyVersionId: body.policyVersionId,
        scope: body.scope,
        scopeTargetId: body.scopeTargetId ?? null,
        assignedByUserId: ctx.userId,
        rationale: body.rationale ?? null,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(201).send({ assignmentId: res.assignmentId });
    },
  );

  app.delete(
    "/v1/redaction/policy-assignments/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.administer"))) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const res = await revokePolicyAssignment({
        teamId: ctx.teamId,
        assignmentId: id,
        actorUserId: ctx.userId,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(200).send({ ok: true });
    },
  );

  app.get(
    "/v1/redaction/policies/:id/audit",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.view"))) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const rows = await listAuditForPolicy({
        teamId: ctx.teamId,
        policyId: id,
      });
      return reply.code(200).send({
        audit: rows.map((r: (typeof rows)[number]) => ({
          id: r.id,
          code: r.code,
          policyVersionId: r.policyVersionId,
          actorUserId: r.actorUserId,
          payload: r.payload,
          occurredAtUtc: r.occurredAtUtc.toISOString(),
        })),
      });
    },
  );

  app.get(
    "/v1/redaction/policy/effective",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.view"))) return reply;
      const q = z
        .object({
          caseId: z.string().uuid().optional(),
          projectId: z.string().uuid().optional(),
        })
        .parse(req.query ?? {});
      const effective = await resolveEffectivePolicy({
        teamId: ctx.teamId,
        caseId: q.caseId ?? null,
        projectId: q.projectId ?? null,
      });
      return reply.code(200).send({ effective });
    },
  );

  app.get(
    "/v1/redaction/policy/assignments",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.view"))) return reply;
      const q = z
        .object({
          scope: z.enum(["GLOBAL", "WORKSPACE", "CASE", "PROJECT"]),
          scopeTargetId: z.string().uuid().nullable().optional(),
        })
        .parse(req.query ?? {});
      const rows = await listAssignmentsForScope({
        teamId: ctx.teamId,
        scope: q.scope,
        scopeTargetId: q.scopeTargetId ?? null,
      });
      return reply.code(200).send({
        assignments: rows.map((a: (typeof rows)[number]) => ({
          id: a.id,
          policyId: a.policyId,
          policyVersionId: a.policyVersionId,
          scope: a.scope,
          scopeTargetId: a.scopeTargetId,
          assignedByUserId: a.assignedByUserId,
          assignedAtUtc: a.assignedAtUtc.toISOString(),
          revokedAtUtc: a.revokedAtUtc?.toISOString() ?? null,
        })),
      });
    },
  );

  app.patch(
    "/v1/redaction/policy",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.administer"))) return reply;
      const body = PolicyPatchBody.parse(req.body);
      const policy = await setRedactionDetectionPolicy({
        teamId: ctx.teamId,
        actorUserId: ctx.userId,
        providers: body.providers,
        kinds: body.kinds as never,
        description: body.description ?? undefined,
      });
      return reply.code(200).send({ policy });
    },
  );

  // ---------------------------------------------------------------------------
  // Phase 3A Elite Closure — video intelligence routes.
  // ---------------------------------------------------------------------------

  app.get(
    "/v1/redaction/videos/:evidenceId/frames",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.view"))) return reply;
      const { evidenceId } = z
        .object({ evidenceId: z.string().uuid() })
        .parse(req.params);
      const rows = await listVideoFrames({
        teamId: ctx.teamId,
        evidenceId,
      });
      return reply.code(200).send({ frames: rows });
    },
  );

  app.post(
    "/v1/redaction/videos/:evidenceId/frames/batch",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.administer"))) return reply;
      const { evidenceId } = z
        .object({ evidenceId: z.string().uuid() })
        .parse(req.params);
      const body = FrameBatchBody.parse(req.body);
      const res = await registerVideoFrameBatch({
        teamId: ctx.teamId,
        evidenceId,
        extractor: body.extractor,
        samplePreset: body.samplePreset,
        frames: body.frames,
        actorUserId: ctx.userId,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(202).send({
        inserted: res.inserted,
        reused: res.reused,
      });
    },
  );

  app.get(
    "/v1/redaction/videos/:evidenceId/tracks",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.view"))) return reply;
      const { evidenceId } = z
        .object({ evidenceId: z.string().uuid() })
        .parse(req.params);
      const rows = await listVideoTracksForEvidence({
        teamId: ctx.teamId,
        evidenceId,
      });
      return reply.code(200).send({ tracks: rows });
    },
  );

  app.post(
    "/v1/redaction/videos/:evidenceId/tracks/group",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.detection.run"))) return reply;
      const { evidenceId } = z
        .object({ evidenceId: z.string().uuid() })
        .parse(req.params);
      const body = TrackGroupingBody.parse(req.body);
      const res = await groupDetectionsIntoTracks({
        teamId: ctx.teamId,
        evidenceId,
        versionId: body.versionId ?? null,
        kind: body.kind,
        label: body.label ?? null,
        iouThreshold: body.iouThreshold,
        detections: body.detections,
        authoredByUserId: ctx.userId,
      });
      return reply.code(200).send({
        trackCount: res.trackCount,
        trackIds: res.trackIds,
      });
    },
  );

  app.post(
    "/v1/redaction/video-tracks/:id/decision",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.detection.review"))) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = TrackDecisionBody.parse(req.body);
      const res = await decideVideoTrack({
        teamId: ctx.teamId,
        trackId: id,
        toState: body.toState,
        decidedByUserId: ctx.userId,
        rationale: body.rationale ?? null,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(200).send({ ok: true, state: res.state });
    },
  );

  app.post(
    "/v1/redaction/video-tracks/merge",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.detection.review"))) return reply;
      const body = TrackMergeBody.parse(req.body);
      const res = await mergeTracks({
        teamId: ctx.teamId,
        trackIds: body.trackIds,
        actorUserId: ctx.userId,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(200).send({
        mergedTrackId: res.mergedTrackId,
        mergedSourceIds: res.mergedSourceIds,
      });
    },
  );

  app.post(
    "/v1/redaction/video-tracks/:id/split",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.detection.review"))) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = TrackSplitBody.parse(req.body);
      const res = await splitTrack({
        teamId: ctx.teamId,
        trackId: id,
        splitAfterFrame: body.splitAfterFrame,
        actorUserId: ctx.userId,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(200).send({
        firstTrackId: res.firstTrackId,
        secondTrackId: res.secondTrackId,
      });
    },
  );

  app.post(
    "/v1/redaction/videos/:evidenceId/decisions/range",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.detection.review"))) return reply;
      const { evidenceId } = z
        .object({ evidenceId: z.string().uuid() })
        .parse(req.params);
      const body = RangeDecisionBody.parse(req.body);
      const res = await propagateRangeDecision({
        teamId: ctx.teamId,
        evidenceId,
        startFrame: body.startFrame,
        endFrame: body.endFrame,
        toState: body.toState,
        decidedByUserId: ctx.userId,
        rationale: body.rationale ?? null,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(200).send({
        affectedTrackIds: res.affectedTrackIds,
      });
    },
  );

  app.get(
    "/v1/redaction/videos/:evidenceId/timeline",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.view"))) return reply;
      const { evidenceId } = z
        .object({ evidenceId: z.string().uuid() })
        .parse(req.params);
      const timeline = await projectVideoTimeline({
        teamId: ctx.teamId,
        evidenceId,
      });
      return reply.code(200).send({ timeline });
    },
  );

  app.post(
    "/v1/redaction/detections/:id/decision",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.detection.review"))) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = DetectionDecisionBody.parse(req.body);
      const res = await recordDetectionDecision({
        teamId: ctx.teamId,
        detectionId: id,
        decisionState: body.decisionState,
        modifiedRegionGeometry: body.modifiedRegionGeometry,
        rationale: body.rationale ?? null,
        decidedByUserId: ctx.userId,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(200).send({
        decisionId: res.decisionId,
        promotedRegionId: res.promotedRegionId,
      });
    },
  );

  // -------------------------------------------------------------------------
  // Derivative pipeline
  // -------------------------------------------------------------------------

  app.post(
    "/v1/redaction/versions/:id/derivative",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.derivative.download"))) {
        return reply;
      }
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const res = await requestRedactionDerivative({
        teamId: ctx.teamId,
        versionId: id,
        requestedByUserId: ctx.userId,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply
        .code(202)
        .send({ derivativeId: res.derivativeId, state: res.state });
    },
  );

  app.post(
    "/v1/redaction/derivatives/:id/mark-ready",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.administer"))) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = DerivativeReadyBody.parse(req.body);
      const res = await markDerivativeReady({
        teamId: ctx.teamId,
        derivativeId: id,
        storageBucket: body.storageBucket,
        storageKey: body.storageKey,
        storageRegion: body.storageRegion,
        byteSize: body.byteSize,
        fileSha256: body.fileSha256,
        contentType: body.contentType,
        renderEngine: body.renderEngine,
        actorUserId: ctx.userId,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(200).send({ ok: true });
    },
  );

  app.post(
    "/v1/redaction/derivatives/:id/mark-failed",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.administer"))) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = DerivativeFailedBody.parse(req.body);
      const res = await markDerivativeFailed({
        teamId: ctx.teamId,
        derivativeId: id,
        failureReason: body.failureReason,
        errorPreview: body.errorPreview,
        actorUserId: ctx.userId,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(200).send({ ok: true });
    },
  );

  app.get(
    "/v1/redaction/derivatives/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.derivative.download"))) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const d = await prisma.redactionDerivative.findFirst({
        where: { id, teamId: ctx.teamId },
      });
      if (!d) {
        return reply
          .code(404)
          .send({ denial: "DERIVATIVE_NOT_READY" as RedactionDenialReason });
      }
      // Bump the audit counter + emit DERIVATIVE_DOWNLOADED on every fetch.
      await prisma.redactionDerivative.update({
        where: { id },
        data: { downloadCount: { increment: 1 } },
      });
      const version = await prisma.redactionVersion.findFirst({
        where: { id: d.versionId },
        select: { projectId: true },
      });
      if (version) {
        await emitRedactionActivity({
          teamId: ctx.teamId,
          projectId: version.projectId,
          versionId: d.versionId,
          code: "DERIVATIVE_DOWNLOADED",
          actorUserId: ctx.userId,
          payload: { derivativeId: id },
        });
      }
      return reply.code(200).send({
        derivative: {
          id: d.id,
          state: d.state,
          kind: d.kind,
          storageBucket: d.storageBucket,
          storageKey: d.storageKey,
          storageRegion: d.storageRegion,
          byteSize: d.byteSize ? Number(d.byteSize) : null,
          fileSha256: d.fileSha256,
          contentType: d.contentType,
          renderedAtUtc: d.renderedAtUtc?.toISOString() ?? null,
          downloadCount: d.downloadCount,
        },
      });
    },
  );

  // Sentinel — also expose the derivative for a given version directly.
  app.get(
    "/v1/redaction/versions/:id/derivative",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      if (!(await gate(reply, ctx, "redaction.view"))) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const d = await getDerivativeForVersion({
        teamId: ctx.teamId,
        versionId: id,
      });
      if (!d) {
        return reply
          .code(404)
          .send({ denial: "DERIVATIVE_NOT_READY" as RedactionDenialReason });
      }
      return reply.code(200).send({
        derivative: {
          id: d.id,
          state: d.state,
          kind: d.kind,
          byteSize: d.byteSize ? Number(d.byteSize) : null,
          fileSha256: d.fileSha256,
          renderedAtUtc: d.renderedAtUtc?.toISOString() ?? null,
        },
      });
    },
  );
}
