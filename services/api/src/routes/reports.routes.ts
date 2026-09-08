/**
 * Phase IA-self-serve-regression-fix — user-scoped reports list.
 *
 *   GET /v1/reports
 *
 * The pre-existing `GET /v1/reports/artifacts?teamId=<uuid>` is a
 * workspace-scoped aggregator that hard-fails with 404 if the caller
 * is not an ACTIVE TeamMember of the supplied teamId. Self-serve
 * users on a PERSONAL workspace sometimes don't carry that
 * membership row, so the Reports page renders empty even when the
 * user owns evidence with generated reports.
 *
 * This endpoint is the safety-net list: scoped to the authenticated
 * user via evidence ownership AND active team membership, it returns
 * every Report row the user can access — independent of the
 * "currently active" workspace selection.
 *
 * Hard safety rules (mirroring the operator brief):
 *   * NEVER exposes another user's reports.
 *   * NEVER exposes reports for soft-deleted evidence (`deletedAt` is
 *     populated → row is excluded).
 *   * NEVER changes the evidence-status filter — same SIGNED/REPORTED
 *     window the aggregator uses, so this endpoint never widens the
 *     visibility surface.
 *   * NEVER mints download URLs — the per-row download still flows
 *     through the existing `/v1/evidence/:id/report/latest` and
 *     `/v1/evidence/:id/verification-package` endpoints, which carry
 *     the canonical governance + retention gates.
 *
 * The response is intentionally a strict subset of the artifact
 * envelope so a downstream UI can render it without re-deriving
 * complex enums. Bounded pagination via cursor.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { getAuthUserId } from "../auth.js";
import { requireAuth } from "../middleware/auth.js";
import { prisma } from "../db.js";
// COMMERCIAL + OUTPUT LIFECYCLE CLOSURE (2026-09-08) — the shared state machine
// and the record-aware eligibility resolver, so this fallback and the workspace
// aggregator cannot describe the same record differently.
import {
  deriveEvidenceOutputState,
  projectReportRequestState,
  type EvidenceOutputState,
  type PersistedReportRequestState,
} from "@proovra/shared";
import { resolveEvidenceOutputEligibilityMany } from "../services/billing/evidence-output-eligibility.service.js";

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(512).optional(),
  // Optional workspace filter — the self-serve Home dashboard passes
  // the active workspace id so the counter set (evidence / cases /
  // reports) stays scoped to ONE workspace. Without it, the endpoint
  // returns every report the caller can access across all teams, which
  // breaks counter consistency on Home.
  teamId: z.string().uuid().optional(),
});

type CursorShape = { c: string; i: string };

function decodeCursor(raw: string | undefined): CursorShape | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64").toString("utf8"),
    ) as Partial<CursorShape>;
    if (typeof parsed.c === "string" && typeof parsed.i === "string") {
      return { c: parsed.c, i: parsed.i };
    }
    return null;
  } catch {
    return null;
  }
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ c: createdAt.toISOString(), i: id }),
  ).toString("base64");
}

export type UserReportRow = {
  evidenceId: string;
  title: string | null;
  /**
   * Inputs to the canonical Evidence title cascade. A record whose name lives
   * only in a filename field rendered as "Untitled evidence" without them.
   */
  displayFileName: string | null;
  originalFileName: string | null;
  mimeType: string | null;
  type: string;
  status: string;
  caseId: string | null;
  createdAt: string;
  /**
   * COMMERCIAL + OUTPUT LIFECYCLE CLOSURE (2026-09-08) — the canonical output
   * state, so this fallback and the workspace aggregator describe a record the
   * same way. The client renders this and never derives a state from
   * `available`.
   */
  reportLifecycle: EvidenceOutputState;
  packageLifecycle: EvidenceOutputState;
  report: {
    available: boolean;
    version: number | null;
    generatedAtUtc: string | null;
  };
  package: {
    available: boolean;
    version: number | null;
    generatedAtUtc: string | null;
  };
};

export type UserReportsEnvelope = {
  items: UserReportRow[];
  nextCursor: string | null;
};

