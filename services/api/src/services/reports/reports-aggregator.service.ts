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

import { caseVisibleToWhere } from "../cases/case-visibility.js";
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
  classifyTerminalReason,
  type NewVersionAction,
  type OutputAction,
  type OutputActionUnavailableReason,
  type OutputOperation,
  type OutputTerminalReasonClass,
  projectReportRequestState,
  type EvidenceOutputState,
  type OutputGenerationState,
  type PersistedReportRequestState,
} from "@proovra/shared";
import { resolveEvidenceOutputEligibilityMany } from "../billing/evidence-output-eligibility.service.js";
import { resolveOutputRecordApplicability } from "../evidence-artifact-status.service.js";
import {
  loadEvidenceOutputFacts,
  type LoadedOutputFacts,
} from "./output-recovery.service.js";

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
  /** The record's actual workspace binding; null for unresolved legacy rows. */
  teamId: string | null;
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
      /** P2-1 — why the verb was withdrawn on a state that would carry one. */
      actionUnavailableReason: OutputActionUnavailableReason | null;
      terminalReasonClass: OutputTerminalReasonClass | null;
      /** An artifact exists and may be opened, whatever the current request says. */
      downloadable: boolean;
      /** The server operation the offered action performs. */
      operation: OutputOperation | null;
    };
    verificationPackage: {
      state: EvidenceOutputState;
      action: OutputAction;
      actionUnavailableReason: OutputActionUnavailableReason | null;
      terminalReasonClass: OutputTerminalReasonClass | null;
      /** A package PAIRED with the latest report exists. */
      downloadable: boolean;
      operation: OutputOperation | null;
      /** The newest package of any version (may predate the latest report). */
      latestAvailableVersion: number | null;
    };
    /** The separate "create a new version" action; never a recovery verb. */
    newVersion: {
      action: NewVersionAction;
      reason: OutputActionUnavailableReason | null;
    };
    /** Poll interval while work is live; null = no live work. */
    pollIntervalMs: number | null;
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
        /** Records with at least one generated report (not report versions). */
        reportsReady: number;
        /** Records with no report whose latest generation request is queued or running. */
        reportsPending: number;
        /** Records with no report whose latest generation request failed (retryable or terminal). */
        reportsFailed: number;
        /** Records with at least one verification package (not package versions). */
        packagesReady: number;
        /** Records with no package whose latest generation request is queued or running. */
        packagesPending: number;
        /** Records with no package whose package generation is gate-blocked. */
        packagesBlocked: number;
        /** Records whose latest-report package generation failed. */
        packagesFailed: number;
        /**
         * DEPRECATED (2026-09-29) — kept for older clients. Equals
         * `reportsAwaitingFirstIssuance`. "Not requested" was untruthful: it
         * mixed never-requested, succeeded-without-artifact and newly eligible
         * records.
         */
        reportsNotRequested: number;
        /**
         * DEPRECATED (2026-09-29) — kept for older clients. Records with no
         * package at the latest report version and nothing in flight (both
         * "no report yet" and "report without its package").
         */
        packagesNotRequested: number;
        /** Finalized records whose plan does not issue a report (e.g. Free). */
        reportsNotIssued: number;
        /** Entitled records with no report and nothing in flight: first issuance owed. */
        reportsAwaitingFirstIssuance: number;
        /** Records whose latest report has no package and nothing is in flight. */
        packagesMissingForLatestReport: number;
        /** Records whose output entitlement could not be read right now. */
        outputsEntitlementUnavailable: number;
        /** Records with at least one real artifact (report or package). */
        totalEvidenceWithArtifacts: number;
        /** Stored report plus package version rows, including history. */
        totalArtifactVersions: number;
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
  | "package_failed"
  | "package_blocked"
  /*
   * EVIDENCE OUTPUT LIFECYCLE (2026-09-29) — the states "not requested" used to
   * hide, each with its own filter so every card is a drill-down:
   */
  /** Finalized; the plan does not issue a report (e.g. Free). Not a failure. */
  | "report_not_issued"
  /** Entitled, no report yet, nothing in flight: first issuance is owed. */
  | "report_awaiting_issuance"
  /** A report exists but its LATEST version has no package. */
  | "package_missing"
  /** Whether outputs are owed could not be read (subscription state). */
  | "entitlement_unavailable";

