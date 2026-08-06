/**
 * PROOVRA Phase 3B — Enterprise Intelligence Platform routes.
 *
 * Bounded HTTP surface for media intelligence records,
 * corrections, provider usage + budgets, executive metrics,
 * and the audit & transparency centre.
 *
 * Every route:
 *   * Requires `requireAuth`.
 *   * Resolves the operator's workspace.
 *   * Bounded denial codes.
 *   * NEVER exposes raw payloads in the projection routes —
 *     payloads are clipped at the projection layer.
 *
 * The adapter REGISTRATION imports below are intentional —
 * importing them ensures `registerAdapter` runs at module load
 * so the adapter registry has entries when the routes resolve.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  AUDIT_TRANSPARENCY_CATEGORIES,
  EXECUTIVE_METRICS_RANGES,
  INTELLIGENCE_CONFIDENCE_BANDS,
  MEDIA_INTELLIGENCE_MODALITIES,
  MEDIA_INTELLIGENCE_PROVIDERS,
  MEDIA_INTELLIGENCE_RECORD_KINDS,
  PROVIDER_ADAPTER_OPERATIONS,
  PROVIDER_BUDGET_PERIODS,
  PROVIDER_BUDGET_SCOPES,
  REVIEWER_CORRECTION_KINDS,
} from "@proovra/shared";

import type { Permission } from "@proovra/shared";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorizeOrFail } from "../middleware/authorize.js";
import {
  extractPrismaDiagnostic,
  isPrismaTableOrColumnMissing,
} from "./_governance-error-bound.js";

import { listAdapterProbes } from "../services/intelligence/providers/provider-adapter.js";
// Side-effect imports — each registers its adapter on the bounded registry.
import "../services/intelligence/providers/azure-document-intelligence-adapter.js";
import "../services/intelligence/providers/deepgram-adapter.js";
import "../services/intelligence/providers/rekognition-adapter.js";
import "../services/intelligence/providers/openai-adapter.js";

import {
  getRecordWithCorrections,
  listRecordsForEvidence,
  runProviderOperation,
} from "../services/intelligence/media-intelligence.service.js";
import {
  acceptCorrection,
  createCorrection,
  getCorrectionVersionChain,
  listCorrectionsForEvidence,
  listCorrectionsForRecord,
  revertCorrection,
} from "../services/intelligence/reviewer-correction.service.js";
import {
  createBudget,
  listBudgetBreaches,
  listBudgetSpend,
  listBudgets,
} from "../services/intelligence/provider-budget.service.js";
import {
  listRecentUsage,
  summariseProviderUsage,
} from "../services/intelligence/provider-usage.service.js";
import {
  projectExecutiveMetrics,
  projectExecutiveTrends,
} from "../services/intelligence/executive-metrics.service.js";
import { listAuditTransparency } from "../services/intelligence/audit-transparency.service.js";
import {
  projectProviderQuality,
  projectReviewerQuality,
  projectTeamQuality,
} from "../services/intelligence/intelligence-quality.service.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const RunProviderByteSchema = z.object({
  provider: z.enum(MEDIA_INTELLIGENCE_PROVIDERS),
  operation: z.enum(PROVIDER_ADAPTER_OPERATIONS),
  bytesBase64: z.string().min(1).optional(),
  url: z.string().url().optional(),
  contentType: z.string().max(120).optional(),
  caseId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
});

const RunProviderTextSchema = z.object({
  provider: z.enum(MEDIA_INTELLIGENCE_PROVIDERS),
  operation: z.enum(PROVIDER_ADAPTER_OPERATIONS),
  text: z.string().min(1).max(200_000),
  caseId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
});

const CorrectionCreateBody = z.object({
  recordId: z.string().uuid(),
  kind: z.enum(REVIEWER_CORRECTION_KINDS),
  patch: z.record(z.string(), z.unknown()),
  rationale: z.string().max(600).optional(),
  reviewConfidenceBand: z.enum(INTELLIGENCE_CONFIDENCE_BANDS).optional(),
});

const BudgetCreateBody = z.object({
  scope: z.enum(PROVIDER_BUDGET_SCOPES),
  scopeTargetId: z.string().uuid().nullable().optional(),
  provider: z.enum(MEDIA_INTELLIGENCE_PROVIDERS).nullable().optional(),
  period: z.enum(PROVIDER_BUDGET_PERIODS),
  softLimitUsdMicros: z.number().int().positive(),
  hardLimitUsdMicros: z.number().int().positive(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Phase 2 hardening — intelligence-platform.routes.ts authorization.
//
// Pre-fix the only gate was `resolveWorkspace`, which:
//   1. read `user.currentWorkspaceId` from the User row,
//   2. confirmed it was non-null,
//   3. returned it as the teamId.
//
// It NEVER checked TeamMember membership and NEVER evaluated a
// permission. Every authenticated user with ANY currentWorkspaceId
// could call corrections, budget POSTs, run/{bytes,text}, and read
// raw record payloads inside their own current workspace, regardless
// of role.
//
// The new helper `authorizeWorkspace`:
//   1. resolves currentWorkspaceId (preserves backward-compat for
//      callers that did not pass a teamId in the request),
//   2. routes the decision through the canonical `authorizeOrFail`
//      middleware which calls evaluateMemberAccess (TeamMember
//      lookup + role-to-permission mapping) and emits bounded denial
//      codes via the central response shape,
//   3. surfaces 404 on non-member (antiEnumeration: true) and
//      403/401/503 on the other denial paths.
//
// Each call site picks the canonical permission for its surface:
//   * intelligence.read           — list/projection reads + payload read
//   * intelligence.feedback.write — correction create/accept/revert
//   * intelligence.run            — run/{bytes,text} (AI provider invocation)
//   * intelligence.policy.manage  — provider budget create/manage
//
// Permission names come from `packages/shared/src/permissions.ts` —
// they are not invented. VIEWER role does NOT grant the write/run/manage
// permissions per the canonical role table.
async function authorizeWorkspace(
  req: FastifyRequest,
  reply: FastifyReply,
  permission: Permission,
): Promise<{ teamId: string; userId: string } | null> {
  const userId = getAuthUserId(req);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { currentWorkspaceId: true },
  });
  if (!user?.currentWorkspaceId) {
    // Operator has no current workspace context; 404 (anti-enumeration)
    // is consistent with authorizeOrFail's not-a-member path.
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  const decision = await authorizeOrFail(req, reply, {
    teamId: user.currentWorkspaceId,
    permission,
    antiEnumeration: true,
  });
  if (!decision) return null;
  return { teamId: decision.teamId, userId: decision.actorUserId };
}

// ---------------------------------------------------------------------------
// PHASE 12 — VERTICAL B. Server-rendered immutable version chain.
// ---------------------------------------------------------------------------

type RawVersionChain = NonNullable<
  Awaited<ReturnType<typeof getCorrectionVersionChain>>
>;
type RawVersion = RawVersionChain["versions"][number];

export type RenderedChainVersion = {
  id: string;
  versionNumber: number;
  kind: string;
  state: string;
  authoredByUserId: string;
  acceptedByUserId: string | null;
  parentCorrectionId: string | null;
  supersedesCorrectionId: string | null;
  supersededByCorrectionId: string | null;
  createdAtUtc: string;
  acceptedAtUtc: string | null;
  revertedAtUtc: string | null;
  supersededAtUtc: string | null;
  rationale: string | null;
  /** Bounded key list — the raw patch body is NOT projected. */
  patchKeys: ReadonlyArray<string>;
  patchFieldCount: number;
  /** Server-decided. The client renders this; it never computes it. */
  isCurrent: boolean;
  isSuperseded: boolean;
  isReverted: boolean;
  /** 0-based depth in the supersede chain, resolved server-side. */
  depth: number;
};

