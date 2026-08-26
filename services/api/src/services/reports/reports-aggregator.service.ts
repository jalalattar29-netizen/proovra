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

import { prisma } from "../../db.js";
import {
  workspaceEvidenceWhere,
  type WorkspaceEvidenceScope,
} from "@proovra/shared-runtime";

export type SectionStatus = "ok" | "degraded" | "unavailable";

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

function deriveReportState(args: {
  evidenceStatus: string;
  reportAvailable: boolean;
}): ReportLifecycle {
  if (args.reportAvailable) return "ready";
  if (args.evidenceStatus === "SIGNED" || args.evidenceStatus === "REPORTED") {
    return "pending";
  }
  return "not_requested";
}

function derivePackageState(args: {
  evidenceStatus: string;
  packageAvailable: boolean;
  packageBlocked: boolean;
}): PackageLifecycle {
  if (args.packageAvailable) return "ready";
  if (args.packageBlocked) return "blocked";
  if (args.evidenceStatus === "SIGNED" || args.evidenceStatus === "REPORTED") {
    return "pending";
  }
  return "not_requested";
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
  let summary: ReportsArtifactsEnvelope["sections"]["summary"] = {
    status: "unavailable",
    data: null,
  };
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

  // ----------- Artifact rows -----------
  let artifacts: ReportsArtifactsEnvelope["sections"]["artifacts"] = {
    status: "unavailable",
    items: [],
    nextCursor: null,
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
      artifacts = { status: "ok", items: [], nextCursor: null };
    } else {
      const evidenceIds = pageRows.map((r) => r.id);
      const [reportRows, packageRows] = await Promise.all([
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
      ]);
      const reportByEvidence = new Map(
        reportRows.map((r) => [r.evidenceId, r]),
      );
      const packageByEvidence = new Map(
        packageRows.map((p) => [p.evidenceId, p]),
      );

      const items: ArtifactRow[] = pageRows.map((r) => {
        const report = reportByEvidence.get(r.id) ?? null;
        const pkg = packageByEvidence.get(r.id) ?? null;
        const { blocked, reason } = readPackageBlocked(
          r.verificationPackageMetadata,
        );
        const reportState = deriveReportState({
          evidenceStatus: String(r.status),
          reportAvailable: report !== null,
        });
        const packageState = derivePackageState({
          evidenceStatus: String(r.status),
          packageAvailable: pkg !== null,
          packageBlocked: blocked,
        });
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
          // Phase 6 — surface template-identity trio in the envelope.
          // Identity propagation only; legacy rows surface NULL.
          provenance: {
            templateSlug: r.templateSlug ?? null,
            templateVersion: r.templateVersion ?? null,
            templateDbId: r.templateDbId ?? null,
          },
        };
      });

      // Lifecycle-filter is applied AFTER row hydration so the cursor
      // remains stable across filter changes (the filter only narrows
      // visible rows from the bounded slice).
      const filtered = filterByLifecycle(items, input.lifecycleFilter ?? "all");

      artifacts = {
        status: "ok",
        items: filtered,
        nextCursor,
      };
    }
  } catch {
    artifacts = { status: "unavailable", items: [], nextCursor: null };
  }

  return {
    generatedAt: new Date().toISOString(),
    workspace: { id: input.teamId, role: input.role },
    sections: { summary, artifacts },
  };
}

function filterByLifecycle(
  items: ArtifactRow[],
  filter: ReportLifecycleFilter,
): ArtifactRow[] {
  switch (filter) {
    case "all":
      return items;
    case "report_ready":
      return items.filter((i) => i.report.state === "ready");
    case "report_pending":
      return items.filter((i) => i.report.state === "pending");
    case "report_failed":
      return items.filter((i) => i.report.state === "failed");
    case "package_ready":
      return items.filter((i) => i.package.state === "ready");
    case "package_pending":
      return items.filter((i) => i.package.state === "pending");
    case "package_blocked":
      return items.filter((i) => i.package.state === "blocked");
  }
}
