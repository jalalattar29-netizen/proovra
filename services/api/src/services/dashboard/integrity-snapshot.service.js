/**
 * Phase 32.8C++++ — EvidenceIntegritySnapshot writer + reader.
 *
 * Advisory operational snapshot of evidence integrity classifier
 * state. The dashboard reads this table for fast "deep integrity"
 * intelligence. When rows are missing (older evidence, fresh
 * workspace, deferred subsystem), the dashboard falls back to live
 * derivation from `Evidence.verificationStatus` + TSA + OTS columns.
 *
 * Hard rules:
 *   - This is ADVISORY data. Writer failures NEVER block evidence /
 *     report / package / verify core flows. Callers wrap every
 *     `recordSnapshotFromEvidence` invocation in `.catch(() => {})`.
 *   - The snapshot mirrors EXISTING worker classifier output (the
 *     `verificationStatus` enum + TSA/OTS columns). It does NOT
 *     recompute hashes from raw bytes — that lives in the worker.
 *   - The dashboard reader is read-only.
 *   - Bounded fields only — no raw file bytes, no signed URLs.
 *   - Operator-safe language: "review required", "TSA signal
 *     unavailable" — no legal-admissibility claims.
 */
import { prisma } from "../../db.js";
/** Bounded source-version label. Bump when the derivation rules change. */
const INTEGRITY_SOURCE_VERSION = "v2-2026-06";
/**
 * Phase 32.8C+++++ — TSA issuer parsing. Returns parsed identity fields
 * if a parser is wired; UNAVAILABLE otherwise. The default API-side
 * parser is intentionally a no-op stub: a real ASN.1 TSA token parser
 * lives in the worker package and runs asynchronously. The dashboard
 * NEVER fabricates parsed fields — when the parser is missing the
 * status is the bounded string "UNAVAILABLE".
 */
export function deriveTsaIssuerProjection(input) {
    if (!input.tsaTokenBase64) {
        return {
            tsaIssuerCommonName: null,
            tsaIssuerOrganization: null,
            tsaPolicyOid: null,
            tsaParseStatus: "UNAVAILABLE",
            tsaParseErrorCode: "TSA_TOKEN_ABSENT",
        };
    }
    // API does not parse ASN.1 — defer to the worker-side parser. The
    // status is UNAVAILABLE (never PARSED, never faked).
    return {
        tsaIssuerCommonName: null,
        tsaIssuerOrganization: null,
        tsaPolicyOid: null,
        tsaParseStatus: "UNAVAILABLE",
        tsaParseErrorCode: "PARSER_NOT_AVAILABLE_IN_API",
    };
}
/**
 * Derive the bounded integrity snapshot shape from existing Evidence
 * fields. Pure function — no DB access. Used by both the writer
 * (which persists the row) and the dashboard fallback (which uses
 * the same logic at read time when no snapshot row exists).
 */