export const REPORT_LIFECYCLE_FILTERS: readonly ReportLifecycleFilter[] = [
  "all",
  "report_ready",
  "report_pending",
  "report_failed",
  "package_ready",
  "package_pending",
  "package_failed",
  "package_blocked",
  "report_not_issued",
  "report_awaiting_issuance",
  "package_missing",
  "entitlement_unavailable",
];

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
    case "ENTITLEMENT_UNAVAILABLE":
      return "unavailable";
    case "NOT_APPLICABLE":
      /*
       * P1-3 (2026-09-10) — the legacy five-value vocabulary has no member for
       * "this record cannot carry the output yet". `unavailable` is the
       * COMMERCIAL member and must not absorb a record condition, so this
       * reads `not_requested`: nothing has been asked for, which is equally
       * true of an unfinalized record and of an integrity-failed one.
       * Consumers that need the distinction read `outputs.*.state`.
       */
      return "not_requested";
    case "ELIGIBLE_NOT_GENERATED":
    case "BLOCKED":
      return "not_requested";
  }
}

function toPackageLifecycle(
  state: EvidenceOutputState,
  blocked: boolean,
): PackageLifecycle {
  /*
   * A gate-blocked package reads "blocked" only when the CANONICAL state says
   * BLOCKED. It used to override every non-READY state, so a record whose
   * plan does not include packages (NOT_INCLUDED — which the canonical
   * derivation deliberately ranks above a gate block) read "blocked" in its
   * row while the classifier, the `package_blocked` filter and its tile
   * counted it as not included. NOT_INCLUDED, BLOCKED and FAILED are three
   * different statements; the row now makes the same one as the tile.
   */
  if (blocked && state === "BLOCKED") return "blocked";
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
    case "ENTITLEMENT_UNAVAILABLE":
      return "unavailable";
    case "NOT_APPLICABLE":
      /*
       * P1-3 (2026-09-10) — the legacy five-value vocabulary has no member for
       * "this record cannot carry the output yet". `unavailable` is the
       * COMMERCIAL member and must not absorb a record condition, so this
       * reads `not_requested`: nothing has been asked for, which is equally
       * true of an unfinalized record and of an integrity-failed one.
       * Consumers that need the distinction read `outputs.*.state`.
       */
      return "not_requested";
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
  /**
   * Who is asking. Row actions are offered only to a caller the canonical
   * record access engine allows `evidence.generate_report`.
   */
  callerUserId?: string | null;
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
  // These are WORKSPACE totals: aggregate counts over the whole
  // population, unaffected by the page, the search or the lifecycle filter.
  // They were recomputed on EVERY list request, so each filter click and each
  // debounced keystroke paid for aggregations it could not change — which
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
    // ONE PROJECTION FOR THE TILES AND THE FILTERS.
    //
    // Every tile that has a matching lifecycle filter is computed from the
    // SAME predicate that filter applies (`lifecycleWhere`), over the same
    // finalized population the list pages through. The old tiles each had
    // their own arithmetic — `SIGNED − REPORTED` for pending reports, "no
    // package row" for pending packages, package VERSION rows for ready
    // packages, a 500-row sample for blocked — so a tile routinely disagreed
    // with the rows its own filter returned.
    const finalized = finalizedPopulation(scope);
    const classified = await classifyWorkspaceOutputs({
      finalized,
      teamId: input.teamId,
    });
    const countWhere = async (filter: ReportLifecycleFilter) => {
      const clause = await lifecycleWhere(filter, {
        finalized,
        teamId: input.teamId,
        classified,
      });
      return prisma.evidence.count({
        where: clause ? { AND: [finalized, clause] } : finalized,
      });
    };
    const [
      reportsReady,
      packagesReady,
      packagesBlocked,
      packagesFailed,
      totalEvidenceWithArtifacts,
      reportVersionCount,
      packageVersionCount,
    ] = await Promise.all([
      countWhere("report_ready"),
      countWhere("package_ready"),
      countWhere("package_blocked"),
      countWhere("package_failed"),
      prisma.evidence.count({
        where: {
          AND: [
            finalized,
            {
              OR: [
                { reports: { some: {} } },
                { verificationPackages: { some: {} } },
              ],
            },
          ],
        },
      }),
      prisma.report.count({ where: { evidence: finalized } }),
      prisma.verificationPackage.count({ where: { evidence: finalized } }),
    ]);
    summary = {
      status: "ok",
      data: {
        reportsReady,
        reportsPending: classified.reportPending.length,
        reportsFailed: classified.reportFailed.length,
        packagesReady,
        packagesPending: classified.packagePending.length,
        packagesBlocked,
        packagesFailed,
        reportsNotRequested: classified.reportNotRequested.length,
        packagesNotRequested: classified.packageNotRequested.length,
        reportsNotIssued: classified.reportNotIssued.length,
        reportsAwaitingFirstIssuance: classified.reportNotRequested.length,
        packagesMissingForLatestReport: classified.packageMissingForLatestReport.length,
        outputsEntitlementUnavailable: classified.entitlementUnavailable.length,
        totalEvidenceWithArtifacts,
        totalArtifactVersions: reportVersionCount + packageVersionCount,
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
      // Exactly the summary population (finalizedPopulation), so a tile and
      // its filter can never describe different records.
      AND: [finalizedPopulation(scope)],
    };
    /*
     * RESTRICTED CASES STAY RESTRICTED (2026-09-29).
     *
     * A case with an access list is visible only to its owner and the people
     * on the list (the rule every case surface applies). This list used to
     * return the case's NAME and id on every row, and to filter by any caseId,
     * so a member left off a restricted case could learn it exists, what it is
     * called and which records belong to it.
     */
    const visibleCase: Prisma.CaseWhereInput = caseVisibleToWhere(input.callerUserId);
    if (input.caseId) {
      whereBase.caseLinks = {
        some: { caseId: input.caseId, case: visibleCase },
      };
    }
    // The filter narrows the QUERY, so pagination, the total and the page all
    // describe the same population.
    const lifecycleClause = await lifecycleWhere(input.lifecycleFilter ?? "all", {
      finalized: finalizedPopulation(scope),
      teamId: input.teamId,
    });
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
        // P2-1 — the record's workspace binding. A legacy row carries none, and
        // the generation writer refuses such a record; the verb is withdrawn
        // from this list on that basis. Scoping is unaffected — the WHERE
        // already carries the canonical owner-scoped arm for these rows.
        teamId: true,
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
          where: { case: visibleCase },
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
      /*
       * THE SAME FACTS AND DECISION AS EVIDENCE DETAIL, for the page, in
       * batch. Row actions and the paired package come from here, so the list
       * and the record can never offer different verbs for one record.
       */
      const loadedFacts = await loadEvidenceOutputFacts({
        evidenceIds,
        callerUserId: input.callerUserId ?? null,
      }).catch(() => new Map<string, LoadedOutputFacts>());
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
        const loaded = loadedFacts.get(r.id) ?? null;
        // The package PAIRED with the latest report; an older package stays in
        // the record's version history but does not make the pair complete.
        const pairedPackage = loaded
          ? (loaded.packageAtLatest ?? (report ? null : loaded.latestPackage))
          : (packageByEvidence.get(r.id) ?? null);
        const pkg = pairedPackage
          ? { version: pairedPackage.version, generatedAtUtc: pairedPackage.generatedAtUtc }
          : null;
        const { blocked, reason } = readPackageBlocked(
          r.verificationPackageMetadata,
        );
        // P1-3 — the record axis, from the ONE status mapping.
        const record = resolveOutputRecordApplicability(r.status);
        const eligibility = eligibilityByEvidence.get(r.id) ?? null;
        const request = requestByEvidence.get(r.id) ?? null;
        const projectRow = (
          row: { state: string } | null | undefined,
        ): OutputGenerationState =>
          row
            ? projectReportRequestState(row.state as PersistedReportRequestState)
            : "NOT_REQUESTED";
        // Per output: the report follows report-producing requests, the
        // package follows every request.
        const generation: OutputGenerationState = loaded
          ? projectRow(loaded.reportRequest)
          : projectRow(request);
        const packageGeneration: OutputGenerationState = loaded
          ? projectRow(loaded.packageRequest)
          : generation;

        const reportCanonicalState = deriveEvidenceOutputState({
          eligibility: eligibility?.reportEligibility ?? "UNRESOLVED",
          generation,
          availability: report !== null ? "READY" : "NO_ARTIFACT",
          record,
        });
        const packageCanonicalState = deriveEvidenceOutputState({
          eligibility: eligibility?.packageEligibility ?? "UNRESOLVED",
          generation: blocked ? "BLOCKED" : packageGeneration,
          availability: pkg !== null ? "READY" : "NO_ARTIFACT",
          record,
        });
        const terminalReasonClass =
          generation === "TERMINAL_FAILURE"
            ? classifyTerminalReason(
                (loaded ? loaded.reportRequest : request)?.terminalReasonCode ?? null,
              )
            : null;
        const packageTerminalReasonClass =
          packageCanonicalState === "TERMINAL_FAILURE"
            ? classifyTerminalReason(loaded?.packageRequest?.terminalReasonCode ?? null)
            : null;
        const noAction = {
          action: "NONE" as OutputAction,
          actionUnavailableReason: "PERMISSION_DENIED" as OutputActionUnavailableReason,
          operation: null,
        };
        const reportState = toReportLifecycle(reportCanonicalState);
        const packageState = toPackageLifecycle(packageCanonicalState, blocked);
        return {
          evidenceId: r.id,
          teamId: r.teamId ?? null,
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
              // The one decision (`resolveEvidenceOutputActions`), never
              // re-derived here. No facts → no verb.
              ...(loaded
                ? {
                    action: loaded.actions.report.action,
                    actionUnavailableReason:
                      loaded.actions.report.action === "NONE"
                        ? loaded.actions.report.reason
                        : null,
                    operation: loaded.actions.report.operation,
                  }
                : noAction),
              terminalReasonClass,
              downloadable: report !== null,
            },
            verificationPackage: {
              state: packageCanonicalState,
              ...(loaded
                ? {
                    action: loaded.actions.verificationPackage.action,
                    actionUnavailableReason:
                      loaded.actions.verificationPackage.action === "NONE"
                        ? loaded.actions.verificationPackage.reason
                        : null,
                    operation: loaded.actions.verificationPackage.operation,
                  }
                : noAction),
              terminalReasonClass: packageTerminalReasonClass,
              downloadable: pkg !== null,
              latestAvailableVersion: loaded?.latestPackage?.version ?? pkg?.version ?? null,
            },
            newVersion: loaded
              ? { action: loaded.actions.newVersion.action, reason: loaded.actions.newVersion.reason }
              : { action: "NONE", reason: "PERMISSION_DENIED" },
            pollIntervalMs:
              loaded &&
              [loaded.reportRequest?.state, loaded.packageRequest?.state].some(
                (st) => st === "QUEUED" || st === "PROCESSING",
              )
                ? 3_000
                : null,
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

// ---------------------------------------------------------------------------
// The canonical per-evidence projection behind the tiles AND the filters
// ---------------------------------------------------------------------------

const FINALIZED_STATUSES: Array<"SIGNED" | "REPORTED"> = ["SIGNED", "REPORTED"];

/**
 * The population every tile, filter and row of this page describes.
 *
 * EVIDENCE OUTPUT LIFECYCLE (2026-09-29): finalized records that still exist
 * as records — not in the trash, not bound for or past destruction. The page
 * used to count and list trashed and destroyed evidence in every tile and
 * filter, inflating "Records with artifacts" and "Artifact versions". Archived
 * records stay: archiving is a storage tier, not removal.
 */
function finalizedPopulation(scope: WorkspaceEvidenceScope): Prisma.EvidenceWhereInput {
  return {
    AND: [scope],
    status: { in: FINALIZED_STATUSES },
    deletedAt: null,
    lifecycleState: { notIn: ["TRASHED", "PENDING_DESTRUCTION", "DESTROYED"] },
  };
}

/**
 * Evidence ids, per lifecycle state that cannot be written as a relation test.
 *
 * "Pending" and "failed" are properties of the record's LATEST generation
 * request, and `ReportGenerationRequest` has no Prisma relation from
 * `Evidence`. They used to be approximated by a platform-wide scan of the
 * newest 5,000 request rows in a state — any workspace's rows, and any request
 * for a record rather than its latest — which both leaked other workspaces'
 * volume into this one's result and silently truncated a large workspace.
 */
export type ClassifiedWorkspaceOutputs = {
  reportReady: string[];
  reportPending: string[];
  reportFailed: string[];
  reportNotRequested: string[];
  /** Report NOT_INCLUDED: finalized, the plan does not issue one. */
  reportNotIssued: string[];
  packageReady: string[];
  packagePending: string[];
  packageFailed: string[];
  packageBlocked: string[];
  packageNotRequested: string[];
  /** Report READY, package ELIGIBLE_NOT_GENERATED at the latest version. */
  packageMissingForLatestReport: string[];
  /** Either output's entitlement could not be read. */
  entitlementUnavailable: string[];
};

const CLASSIFY_BATCH = 1000;

/**
 * Classifies every finalized record in the workspace through the same
 * `deriveEvidenceOutputState` the list rows use.
 *
 * Bounded in memory: records are read in id-ordered batches, each batch costs
 * one evidence read plus batched report, package, request and eligibility
 * reads. Only matching ids are kept. Every record must be classified because
 * an historical package is not READY for a newer report version.
 */
export async function classifyWorkspaceOutputs(input: {
  finalized: Prisma.EvidenceWhereInput;
  teamId: string;
}): Promise<ClassifiedWorkspaceOutputs> {
  const out: ClassifiedWorkspaceOutputs = {
    reportReady: [],
    reportPending: [],
    reportFailed: [],
    reportNotRequested: [],
    reportNotIssued: [],
    packageReady: [],
    packagePending: [],
    packageFailed: [],
    packageBlocked: [],
    packageNotRequested: [],
    packageMissingForLatestReport: [],
    entitlementUnavailable: [],
  };
  let after: string | null = null;
  for (;;) {
    const batch: Array<{
      id: string;
      status: string;
      verificationPackageMetadata: Prisma.JsonValue;
    }> = await prisma.evidence.findMany({
      where: {
        AND: [input.finalized, ...(after ? [{ id: { gt: after } }] : [])],
      },
      orderBy: { id: "asc" },
      take: CLASSIFY_BATCH,
      select: {
        id: true,
        status: true,
        verificationPackageMetadata: true,
      },
    });
    if (batch.length === 0) break;
    after = batch[batch.length - 1].id;

    const ids = batch.map((r) => r.id);
    const [reports, packages, reportRequests, anyRequests, eligibility] =
      await Promise.all([
        prisma.report.findMany({
          where: { evidenceId: { in: ids } },
          orderBy: [{ evidenceId: "asc" }, { version: "desc" }],
          distinct: ["evidenceId"],
          select: { evidenceId: true, version: true },
        }),
        prisma.verificationPackage.findMany({
          where: { evidenceId: { in: ids } },
          select: { evidenceId: true, version: true },
        }),
        prisma.reportGenerationRequest.findMany({
          where: { evidenceId: { in: ids }, artifactType: "REPORT" },
          orderBy: [{ evidenceId: "asc" }, { createdAtUtc: "desc" }],
          distinct: ["evidenceId"],
          select: { evidenceId: true, state: true },
        }),
        prisma.reportGenerationRequest.findMany({
          where: { evidenceId: { in: ids } },
          orderBy: [{ evidenceId: "asc" }, { createdAtUtc: "desc" }],
          distinct: ["evidenceId"],
          select: { evidenceId: true, state: true },
        }),
        resolveEvidenceOutputEligibilityMany({
          evidenceIds: ids,
          teamId: input.teamId,
        }),
      ]);
    const latestReportById = new Map(reports.map((r) => [r.evidenceId, r.version]));
    const packageVersionsById = new Map<string, Set<number>>();
    for (const pkg of packages) {
      const versions = packageVersionsById.get(pkg.evidenceId) ?? new Set<number>();
      versions.add(pkg.version);
      packageVersionsById.set(pkg.evidenceId, versions);
    }
    const generationMap = (rows: Array<{ evidenceId: string; state: string }>) =>
      new Map<string, OutputGenerationState>(
        rows.map((q) => [
          q.evidenceId,
          projectReportRequestState(q.state as PersistedReportRequestState),
        ]),
      );
    const reportGenerationById = generationMap(reportRequests);
    const packageGenerationById = generationMap(anyRequests);

    for (const row of batch) {
      const record = resolveOutputRecordApplicability(row.status);
      const elig = eligibility.get(row.id) ?? null;
      const latestReportVersion = latestReportById.get(row.id) ?? null;
      const packageVersions = packageVersionsById.get(row.id);
      const packageAtLatest = latestReportVersion != null
        ? Boolean(packageVersions?.has(latestReportVersion))
        : Boolean(packageVersions?.size);
      const reportGeneration = reportGenerationById.get(row.id) ?? "NOT_REQUESTED";
      const rawPackageGeneration = packageGenerationById.get(row.id) ?? "NOT_REQUESTED";
      const packageBlocked = readPackageBlocked(row.verificationPackageMetadata).blocked;

      const reportState = deriveEvidenceOutputState({
        eligibility: elig?.reportEligibility ?? "UNRESOLVED",
        generation: reportGeneration,
        availability: latestReportVersion != null ? "READY" : "NO_ARTIFACT",
        record,
      });
      const packageState = deriveEvidenceOutputState({
        eligibility: elig?.packageEligibility ?? "UNRESOLVED",
        generation: packageBlocked ? "BLOCKED" : rawPackageGeneration,
        availability: packageAtLatest ? "READY" : "NO_ARTIFACT",
        record,
      });

      if (reportState === "READY") out.reportReady.push(row.id);
      else if (reportState === "QUEUED" || reportState === "GENERATING") out.reportPending.push(row.id);
      else if (reportState === "RETRYABLE_FAILURE" || reportState === "TERMINAL_FAILURE") out.reportFailed.push(row.id);
      else if (reportState === "ELIGIBLE_NOT_GENERATED") out.reportNotRequested.push(row.id);
      else if (reportState === "NOT_INCLUDED") out.reportNotIssued.push(row.id);

      if (packageState === "READY") out.packageReady.push(row.id);
      else if (packageState === "QUEUED" || packageState === "GENERATING") out.packagePending.push(row.id);
      else if (packageState === "RETRYABLE_FAILURE" || packageState === "TERMINAL_FAILURE") out.packageFailed.push(row.id);
      else if (packageState === "BLOCKED") out.packageBlocked.push(row.id);
      else if (packageState === "ELIGIBLE_NOT_GENERATED") {
        out.packageNotRequested.push(row.id);
        if (reportState === "READY") out.packageMissingForLatestReport.push(row.id);
      }
      if (reportState === "ENTITLEMENT_UNAVAILABLE" || packageState === "ENTITLEMENT_UNAVAILABLE") {
        out.entitlementUnavailable.push(row.id);
      }
    }

    if (batch.length < CLASSIFY_BATCH) break;
  }
  return out;
}

/**
 * THE LIFECYCLE FILTER, AS A DATABASE PREDICATE.
 *
 * Each filter selects exactly the rows whose projected lifecycle (see
 * `toReportLifecycle` / `toPackageLifecycle`) carries that value, across the
 * whole workspace and before pagination — and the summary tile of the same
 * name is `count(finalized AND lifecycleWhere(filter))`, so a tile and its
 * filter's total cannot disagree.
 *
 * Ready and blocked are relation / JSON-path tests. Pending and failed come
 * from `classifyWorkspaceOutputs`, as an id set.
 */
async function lifecycleWhere(
  filter: ReportLifecycleFilter,
  ctx: {
    finalized: Prisma.EvidenceWhereInput;
    teamId: string;
    classified?: ClassifiedWorkspaceOutputs;
  },
): Promise<Prisma.EvidenceWhereInput | null> {
  const classified = async () =>
    ctx.classified ??
    (await classifyWorkspaceOutputs({ finalized: ctx.finalized, teamId: ctx.teamId }));
  switch (filter) {
    case "all":
      return null;
    case "report_ready":
      return { id: { in: (await classified()).reportReady } };
    case "report_pending":
      // Queued or running, with no report yet. A Free record that was never
      // entitled to a report has no request and is not pending.
      return { id: { in: (await classified()).reportPending } };
    case "report_failed":
      return { id: { in: (await classified()).reportFailed } };
    case "package_ready":
      return { id: { in: (await classified()).packageReady } };
    case "package_pending":
      return { id: { in: (await classified()).packagePending } };
    case "package_failed":
      return { id: { in: (await classified()).packageFailed } };
    case "package_blocked":
      return { id: { in: (await classified()).packageBlocked } };
    case "report_not_issued":
      return { id: { in: (await classified()).reportNotIssued } };
    case "report_awaiting_issuance":
      return { id: { in: (await classified()).reportNotRequested } };
    case "package_missing":
      return { id: { in: (await classified()).packageMissingForLatestReport } };
    case "entitlement_unavailable":
      return { id: { in: (await classified()).entitlementUnavailable } };
  }
}
