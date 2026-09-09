/**
 * Phase 32.8D — Reports & Artifacts aggregator service.
 *
 * Read-only aggregator that powers the new enterprise /reports
 * page. Returns workspace-scoped artifacts (reports + verification
 * packages) joined to evidence metadata. Same partial-failure-
 * tolerant envelope pattern as the Phase 32.8C Command Center.
 *
 * Hard rules:
 *   - READ ONLY. Never calls write methods, never emits audit /
 *     custody events, never generates signed URLs, never marks
 *     a package "viewed", never triggers report or package
 *     generation. Browsing the /reports list MUST be free of
 *     side effects per Phase 32.8D Task B4.
 *   - NEVER returns presigned URLs or storage keys. The list
 *     surfaces metadata + lifecycle state only; the explicit
 *     download flow at `/v1/evidence/:id/report/latest` and
 *     `/v1/evidence/:id/verification-package` is the canonical
 *     side-effect-emitting download path.
 *   - Bounded queries. Default limit 25, max 100.
 *   - Per-section try/catch — the summary may be `unavailable`
 *     while the artifact list still renders.
 */

import type { Prisma } from "@prisma/client";

import { evidenceIntakeIdentityArms } from "../search/intake-identity-search.js";
import { prisma } from "../../db.js";
import {
  workspaceEvidenceWhere,
  type WorkspaceEvidenceScope,
} from "@proovra/shared-runtime";
// COMMERCIAL + OUTPUT LIFECYCLE CLOSURE (2026-09-08) — the list derives its
// lifecycle from the SAME shared state machine the per-record projection uses.
import {
  deriveEvidenceOutputState,
  // RELIABILITY CLOSURE (2026-09-09) — the canonical action and terminal class,
  // projected by the server so the Reports page derives neither.
  outputActionFor,
  classifyTerminalReason,
  type OutputAction,
  type OutputTerminalReasonClass,
  projectReportRequestState,
  type EvidenceOutputState,
  type OutputGenerationState,
  type PersistedReportRequestState,
} from "@proovra/shared";
import { resolveEvidenceOutputEligibilityMany } from "../billing/evidence-output-eligibility.service.js";

/** `skipped` = the caller did not ask for it. NOT a failure. */
export type SectionStatus = "ok" | "degraded" | "unavailable" | "skipped";

export type ReportLifecycle =
  | "not_requested"
  | "pending"
  | "ready"
  | "failed"
  | "unavailable";

export type PackageLifecycle =
  | "not_requested"
  | "pending"
  | "ready"
  | "blocked"
  | "failed"
  | "unavailable";

/**
 * Phase 6 — template-identity provenance trio. Surfaced for downstream
 * traceability ONLY; never drives policy. All three fields are
 * nullable because legacy rows (pre-Phase T) carry NULL on the
 * underlying Evidence columns.
 */
export type TemplateProvenance = {
  templateSlug: string | null;
  templateVersion: number | null;
  templateDbId: string | null;
};

