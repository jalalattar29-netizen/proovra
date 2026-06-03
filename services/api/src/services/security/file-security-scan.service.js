/**
 * Phase 11 — File security scan foundation.
 *
 * Architecture goal: provide an enterprise-ready scan record so future
 * scanners (local ClamAV, cloud) can plug in without reshaping the
 * evidence pipeline. This phase ships the model + service + a no-op
 * scanner; production scanners wire in later.
 *
 * Rules:
 *   - Scan failure NEVER deletes evidence.
 *   - Suspicious findings are internal-only (REVIEW_REQUIRED is set at
 *     the application layer; this service only records the state).
 *   - When MALWARE_SCANNING_ENABLED is false, `recordScanOutcome` is
 *     not called from the upload pipeline and no rows are written.
 *   - When the feature is enabled but no scanner is wired up, the row
 *     is `SKIPPED` with a clear `findingsSummary`.
 *
 * Wording: NEVER claim "virus free", "secure", "guaranteed". Use the
 * stable status enum + the limited vocabulary in `findingsSummary`.
 */
import { prisma as defaultPrisma } from "../../db.js";
import { safeEmitSecurityEvent } from "./security-event.service.js";
const ENV_FLAG = "MALWARE_SCANNING_ENABLED";
export function isMalwareScanningEnabled() {
    return process.env[ENV_FLAG] === "true";
}
const noopScanner = async () => ({
    status: "SKIPPED",
    scanner: "noop",
    signatureVersion: null,
    findingsSummary: "no_scanner_configured",
});
let activeScanner = noopScanner;
/**
 * Wire a real scanner from the operations / deployment layer. Tests
 * use this to inject deterministic CLEAN / SUSPICIOUS / FAILED
 * outcomes. Returns a function that restores the previous scanner.
 */
export function setActiveScanner(s) {
    const prev = activeScanner;
    activeScanner = s;
    return () => {
        activeScanner = prev;
    };
}
// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------
/**
 * Enqueue a PENDING scan row for an evidence record. Idempotent within
 * the same minute: if a PENDING scan already exists, return it.
 *
 * No-op when MALWARE_SCANNING_ENABLED is false. Returns null in that
 * case so callers can treat "no scan" as a first-class state.
 */
export async function enqueueScan(input, client = defaultPrisma) {
    if (!isMalwareScanningEnabled())
        return null;
    try {
        const existing = await client.fileSecurityScan.findFirst({
            where: { evidenceId: input.evidenceId, status: "PENDING" },
            orderBy: { createdAt: "desc" },
        });
        if (existing)
            return existing;
        return await client.fileSecurityScan.create({
            data: {
                evidenceId: input.evidenceId,
                teamId: input.teamId,
                status: "PENDING",
            },
        });
    }
    catch {
        return null;
    }
}
/**
 * Run the active scanner against an evidence record. Always writes a
 * terminal row (CLEAN / SUSPICIOUS / FAILED / SKIPPED). The PENDING row
 * (if any) is finalised in-place.
 *
 * Errors from the scanner are caught and recorded as FAILED — callers
 * never see exceptions from this function.
 */
export async function runScan(input, client = defaultPrisma) {
    if (!isMalwareScanningEnabled())
        return null;
    let result;
    try {
        result = await activeScanner(input);
    }
    catch (err) {
        result = {
            status: "FAILED",
            scanner: "unknown",
            findingsSummary: err instanceof Error
                ? `scanner_error:${err.message.slice(0, 200)}`
                : "scanner_error",
        };
    }
    let row = null;
    try {
        const pending = await client.fileSecurityScan.findFirst({
            where: { evidenceId: input.evidenceId, status: "PENDING" },
            orderBy: { createdAt: "desc" },
        });
        if (pending) {
            row = await client.fileSecurityScan.update({
                where: { id: pending.id },
                data: {
                    status: result.status,
                    scanner: result.scanner,
                    signatureVersion: result.signatureVersion ?? null,
                    findingsSummary: result.findingsSummary ?? null,
                    scannedAtUtc: new Date(),
                },
            });
        }
        else {
            row = await client.fileSecurityScan.create({
                data: {
                    evidenceId: input.evidenceId,
                    teamId: input.teamId,
                    status: result.status,
                    scanner: result.scanner,
                    signatureVersion: result.signatureVersion ?? null,
                    findingsSummary: result.findingsSummary ?? null,
                    scannedAtUtc: new Date(),
                },
            });
        }
    }
    catch {
        return null;
    }
    // Surface scanner-unavailable + suspicious findings as security
    // events. The /security operations page reads from there.
    if (result.status === "SUSPICIOUS") {
        safeEmitSecurityEvent({
            teamId: input.teamId,
            eventType: "suspicious_file_type",
            severity: "HIGH",
            evidenceId: input.evidenceId,
            details: {
                scanner: result.scanner,
                summaryCode: result.findingsSummary ?? null,
            },
        }, client);
    }
    else if (result.status === "SKIPPED" &&
        result.findingsSummary === "no_scanner_configured") {
        safeEmitSecurityEvent({
            teamId: input.teamId,
            eventType: "scanner_unavailable",
            severity: "INFO",
            evidenceId: input.evidenceId,
            details: { scanner: result.scanner },
        }, client);
    }
    else if (result.status === "FAILED") {
        safeEmitSecurityEvent({
            teamId: input.teamId,
            eventType: "scanner_unavailable",
            severity: "WARNING",
            evidenceId: input.evidenceId,
            details: {
                scanner: result.scanner,
                summary: result.findingsSummary ?? null,
            },
        }, client);
    }
    return row;
}
// -----------------------------------------------------------------------------
// Read helpers
// -----------------------------------------------------------------------------
export async function getLatestScanForEvidence(evidenceId, client = defaultPrisma) {
    return client.fileSecurityScan.findFirst({
        where: { evidenceId },
        orderBy: { createdAt: "desc" },
    });
}
export async function listScansForTeam(input, client = defaultPrisma) {
    return client.fileSecurityScan.findMany({
        where: {
            teamId: input.teamId,
            ...(input.status ? { status: input.status } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: Math.min(Math.max(input.limit ?? 50, 1), 200),
    });
}
export async function countScansByTeam(input, client = defaultPrisma) {
    const days = Math.max(1, Math.min(input.sinceDays ?? 30, 365));
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const rows = await client.fileSecurityScan.groupBy({
        by: ["status"],
        where: { teamId: input.teamId, createdAt: { gte: since } },
        _count: { _all: true },
    });
    const counts = {
        pending: 0,
        clean: 0,
        suspicious: 0,
        failed: 0,
        skipped: 0,
    };
    for (const r of rows) {
        if (r.status === "PENDING")
            counts.pending = r._count._all;
        else if (r.status === "CLEAN")
            counts.clean = r._count._all;
        else if (r.status === "SUSPICIOUS")
            counts.suspicious = r._count._all;
        else if (r.status === "FAILED")
            counts.failed = r._count._all;
        else if (r.status === "SKIPPED")
            counts.skipped = r._count._all;
    }
    return counts;
}
/**
 * Safe projection. Internal-only fields like the raw signature_version
 * detail are kept; we still avoid echoing anything that could leak
 * scanner internals to a public surface. Public verify NEVER reads
 * this — see Phase 11 brief, rule 8.
 */
export function projectFileSecurityScan(row) {
    return {
        id: row.id,
        evidenceId: row.evidenceId,
        teamId: row.teamId,
        status: row.status,
        scanner: row.scanner,
        signatureVersion: row.signatureVersion,
        findingsSummary: row.findingsSummary,
        scannedAtUtc: row.scannedAtUtc?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}