export default async function registerReportsRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get(
    "/v1/reports",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = ListQuery.parse(req.query ?? {});
      const userId = getAuthUserId(req);
      const limit = query.limit ?? 50;
      const cursor = decodeCursor(query.cursor);

      // -----------------------------------------------------------------
      // Resolve the set of team workspaces the caller is an ACTIVE
      // member of. The OR with `ownerUserId === userId` covers the
      // self-serve PERSONAL case: when the workspace bootstrap missed
      // the personal-Team membership row, the user still owns their
      // evidence directly and the report shows up via that branch.
      // -----------------------------------------------------------------
      const memberships = await prisma.teamMember.findMany({
        where: { userId, status: "ACTIVE" },
        select: { teamId: true },
      });
      const teamIds = memberships.map((m) => m.teamId);

      // The existing aggregator uses `Record<string, unknown>` for
      // its where-shape so the Prisma enum typing (EvidenceStatus)
      // doesn't fight the static `["SIGNED", "REPORTED"]` literal.
      // Mirror that pattern for consistency.
      //
      // When `teamId` is supplied (Home dashboard case) we scope to a
      // single workspace. The caller must own the row OR be an active
      // member of that workspace — same safety semantics, narrowed.
      let accessClause: Record<string, unknown>;
      if (query.teamId) {
        const scopedTeamId = query.teamId;
        const isMember = teamIds.includes(scopedTeamId);
        // Phase HOME-DATA-OWNERSHIP — when the scoped workspace is the
        // CALLER'S OWN personal team, legacy rows created before the
        // team-id backfill carry `teamId NULL` but are still owned by
        // the caller. Without this arm the Home dashboard (which always
        // passes teamId) showed 0 reports while the user owned hundreds.
        // Bound to ownerUserId === caller, so nothing cross-tenant can
        // ever match.
        const scopedTeam = await prisma.team.findUnique({
          where: { id: scopedTeamId },
          select: { isPersonal: true, ownerUserId: true },
        });
        const isCallersPersonalTeam =
          scopedTeam?.isPersonal === true && scopedTeam.ownerUserId === userId;
        if (isCallersPersonalTeam) {
          accessClause = {
            OR: [
              { teamId: scopedTeamId },
              { AND: [{ ownerUserId: userId }, { teamId: null }] },
            ],
          };
        } else {
          accessClause = {
            AND: [
              { teamId: scopedTeamId },
              isMember
                ? { OR: [{ ownerUserId: userId }, { teamId: scopedTeamId }] }
                : { ownerUserId: userId },
            ],
          };
        }
      } else {
        accessClause = {
          OR: [
            { ownerUserId: userId },
            ...(teamIds.length > 0 ? [{ teamId: { in: teamIds } }] : []),
          ],
        };
      }

      const cursorClause: Record<string, unknown> | null = cursor
        ? {
            OR: [
              { createdAt: { lt: new Date(cursor.c) } },
              {
                createdAt: new Date(cursor.c),
                id: { lt: cursor.i },
              },
            ],
          }
        : null;

      const whereEvidence: Record<string, unknown> = {
        AND: [
          accessClause,
          { status: { in: ["SIGNED", "REPORTED"] } },
          // Soft-delete safety. Schemas without `deletedAt` ignore the
          // clause; rows with `deletedAt` set are excluded.
          { deletedAt: null },
          ...(cursorClause ? [cursorClause] : []),
        ],
      };

      type EvidenceListRow = {
        id: string;
        title: string | null;
        displayFileName: string | null;
        originalFileName: string | null;
        mimeType: string | null;
        type: string;
        status: string;
        caseLinks: Array<{ caseId: string }>;
        createdAt: Date;
      };
      let rows: EvidenceListRow[] = [];
      try {
        rows = (await prisma.evidence.findMany({
          where: whereEvidence as never,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit + 1,
          select: {
            id: true,
            title: true,
            displayFileName: true,
            originalFileName: true,
            mimeType: true,
            type: true,
            status: true,
            caseLinks: {
              orderBy: { linkedAtUtc: "asc" },
              select: { caseId: true },
              take: 1,
            },
            createdAt: true,
          },
        })) as EvidenceListRow[];
      } catch {
        // The `deletedAt` column may not exist on every deployment;
        // retry without the clause. Other failures bubble up as 500.
        const fallbackWhere: Record<string, unknown> = {
          AND: [
            accessClause,
            { status: { in: ["SIGNED", "REPORTED"] } },
            ...(cursorClause ? [cursorClause] : []),
          ],
        };
        rows = (await prisma.evidence.findMany({
          where: fallbackWhere as never,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit + 1,
          select: {
            id: true,
            title: true,
            type: true,
            status: true,
            caseLinks: {
              orderBy: { linkedAtUtc: "asc" },
              select: { caseId: true },
              take: 1,
            },
            createdAt: true,
          },
        })) as EvidenceListRow[];
      }

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;

      if (pageRows.length === 0) {
        const envelope: UserReportsEnvelope = { items: [], nextCursor: null };
        return reply.code(200).send(envelope);
      }

      const evidenceIds = pageRows.map((r) => r.id);
      const [reportRows, packageRows, requestRows, eligibilityByEvidence] =
        await Promise.all([
        prisma.report.findMany({
          where: { evidenceId: { in: evidenceIds } },
          orderBy: [{ evidenceId: "asc" }, { version: "desc" }],
          distinct: ["evidenceId"],
          select: {
            evidenceId: true,
            version: true,
            generatedAtUtc: true,
          },
        }),
        prisma.verificationPackage.findMany({
          where: { evidenceId: { in: evidenceIds } },
          orderBy: [{ evidenceId: "asc" }, { version: "desc" }],
          distinct: ["evidenceId"],
          select: {
            evidenceId: true,
            version: true,
            generatedAtUtc: true,
          },
        }),
        /*
         * COMMERCIAL + OUTPUT LIFECYCLE CLOSURE (2026-09-08) — this fallback
         * projected only `available`, and the Reports page turned the absence
         * into `not_requested`. So a Free record read "Report not requested"
         * here and "Report generating — refresh later" through the workspace
         * aggregator: two surfaces, two invented answers, neither of them the
         * state. The lifecycle is projected here too, from the same axes.
         */
        prisma.reportGenerationRequest
          .findMany({
            where: { evidenceId: { in: evidenceIds } },
            orderBy: [{ evidenceId: "asc" }, { createdAtUtc: "desc" }],
            distinct: ["evidenceId"],
            select: { evidenceId: true, state: true },
          })
          .catch(() => []),
        resolveEvidenceOutputEligibilityMany({
          evidenceIds,
          // The user-scoped fallback is by evidence OWNERSHIP, so the personal
          // subject is the caller.
          ownerUserId: userId,
          teamId: null,
        }).catch(() => new Map()),
      ]);

      const reportByEvidence = new Map(
        reportRows.map((r) => [r.evidenceId, r]),
      );
      const packageByEvidence = new Map(
        packageRows.map((p) => [p.evidenceId, p]),
      );
      const requestByEvidence = new Map(
        requestRows.map((q) => [q.evidenceId, q]),
      );

      const items: UserReportRow[] = pageRows.map((r) => {
        const report = reportByEvidence.get(r.id) ?? null;
        const pkg = packageByEvidence.get(r.id) ?? null;
        const finalized = r.status === "SIGNED" || r.status === "REPORTED";
        const request = requestByEvidence.get(r.id) ?? null;
        const eligibility = eligibilityByEvidence.get(r.id) ?? null;
        const generation = request
          ? projectReportRequestState(
              request.state as PersistedReportRequestState,
            )
          : "NOT_REQUESTED";
        const reportLifecycle = deriveEvidenceOutputState({
          eligibility: eligibility?.reportEligibility ?? "ELIGIBLE",
          generation,
          availability: report !== null ? "READY" : "NO_ARTIFACT",
          finalized,
        });
        const packageLifecycle = deriveEvidenceOutputState({
          eligibility: eligibility?.packageEligibility ?? "ELIGIBLE",
          generation,
          availability: pkg !== null ? "READY" : "NO_ARTIFACT",
          finalized,
        });
        return {
          reportLifecycle,
          packageLifecycle,
          evidenceId: r.id,
          title: r.title,
          displayFileName: r.displayFileName ?? null,
          originalFileName: r.originalFileName ?? null,
          mimeType: r.mimeType ?? null,
          type: String(r.type),
          status: String(r.status),
          caseId: r.caseLinks[0]?.caseId ?? null,
          createdAt: r.createdAt.toISOString(),
          report: {
            available: report !== null,
            version: report?.version ?? null,
            generatedAtUtc: report?.generatedAtUtc?.toISOString() ?? null,
          },
          package: {
            available: pkg !== null,
            version: pkg?.version ?? null,
            generatedAtUtc: pkg?.generatedAtUtc?.toISOString() ?? null,
          },
        };
      });

      const lastRow = pageRows[pageRows.length - 1]!;
      const envelope: UserReportsEnvelope = {
        items,
        nextCursor: hasMore ? encodeCursor(lastRow.createdAt, lastRow.id) : null,
      };
      return reply.code(200).send(envelope);
    },
  );
}