export type ArtifactRow = {
  evidenceId: string;
  /**
   * The record's stored title, VERBATIM — `null` when there is none.
   *
   * It used to be coerced to the literal "Untitled evidence" here, which is
   * why the Reports queue was a wall of that phrase for records that have a
   * perfectly good name in `displayFileName` / `originalFileName`. A capture
   * or an intake upload frequently stores the name there and leaves `title`
   * null; the Evidence Library has always resolved those through its title
   * cascade, and this aggregator was the one surface that did not.
   *
   * The substitution is gone. The fields the cascade needs travel with the
   * row, and the CLIENT resolves the display name through the same
   * `getDisplayTitle` every other list uses — one cascade, not a second one
   * written here.
   */
  title: string | null;
  /** For the title cascade. Never a fallback on their own. */
  displayFileName: string | null;
  originalFileName: string | null;
  mimeType: string | null;
  type: string;
  status: string;
  verificationStatus: string | null;
  caseId: string | null;
  /** The linked case's name, for display. Null only when it has none. */
  caseTitle: string | null;
  /**
   * The organization's own customer identifier, snapshotted from the intake
   * link. Searchable (see the `OR` in the where clause) and therefore
   * projected: a row that came back because someone searched CUST-849271 has
   * to be able to show why. Null for everything not acquired through intake.
   */
  intakeCustomerId: string | null;
  createdAt: string;
  /** Report lifecycle (bounded enum, never raw enum values). */
  report: {
    state: ReportLifecycle;
    version: number | null;
    generatedAtUtc: string | null;
  };
  /** Verification package lifecycle. */
  package: {
    state: PackageLifecycle;
    version: number | null;
    generatedAtUtc: string | null;
    blockedReason: string | null;
  };
  /**
   * RELIABILITY CLOSURE (2026-09-09) — THE CANONICAL OUTPUT PROJECTION, SO THE
   * REPORTS PAGE STOPS BEING A SECOND ACTION AUTHORITY.
   *
   * The two blocks above are the legacy five-value vocabulary, and they are
   * RETAINED because existing consumers read them. What they cannot carry is an
   * ACTION: the browser re-derived one from them, and the mapping is lossy in
   * exactly the places that matter.
   *
   *   * `BLOCKED` collapses into `not_requested`, so the page offered
   *     "Generate report & package" for a record whose canonical action is
   *     NONE — a button that posts, is refused, and reports success.
   *   * every `TERMINAL_FAILURE` collapses into `failed`, so the page offered
   *     "Retry generation" for integrity and technical terminals that nothing
   *     will reopen, and labelled a now-eligible COMMERCIAL terminal "Retry"
   *     when the canonical verb is GENERATE.
   *
   * This block is the same `deriveEvidenceOutputState` / `outputActionFor`
   * answer that Evidence Detail renders, projected once by the server. The
   * browser renders `action`; it derives nothing.
   */
  outputs: {
    report: {
      state: EvidenceOutputState;
      action: OutputAction;
      terminalReasonClass: OutputTerminalReasonClass | null;
      /** An artifact exists and may be opened, whatever the current request says. */
      downloadable: boolean;
    };
    verificationPackage: {
      state: EvidenceOutputState;
      action: OutputAction;
      terminalReasonClass: OutputTerminalReasonClass | null;
      downloadable: boolean;
    };
  };
  /**
   * Phase 6 — workflow-template provenance trio. Surfaced as part of
   * the report/package envelope for downstream traceability. NULL
   * trio members on legacy rows are surfaced as-is.
   */
  provenance: TemplateProvenance;
};

export type ReportsArtifactsEnvelope = {
  generatedAt: string;
  workspace: { id: string; role: string };
  sections: {
    summary: {
      status: SectionStatus;
      data: {
        reportsReady: number;
        reportsPending: number;
        packagesReady: number;
        packagesPending: number;
        packagesBlocked: number;
        totalEvidenceWithArtifacts: number;
      } | null;
    };
    artifacts: {
      status: SectionStatus;
      items: ArtifactRow[];
      nextCursor: string | null;
      /**
       * Rows matching the CURRENT query across the whole workspace — not the
       * length of this page. Null only when the list itself failed.
       */
      total: number | null;
    };
  };
};

// ---------------------------------------------------------------------------
// Bounded limits
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export type ReportLifecycleFilter =
  | "all"
  | "report_ready"
  | "report_pending"
  | "report_failed"
  | "package_ready"
  | "package_pending"
  | "package_blocked";

// ---------------------------------------------------------------------------
// Lifecycle mapping (mirror of Phase 32.6.x artifact-status semantics)
// ---------------------------------------------------------------------------

/**
 * COMMERCIAL + OUTPUT LIFECYCLE CLOSURE (2026-09-08) — the list lifecycle is
 * now the SAME derivation the per-record projection uses.
 *
 * What these two functions used to do: `reportAvailable ? "ready" : finalized ?
 * "pending" : "not_requested"`. Absence meant pending, with no commercial input
 * and no reference to whether generation had ever been requested. Three
 * consequences, all of them live in production:
 *
 *   * every finalized record on a plan without reports read "pending" forever,
 *     and the Reports page told the customer "Report generating — refresh
 *     later" for the life of the record;
 *   * `"failed"` was unreachable, so the page's `Retry generation` control —
 *     gated on exactly that state — had never rendered for anybody;
 *   * `"unavailable"` was declared and unreachable too, so the page had no way
 *     to say the honest thing.
 *
 * They now take the canonical three axes and delegate to
 * `deriveEvidenceOutputState`, so a row in the list and the same record's
 * detail page cannot disagree.
 */
