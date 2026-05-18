/**
 * Phase 27.5 — Governance operations routes.
 *
 *   Analytics:
 *     GET    /v1/governance/analytics?teamId&window
 *
 *   Notifications:
 *     GET    /v1/governance/notifications?teamId&kind&severity&unacknowledged&limit
 *     POST   /v1/governance/notifications/:id/acknowledge
 *
 *   Export snapshots:
 *     POST   /v1/governance/export-snapshots
 *     GET    /v1/governance/export-snapshots?teamId&snapshotKind&evidenceId&limit
 *     GET    /v1/governance/export-snapshots/:id?teamId
 *     GET    /v1/governance/export-snapshots/:id/verify?teamId
 *
 *   Reconciliation runs (read-only listing):
 *     GET    /v1/governance/reconciliation-runs?teamId&kind&limit
 *     GET    /v1/governance/destruction-executions?teamId&reviewId&limit
 *     GET    /v1/governance/immutable-storage-checks?teamId&evidenceId&limit
 *
 * Every route requires workspace membership and `governance.policy.read`
 * (read) or `governance.policy.manage` (acknowledge). Export-snapshot
 * creation requires the evidence-export caller, so it's an additional
 * `evidence.generate_package` permission gate.
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../services/governance.service.js";
import {
  computeGovernanceAnalytics,
  type GovernanceAnalyticsResult,
} from "../services/governance-lifecycle/governance-analytics.service.js";
import {
  acknowledgeGovernanceNotification,
  countFailedGovernanceNotifications,
  countPendingGovernanceNotifications,
  GovernanceNotificationError,
  listGovernanceNotifications,
} from "../services/governance-lifecycle/governance-notification.service.js";
import {
  captureExportSnapshot,
  getExportSnapshot,
  GovernanceExportSnapshotError,
  listExportSnapshots,
  verifyExportSnapshotHash,
} from "../services/governance-lifecycle/export-lineage.service.js";
import {
  ANALYTICS_WINDOWS,
  GOVERNANCE_EXPORT_SNAPSHOT_KINDS,
  GOVERNANCE_NOTIFICATION_DELIVERY_STATUSES,
  GOVERNANCE_NOTIFICATION_KINDS,
  GOVERNANCE_NOTIFICATION_SEVERITIES,
  GOVERNANCE_RECONCILIATION_KINDS,
} from "@proovra/shared";

const ParamsId = z.object({ id: z.string().uuid() });

async function requireMember(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<{ userId: string; role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER" } | null> {
  const userId = getAuthUserId(req);
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
  });
  if (!membership) {
    reply.code(403).send({ message: "Not a member of the workspace" });
    return null;
  }
  return { userId, role: membership.role };
}

function denyByPermission(reply: FastifyReply, reason: string) {
  reply.code(403).send({ error: { code: "permission_denied", reason } });
}

export async function governanceOperationsRoutes(app: FastifyInstance) {
  // ===========================================================================
  // Analytics
  // ===========================================================================

  app.get(
    "/v1/governance/analytics",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = z
        .object({
          teamId: z.string().uuid(),
          window: z.enum(ANALYTICS_WINDOWS).optional(),
        })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "governance.policy.read");
      if (!perm.allowed) return denyByPermission(reply, perm.reason);

      const result: GovernanceAnalyticsResult = await computeGovernanceAnalytics({
        teamId: query.teamId,
        window: query.window,
      });
      return reply.code(200).send(result);
    },
  );

  // ===========================================================================
  // Notifications
  // ===========================================================================

  app.get(
    "/v1/governance/notifications",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = z
        .object({
          teamId: z.string().uuid(),
          kind: z.enum(GOVERNANCE_NOTIFICATION_KINDS).optional(),
          severity: z.enum(GOVERNANCE_NOTIFICATION_SEVERITIES).optional(),
          deliveryStatus: z
            .enum(GOVERNANCE_NOTIFICATION_DELIVERY_STATUSES)
            .optional(),
          unacknowledged: z.coerce.boolean().optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "governance.policy.read");
      if (!perm.allowed) return denyByPermission(reply, perm.reason);

      const [notifications, pendingCount, failedCount] = await Promise.all([
        listGovernanceNotifications({
          teamId: query.teamId,
          kind: query.kind,
          severity: query.severity,
          deliveryStatus: query.deliveryStatus,
          unacknowledged: query.unacknowledged,
          limit: query.limit,
        }),
        countPendingGovernanceNotifications(query.teamId),
        countFailedGovernanceNotifications(query.teamId),
      ]);
      return reply.code(200).send({
        notifications,
        counts: { pending: pendingCount, failed: failedCount },
      });
    },
  );

  app.post(
    "/v1/governance/notifications/:id/acknowledge",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({ teamId: z.string().uuid() })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "governance.policy.manage");
      if (!perm.allowed) return denyByPermission(reply, perm.reason);
      try {
        const notification = await acknowledgeGovernanceNotification({
          id,
          teamId: body.teamId,
          actorUserId: ok.userId,
        });
        return reply.code(200).send({ notification });
      } catch (err) {
        if (err instanceof GovernanceNotificationError) {
          return reply
            .code(404)
            .send({ error: { code: err.code, details: err.details } });
        }
        throw err;
      }
    },
  );

  // ===========================================================================
  // Export snapshots
  // ===========================================================================

  app.post(
    "/v1/governance/export-snapshots",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({
          teamId: z.string().uuid(),
          evidenceId: z.string().uuid().nullable().optional(),
          snapshotKind: z.enum(GOVERNANCE_EXPORT_SNAPSHOT_KINDS),
        })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId);
      if (!ok) return;
      // Capturing a snapshot is the documentary side of an export — the
      // caller already has the right to export. Require the same
      // permission as report/package generation to keep things tight.
      const perm = requirePermission(ok.role, "evidence.generate_package");
      if (!perm.allowed) return denyByPermission(reply, perm.reason);
      try {
        const snapshot = await captureExportSnapshot({
          teamId: body.teamId,
          evidenceId: body.evidenceId ?? null,
          snapshotKind: body.snapshotKind,
          createdByUserId: ok.userId,
        });
        return reply.code(201).send({ snapshot });
      } catch (err) {
        if (err instanceof GovernanceExportSnapshotError) {
          return reply
            .code(err.code === "EXPORT_SNAPSHOT_EVIDENCE_NOT_FOUND" ? 404 : 400)
            .send({ error: { code: err.code, details: err.details } });
        }
        throw err;
      }
    },
  );

  app.get(
    "/v1/governance/export-snapshots",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = z
        .object({
          teamId: z.string().uuid(),
          snapshotKind: z.enum(GOVERNANCE_EXPORT_SNAPSHOT_KINDS).optional(),
          evidenceId: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "governance.policy.read");
      if (!perm.allowed) return denyByPermission(reply, perm.reason);
      const snapshots = await listExportSnapshots({
        teamId: query.teamId,
        snapshotKind: query.snapshotKind,
        evidenceId: query.evidenceId,
        limit: query.limit,
      });
      return reply.code(200).send({ snapshots });
    },
  );

  app.get(
    "/v1/governance/export-snapshots/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const query = z.object({ teamId: z.string().uuid() }).parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "governance.policy.read");
      if (!perm.allowed) return denyByPermission(reply, perm.reason);
      const snapshot = await getExportSnapshot({ teamId: query.teamId, id });
      if (!snapshot) {
        return reply.code(404).send({
          error: { code: "EXPORT_SNAPSHOT_NOT_FOUND" },
        });
      }
      return reply.code(200).send({ snapshot });
    },
  );

  app.get(
    "/v1/governance/export-snapshots/:id/verify",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const query = z.object({ teamId: z.string().uuid() }).parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "governance.policy.read");
      if (!perm.allowed) return denyByPermission(reply, perm.reason);
      const snapshot = await getExportSnapshot({ teamId: query.teamId, id });
      if (!snapshot) {
        return reply.code(404).send({
          error: { code: "EXPORT_SNAPSHOT_NOT_FOUND" },
        });
      }
      const valid = verifyExportSnapshotHash(snapshot);
      return reply
        .code(200)
        .send({ snapshotId: snapshot.id, valid, snapshotHash: snapshot.snapshotHash });
    },
  );

  // ===========================================================================
  // Reconciliation runs (read-only)
  // ===========================================================================

  app.get(
    "/v1/governance/reconciliation-runs",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = z
        .object({
          teamId: z.string().uuid(),
          kind: z.enum(GOVERNANCE_RECONCILIATION_KINDS).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "governance.policy.read");
      if (!perm.allowed) return denyByPermission(reply, perm.reason);
      const limit = Math.min(query.limit ?? 50, 200);
      const rows = await prisma.governanceReconciliationRun.findMany({
        where: {
          // teamId can be null (cross-team runs); we include both so the
          // dashboard can show platform-wide runs without flooding when
          // user filter explicit teamId.
          OR: [{ teamId: query.teamId }, { teamId: null }],
          ...(query.kind ? { kind: query.kind } : {}),
        },
        orderBy: { startedAtUtc: "desc" },
        take: limit,
      });
      return reply.code(200).send({
        runs: rows.map((r) => ({
          id: r.id,
          teamId: r.teamId,
          kind: r.kind,
          status: r.status,
          trigger: r.trigger,
          startedAtUtc: r.startedAtUtc.toISOString(),
          finishedAtUtc: r.finishedAtUtc?.toISOString() ?? null,
          scannedCount: r.scannedCount,
          matchedCount: r.matchedCount,
          createdCount: r.createdCount,
          skippedCount: r.skippedCount,
          failedCount: r.failedCount,
          incidentCount: r.incidentCount,
          errorSummary: r.errorSummary,
          metadata: r.metadata,
        })),
      });
    },
  );

  app.get(
    "/v1/governance/destruction-executions",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = z
        .object({
          teamId: z.string().uuid(),
          reviewId: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "governance.policy.read");
      if (!perm.allowed) return denyByPermission(reply, perm.reason);
      const rows = await prisma.destructionExecution.findMany({
        where: {
          teamId: query.teamId,
          ...(query.reviewId ? { destructionReviewId: query.reviewId } : {}),
        },
        orderBy: { plannedAtUtc: "desc" },
        take: Math.min(query.limit ?? 50, 200),
      });
      return reply.code(200).send({
        executions: rows.map((r) => ({
          id: r.id,
          teamId: r.teamId,
          evidenceId: r.evidenceId,
          destructionReviewId: r.destructionReviewId,
          status: r.status,
          phase: r.phase,
          attemptCount: r.attemptCount,
          plannedAtUtc: r.plannedAtUtc.toISOString(),
          startedAtUtc: r.startedAtUtc?.toISOString() ?? null,
          storageDeletedAtUtc: r.storageDeletedAtUtc?.toISOString() ?? null,
          tombstonedAtUtc: r.tombstonedAtUtc?.toISOString() ?? null,
          completedAtUtc: r.completedAtUtc?.toISOString() ?? null,
          failedAtUtc: r.failedAtUtc?.toISOString() ?? null,
          rolledBackAtUtc: r.rolledBackAtUtc?.toISOString() ?? null,
          certificateHash: r.certificateHash,
          lineageHash: r.lineageHash,
          errorCode: r.errorCode,
          errorDetail: r.errorDetail,
        })),
      });
    },
  );

  app.get(
    "/v1/governance/immutable-storage-checks",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = z
        .object({
          teamId: z.string().uuid(),
          evidenceId: z.string().uuid().optional(),
          driftOnly: z.coerce.boolean().optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "governance.policy.read");
      if (!perm.allowed) return denyByPermission(reply, perm.reason);
      const rows = await prisma.immutableStorageCheck.findMany({
        where: {
          teamId: query.teamId,
          ...(query.evidenceId ? { evidenceId: query.evidenceId } : {}),
          ...(query.driftOnly
            ? {
                outcome: {
                  in: [
                    "MISSING_LOCK",
                    "RETENTION_MISMATCH",
                    "LEGAL_HOLD_MISMATCH",
                    "COMPLIANCE_MODE_MISMATCH",
                  ],
                },
              }
            : {}),
        },
        orderBy: { checkedAtUtc: "desc" },
        take: Math.min(query.limit ?? 100, 500),
      });
      return reply.code(200).send({
        checks: rows.map((r) => ({
          id: r.id,
          teamId: r.teamId,
          evidenceId: r.evidenceId,
          outcome: r.outcome,
          checkedAtUtc: r.checkedAtUtc.toISOString(),
          dbRetentionUntilUtc: r.dbRetentionUntilUtc?.toISOString() ?? null,
          dbLegalHoldActive: r.dbLegalHoldActive,
          dbImmutable: r.dbImmutable,
          storageRetainUntilUtc: r.storageRetainUntilUtc?.toISOString() ?? null,
          storageLegalHoldActive: r.storageLegalHoldActive,
          storageComplianceMode: r.storageComplianceMode,
          raisedIncidentId: r.raisedIncidentId,
          driftSummary: r.driftSummary,
        })),
      });
    },
  );
}