export type RenderedVersionChain = {
  recordId: string;
  evidenceId: string;
  immutable: true;
  /** Ordered oldest → newest. This IS the render order. */
  versions: ReadonlyArray<RenderedChainVersion>;
  /** The accepted, non-superseded head — or null when none is accepted. */
  currentVersionId: string | null;
  totalVersions: number;
  acceptedCount: number;
  revertedCount: number;
};

/**
 * Projects the raw chain into the exact shape the reviewer surface
 * renders. Two invariants live here and nowhere else:
 *
 *   1. `currentVersionId` is the highest-numbered ACCEPTED version that
 *      nothing supersedes. If no version was ever accepted it is null —
 *      NOT the newest draft, and NOT "version 1".
 *   2. `patchKeys` replaces the raw patch body. The chain is an audit
 *      trail of WHAT changed, not a channel for re-emitting extracted
 *      content into a dashboard.
 */
function renderVersionChain(chain: RawVersionChain): RenderedVersionChain {
  const ordered = [...chain.versions].sort(
    (a: RawVersion, b: RawVersion) => a.versionNumber - b.versionNumber,
  );
  const byId = new Map(ordered.map((v) => [v.id, v] as const));
  const head =
    [...ordered]
      .reverse()
      .find(
        (v) =>
          v.state === "ACCEPTED" &&
          !v.supersededByCorrectionId &&
          !v.revertedAtUtc,
      ) ?? null;

  const depthOf = (v: RawVersion): number => {
    let depth = 0;
    let cursor: RawVersion | undefined = v;
    const seen = new Set<string>();
    while (cursor?.parentCorrectionId && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      const parent: RawVersion | undefined = byId.get(cursor.parentCorrectionId);
      if (!parent) break;
      depth += 1;
      cursor = parent;
    }
    return depth;
  };

  const versions = ordered.map<RenderedChainVersion>((v) => {
    const patch = (v.patchPreview ?? {}) as Record<string, unknown>;
    const patchKeys = Object.keys(patch).slice(0, 40);
    return {
      id: v.id,
      versionNumber: v.versionNumber,
      kind: v.kind,
      state: v.state,
      authoredByUserId: v.authoredByUserId,
      acceptedByUserId: v.acceptedByUserId,
      parentCorrectionId: v.parentCorrectionId,
      supersedesCorrectionId: v.supersedesCorrectionId,
      supersededByCorrectionId: v.supersededByCorrectionId,
      createdAtUtc: v.createdAtUtc,
      acceptedAtUtc: v.acceptedAtUtc,
      revertedAtUtc: v.revertedAtUtc,
      supersededAtUtc: v.supersededAtUtc,
      rationale: v.rationale,
      patchKeys,
      patchFieldCount: Object.keys(patch).length,
      isCurrent: head !== null && head.id === v.id,
      isSuperseded: v.supersededByCorrectionId !== null,
      isReverted: v.revertedAtUtc !== null,
      depth: depthOf(v),
    };
  });

  return {
    recordId: chain.recordId,
    evidenceId: chain.evidenceId,
    immutable: true,
    versions,
    currentVersionId: head?.id ?? null,
    totalVersions: versions.length,
    acceptedCount: versions.filter((v) => v.state === "ACCEPTED").length,
    revertedCount: versions.filter((v) => v.isReverted).length,
  };
}

