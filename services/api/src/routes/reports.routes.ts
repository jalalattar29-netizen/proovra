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
  outputActionFor,
  resolveOfferedOutputAction,
  classifyTerminalReason,
  type OutputAction,
  type OutputActionUnavailableReason,
  type OutputTerminalReasonClass,
  projectReportRequestState,
  type EvidenceOutputState,
  type PersistedReportRequestState,
} from "@proovra/shared";
import { resolveEvidenceOutputEligibilityByRecord } from "../services/billing/evidence-output-eligibility.service.js";
import { resolveOutputRecordApplicability } from "../services/evidence-artifact-status.service.js";

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
  /**
   * RELIABILITY CLOSURE (2026-09-09) — the canonical ACTION, projected here so
   * this fallback and the workspace aggregator hand the browser the same
   * answer. Without it the page re-derived a verb from a lossy five-value
   * mapping and offered controls the server would refuse.
   */
  outputs: {
    report: UserReportOutputProjection;
    verificationPackage: UserReportOutputProjection;
  };
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

type UserReportOutputProjection = {
  state: EvidenceOutputState;
  action: OutputAction;
  /** P2-1 — why the verb was withdrawn on a state that would carry one. */
  actionUnavailableReason: OutputActionUnavailableReason | null;
  terminalReasonClass: OutputTerminalReasonClass | null;
  downloadable: boolean;
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
        /**
         * P2-2 CLOSURE (2026-09-10) — the record's OWN commercial subject.
         *
         * This route can return rows from several workspaces at once (it
         * matches on ownership OR any active membership), and it resolved
         * every one of them against the CALLER'S personal plan. The subject of
         * a record is the workspace that holds it, so the workspace travels
         * with the row and the eligibility is grouped by it below.
         */
        ownerUserId: string;
        teamId: string | null;
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
            // P2-2 — the record's own commercial subject travels with the row.
            ownerUserId: true,
            teamId: true,
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
            // P2-2 — required on BOTH branches: the fallback select is what a
            // deployment without `deleted_at` actually runs, and eligibility
            // must be resolved against the record's subject there too.
            ownerUserId: true,
            teamId: true,
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
            // The terminal CLASS decides whether an action exists, so the
            // bounded code has to travel with the state. Never projected raw.
            select: {
              evidenceId: true,
              state: true,
              terminalReasonCode: true,
            },
          })
          .catch(() => []),
        /*
         * P2-2 CLOSURE (2026-09-10) — PER-RECORD COMMERCIAL SUBJECT.
         *
         * This passed `{ ownerUserId: caller, teamId: null }`, i.e. the
         * CALLER'S PERSONAL PLAN, and applied it to every row on the page. But
         * `accessClause` above matches rows the caller owns OR rows in ANY
         * workspace they are an active member of, so a Free-plan user reading
         * this fallback saw their Team workspace's records reported as "not
         * included" — a commercial verdict taken from the reader rather than
         * from the record.
         *
         * The rows carry their own `ownerUserId`/`teamId` now, and the
         * canonical resolver groups by that subject: one plan resolution per
         * distinct subject on the page, no N+1, no second calculation here.
         */
        resolveEvidenceOutputEligibilityByRecord(
          pageRows.map((r) => ({
            id: r.id,
            ownerUserId: r.ownerUserId,
            teamId: r.teamId ?? null,
          })),
        ).catch(() => new Map()),
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
        // P1-3 — the record axis, from the ONE status mapping.
        const record = resolveOutputRecordApplicability(r.status);
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
          record,
        });
        const packageLifecycle = deriveEvidenceOutputState({
          eligibility: eligibility?.packageEligibility ?? "ELIGIBLE",
          generation,
          availability: pkg !== null ? "READY" : "NO_ARTIFACT",
          record,
        });
        /*
         * RELIABILITY CLOSURE (2026-09-09) — THE ACTION TRAVELS WITH THE STATE.
         *
         * This route already derives the canonical lifecycle; it stopped one
         * step short of the thing a surface actually needs, so the browser
         * re-derived a verb from a lossy five-value mapping and offered
         * Generate on BLOCKED records and Retry on terminals nothing reopens.
         *
         * Projecting it here costs one call to the same pure authority the
         * workspace aggregator and Evidence Detail use, and it is what makes
         * "the same record shows the same action on every surface" true rather
         * than intended.
         */
        const terminalReasonClass =
          generation === "TERMINAL_FAILURE"
            ? classifyTerminalReason(request?.terminalReasonCode ?? null)
            : null;
        return {
          reportLifecycle,
          packageLifecycle,
          outputs: {
            report: {
              state: reportLifecycle,
              /*
               * P2-1 (2026-09-10) — the verb is withdrawn for a record whose
               * workspace cannot be resolved. This fallback lists those records
               * too, so the rule has to be applied here as well.
               */
              ...resolveOfferedOutputAction({
                action: outputActionFor({
                  state: reportLifecycle,
                  eligibility: eligibility?.reportEligibility ?? "ELIGIBLE",
                  terminalReasonClass,
                }),
                workspaceResolved: Boolean(r.teamId),
              }),
              terminalReasonClass,
              downloadable: report !== null,
            },
            verificationPackage: {
              state: packageLifecycle,
              ...resolveOfferedOutputAction({
                action: outputActionFor({
                  state: packageLifecycle,
                  eligibility: eligibility?.packageEligibility ?? "ELIGIBLE",
                  terminalReasonClass,
                }),
                workspaceResolved: Boolean(r.teamId),
              }),
              terminalReasonClass,
              downloadable: pkg !== null,
            },
          },
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