export function deriveIntegritySnapshot(input) {
    const reasonCodes = [];
    // verificationStatus is the bounded worker classifier output we trust.
    const vs = input.verificationStatus;
    const isReviewRequired = vs === "REVIEW_REQUIRED";
    const isFailed = vs === "FAILED";
    const isOk = vs === "RECORDED_INTEGRITY_VERIFIED" || vs === "MATERIALS_AVAILABLE";
    // Dashboard tri-state derivation — null when not computed.
    const canonicalHashMatches = isOk === true ? true : isFailed ? false : isReviewRequired ? false : null;
    const signatureValid = isOk === true ? true : isFailed ? false : isReviewRequired ? null : null;
    const custodyChainValid = isOk === true ? true : isFailed ? false : isReviewRequired ? null : null;
    // TSA derivation from existing columns.
    let tsaStatus;
    let timestampDigestMatches;
    if (input.tsaTokenBase64 && input.tsaGenTimeUtc) {
        tsaStatus = "OK";
        timestampDigestMatches = true;
    }
    else if (input.tsaTokenBase64 == null && input.tsaGenTimeUtc == null) {
        tsaStatus = "UNAVAILABLE";
        timestampDigestMatches = null;
        if (isOk || isReviewRequired)
            reasonCodes.push("TSA_UNAVAILABLE");
    }
    else {
        tsaStatus = "PENDING";
        timestampDigestMatches = null;
    }
    // OTS derivation from the existing string column.
    let otsStatus;
    let otsHashMatches;
    const rawOts = (input.otsStatus ?? "").toUpperCase();
    if (rawOts === "ANCHORED" || rawOts === "VERIFIED") {
        otsStatus = "OK";
        otsHashMatches = true;
    }
    else if (rawOts === "FAILED" || rawOts === "ERRORED") {
        otsStatus = "FAILED";
        otsHashMatches = false;
        reasonCodes.push("OTS_FAILED");
    }
    else if (rawOts === "" || input.otsStatus == null) {
        otsStatus = "UNAVAILABLE";
        otsHashMatches = null;
        if (isOk)
            reasonCodes.push("OTS_UNAVAILABLE");
    }
    else {
        otsStatus = "PENDING";
        otsHashMatches = null;
    }
    if (isReviewRequired)
        reasonCodes.push("INTEGRITY_REVIEW_REQUIRED");
    if (isFailed)
        reasonCodes.push("INTEGRITY_FAILED");
    const overallStatus = isFailed
        ? "FAILED"
        : isReviewRequired
            ? "REVIEW_REQUIRED"
            : isOk
                ? "OK"
                : "UNKNOWN";
    return {
        canonicalHashMatches,
        signatureValid,
        custodyChainValid,
        timestampDigestMatches,
        otsHashMatches,
        tsaStatus,
        otsStatus,
        overallStatus,
        reasonCodes,
    };
}
/**
 * Upsert a snapshot row from current Evidence state. Advisory — the
 * caller MUST wrap this in `.catch(() => {})` so a snapshot write
 * failure never blocks evidence/report/package core flows.
 *
 * Idempotent on `evidenceId` (1:1 with Evidence).
 */
export async function recordSnapshotFromEvidence(input) {
    const derived = deriveIntegritySnapshot(input);
    const issuer = deriveTsaIssuerProjection({
        tsaTokenBase64: input.tsaTokenBase64,
    });
    await prisma.evidenceIntegritySnapshot.upsert({
        where: { evidenceId: input.evidenceId },
        create: {
            evidenceId: input.evidenceId,
            teamId: input.teamId,
            canonicalHashMatches: derived.canonicalHashMatches,
            signatureValid: derived.signatureValid,
            custodyChainValid: derived.custodyChainValid,
            timestampDigestMatches: derived.timestampDigestMatches,
            otsHashMatches: derived.otsHashMatches,
            tsaStatus: derived.tsaStatus,
            otsStatus: derived.otsStatus,
            overallStatus: derived.overallStatus,
            reasonCodes: derived.reasonCodes,
            sourceVersion: INTEGRITY_SOURCE_VERSION,
            tsaIssuerCommonName: issuer.tsaIssuerCommonName,
            tsaIssuerOrganization: issuer.tsaIssuerOrganization,
            tsaPolicyOid: issuer.tsaPolicyOid,
            tsaParseStatus: issuer.tsaParseStatus,
            tsaParseErrorCode: issuer.tsaParseErrorCode,
            tsaParsedAtUtc: new Date(),
        },
        update: {
            teamId: input.teamId,
            canonicalHashMatches: derived.canonicalHashMatches,
            signatureValid: derived.signatureValid,
            custodyChainValid: derived.custodyChainValid,
            timestampDigestMatches: derived.timestampDigestMatches,
            otsHashMatches: derived.otsHashMatches,
            tsaStatus: derived.tsaStatus,
            otsStatus: derived.otsStatus,
            overallStatus: derived.overallStatus,
            reasonCodes: derived.reasonCodes,
            computedAtUtc: new Date(),
            sourceVersion: INTEGRITY_SOURCE_VERSION,
            tsaIssuerCommonName: issuer.tsaIssuerCommonName,
            tsaIssuerOrganization: issuer.tsaIssuerOrganization,
            tsaPolicyOid: issuer.tsaPolicyOid,
            tsaParseStatus: issuer.tsaParseStatus,
            tsaParseErrorCode: issuer.tsaParseErrorCode,
            tsaParsedAtUtc: new Date(),
        },
    });
}
/**
 * Read-side helper for the dashboard. Returns snapshots for the
 * workspace, ordered by overall-status severity then computedAtUtc.
 * The dashboard treats `null` snapshots as "fall back to live
 * derivation" — never as "OK".
 */