function decodeBase64(payload: string): Uint8Array {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const B = (globalThis as any).Buffer;
  if (B) return B.from(payload, "base64");
  return new Uint8Array(0);
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function intelligencePlatformRoutes(app: FastifyInstance) {
  // ---- Records ----
  app.get(
    "/v1/intelligence/evidence/:evidenceId/records",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await authorizeWorkspace(req, reply, "intelligence.read");
      if (!ctx) return reply;
      const { evidenceId } = z
        .object({ evidenceId: z.string().uuid() })
        .parse(req.params);
      const q = z
        .object({
          modality: z.enum(MEDIA_INTELLIGENCE_MODALITIES).optional(),
          kind: z.enum(MEDIA_INTELLIGENCE_RECORD_KINDS).optional(),
        })
        .parse(req.query ?? {});
      const records = await listRecordsForEvidence({
        teamId: ctx.teamId,
        evidenceId,
        modality: q.modality,
        kind: q.kind,
      });
      return reply.code(200).send({ records });
    },
  );

  app.get(
    "/v1/intelligence/records/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await authorizeWorkspace(req, reply, "intelligence.read");
      if (!ctx) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const row = await getRecordWithCorrections({
        teamId: ctx.teamId,
        recordId: id,
      });
      if (!row) return reply.code(404).send({ denial: "RECORD_NOT_FOUND" });
      // PHASE 12 — VERTICAL B. The record detail carries its own
      // server-rendered immutable chain so the restricted admin surface
      // renders provenance in ONE round trip and never stitches the
      // chain together itself.
      const chain = await getCorrectionVersionChain({
        teamId: ctx.teamId,
        recordId: id,
      });
      return reply.code(200).send({
        record: row,
        chain: chain ? renderVersionChain(chain) : null,
      });
    },
  );

  // ---- Provider operations ----
  app.post(
    "/v1/intelligence/evidence/:evidenceId/run/bytes",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Phase 2 hardening — costly AI provider invocation requires
      // `intelligence.run`. VIEWER role does NOT grant this permission,
      // so a workspace VIEWER can no longer trigger paid provider calls.
      const ctx = await authorizeWorkspace(req, reply, "intelligence.run");
      if (!ctx) return reply;
      const { evidenceId } = z
        .object({ evidenceId: z.string().uuid() })
        .parse(req.params);
      const body = RunProviderByteSchema.parse(req.body);
      const bytes = body.bytesBase64 ? decodeBase64(body.bytesBase64) : null;
      const res = await runProviderOperation({
        teamId: ctx.teamId,
        evidenceId,
        provider: body.provider,
        operation: body.operation,
        initiatedByUserId: ctx.userId,
        caseId: body.caseId ?? null,
        projectId: body.projectId ?? null,
        byteSource: { bytes, url: body.url, contentType: body.contentType },
      });
      if (!res.ok) {
        return reply
          .code(res.decision === "BLOCK" ? 402 : 409)
          .send({ decision: res.decision, reason: res.reason });
      }
      return reply.code(200).send({
        decision: res.decision,
        insertedRecords: res.insertedRecords,
        insertedEntities: res.insertedEntities,
      });
    },
  );

  app.post(
    "/v1/intelligence/evidence/:evidenceId/run/text",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Phase 2 hardening — same as run/bytes; VIEWER cannot invoke
      // text-mode AI provider calls.
      const ctx = await authorizeWorkspace(req, reply, "intelligence.run");
      if (!ctx) return reply;
      const { evidenceId } = z
        .object({ evidenceId: z.string().uuid() })
        .parse(req.params);
      const body = RunProviderTextSchema.parse(req.body);
      const res = await runProviderOperation({
        teamId: ctx.teamId,
        evidenceId,
        provider: body.provider,
        operation: body.operation,
        initiatedByUserId: ctx.userId,
        caseId: body.caseId ?? null,
        projectId: body.projectId ?? null,
        text: body.text,
      });
      if (!res.ok) {
        return reply
          .code(res.decision === "BLOCK" ? 402 : 409)
          .send({ decision: res.decision, reason: res.reason });
      }
      return reply.code(200).send({
        decision: res.decision,
        insertedRecords: res.insertedRecords,
        insertedEntities: res.insertedEntities,
        extractedText: res.extractedText,
      });
    },
  );

  // ---- Corrections ----
  app.post(
    "/v1/intelligence/corrections",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Phase 2 hardening — reviewer correction creation requires
      // `intelligence.feedback.write`. VIEWER role does NOT grant this.
      const ctx = await authorizeWorkspace(
        req,
        reply,
        "intelligence.feedback.write",
      );
      if (!ctx) return reply;
      const body = CorrectionCreateBody.parse(req.body);
      const res = await createCorrection({
        teamId: ctx.teamId,
        recordId: body.recordId,
        kind: body.kind,
        patch: body.patch,
        rationale: body.rationale ?? null,
        reviewConfidenceBand: body.reviewConfidenceBand ?? null,
        authoredByUserId: ctx.userId,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(201).send({ correctionId: res.correctionId });
    },
  );

  app.post(
    "/v1/intelligence/corrections/:id/accept",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Phase 2 hardening — accepting a correction mutates a reviewer
      // record; gated on `intelligence.feedback.write`.
      const ctx = await authorizeWorkspace(
        req,
        reply,
        "intelligence.feedback.write",
      );
      if (!ctx) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const res = await acceptCorrection({
        teamId: ctx.teamId,
        correctionId: id,
        acceptedByUserId: ctx.userId,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(200).send({ recordId: res.recordId });
    },
  );

  app.post(
    "/v1/intelligence/corrections/:id/revert",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Phase 2 hardening — same gate as accept.
      const ctx = await authorizeWorkspace(
        req,
        reply,
        "intelligence.feedback.write",
      );
      if (!ctx) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const res = await revertCorrection({
        teamId: ctx.teamId,
        correctionId: id,
        actorUserId: ctx.userId,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(200).send({
        revertedCorrectionId: res.revertedCorrectionId,
      });
    },
  );

  app.get(
    "/v1/intelligence/records/:id/corrections",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await authorizeWorkspace(req, reply, "intelligence.read");
      if (!ctx) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const rows = await listCorrectionsForRecord({
        teamId: ctx.teamId,
        recordId: id,
      });
      return reply.code(200).send({ corrections: rows });
    },
  );

  app.get(
    "/v1/intelligence/evidence/:evidenceId/corrections",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await authorizeWorkspace(req, reply, "intelligence.read");
      if (!ctx) return reply;
      const { evidenceId } = z
        .object({ evidenceId: z.string().uuid() })
        .parse(req.params);
      const rows = await listCorrectionsForEvidence({
        teamId: ctx.teamId,
        evidenceId,
      });
      return reply.code(200).send({ corrections: rows });
    },
  );

  // ---- Cost controls ----
  app.get(
    "/v1/intelligence/providers/usage",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await authorizeWorkspace(req, reply, "intelligence.read");
      if (!ctx) return reply;
      const summary = await summariseProviderUsage({ teamId: ctx.teamId });
      const recent = await listRecentUsage({ teamId: ctx.teamId, limit: 50 });
      return reply.code(200).send({
        summary,
        recent: recent.map((r: (typeof recent)[number]) => ({
          id: r.id,
          provider: r.provider,
          operation: r.operation,
          unit: r.unit,
          units: r.units,
          estimatedCostUsdMicros: Number(r.estimatedCostUsdMicros),
          decision: r.decision,
          evidenceId: r.evidenceId,
          caseId: r.caseId,
          projectId: r.projectId,
          initiatedByUserId: r.initiatedByUserId,
          failureReason: r.failureReason,
          occurredAtUtc: r.occurredAtUtc.toISOString(),
        })),
      });
    },
  );

  app.get(
    "/v1/intelligence/providers/budgets",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await authorizeWorkspace(req, reply, "intelligence.read");
      if (!ctx) return reply;
      // Phase O Stream B — schema-drift safety net for NODE-1H
      // (provider_budgets.archived_at missing on production until the
      // repair migration is applied). On Prisma P2021/P2022 return a
      // bounded empty payload with `degraded: true`; other errors
      // propagate to the central handler so real bugs are NOT
      // swallowed.
      try {
        const budgets = await listBudgets({ teamId: ctx.teamId });
        return reply.code(200).send({ budgets });
      } catch (err) {
        if (isPrismaTableOrColumnMissing(err)) {
          const diag = extractPrismaDiagnostic(err);
          reply.log.warn(
            {
              event: "intelligence.provider_budgets.schema_not_ready",
              requestId: reply.request?.id ?? null,
              teamId: ctx.teamId,
              prismaName: diag.name,
              prismaCode: diag.code,
              missingColumn: diag.missingColumn,
              missingTable: diag.missingTable,
              modelName: diag.modelName,
              message: diag.message,
            },
            "GET /v1/intelligence/providers/budgets degraded: schema not ready",
          );
          return reply.code(200).send({
            budgets: [],
            degraded: true,
            reason: "SCHEMA_NOT_READY",
          });
        }
        throw err;
      }
    },
  );

  app.post(
    "/v1/intelligence/providers/budgets",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Phase 2 hardening — provider budget creation affects cost
      // controls AND downstream billing exposure; gated on
      // `intelligence.policy.manage` (admin-tier — OWNER/ADMIN only,
      // NOT held by MEMBER/VIEWER per the canonical role table).
      const ctx = await authorizeWorkspace(
        req,
        reply,
        "intelligence.policy.manage",
      );
      if (!ctx) return reply;
      const body = BudgetCreateBody.parse(req.body);
      const res = await createBudget({
        teamId: ctx.teamId,
        scope: body.scope,
        scopeTargetId: body.scopeTargetId ?? null,
        provider: body.provider ?? null,
        period: body.period,
        softLimitUsdMicros: body.softLimitUsdMicros,
        hardLimitUsdMicros: body.hardLimitUsdMicros,
        createdByUserId: ctx.userId,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(201).send({ budgetId: res.budgetId });
    },
  );

  // ---- Provider health ----
  app.get(
    "/v1/intelligence/providers/health",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await authorizeWorkspace(req, reply, "intelligence.read");
      if (!ctx) return reply;
      void ctx;
      const probes = listAdapterProbes();
      return reply.code(200).send({ providers: probes });
    },
  );

  // ---- Executive metrics (snapshot — kept for backward compat) ----
  app.get(
    "/v1/executive/metrics",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await authorizeWorkspace(req, reply, "intelligence.read");
      if (!ctx) return reply;
      const metrics = await projectExecutiveMetrics({ teamId: ctx.teamId });
      return reply.code(200).send({ metrics });
    },
  );

  // ---- Executive trends (Phase 3B Closure — selectable range) ----
  app.get(
    "/v1/executive/trends",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await authorizeWorkspace(req, reply, "intelligence.read");
      if (!ctx) return reply;
      const q = z
        .object({ range: z.enum(EXECUTIVE_METRICS_RANGES).optional() })
        .parse(req.query ?? {});
      const trends = await projectExecutiveTrends({
        teamId: ctx.teamId,
        range: q.range ?? "7d",
      });
      return reply.code(200).send({ trends });
    },
  );

  // ---- Intelligence quality — provider / reviewer / team ----
  app.get(
    "/v1/intelligence/quality/providers",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await authorizeWorkspace(req, reply, "intelligence.read");
      if (!ctx) return reply;
      const q = z
        .object({ range: z.enum(EXECUTIVE_METRICS_RANGES).optional() })
        .parse(req.query ?? {});
      const projection = await projectProviderQuality({
        teamId: ctx.teamId,
        range: q.range ?? "7d",
      });
      return reply.code(200).send({ projection });
    },
  );

  app.get(
    "/v1/intelligence/quality/reviewers",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await authorizeWorkspace(req, reply, "intelligence.read");
      if (!ctx) return reply;
      const q = z
        .object({ range: z.enum(EXECUTIVE_METRICS_RANGES).optional() })
        .parse(req.query ?? {});
      const projection = await projectReviewerQuality({
        teamId: ctx.teamId,
        range: q.range ?? "7d",
      });
      return reply.code(200).send({ projection });
    },
  );

  app.get(
    "/v1/intelligence/quality/teams",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await authorizeWorkspace(req, reply, "intelligence.read");
      if (!ctx) return reply;
      const q = z
        .object({ range: z.enum(EXECUTIVE_METRICS_RANGES).optional() })
        .parse(req.query ?? {});
      const projection = await projectTeamQuality({
        teamId: ctx.teamId,
        range: q.range ?? "7d",
      });
      return reply.code(200).send({ projection });
    },
  );

  // ---- Correction version chain ----
  //
  // PHASE 12 — VERTICAL B. The chain is rendered SERVER-side and handed
  // to the client already ordered, already linked, and already marked
  // with which version is current. The browser must never reconstruct
  // parent/supersedes edges from a flat list — that is exactly how an
  // immutable audit chain silently becomes a client-side opinion.
  app.get(
    "/v1/intelligence/records/:id/version-chain",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await authorizeWorkspace(req, reply, "intelligence.read");
      if (!ctx) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const chain = await getCorrectionVersionChain({
        teamId: ctx.teamId,
        recordId: id,
      });
      if (!chain) return reply.code(404).send({ denial: "RECORD_NOT_FOUND" });
      return reply.code(200).send({ chain: renderVersionChain(chain) });
    },
  );

  // ---- Budget breach + spend dashboards ----
  app.get(
    "/v1/intelligence/budgets/breaches",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await authorizeWorkspace(req, reply, "intelligence.read");
      if (!ctx) return reply;
      const q = z
        .object({ range: z.enum(EXECUTIVE_METRICS_RANGES).optional() })
        .parse(req.query ?? {});
      const projection = await listBudgetBreaches({
        teamId: ctx.teamId,
        range: q.range ?? "30d",
      });
      return reply.code(200).send({ projection });
    },
  );

  app.get(
    "/v1/intelligence/budgets/spend",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await authorizeWorkspace(req, reply, "intelligence.read");
      if (!ctx) return reply;
      const projection = await listBudgetSpend({ teamId: ctx.teamId });
      return reply.code(200).send({ projection });
    },
  );

  // ---- Audit & Transparency Centre ----
  app.get(
    "/v1/audit-transparency",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await authorizeWorkspace(req, reply, "intelligence.read");
      if (!ctx) return reply;
      const q = z
        .object({
          category: z.enum(AUDIT_TRANSPARENCY_CATEGORIES).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        })
        .parse(req.query ?? {});
      const entries = await listAuditTransparency({
        teamId: ctx.teamId,
        category: q.category,
        limit: q.limit,
      });
      return reply.code(200).send({ entries });
    },
  );
}
