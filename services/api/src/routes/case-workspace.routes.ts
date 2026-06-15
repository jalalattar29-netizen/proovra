/**
 * Phase 32.8D — Case Workspace + Reports aggregator routes.
 *
 *   GET /v1/cases/summary?teamId=<uuid>
 *   GET /v1/cases/:id/workspace
 *   GET /v1/reports/artifacts?teamId=<uuid>&limit=&cursor=&lifecycle=&search=&caseId=
 *
 * Each endpoint is read-only, workspace-scoped, partial-failure
 * tolerant, and EMITS NO AUDIT — browsing these aggregators is not
 * an auditable event the way an explicit case view or artifact
 * download is. The existing `/v1/cases/:id` GET endpoint remains
 * the canonical "viewed-case" audit surface; this workspace endpoint
 * is the tabbed-overview reader and intentionally does not duplicate
 * that audit.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

import {
  buildCasesSummary,
  buildCaseWorkspace,
} from "../services/cases/case-workspace.service.js";
import { listWorkspaceArtifacts } from "../services/reports/reports-aggregator.service.js";
import { buildMatterWorkspace } from "../services/cases/matter-workspace.service.js";
import { buildMatterQueue } from "../services/cases/matter-queue.service.js";
import {
  CaseError,
  changeCaseStatus,
  addCaseAssignment,
  removeCaseAssignment,
  addCaseComment,
  deleteCaseComment,
  resolveCaseComment,
  addEvidenceLink,
  removeEvidenceLink,
  removeLegacyEvidenceCaseId,
} from "../services/cases/case-lifecycle.service.js";
import {
  type CaseAccessRole,
  type CaseMutation,
  evaluateCaseMutationPermission,
  getCaseAssignmentRoles,
} from "../services/cases/case-permission.service.js";

/**
 * Phase 32.8D-frontend-closure — Canonical case mutation gate.
 *
 * Replaces the ad-hoc per-route `member.role !== "OPERATOR"` checks
 * (where OPERATOR/INVESTIGATOR/AUDITOR were dead values that never
 * appeared on `member.role`) with a single bounded matrix.
 *
 * Returns `null` after sending a 403 response; the caller bails.
 */
async function gateCaseMutation(
  reply: FastifyReply,
  mutation: CaseMutation,
  caseId: string,
  member: { userId: string; role: string },
): Promise<{ userId: string; role: string } | null> {
  const accessRole = member.role as CaseAccessRole;
  const assignmentRoles = await getCaseAssignmentRoles(caseId, member.userId);
  const decision = evaluateCaseMutationPermission({
    mutation,
    accessRole,
    assignmentRoles,
  });
  if (!decision.allowed) {
    reply.code(403).send({
      error: {
        code: "forbidden",
        reason: decision.reason,
      },
    });
    return null;
  }
  return member;
}

function clientIp(req: FastifyRequest): string | null {
  return (req.ip as string) ?? null;
}
function clientUa(req: FastifyRequest): string | null {
  return (req.headers["user-agent"] as string | undefined) ?? null;
}

