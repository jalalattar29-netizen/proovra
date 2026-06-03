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
import { prisma } from "../../db.js";
// ---------------------------------------------------------------------------
// Bounded limits
// ---------------------------------------------------------------------------
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
// ---------------------------------------------------------------------------
// Lifecycle mapping (mirror of Phase 32.6.x artifact-status semantics)
// ---------------------------------------------------------------------------
function deriveReportState(args) {
    if (args.reportAvailable)
        return "ready";
    if (args.evidenceStatus === "SIGNED" || args.evidenceStatus === "REPORTED") {
        return "pending";
    }
    return "not_requested";
}
function derivePackageState(args) {
    if (args.packageAvailable)
        return "ready";
    if (args.packageBlocked)
        return "blocked";
    if (args.evidenceStatus === "SIGNED" || args.evidenceStatus === "REPORTED") {
        return "pending";
    }
    return "not_requested";
}
function readPackageBlocked(metadata) {
    if (metadata == null || typeof metadata !== "object") {
        return { blocked: false, reason: null };
    }
    const obj = metadata;
    if (obj.blocked !== true)
        return { blocked: false, reason: null };
    const reason = typeof obj.reason === "string"
        ? obj.reason.slice(0, 160)
        : typeof obj.outcome === "string"
            ? obj.outcome.slice(0, 160)
            : null;
    return { blocked: true, reason };
}
// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------
export async function listWorkspaceArtifacts(input) {
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    // ----------- Summary counts (workspace-level) -----------
    let summary = {
        status: "unavailable",
        data: null,
    };
    try {
        const [reportsReady, reportsPendingCandidates, packagesReady, packagesPendingCandidates, packagesBlockedCount, totalEvidenceWithArtifacts,] = await Promise.all([
            prisma.evidence.count({
                where: { teamId: input.teamId, status: "REPORTED" },
            }),
            prisma.evidence.count({
                where: { teamId: input.teamId, status: "SIGNED" },
            }),
            prisma.verificationPackage.count({
                where: { evidence: { teamId: input.teamId } },
            }),
            prisma.evidence.count({
                where: {
                    teamId: input.teamId,
                    status: { in: ["SIGNED", "REPORTED"] },
                    verificationPackages: { none: {} },
                },
            }),
            // Packages where the gate-denial metadata indicates `blocked: true`.
            // Prisma doesn't support a JSON `blocked === true` predicate at the
            // count level on all versions; we read a bounded sample then count
            // the blocked flag client-side.
            prisma.evidence
                .findMany({
                where: {
                    teamId: input.teamId,
                    status: { in: ["SIGNED", "REPORTED"] },
                    verificationPackageMetadata: { not: null },
                },
                take: 500,
                select: { verificationPackageMetadata: true },
            })
                .then((rows) => {
                let n = 0;
                for (const row of rows) {
                    const { blocked } = readPackageBlocked(row.verificationPackageMetadata);
                    if (blocked)
                        n += 1;
                }
                return n;
            })
                .catch(() => 0),
            prisma.evidence.count({
                where: {
                    teamId: input.teamId,
                    status: { in: ["SIGNED", "REPORTED"] },
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
    }
    catch {
        summary = { status: "unavailable", data: null };
    }
    // ----------- Artifact rows -----------
    let artifacts = {
        status: "unavailable",
        items: [],
        nextCursor: null,
    };
    try {
        const whereBase = {
            teamId: input.teamId,
            status: { in: ["SIGNED", "REPORTED"] },
        };
        if (input.caseId)
            whereBase.caseId = input.caseId;
        if (input.search && input.search.trim()) {
            whereBase.title = {
                contains: input.search.trim().slice(0, 80),
                mode: "insensitive",
            };
        }
        // Cursor — opaque, last (createdAt, id) pair, base64-encoded JSON.
        let cursorFilter = null;
        if (input.cursor) {
            try {
                const parsed = JSON.parse(Buffer.from(input.cursor, "base64").toString("utf8"));
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
            }
            catch {
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
                type: true,
                status: true,
                verificationStatus: true,
                caseId: true,
                createdAt: true,
                verificationPackageMetadata: true,
            },
        });
        const hasMore = rows.length > limit;
        const pageRows = hasMore ? rows.slice(0, limit) : rows;
        const nextCursor = hasMore && pageRows.length > 0
            ? Buffer.from(JSON.stringify({
                c: pageRows[pageRows.length - 1].createdAt.toISOString(),
                i: pageRows[pageRows.length - 1].id,
            })).toString("base64")
            : null;
        if (pageRows.length === 0) {
            artifacts = { status: "ok", items: [], nextCursor: null };
        }
        else {
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
            const reportByEvidence = new Map(reportRows.map((r) => [r.evidenceId, r]));
            const packageByEvidence = new Map(packageRows.map((p) => [p.evidenceId, p]));
            const items = pageRows.map((r) => {
                const report = reportByEvidence.get(r.id) ?? null;
                const pkg = packageByEvidence.get(r.id) ?? null;
                const { blocked, reason } = readPackageBlocked(r.verificationPackageMetadata);
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
                    title: r.title ?? "Untitled evidence",
                    type: String(r.type),
                    status: String(r.status),
                    verificationStatus: r.verificationStatus
                        ? String(r.verificationStatus)
                        : null,
                    caseId: r.caseId,
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
    }
    catch {
        artifacts = { status: "unavailable", items: [], nextCursor: null };
    }
    return {
        generatedAt: new Date().toISOString(),
        workspace: { id: input.teamId, role: input.role },
        sections: { summary, artifacts },
    };
}
function filterByLifecycle(items, filter) {
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