function toReportLifecycle(state: EvidenceOutputState): ReportLifecycle {
  switch (state) {
    case "READY":
      return "ready";
    case "QUEUED":
    case "GENERATING":
      return "pending";
    case "RETRYABLE_FAILURE":
    case "TERMINAL_FAILURE":
      return "failed";
    case "NOT_INCLUDED":
      return "unavailable";
    case "ELIGIBLE_NOT_GENERATED":
    case "BLOCKED":
      return "not_requested";
  }
}

function toPackageLifecycle(
  state: EvidenceOutputState,
  blocked: boolean,
): PackageLifecycle {
  if (blocked && state !== "READY") return "blocked";
  switch (state) {
    case "READY":
      return "ready";
    case "QUEUED":
    case "GENERATING":
      return "pending";
    case "RETRYABLE_FAILURE":
    case "TERMINAL_FAILURE":
      return "failed";
    case "NOT_INCLUDED":
      return "unavailable";
    case "ELIGIBLE_NOT_GENERATED":
    case "BLOCKED":
      return "not_requested";
  }
}

function readPackageBlocked(metadata: unknown): {
  blocked: boolean;
  reason: string | null;
} {
  if (metadata == null || typeof metadata !== "object") {
    return { blocked: false, reason: null };
  }
  const obj = metadata as Record<string, unknown>;
  if (obj.blocked !== true) return { blocked: false, reason: null };
  const reason =
    typeof obj.reason === "string"
      ? obj.reason.slice(0, 160)
      : typeof obj.outcome === "string"
        ? obj.outcome.slice(0, 160)
        : null;
  return { blocked: true, reason };
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function listWorkspaceArtifacts(input: {
  teamId: string;
  role: string;
  limit?: number;
  cursor?: string | null;
  lifecycleFilter?: ReportLifecycleFilter;
  search?: string | null;
  caseId?: string | null;
  /**
   * Compute the workspace summary. Defaults to true so existing callers are
   * unchanged; the Reports page passes false for every request after the
   * first, because a filter cannot move a workspace total.
   */
  includeSummary?: boolean;
  /**
   * Whether this caller may match on the raw recipient contact of the intake
   * link behind a record. The same authority that decides whether an address
   * is SHOWN decides whether it can be searched for — otherwise the search box
   * answers "is this address in this workspace?" for someone who may not see it.
   */
  matchRecipientContact?: boolean;
}): Promise<ReportsArtifactsEnvelope> {
  const limit = Math.min(
    Math.max(input.limit ?? DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );

  // WORKSPACE-SCOPE CONVERGENCE — resolve the canonical population ONCE, and
  // use the SAME value for the summary counts and the artifact rows below.
  //
  // Two defects closed by one change. The first is the personal omission: a
  // strict `teamId` equality misses a personal workspace's legacy NULL-team
  // Evidence, so this page reported fewer reports and packages than the
  // workspace actually had. The second is DIVERGENCE — the summary and the
  // list each built their own filter, so even once one of them was corrected
  // the other could still disagree, and a header that contradicts the rows
  // beneath it is a worse failure than a wrong number in both.
  //
  // Resolved outside the two try/catch blocks deliberately: if the scope
  // itself cannot be resolved, neither section may fall back to a strict
  // filter and report a confident smaller number. Both degrade instead.
  const scope: WorkspaceEvidenceScope = await workspaceEvidenceWhere(input.teamId, prisma);

  // ----------- Summary counts (workspace-level) -----------
  //
  // SKIPPABLE, and that is the performance fix.
  //
  // These are WORKSPACE totals: six aggregate counts over the whole
  // population, unaffected by the page, the search or the lifecycle filter.
  // They were recomputed on EVERY list request, so each filter click and each
  // debounced keystroke paid for six aggregations it could not change — which
  // is what made changing a filter feel like a page load.
  //
  // The caller fetches them once per workspace and asks for
  // `includeSummary: false` on every subsequent list query. The section is
  // then reported `skipped`, which the client distinguishes from
  // `unavailable`: one means "you did not ask", the other means "it failed".
  let summary: ReportsArtifactsEnvelope["sections"]["summary"] = {
    status: "unavailable",
    data: null,
  };
  if (input.includeSummary === false) {
    summary = { status: "skipped", data: null };
  } else {
  try {
    const [
      reportsReady,
      reportsPendingCandidates,
      packagesReady,
      packagesPendingCandidates,
      packagesBlockedCount,
      totalEvidenceWithArtifacts,
    ] = await Promise.all([
      prisma.evidence.count({
        where: { AND: [scope, { status: "REPORTED" }] },
      }),
      prisma.evidence.count({
        where: { AND: [scope, { status: "SIGNED" }] },
      }),
      prisma.verificationPackage.count({
        where: { evidence: scope },
      }),
      prisma.evidence.count({
        where: {
          AND: [
            scope,
            {
              status: { in: ["SIGNED", "REPORTED"] },
              verificationPackages: { none: {} },
            },
          ],
        },
      }),
      // Packages where the gate-denial metadata indicates `blocked: true`.
      // Prisma doesn't support a JSON `blocked === true` predicate at the
      // count level on all versions; we read a bounded sample then count
      // the blocked flag client-side.
      prisma.evidence
        .findMany({
          where: {
            AND: [
              scope,
              {
                status: { in: ["SIGNED", "REPORTED"] },
                verificationPackageMetadata: {
                  not: null as unknown as undefined,
                },
              },
            ],
          },
          take: 500,
          select: { verificationPackageMetadata: true },
        })
        .then((rows) => {
          let n = 0;
          for (const row of rows) {
            const { blocked } = readPackageBlocked(
              row.verificationPackageMetadata,
            );
            if (blocked) n += 1;
          }
          return n;
        })
        .catch(() => 0),
      prisma.evidence.count({
        where: {
          AND: [scope, { status: { in: ["SIGNED", "REPORTED"] } }],
        },
      }),
    ]);
    summary = {
      status: "ok",
      data: {
        reportsReady,
        reportsPending: Math.max(0, reportsPendingCandidates - reportsReady),
        packagesReady,
        packagesPending: packagesPendingCandidates,
        packagesBlocked: packagesBlockedCount,
        totalEvidenceWithArtifacts,
      },
    };
  } catch {
    summary = { status: "unavailable", data: null };
  }
  }

  // ----------- Artifact rows -----------
  let artifacts: ReportsArtifactsEnvelope["sections"]["artifacts"] = {
    status: "unavailable",
    items: [],
    nextCursor: null,
    total: null,
  };
  try {
    // Typed as a Prisma filter rather than `Record<string, unknown>` so the
    // canonical scope cannot be dropped from it without the compiler noticing.
    const whereBase: Prisma.EvidenceWhereInput = {
      // The SAME `scope` the summary above counted through. The list and the
      // header are now population-identical by construction, not by two edits
      // that happen to agree.
      AND: [scope],
      status: { in: ["SIGNED", "REPORTED"] },
    };
    if (input.caseId) whereBase.caseLinks = { some: { caseId: input.caseId } };
    // The filter narrows the QUERY, so pagination, the total and the page all
    // describe the same population.
    const lifecycleClause = await lifecycleWhere(input.lifecycleFilter ?? "all");
    if (lifecycleClause) {
      (whereBase.AND as Prisma.EvidenceWhereInput[]).push(lifecycleClause);
    }
    if (input.search && input.search.trim()) {
      // SEARCH THE FIELDS THE TITLE CASCADE READS, not `title` alone.
      //
      // The row's displayed name resolves `title` -> `displayFileName` ->
      // `originalFileName`, because a capture or an intake upload commonly
      // leaves `title` null. Matching only `title` meant a user could read a
      // name on screen, type it, and get nothing back — the search appeared
      // broken precisely for the records whose names had just been fixed.
      const needle = input.search.trim().slice(0, 80);
      const like = { contains: needle, mode: "insensitive" as const };
      whereBase.OR = [
        { title: like },
        { displayFileName: like },
        { originalFileName: like },
        /*
         * EXTERNAL INTAKE IDENTITY. This aggregator is a projection over
         * Evidence, so the same arms the evidence list uses apply here
         * unchanged — an operator who found the record by a customer number
         * or a recipient's address can find its deliverables the same way.
         *
         * Reports are NOT given their own copy of the recipient data to make
         * this work. There is a 1:1 relation through a unique key; a second
         * table holding the same contact details would be a second place a
         * disclosure decision has to be got right.
         */
        ...evidenceIntakeIdentityArms(needle, {
          matchRecipientContact: input.matchRecipientContact === true,
        }),
      ];
    }
    // Cursor — opaque, last (createdAt, id) pair, base64-encoded JSON.
    let cursorFilter: Prisma.EvidenceWhereInput | null = null;
    if (input.cursor) {
      try {
        const parsed = JSON.parse(
          Buffer.from(input.cursor, "base64").toString("utf8"),
        ) as { c?: string; i?: string };
        if (parsed.c && parsed.i) {
          cursorFilter = {
            OR: [
              { createdAt: { lt: new Date(parsed.c) } },
              {
                createdAt: new Date(parsed.c),
                id: { lt: parsed.i },
              },
            ],
          };
        }
      } catch {
        // ignore malformed cursor — start from the beginning.
      }
    }

    const rows = await prisma.evidence.findMany({
      where: cursorFilter ? { AND: [whereBase, cursorFilter] } : whereBase,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: {
        id: true,
        title: true,
        // The title cascade's inputs. Presentation data only — nothing here
        // decides lifecycle, permission or eligibility.
        displayFileName: true,
        originalFileName: true,
        mimeType: true,
        type: true,
        status: true,
        verificationStatus: true,
        intakeCustomerId: true,
        // The case NAME travels with the link, in this one query. Selecting
        // only the identifier is what forced the row to render "Case #f2b146"
        // to a human, and fetching the name per row would have been an N+1.
        caseLinks: {
          orderBy: { linkedAtUtc: "asc" },
          select: { caseId: true, case: { select: { name: true } } },
          take: 1,
        },
        createdAt: true,
        verificationPackageMetadata: true,
        // Phase 6 — template provenance trio surfaced on the
        // report/package envelope for downstream traceability.
        // Identity-only; never drives lifecycle.
        templateSlug: true,
        templateVersion: true,
        templateDbId: true,
      },
    });

    // THE TOTAL FOR THIS QUERY.
    //
    // `Artifacts · 25` was the length of the page, so a workspace with 278
    // reports advertised 25 of them and offered no way to reach the rest. The
    // count runs against the SAME `whereBase` the page came from — including
    // the search and the lifecycle clause — so the header, the pagination and
    // the rows all describe one population.
    const total = await prisma.evidence.count({
      where: cursorFilter ? { AND: [whereBase] } : whereBase,
    });

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    const nextCursor =
      hasMore && pageRows.length > 0
        ? Buffer.from(
            JSON.stringify({
              c: pageRows[pageRows.length - 1].createdAt.toISOString(),
              i: pageRows[pageRows.length - 1].id,
            }),
          ).toString("base64")
        : null;

    if (pageRows.length === 0) {
      artifacts = { status: "ok", items: [], nextCursor: null, total };
    } else {
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
         * AXIS 2 for the page, in ONE query. The newest durable generation
         * request per record is what makes `failed` reachable at all — the
         * derivation could not return it before, and the page's own retry
         * control was gated on it.
         */
        /*
         * WRAPPED IN AN ASYNC IIFE, NOT `.catch()`.
         *
         * `.catch()` only handles a REJECTION. A missing or unavailable Prisma
         * delegate throws SYNCHRONOUSLY at the property access, before any
         * promise exists, so the throw escapes past the handler and takes the
         * whole artifact list with it — the page would render "unavailable"
         * rather than degrading one axis. These two reads are enrichment: the
         * list must survive losing either of them.
         */
        (async () => {
          try {
            return await prisma.reportGenerationRequest.findMany({
              where: { evidenceId: { in: evidenceIds } },
              orderBy: [{ evidenceId: "asc" }, { createdAtUtc: "desc" }],
              distinct: ["evidenceId"],
              // The terminal CLASS decides whether an action exists, so the
              // code has to travel with the state. It is never projected raw.
              select: {
                evidenceId: true,
                state: true,
                terminalReasonCode: true,
              },
            });
          } catch {
            return [] as Array<{
              evidenceId: string;
              state: string;
              terminalReasonCode: string | null;
            }>;
          }
        })(),
        /*
         * AXIS 1 for the page. One scope resolution and one ledger read for
         * the whole page — never per row.
         */
        (async () => {
          try {
            return await resolveEvidenceOutputEligibilityMany({
              evidenceIds,
              // Workspace-scoped list: the commercial subject is the
              // workspace, and the by-team branch resolves it from the
              // workspace row.
              teamId: input.teamId,
            });
          } catch {
            return new Map<
              string,
              Awaited<ReturnType<typeof resolveEvidenceOutputEligibilityMany>> extends Map<
                string,
                infer V
              >
                ? V
                : never
            >();
          }
        })(),
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

      const items: ArtifactRow[] = pageRows.map((r) => {
        const report = reportByEvidence.get(r.id) ?? null;
        const pkg = packageByEvidence.get(r.id) ?? null;
        const { blocked, reason } = readPackageBlocked(
          r.verificationPackageMetadata,
        );
        const finalized = r.status === "SIGNED" || r.status === "REPORTED";
        const eligibility = eligibilityByEvidence.get(r.id) ?? null;
        const request = requestByEvidence.get(r.id) ?? null;
        const generation: OutputGenerationState = request
          ? projectReportRequestState(
              request.state as PersistedReportRequestState,
            )
          : "NOT_REQUESTED";

        const reportCanonicalState = deriveEvidenceOutputState({
          eligibility: eligibility?.reportEligibility ?? "ELIGIBLE",
          generation,
          availability: report !== null ? "READY" : "NO_ARTIFACT",
          finalized,
        });
        const packageCanonicalState = deriveEvidenceOutputState({
          eligibility: eligibility?.packageEligibility ?? "ELIGIBLE",
          generation: blocked ? "BLOCKED" : generation,
          availability: pkg !== null ? "READY" : "NO_ARTIFACT",
          finalized,
        });
        const terminalReasonClass =
          generation === "TERMINAL_FAILURE"
            ? classifyTerminalReason(request?.terminalReasonCode ?? null)
            : null;
        const reportState = toReportLifecycle(reportCanonicalState);
        const packageState = toPackageLifecycle(packageCanonicalState, blocked);
        return {
          evidenceId: r.id,
          title: r.title ?? null,
          displayFileName: r.displayFileName ?? null,
          originalFileName: r.originalFileName ?? null,
          mimeType: r.mimeType ?? null,
          type: String(r.type),
          status: String(r.status),
          verificationStatus: r.verificationStatus
            ? String(r.verificationStatus)
            : null,
          caseId: r.caseLinks[0]?.caseId ?? null,
          // Null when a legacy row genuinely has no name; the client falls
          // back to the short id only then.
          caseTitle: r.caseLinks[0]?.case?.name?.trim() || null,
          intakeCustomerId: r.intakeCustomerId ?? null,
          createdAt: r.createdAt.toISOString(),
          report: {
            state: reportState,
            version: report?.version ?? null,
            generatedAtUtc: report?.generatedAtUtc?.toISOString() ?? null,
          },
          package: {
            state: packageState,
            version: pkg?.version ?? null,
            generatedAtUtc: pkg?.generatedAtUtc?.toISOString() ?? null,
            blockedReason: reason,
          },
          // The canonical projection, so the browser renders an action rather
          // than inferring one from the lossy vocabulary above.
          outputs: {
            report: {
              state: reportCanonicalState,
              action: outputActionFor({
                state: reportCanonicalState,
                eligibility: eligibility?.reportEligibility ?? "ELIGIBLE",
                terminalReasonClass,
              }),
              terminalReasonClass,
              downloadable: report !== null,
            },
            verificationPackage: {
              state: packageCanonicalState,
              action: outputActionFor({
                state: packageCanonicalState,
                eligibility: eligibility?.packageEligibility ?? "ELIGIBLE",
                terminalReasonClass:
                  packageCanonicalState === "TERMINAL_FAILURE"
                    ? terminalReasonClass
                    : null,
              }),
              terminalReasonClass:
                packageCanonicalState === "TERMINAL_FAILURE"
                  ? terminalReasonClass
                  : null,
              downloadable: pkg !== null,
            },
          },
          // Phase 6 — surface template-identity trio in the envelope.
          // Identity propagation only; legacy rows surface NULL.
          provenance: {
            templateSlug: r.templateSlug ?? null,
            templateVersion: r.templateVersion ?? null,
            templateDbId: r.templateDbId ?? null,
          },
        };
      });

      artifacts = {
        status: "ok",
        items,
        nextCursor,
        total,
      };
    }
  } catch {
    artifacts = { status: "unavailable", items: [], nextCursor: null, total: null };
  }

  return {
    generatedAt: new Date().toISOString(),
    workspace: { id: input.teamId, role: input.role },
    sections: { summary, artifacts },
  };
}

/**
 * THE LIFECYCLE FILTER, AS A DATABASE PREDICATE.
 *
 * It used to run in `filterByLifecycle` AFTER pagination, over the 25 rows the
 * page had already fetched. So "Report pending" searched 25 of 278 records: it
 * returned whichever of the newest 25 happened to be pending, called that the
 * answer, and reported a count derived from the same slice. The filter was not
 * slow — it was looking at 9% of the data.
 *
 * The derivations these mirror are `deriveReportState` / `derivePackageState`
 * above, and the mirror is exact BECAUSE the surrounding `whereBase` already
 * pins `status IN (SIGNED, REPORTED)`: within that population "pending" is
 * precisely "no artifact row exists", so `none: {}` is the whole predicate and
 * `not_requested` is unreachable.
 *
 * BLOCKED is the one that cannot be a relation test — it lives in the
 * `verificationPackageMetadata` JSON — so it is expressed as a JSON path
 * filter against the same column `readPackageBlocked` reads.
 */
/**
 * THE GENERATION-REQUEST ARM, AS AN ID SET.
 *
 * `ReportGenerationRequest` carries `evidence_id` as a plain column — there is
 * no Prisma relation from `Evidence`, and adding one would mean a schema
 * change and a foreign key for a read filter. The states are a small closed
 * set and the population is already narrowed to one workspace's finalized
 * records, so a bounded id lookup expresses the same predicate with no
 * migration.
 *
 * Bounded deliberately: a filter is a page of results, not an export, and an
 * unbounded `IN` list is how a filter becomes a table scan.
 */
const LIFECYCLE_REQUEST_ID_SCAN = 5000;

async function evidenceIdsWithRequestState(
  states: readonly string[],
): Promise<string[]> {
  try {
    const rows = await prisma.reportGenerationRequest.findMany({
      where: { state: { in: [...states] } },
      orderBy: { createdAtUtc: "desc" },
      take: LIFECYCLE_REQUEST_ID_SCAN,
      select: { evidenceId: true },
      distinct: ["evidenceId"],
    });
    return rows.map((r) => r.evidenceId);
  } catch {
    return [];
  }
}

async function lifecycleWhere(
  filter: ReportLifecycleFilter,
): Promise<Prisma.EvidenceWhereInput | null> {
  switch (filter) {
    case "all":
      return null;
    case "report_ready":
      return { reports: { some: {} } };
    case "report_pending": {
      /*
       * COMMERCIAL + OUTPUT LIFECYCLE CLOSURE (2026-09-08) — "pending" is no
       * longer "no artifact row". It is "a durable generation request exists
       * and has not finished", which is what the word means and what the
       * derivation now returns. Absence with no request is either
       * `eligible_not_generated` or `unavailable`, and neither is pending.
       */
      const ids = await evidenceIdsWithRequestState(["QUEUED", "PROCESSING"]);
      return { reports: { none: {} }, id: { in: ids } };
    }
    case "report_failed": {
      /*
       * REACHABLE NOW. The note that stood here — "no persisted failure state
       * exists for a report" — was true of the DERIVATION and false of the
       * database: `ReportGenerationRequest` has carried FAILED_RETRYABLE and
       * FAILED_TERMINAL since Point 5, and nothing outside the worker read
       * them. The page's own `Retry generation` control was gated on this
       * state, so it had never rendered for anybody.
       */
      const ids = await evidenceIdsWithRequestState([
        "FAILED_RETRYABLE",
        "FAILED_TERMINAL",
      ]);
      return { reports: { none: {} }, id: { in: ids } };
    }
    case "package_ready":
      return { verificationPackages: { some: {} } };
    case "package_pending": {
      // Same correction as `report_pending`: the package is produced inside
      // the report job, so its pending-ness is that job's request row.
      const ids = await evidenceIdsWithRequestState(["QUEUED", "PROCESSING"]);
      return {
        verificationPackages: { none: {} },
        NOT: { verificationPackageMetadata: { path: ["blocked"], equals: true } },
        id: { in: ids },
      };
    }
    case "package_blocked":
      return {
        verificationPackages: { none: {} },
        verificationPackageMetadata: { path: ["blocked"], equals: true },
      };
  }
}