function handleCaseError(reply: FastifyReply, err: unknown): boolean {
  if (err instanceof CaseError) {
    const status =
      err.code === "case_not_found" ||
      err.code === "evidence_not_found" ||
      err.code === "assignment_not_found" ||
      err.code === "comment_not_found"
        ? 404
        : err.code === "invalid_transition" ||
            err.code === "active_legal_hold_blocks_closure" ||
            err.code === "evidence_link_exists" ||
            err.code === "assignment_exists"
          ? 409
          : // Phase CASES-PERSONAL-UX-CLEANUP — author-only delete
            // returns 403 so the frontend can render a precise toast.
            err.code === "comment_forbidden"
            ? 403
            : 400;
    reply.code(status).send({ error: { code: err.code } });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Membership helpers
// ---------------------------------------------------------------------------

async function requireWorkspaceMember(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<{ userId: string; role: string } | null> {
  const userId = getAuthUserId(req);
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { role: true, status: true },
  });
  if (!membership) {
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  if (membership.status !== "ACTIVE") {
    reply.code(403).send({ error: { code: "member_inactive" } });
    return null;
  }
  return { userId, role: membership.role };
}

async function requireCaseAccess(
  req: FastifyRequest,
  reply: FastifyReply,
  caseId: string,
): Promise<{ userId: string; role: string } | null> {
  const userId = getAuthUserId(req);
  const caseRow = await prisma.case.findUnique({
    where: { id: caseId },
    select: {
      id: true,
      ownerUserId: true,
      teamId: true,
      access: { where: { userId }, select: { id: true } },
    },
  });
  if (!caseRow) {
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  // Case owner — always allowed.
  if (caseRow.ownerUserId === userId) {
    return { userId, role: "OWNER" };
  }
  // Direct access — allowed.
  if (caseRow.access.length > 0) {
    return { userId, role: "MEMBER" };
  }
  // Team workspace member with no explicit access list on the case.
  if (caseRow.teamId) {
    const membership = await prisma.teamMember.findUnique({
      where: {
        teamId_userId: { teamId: caseRow.teamId, userId },
      },
      select: { role: true, status: true },
    });
    if (
      membership &&
      membership.status === "ACTIVE" &&
      caseRow.access.length === 0
    ) {
      // Case has no explicit access list — workspace membership grants
      // read access. (Same model as /v1/cases list.)
      const teamCaseAccessCount = await prisma.caseAccess.count({
        where: { caseId },
      });
      if (teamCaseAccessCount === 0) {
        return { userId, role: membership.role };
      }
    }
  }
  reply.code(404).send({ error: { code: "not_found" } });
  return null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const SummaryQuery = z.object({ teamId: z.string().uuid() });

const WorkspaceParams = z.object({ id: z.string().uuid() });

const ArtifactsQuery = z.object({
  teamId: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(512).optional(),
  lifecycle: z
    .enum([
      "all",
      "report_ready",
      "report_pending",
      "report_failed",
      "package_ready",
      "package_pending",
      "package_blocked",
    ])
    .optional(),
  search: z.string().min(1).max(80).optional(),
  caseId: z.string().uuid().optional(),
});

export async function caseWorkspaceRoutes(app: FastifyInstance) {
  // ----------- Cases summary (for /cases list page) -----------
  app.get(
    "/v1/cases/summary",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = SummaryQuery.parse(req.query ?? {});
      const member = await requireWorkspaceMember(req, reply, query.teamId);
      if (!member) return;
      const envelope = await buildCasesSummary({
        teamId: query.teamId,
        userId: member.userId,
        role: member.role,
      });
      return reply.code(200).send(envelope);
    },
  );

  // ----------- Single case workspace (for /cases/:id tabs) -----------
  app.get(
    "/v1/cases/:id/workspace",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = WorkspaceParams.parse(req.params ?? {});
      const member = await requireCaseAccess(req, reply, params.id);
      if (!member) return;
      const envelope = await buildCaseWorkspace({
        caseId: params.id,
        userId: member.userId,
        role: member.role,
      });
      if ("notFound" in envelope) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      return reply.code(200).send(envelope);
    },
  );

  // =========================================================================
  // Phase 32.8D — Matter Workspace routes
  //
  //   GET    /v1/cases/matter-queue           — operations queue
  //   GET    /v1/cases/:id/matter-workspace   — 11-section workspace
  //   GET    /v1/cases/:id/risk               — latest risk snapshot
  //
  // Lifecycle mutations (audited):
  //   POST   /v1/cases/:id/status
  //   POST   /v1/cases/:id/assignments
  //   DELETE /v1/cases/:id/assignments/:assignmentId
  //   POST   /v1/cases/:id/comments
  //   POST   /v1/cases/:id/comments/:commentId/resolve
  //   POST   /v1/cases/:id/evidence-links
  //   DELETE /v1/cases/:id/evidence-links/:linkId
  // =========================================================================

  const MatterQueueQuery = z.object({
    teamId: z.string().uuid(),
    status: z
      .enum([
        "OPEN",
        "INVESTIGATING",
        "ON_HOLD",
        "RESOLVED",
        "CLOSED",
        "ARCHIVED",
      ])
      .optional(),
    riskLevel: z.enum(["NONE", "LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
    assignedToUserId: z.string().uuid().optional(),
    hasOpenIncidents: z.coerce.boolean().optional(),
    hasGovernanceBlockers: z.coerce.boolean().optional(),
    hasOverdueWorkflows: z.coerce.boolean().optional(),
    hasLegalHold: z.coerce.boolean().optional(),
    missingArtifact: z.coerce.boolean().optional(),
    search: z.string().min(1).max(80).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  });

  app.get(
    "/v1/cases/matter-queue",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = MatterQueueQuery.parse(req.query ?? {});
      const member = await requireWorkspaceMember(req, reply, q.teamId);
      if (!member) return;
      const envelope = await buildMatterQueue({
        teamId: q.teamId,
        userId: member.userId,
        role: member.role,
        limit: q.limit,
        filter: {
          status: q.status,
          riskLevel: q.riskLevel,
          assignedToUserId: q.assignedToUserId,
          hasOpenIncidents: q.hasOpenIncidents,
          hasGovernanceBlockers: q.hasGovernanceBlockers,
          hasOverdueWorkflows: q.hasOverdueWorkflows,
          hasLegalHold: q.hasLegalHold,
          missingArtifact: q.missingArtifact,
          search: q.search,
        },
      });
      return reply.code(200).send(envelope);
    },
  );

  app.get(
    "/v1/cases/:id/matter-workspace",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = WorkspaceParams.parse(req.params);
      const member = await requireCaseAccess(req, reply, params.id);
      if (!member) return;
      const envelope = await buildMatterWorkspace({
        caseId: params.id,
        userId: member.userId,
        role: member.role,
      });
      if ("notFound" in envelope) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      return reply.code(200).send(envelope);
    },
  );

  app.get(
    "/v1/cases/:id/risk",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = WorkspaceParams.parse(req.params);
      const member = await requireCaseAccess(req, reply, params.id);
      if (!member) return;
      const snap = await prisma.caseRiskSnapshot.findFirst({
        where: { caseId: params.id },
        orderBy: { sampledAtUtc: "desc" },
      });
      if (!snap) {
        return reply
          .code(200)
          .send({ snapshot: null, hint: "No risk snapshot yet — open the matter workspace to compute one lazily." });
      }
      return reply.code(200).send({
        snapshot: {
          riskScore: snap.riskScore,
          riskLevel: snap.riskLevel,
          evidenceGapCount: snap.evidenceGapCount,
          openIncidentCount: snap.openIncidentCount,
          activeWorkflowCount: snap.activeWorkflowCount,
          overdueWorkflowCount: snap.overdueWorkflowCount,
          governanceBlockerCount: snap.governanceBlockerCount,
          reviewerPressureScore: snap.reviewerPressureScore,
          auditReadinessScore: snap.auditReadinessScore,
          custodyConcernCount: snap.custodyConcernCount,
          integrityConcernCount: snap.integrityConcernCount,
          packageReportGapCount: snap.packageReportGapCount,
          reasonCodes: Array.isArray(snap.reasonCodes)
            ? (snap.reasonCodes as string[])
            : [],
          recommendedAction: snap.recommendedAction,
          sampledAtUtc: snap.sampledAtUtc.toISOString(),
        },
      });
    },
  );

  // ---------------------------------------------------------------------
  // Phase C2 — Matter-level discussion thread aggregator.
  //
  // GET /v1/cases/:id/discussion-threads
  //
  // Returns the union of Phase 16 discussion threads anchored to the
  // evidence linked to this matter, plus matter-level discussion
  // threads (DiscussionThread.kind = INVESTIGATION_COORDINATION whose
  // evidenceId resolves to a case-linked evidence). Read-only, never
  // emits audit (browsing the aggregator is not an auditable action —
  // explicit thread reads inside the per-evidence inspector retain
  // their existing audit semantics).
  //
  // Workspace isolation: the case's teamId binds the entire query.
  // No cross-workspace thread can be surfaced through this aggregator.
  //
  // Bounded: at most 50 most-recently-updated threads. The Matter
  // Workspace Communications tab uses this for surfacing; a future
  // C2.x can add pagination if 50 ever becomes operationally
  // insufficient.
  // ---------------------------------------------------------------------
  app.get(
    "/v1/cases/:id/discussion-threads",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = WorkspaceParams.parse(req.params);
      const member = await requireCaseAccess(req, reply, params.id);
      if (!member) return;

      const caseRow = await prisma.case.findUnique({
        where: { id: params.id },
        select: { id: true, teamId: true },
      });
      if (!caseRow || !caseRow.teamId) {
        return reply.code(200).send({
          caseId: params.id,
          teamId: caseRow?.teamId ?? null,
          threads: [],
          counts: {
            total: 0,
            open: 0,
            inProgress: 0,
            resolved: 0,
            closed: 0,
            escalated: 0,
          },
        });
      }

      const links = await prisma.caseEvidenceLink.findMany({
        where: { caseId: params.id },
        select: { evidenceId: true },
      });
      const evidenceIds = links.map((l) => l.evidenceId);
      if (evidenceIds.length === 0) {
        return reply.code(200).send({
          caseId: params.id,
          teamId: caseRow.teamId,
          threads: [],
          counts: {
            total: 0,
            open: 0,
            inProgress: 0,
            resolved: 0,
            closed: 0,
            escalated: 0,
          },
        });
      }

      const threads = await prisma.discussionThread.findMany({
        where: {
          teamId: caseRow.teamId,
          evidenceId: { in: evidenceIds },
          visibility: "INTERNAL",
        },
        select: {
          id: true,
          evidenceId: true,
          kind: true,
          status: true,
          title: true,
          assignedToUserId: true,
          escalatedAtUtc: true,
          resolvedAtUtc: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: "desc" },
        take: 50,
      });

      const counts = {
        total: threads.length,
        open: threads.filter((t) => t.status === "OPEN").length,
        inProgress: threads.filter((t) => t.status === "IN_PROGRESS").length,
        resolved: threads.filter((t) => t.status === "RESOLVED").length,
        closed: threads.filter((t) => t.status === "CLOSED").length,
        escalated: threads.filter((t) => t.escalatedAtUtc !== null).length,
      };

      return reply.code(200).send({
        caseId: params.id,
        teamId: caseRow.teamId,
        threads: threads.map((t) => ({
          id: t.id,
          evidenceId: t.evidenceId,
          kind: t.kind,
          status: t.status,
          title: t.title,
          assignedToUserId: t.assignedToUserId,
          escalatedAtUtc: t.escalatedAtUtc?.toISOString() ?? null,
          resolvedAtUtc: t.resolvedAtUtc?.toISOString() ?? null,
          createdAt: t.createdAt.toISOString(),
          updatedAt: t.updatedAt.toISOString(),
        })),
        counts,
      });
    },
  );

  // ---------------------------------------------------------------------
  // Phase C3 — Matter-level evidence-request aggregator.
  //
  // GET /v1/cases/:id/evidence-requests
  //
  // Returns the case's evidence requests with bounded per-request
  // completion summary so the reviewer console / Matter Workspace can
  // surface intake readiness at a glance. Read-only, never emits
  // audit — clicking through to /evidence-requests/[id] retains the
  // existing audit semantics for explicit per-request reads.
  //
  // Workspace isolation: query narrows by the case's teamId. A
  // request from another workspace can never be surfaced through
  // this aggregator even if it references the same caseId by
  // accident (caseId is a soft reference in the request model).
  //
  // Bounded: at most 50 most-recently-updated requests. Pagination
  // is a C3.x deferred follow-up.
  // ---------------------------------------------------------------------
  app.get(
    "/v1/cases/:id/evidence-requests",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = WorkspaceParams.parse(req.params);
      const member = await requireCaseAccess(req, reply, params.id);
      if (!member) return;

      const caseRow = await prisma.case.findUnique({
        where: { id: params.id },
        select: { id: true, teamId: true },
      });
      if (!caseRow || !caseRow.teamId) {
        return reply.code(200).send({
          caseId: params.id,
          teamId: caseRow?.teamId ?? null,
          requests: [],
          counts: {
            total: 0,
            open: 0,
            sent: 0,
            inProgress: 0,
            needsMoreInfo: 0,
            fulfilled: 0,
            closed: 0,
          },
        });
      }

      const requests = await prisma.evidenceRequest.findMany({
        where: {
          teamId: caseRow.teamId,
          caseId: params.id,
        },
        include: {
          deliverables: {
            select: { required: true, status: true },
          },
        },
        orderBy: { updatedAt: "desc" },
        take: 50,
      });

      const isSatisfied = (status: string) =>
        status === "FULFILLED" || status === "WAIVED";

      const rows = requests.map((r) => {
        const required = r.deliverables.filter((d) => d.required);
        const optional = r.deliverables.filter((d) => !d.required);
        const requiredFulfilled = required.filter((d) =>
          isSatisfied(d.status),
        ).length;
        const optionalFulfilled = optional.filter((d) =>
          isSatisfied(d.status),
        ).length;
        const total = r.deliverables.length;
        const satisfied = r.deliverables.filter((d) =>
          isSatisfied(d.status),
        ).length;
        const completionPercent =
          total === 0 ? 0 : Math.round((satisfied / total) * 100);
        const reviewReady =
          required.length === 0 || requiredFulfilled === required.length;
        return {
          id: r.id,
          title: r.title,
          status: r.status,
          priority: r.priority,
          requestType: r.requestType,
          dueAtUtc: r.dueAtUtc?.toISOString() ?? null,
          sentAtUtc: r.sentAtUtc?.toISOString() ?? null,
          intakeLinkId: r.intakeLinkId,
          assignedReviewerUserId: r.assignedReviewerUserId,
          requestedByUserId: r.requestedByUserId,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
          completion: {
            requiredTotal: required.length,
            requiredFulfilled,
            optionalTotal: optional.length,
            optionalFulfilled,
            completionPercent,
            reviewReady,
            needsMoreInfo: r.status === "NEEDS_MORE_INFO",
          },
        };
      });

      const counts = {
        total: rows.length,
        open: rows.filter((r) => r.status === "OPEN" || r.status === "DRAFT")
          .length,
        sent: rows.filter((r) => r.status === "SENT" || r.status === "VIEWED")
          .length,
        inProgress: rows.filter(
          (r) =>
            r.status === "IN_PROGRESS" ||
            r.status === "RESPONSE_RECEIVED" ||
            r.status === "UNDER_REVIEW" ||
            r.status === "PARTIALLY_FULFILLED",
        ).length,
        needsMoreInfo: rows.filter((r) => r.status === "NEEDS_MORE_INFO")
          .length,
        fulfilled: rows.filter((r) => r.status === "FULFILLED").length,
        closed: rows.filter(
          (r) => r.status === "CLOSED" || r.status === "CANCELLED",
        ).length,
      };

      return reply.code(200).send({
        caseId: params.id,
        teamId: caseRow.teamId,
        requests: rows,
        counts,
      });
    },
  );

  // ---------- Picker endpoints (read-only, side-effect-free) ----------
  //
  // Phase 32.8D-frontend-closure — backs the assignment picker and
  // evidence search modals. These endpoints are deliberately distinct
  // from the global /v1/evidence and /v1/teams/:id/members surfaces
  // so they can stay narrow and side-effect-safe:
  //   - no audit emission
  //   - no signed URLs
  //   - no enumeration of users outside the active workspace
  //   - bounded result sizes
  //   - case-scoped (require case access)

  const AssignmentCandidatesQuery = z.object({
    search: z.string().min(1).max(80).optional(),
    // Phase 32.8D-frontend-closure-2 — bounded limit (hard ceiling
    // at 50) + optional cursor for stable "load more". The cursor
    // is the ISO timestamp of the last `TeamMember.createdAt` on the
    // previous page; the order is `createdAt ASC` so pages stay
    // stable across refresh.
    limit: z.coerce.number().int().min(1).max(50).optional(),
    cursor: z.string().min(1).max(128).optional(),
  });
  app.get(
    "/v1/cases/:id/assignment-candidates",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = WorkspaceParams.parse(req.params);
      const q = AssignmentCandidatesQuery.parse(req.query ?? {});
      const access = await requireCaseAccess(req, reply, params.id);
      if (!access) return;
      const caseRow = await prisma.case.findUnique({
        where: { id: params.id },
        select: { id: true, teamId: true, ownerUserId: true },
      });
      if (!caseRow) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      // Personal cases (no teamId) — assignment is not supported by
      // the lifecycle service. Return an explanatory empty envelope.
      if (!caseRow.teamId) {
        return reply.code(200).send({
          workspaceScope: "PERSONAL",
          items: [],
          reason:
            "Personal cases do not support assignments. Switch to a team workspace to coordinate work.",
        });
      }
      const search = q.search?.trim() ?? "";
      const limit = Math.min(q.limit ?? 25, 50);
      // Cursor is the createdAt of the last row on the previous
      // page. We fetch `limit + 1` rows to detect whether a next
      // page exists without an extra round trip.
      let cursorDate: Date | null = null;
      if (q.cursor) {
        const parsed = new Date(q.cursor);
        if (!Number.isNaN(parsed.getTime())) cursorDate = parsed;
      }
      const members = await prisma.teamMember.findMany({
        where: {
          teamId: caseRow.teamId,
          status: "ACTIVE",
          ...(cursorDate ? { createdAt: { gt: cursorDate } } : {}),
          ...(search
            ? {
                user: {
                  OR: [
                    { email: { contains: search, mode: "insensitive" } },
                    { displayName: { contains: search, mode: "insensitive" } },
                    { firstName: { contains: search, mode: "insensitive" } },
                    { lastName: { contains: search, mode: "insensitive" } },
                  ],
                },
              }
            : {}),
        },
        select: {
          role: true,
          createdAt: true,
          user: {
            select: {
              id: true,
              email: true,
              displayName: true,
              firstName: true,
              lastName: true,
            },
          },
        },
        take: limit + 1,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      const hasMore = members.length > limit;
      const page = hasMore ? members.slice(0, limit) : members;
      const nextCursor =
        hasMore && page.length > 0
          ? page[page.length - 1]!.createdAt.toISOString()
          : null;
      const userIds = page.map((m) => m.user.id);
      const existing = await prisma.caseAssignment.findMany({
        where: {
          caseId: params.id,
          assignedToUserId: { in: userIds },
          status: "ACTIVE",
        },
        select: { assignedToUserId: true, role: true },
      });
      const byUser = new Map<string, string[]>();
      for (const e of existing) {
        const list = byUser.get(e.assignedToUserId) ?? [];
        list.push(String(e.role));
        byUser.set(e.assignedToUserId, list);
      }
      return reply.code(200).send({
        workspaceScope: "TEAM",
        items: page.map((m) => ({
          userId: m.user.id,
          displayName:
            [m.user.firstName, m.user.lastName].filter(Boolean).join(" ").trim() ||
            m.user.displayName ||
            m.user.email ||
            null,
          email: m.user.email ?? null,
          workspaceRole: m.role,
          existingAssignmentRoles: byUser.get(m.user.id) ?? [],
        })),
        nextCursor,
      });
    },
  );

  const LinkableEvidenceQuery = z.object({
    search: z.string().min(1).max(80).optional(),
    // Phase 32.8D-frontend-closure-2 — same cursor pattern as the
    // assignment candidates endpoint. The cursor is the ISO
    // timestamp of the last `Evidence.createdAt` (descending order
    // → cursor advances backward in time).
    limit: z.coerce.number().int().min(1).max(50).optional(),
    cursor: z.string().min(1).max(128).optional(),
  });
  app.get(
    "/v1/cases/:id/linkable-evidence",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = WorkspaceParams.parse(req.params);
      const q = LinkableEvidenceQuery.parse(req.query ?? {});
      const access = await requireCaseAccess(req, reply, params.id);
      if (!access) return;
      const caseRow = await prisma.case.findUnique({
        where: { id: params.id },
        select: { id: true, teamId: true, ownerUserId: true },
      });
      if (!caseRow) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      const search = q.search?.trim() ?? "";
      const limit = Math.min(q.limit ?? 25, 50);
      let cursorDate: Date | null = null;
      if (q.cursor) {
        const parsed = new Date(q.cursor);
        if (!Number.isNaN(parsed.getTime())) cursorDate = parsed;
      }
      // Bounded read: evidence belonging to the case's workspace
      // (team or personal), filtered by free-text search on title.
      // We never expose evidence storage keys, signed URLs, or raw
      // content — only the bounded summary fields.
      const where = caseRow.teamId
        ? { teamId: caseRow.teamId }
        : { ownerUserId: caseRow.ownerUserId };
      const items = await prisma.evidence.findMany({
        where: {
          ...where,
          ...(cursorDate ? { createdAt: { lt: cursorDate } } : {}),
          ...(search
            ? { title: { contains: search, mode: "insensitive" } }
            : {}),
        },
        select: {
          id: true,
          title: true,
          type: true,
          status: true,
          verificationStatus: true,
          lifecycleState: true,
          createdAt: true,
          latestReportVersion: true,
          verificationPackageVersion: true,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      });
      const hasMore = items.length > limit;
      const page = hasMore ? items.slice(0, limit) : items;
      const nextCursor =
        hasMore && page.length > 0
          ? page[page.length - 1]!.createdAt.toISOString()
          : null;
      const evIds = page.map((e) => e.id);
      const existingLinks = await prisma.caseEvidenceLink.findMany({
        where: { caseId: params.id, evidenceId: { in: evIds } },
        select: { evidenceId: true, role: true },
      });
      const linkedSet = new Set(existingLinks.map((l) => l.evidenceId));
      const linkedRoleByEv = new Map(
        existingLinks.map((l) => [l.evidenceId, String(l.role)]),
      );
      return reply.code(200).send({
        items: page.map((e) => ({
          id: e.id,
          title: e.title ?? "Untitled evidence",
          type: String(e.type),
          status: String(e.status),
          verificationStatus: e.verificationStatus
            ? String(e.verificationStatus)
            : null,
          lifecycleState: e.lifecycleState ? String(e.lifecycleState) : null,
          createdAt: e.createdAt.toISOString(),
          reportReady: e.latestReportVersion !== null,
          packageReady: e.verificationPackageVersion !== null,
          alreadyLinked: linkedSet.has(e.id),
          existingLinkRole: linkedRoleByEv.get(e.id) ?? null,
        })),
        nextCursor,
      });
    },
  );

  // ---------- Mutations (audited) ----------

  const StatusBody = z.object({
    toStatus: z.enum([
      "OPEN",
      "INVESTIGATING",
      "ON_HOLD",
      "RESOLVED",
      "CLOSED",
      "ARCHIVED",
    ]),
    reason: z.string().min(1).max(400).optional(),
  });
  app.post(
    "/v1/cases/:id/status",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = WorkspaceParams.parse(req.params);
      const body = StatusBody.parse(req.body ?? {});
      const access = await requireCaseAccess(req, reply, params.id);
      if (!access) return;
      const member = await gateCaseMutation(reply, "STATUS_CHANGE", params.id, access);
      if (!member) return;
      try {
        const updated = await changeCaseStatus({
          caseId: params.id,
          toStatus: body.toStatus,
          reason: body.reason ?? null,
          actorUserId: member.userId,
          ipAddress: clientIp(req),
          userAgent: clientUa(req),
        });
        return reply.code(200).send({ case: updated });
      } catch (err) {
        if (handleCaseError(reply, err)) return;
        throw err;
      }
    },
  );

  const AssignmentBody = z.object({
    assignedToUserId: z.string().uuid(),
    role: z.enum([
      "OWNER",
      "INVESTIGATOR",
      "REVIEWER",
      "GOVERNANCE",
      "OBSERVER",
    ]),
    note: z.string().min(1).max(400).optional(),
  });
  app.post(
    "/v1/cases/:id/assignments",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = WorkspaceParams.parse(req.params);
      const body = AssignmentBody.parse(req.body ?? {});
      const access = await requireCaseAccess(req, reply, params.id);
      if (!access) return;
      const member = await gateCaseMutation(reply, "ASSIGN", params.id, access);
      if (!member) return;
      try {
        const row = await addCaseAssignment({
          caseId: params.id,
          assignedToUserId: body.assignedToUserId,
          role: body.role,
          note: body.note ?? null,
          actorUserId: member.userId,
          ipAddress: clientIp(req),
          userAgent: clientUa(req),
        });
        return reply.code(200).send({ assignment: row });
      } catch (err) {
        if (handleCaseError(reply, err)) return;
        throw err;
      }
    },
  );

  app.delete(
    "/v1/cases/:id/assignments/:assignmentId",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z
        .object({ id: z.string().uuid(), assignmentId: z.string().uuid() })
        .parse(req.params);
      const access = await requireCaseAccess(req, reply, params.id);
      if (!access) return;
      const member = await gateCaseMutation(reply, "ASSIGN", params.id, access);
      if (!member) return;
      try {
        const row = await removeCaseAssignment({
          caseId: params.id,
          assignmentId: params.assignmentId,
          actorUserId: member.userId,
          ipAddress: clientIp(req),
          userAgent: clientUa(req),
        });
        return reply.code(200).send({ assignment: row });
      } catch (err) {
        if (handleCaseError(reply, err)) return;
        throw err;
      }
    },
  );

  const CommentBody = z.object({
    body: z.string().min(1).max(4000),
    visibility: z
      .enum(["INTERNAL", "REVIEWERS", "ALL_MEMBERS"])
      .optional(),
  });
  app.post(
    "/v1/cases/:id/comments",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = WorkspaceParams.parse(req.params);
      const body = CommentBody.parse(req.body ?? {});
      const access = await requireCaseAccess(req, reply, params.id);
      if (!access) return;
      const member = await gateCaseMutation(reply, "COMMENT", params.id, access);
      if (!member) return;
      try {
        const row = await addCaseComment({
          caseId: params.id,
          body: body.body,
          visibility: body.visibility,
          actorUserId: member.userId,
          ipAddress: clientIp(req),
          userAgent: clientUa(req),
        });
        return reply.code(200).send({ comment: row });
      } catch (err) {
        if (handleCaseError(reply, err)) return;
        throw err;
      }
    },
  );

  app.post(
    "/v1/cases/:id/comments/:commentId/resolve",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z
        .object({ id: z.string().uuid(), commentId: z.string().uuid() })
        .parse(req.params);
      const access = await requireCaseAccess(req, reply, params.id);
      if (!access) return;
      const member = await gateCaseMutation(
        reply,
        "COMMENT_RESOLVE",
        params.id,
        access,
      );
      if (!member) return;
      try {
        const row = await resolveCaseComment({
          caseId: params.id,
          commentId: params.commentId,
          actorUserId: member.userId,
          ipAddress: clientIp(req),
          userAgent: clientUa(req),
        });
        return reply.code(200).send({ comment: row });
      } catch (err) {
        if (handleCaseError(reply, err)) return;
        throw err;
      }
    },
  );

  // Phase CASES-PERSONAL-UX-CLEANUP — author-only DELETE of a case
  // comment ("note"). Two-layer authorization:
  //   1. The route requires the caller to be a case member with the
  //      COMMENT mutation gate (same gate used to create notes).
  //   2. The lifecycle service enforces author-only deletion — a
  //      different member of the same case cannot delete someone
  //      else's note. The service returns `comment_forbidden` →
  //      HTTP 403 (mapped by `handleCaseError`).
  // No new schema, no enterprise moderation, no admin override —
  // the destructive surface stays narrowly bounded.
  app.delete(
    "/v1/cases/:id/comments/:commentId",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z
        .object({ id: z.string().uuid(), commentId: z.string().uuid() })
        .parse(req.params);
      const access = await requireCaseAccess(req, reply, params.id);
      if (!access) return;
      const member = await gateCaseMutation(
        reply,
        "COMMENT",
        params.id,
        access,
      );
      if (!member) return;
      try {
        const result = await deleteCaseComment({
          caseId: params.id,
          commentId: params.commentId,
          actorUserId: member.userId,
          ipAddress: clientIp(req),
          userAgent: clientUa(req),
        });
        return reply.code(200).send(result);
      } catch (err) {
        if (handleCaseError(reply, err)) return;
        throw err;
      }
    },
  );

  const EvidenceLinkBody = z.object({
    evidenceId: z.string().uuid(),
    role: z
      .enum(["PRIMARY", "SUPPORTING", "RELATED", "DUPLICATE", "DERIVED", "CONTEXT"])
      .optional(),
    reason: z.string().min(1).max(400).optional(),
  });
  app.post(
    "/v1/cases/:id/evidence-links",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = WorkspaceParams.parse(req.params);
      const body = EvidenceLinkBody.parse(req.body ?? {});
      const access = await requireCaseAccess(req, reply, params.id);
      if (!access) return;
      const member = await gateCaseMutation(
        reply,
        "EVIDENCE_LINK",
        params.id,
        access,
      );
      if (!member) return;
      try {
        const row = await addEvidenceLink({
          caseId: params.id,
          evidenceId: body.evidenceId,
          role: body.role,
          reason: body.reason ?? null,
          actorUserId: member.userId,
          ipAddress: clientIp(req),
          userAgent: clientUa(req),
        });
        return reply.code(200).send({ link: row });
      } catch (err) {
        if (handleCaseError(reply, err)) return;
        throw err;
      }
    },
  );

  // Phase 32.8D-frontend-closure-2 — audited unlink of legacy
  // Evidence.caseId attachments (no CaseEvidenceLink row). Same
  // permission gate as EVIDENCE_LINK. Does not delete the Evidence
  // record itself; only clears the legacy caseId pointer with audit.
  app.delete(
    "/v1/cases/:id/legacy-evidence-link/:evidenceId",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z
        .object({ id: z.string().uuid(), evidenceId: z.string().uuid() })
        .parse(req.params);
      const access = await requireCaseAccess(req, reply, params.id);
      if (!access) return;
      const member = await gateCaseMutation(
        reply,
        "EVIDENCE_UNLINK_LEGACY",
        params.id,
        access,
      );
      if (!member) return;
      try {
        const result = await removeLegacyEvidenceCaseId({
          caseId: params.id,
          evidenceId: params.evidenceId,
          actorUserId: member.userId,
          ipAddress: clientIp(req),
          userAgent: clientUa(req),
        });
        return reply.code(200).send(result);
      } catch (err) {
        if (handleCaseError(reply, err)) return;
        throw err;
      }
    },
  );

  app.delete(
    "/v1/cases/:id/evidence-links/:linkId",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z
        .object({ id: z.string().uuid(), linkId: z.string().uuid() })
        .parse(req.params);
      const access = await requireCaseAccess(req, reply, params.id);
      if (!access) return;
      const member = await gateCaseMutation(
        reply,
        "EVIDENCE_LINK",
        params.id,
        access,
      );
      if (!member) return;
      try {
        const result = await removeEvidenceLink({
          caseId: params.id,
          linkId: params.linkId,
          actorUserId: member.userId,
          ipAddress: clientIp(req),
          userAgent: clientUa(req),
        });
        return reply.code(200).send(result);
      } catch (err) {
        if (handleCaseError(reply, err)) return;
        throw err;
      }
    },
  );

  // ----------- Workspace artifacts list (for /reports page) -----------
  app.get(
    "/v1/reports/artifacts",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = ArtifactsQuery.parse(req.query ?? {});
      const member = await requireWorkspaceMember(req, reply, query.teamId);
      if (!member) return;
      const envelope = await listWorkspaceArtifacts({
        teamId: query.teamId,
        role: member.role,
        limit: query.limit,
        cursor: query.cursor ?? null,
        lifecycleFilter: query.lifecycle ?? "all",
        search: query.search ?? null,
        caseId: query.caseId ?? null,
      });
      return reply.code(200).send(envelope);
    },
  );
}