export async function listWorkspaceIntegritySnapshots(input) {
    const rows = await prisma.evidenceIntegritySnapshot.findMany({
        where: {
            teamId: input.teamId,
            // Surface only signals the operator needs to action.
            overallStatus: { in: ["REVIEW_REQUIRED", "FAILED"] },
        },
        orderBy: { computedAtUtc: "desc" },
        take: Math.min(Math.max(input.limit, 1), 100),
        select: {
            evidenceId: true,
            overallStatus: true,
            tsaStatus: true,
            otsStatus: true,
            reasonCodes: true,
            computedAtUtc: true,
            tsaIssuerCommonName: true,
            tsaIssuerOrganization: true,
            tsaPolicyOid: true,
            tsaParseStatus: true,
            tsaParseErrorCode: true,
            tsaParsedAtUtc: true,
        },
    });
    return rows.map((r) => ({
        evidenceId: r.evidenceId,
        overallStatus: (r.overallStatus ?? "UNKNOWN"),
        tsaStatus: r.tsaStatus,
        otsStatus: r.otsStatus,
        reasonCodes: Array.isArray(r.reasonCodes)
            ? r.reasonCodes
            : [],
        computedAtUtc: r.computedAtUtc.toISOString(),
        tsaIssuerCommonName: r.tsaIssuerCommonName,
        tsaIssuerOrganization: r.tsaIssuerOrganization,
        tsaPolicyOid: r.tsaPolicyOid,
        tsaParseStatus: r.tsaParseStatus,
        tsaParseErrorCode: r.tsaParseErrorCode,
        tsaParsedAtUtc: r.tsaParsedAtUtc?.toISOString() ?? null,
    }));
}
/**
 * Backfill a bounded slice of workspace evidence into the snapshot
 * table. Used by:
 *   1. the dashboard's deep-integrity engine on first access (lazy
 *      backfill — wraps every write in try/catch so a single failure
 *      doesn't block the rest).
 *   2. an operator-triggered reconcile flow.
 *
 * Never throws — returns the count of rows actually persisted.
 */
export async function backfillIntegritySnapshots(input) {
    let persisted = 0;
    let failed = 0;
    try {
        const evidence = await prisma.evidence.findMany({
            where: {
                teamId: input.teamId,
                status: { in: ["SIGNED", "REPORTED"] },
            },
            take: Math.min(Math.max(input.limit, 1), 200),
            orderBy: { updatedAt: "desc" },
            select: {
                id: true,
                teamId: true,
                verificationStatus: true,
                tsaTokenBase64: true,
                tsaGenTimeUtc: true,
                otsStatus: true,
            },
        });
        for (const e of evidence) {
            try {
                await recordSnapshotFromEvidence({
                    evidenceId: e.id,
                    teamId: e.teamId,
                    verificationStatus: e.verificationStatus
                        ? String(e.verificationStatus)
                        : null,
                    tsaTokenBase64: e.tsaTokenBase64 ?? null,
                    tsaGenTimeUtc: e.tsaGenTimeUtc ?? null,
                    otsStatus: e.otsStatus ?? null,
                });
                persisted += 1;
            }
            catch {
                failed += 1;
            }
        }
    }
    catch {
        /* If the outer query itself fails we silently degrade. */
    }
    return { persisted, failed };
}
