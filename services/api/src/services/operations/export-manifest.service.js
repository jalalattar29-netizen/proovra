/**
 * Phase P2.1 — Immutable Export Manifest service.
 *
 * Generates a deterministic, operator-readable JSON manifest for every
 * operationally-significant export the platform produces today:
 *
 *   * Report PDF (one per `Report` row)
 *   * Verification Package ZIP (one per `VerificationPackage` row)
 *
 * Other export kinds (governance export, audit export, recovery
 * export) are surfaced as a SAFE EMPTY LIST today — they exist in
 * the codebase as routes / surfaces, but they do not yet persist a
 * row we can dereference to a stable artifact. The manifest endpoint
 * intentionally refuses to manufacture metadata for them rather than
 * pretend.
 *
 * The manifest is **a deterministic projection over current persisted
 * state**. Given the same row state + the same S3 object bytes, the
 * manifest's `manifestHash` is identical between calls. This is the
 * basis for the P2.1 reproducibility verifier.
 *
 * Hard rules:
 *   * No secrets in the manifest (no signing key material, no S3
 *     credentials).
 *   * No raw ip/userAgent telemetry.
 *   * Bounded `kind` enum.
 *   * Honest Object Lock surfacing: we read the actual
 *     `storageObjectLockMode` / `storageObjectLockRetainUntilUtc` /
 *     `storageObjectLockLegalHoldStatus` columns AND the platform-
 *     wide `verifyObjectLockConfiguration()` result so the operator
 *     sees both the per-object stored intent AND the bucket's actual
 *     capability.
 *   * Manifest is JSON-canonicalised before hashing (sorted keys,
 *     no trailing whitespace).
 */
import { createHash } from "node:crypto";
import { prisma as defaultPrisma } from "../../db.js";
import { verifyObjectLockConfiguration } from "../../storage.js";
// ---------------------------------------------------------------------------
// Bounded enums
// ---------------------------------------------------------------------------
export const EXPORT_KINDS = [
    "report_pdf",
    "verification_package_zip",
];
export const OBJECT_LOCK_PLATFORM_MODES = [
    "verified",
    "claimed-but-unsupported",
    "disabled",
    "skipped",
];
// ---------------------------------------------------------------------------
// Canonical JSON + hash
// ---------------------------------------------------------------------------
/**
 * Canonicalises an arbitrary JSON-serialisable value:
 *   * object keys sorted lexicographically at every depth
 *   * no extra whitespace
 *   * arrays preserved in order (operator decides ordering semantics)
 *
 * This is a small, audit-friendly implementation. We avoid bringing
 * in `json-canonicalize` to keep the dependency surface tight.
 */
export function canonicalJson(value) {
    return JSON.stringify(value, (_key, raw) => {
        if (raw === null || typeof raw !== "object")
            return raw;
        if (Array.isArray(raw))
            return raw;
        const obj = raw;
        const sorted = {};
        for (const k of Object.keys(obj).sort())
            sorted[k] = obj[k];
        return sorted;
    });
}
export function hashManifest(manifest) {
    return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}
// ---------------------------------------------------------------------------
// Export id encoding (route layer uses this)
// ---------------------------------------------------------------------------
const KIND_PREFIX = {
    report_pdf: "report",
    verification_package_zip: "vpkg",
};
export function encodeExportId(kind, rowId) {
    return `${KIND_PREFIX[kind]}:${rowId}`;
}
export function decodeExportId(exportId) {
    const [prefix, rest] = exportId.split(":", 2);
    if (!prefix || !rest)
        return null;
    const kindEntry = Object.entries(KIND_PREFIX).find(([, p]) => p === prefix);
    if (!kindEntry)
        return null;
    return { kind: kindEntry[0], rowId: rest };
}
export async function listExports(input, client = defaultPrisma) {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const kinds = input.kinds ?? EXPORT_KINDS;
    const out = [];
    if (kinds.includes("report_pdf")) {
        const reports = await client.report.findMany({
            where: { evidence: { teamId: input.teamId } },
            select: {
                id: true,
                evidenceId: true,
                version: true,
                sizeBytes: true,
                generatedAtUtc: true,
                storageObjectLockMode: true,
                pdfSignatureStatus: true,
                evidence: { select: { teamId: true } },
            },
            orderBy: { generatedAtUtc: "desc" },
            take: limit,
        });
        for (const r of reports) {
            out.push({
                exportId: encodeExportId("report_pdf", r.id),
                kind: "report_pdf",
                kindLabel: "Report PDF",
                exportVersion: r.version,
                evidenceId: r.evidenceId,
                teamId: r.evidence.teamId ?? input.teamId,
                generatedAtUtc: r.generatedAtUtc.toISOString(),
                sizeBytes: r.sizeBytes ? r.sizeBytes.toString() : null,
                objectLockStoredMode: normaliseObjectLockMode(r.storageObjectLockMode),
                artifactSigned: r.pdfSignatureStatus === "SIGNED",
            });
        }
    }
    if (kinds.includes("verification_package_zip")) {
        const packages = await client.verificationPackage.findMany({
            where: { evidence: { teamId: input.teamId } },
            select: {
                id: true,
                evidenceId: true,
                version: true,
                sizeBytes: true,
                generatedAtUtc: true,
                storageObjectLockMode: true,
                evidence: { select: { teamId: true } },
            },
            orderBy: { generatedAtUtc: "desc" },
            take: limit,
        });
        for (const p of packages) {
            out.push({
                exportId: encodeExportId("verification_package_zip", p.id),
                kind: "verification_package_zip",
                kindLabel: "Verification Package",
                exportVersion: p.version,
                evidenceId: p.evidenceId,
                teamId: p.evidence.teamId ?? input.teamId,
                generatedAtUtc: p.generatedAtUtc.toISOString(),
                sizeBytes: p.sizeBytes ? p.sizeBytes.toString() : null,
                objectLockStoredMode: normaliseObjectLockMode(p.storageObjectLockMode),
                artifactSigned: false,
            });
        }
    }
    return out
        .sort((a, b) => b.generatedAtUtc.localeCompare(a.generatedAtUtc))
        .slice(0, limit);
}
export async function resolveExportManifest(input, client = defaultPrisma) {
    const decoded = decodeExportId(input.exportId);
    if (!decoded) {
        return { ok: false, code: "not_found", message: "Unknown export id." };
    }
    const objectLockResult = await verifyObjectLockConfiguration();
    const platformMode = objectLockResult.mode === "verified"
        ? "verified"
        : objectLockResult.mode === "claimed-but-unsupported"
            ? "claimed-but-unsupported"
            : objectLockResult.mode === "disabled"
                ? "disabled"
                : "skipped";
    if (decoded.kind === "report_pdf") {
        const r = await client.report.findFirst({
            where: { id: decoded.rowId, evidence: { teamId: input.teamId } },
            select: {
                id: true,
                evidenceId: true,
                version: true,
                sizeBytes: true,
                generatedAtUtc: true,
                storageBucket: true,
                storageKey: true,
                storageRegion: true,
                storageObjectLockMode: true,
                storageObjectLockRetainUntilUtc: true,
                storageObjectLockLegalHoldStatus: true,
                pdfSignatureStatus: true,
                pdfSignerKeyId: true,
                pdfSignedAtUtc: true,
                evidence: { select: { teamId: true, organizationId: true } },
            },
        });
        if (!r)
            return { ok: false, code: "not_found", message: "Export not found." };
        const manifest = {
            manifestVersion: 1,
            kind: "report_pdf",
            exportId: encodeExportId("report_pdf", r.id),
            exportVersion: r.version,
            kindLabel: "Report PDF",
            evidenceId: r.evidenceId,
            teamId: r.evidence.teamId ?? input.teamId,
            organizationId: r.evidence.organizationId ?? null,
            generatedAtUtc: r.generatedAtUtc.toISOString(),
            artifact: {
                storageBucket: r.storageBucket,
                storageKey: r.storageKey,
                storageRegion: r.storageRegion ?? null,
                sizeBytes: r.sizeBytes ? r.sizeBytes.toString() : null,
                contentType: "application/pdf",
            },
            objectLock: {
                platformMode,
                storedMode: normaliseObjectLockMode(r.storageObjectLockMode),
                storedRetainUntilUtc: r.storageObjectLockRetainUntilUtc
                    ? r.storageObjectLockRetainUntilUtc.toISOString()
                    : null,
                storedLegalHoldStatus: normaliseLegalHold(r.storageObjectLockLegalHoldStatus),
            },
            signing: {
                artifactSigned: r.pdfSignatureStatus === "SIGNED",
                artifactSigningKeyId: r.pdfSignerKeyId ?? null,
                artifactSignedAtUtc: r.pdfSignedAtUtc ? r.pdfSignedAtUtc.toISOString() : null,
                artifactUnsignedOptOut: r.pdfSignatureStatus === "UNSIGNED_OPT_OUT",
            },
            reproducibility: {
                deterministicProjection: true,
                sourceFields: REPORT_SOURCE_FIELDS,
            },
        };
        return { ok: true, envelope: buildEnvelope(manifest) };
    }
    if (decoded.kind === "verification_package_zip") {
        const p = await client.verificationPackage.findFirst({
            where: { id: decoded.rowId, evidence: { teamId: input.teamId } },
            select: {
                id: true,
                evidenceId: true,
                version: true,
                sizeBytes: true,
                generatedAtUtc: true,
                storageBucket: true,
                storageKey: true,
                storageRegion: true,
                storageObjectLockMode: true,
                storageObjectLockRetainUntilUtc: true,
                storageObjectLockLegalHoldStatus: true,
                evidence: { select: { teamId: true, organizationId: true } },
            },
        });
        if (!p)
            return { ok: false, code: "not_found", message: "Export not found." };
        const manifest = {
            manifestVersion: 1,
            kind: "verification_package_zip",
            exportId: encodeExportId("verification_package_zip", p.id),
            exportVersion: p.version,
            kindLabel: "Verification Package",
            evidenceId: p.evidenceId,
            teamId: p.evidence.teamId ?? input.teamId,
            organizationId: p.evidence.organizationId ?? null,
            generatedAtUtc: p.generatedAtUtc.toISOString(),
            artifact: {
                storageBucket: p.storageBucket,
                storageKey: p.storageKey,
                storageRegion: p.storageRegion ?? null,
                sizeBytes: p.sizeBytes ? p.sizeBytes.toString() : null,
                contentType: "application/zip",
            },
            objectLock: {
                platformMode,
                storedMode: normaliseObjectLockMode(p.storageObjectLockMode),
                storedRetainUntilUtc: p.storageObjectLockRetainUntilUtc
                    ? p.storageObjectLockRetainUntilUtc.toISOString()
                    : null,
                storedLegalHoldStatus: normaliseLegalHold(p.storageObjectLockLegalHoldStatus),
            },
            signing: {
                artifactSigned: false,
                artifactSigningKeyId: null,
                artifactSignedAtUtc: null,
                artifactUnsignedOptOut: false,
            },
            reproducibility: {
                deterministicProjection: true,
                sourceFields: VPKG_SOURCE_FIELDS,
            },
        };
        return { ok: true, envelope: buildEnvelope(manifest) };
    }
    return { ok: false, code: "not_found", message: "Unknown export id." };
}
function buildEnvelope(manifest) {
    return {
        manifest,
        manifestHash: hashManifest(manifest),
        generatedAtUtc: new Date().toISOString(),
    };
}
const REPORT_SOURCE_FIELDS = [
    "Report.id",
    "Report.version",
    "Report.generatedAtUtc",
    "Report.storageBucket",
    "Report.storageKey",
    "Report.storageRegion",
    "Report.sizeBytes",
    "Report.storageObjectLockMode",
    "Report.storageObjectLockRetainUntilUtc",
    "Report.storageObjectLockLegalHoldStatus",
    "Report.pdfSignatureStatus",
    "Report.pdfSignerKeyId",
    "Report.pdfSignedAtUtc",
    "Evidence.teamId",
    "Evidence.organizationId",
];
const VPKG_SOURCE_FIELDS = [
    "VerificationPackage.id",
    "VerificationPackage.version",
    "VerificationPackage.generatedAtUtc",
    "VerificationPackage.storageBucket",
    "VerificationPackage.storageKey",
    "VerificationPackage.storageRegion",
    "VerificationPackage.sizeBytes",
    "VerificationPackage.storageObjectLockMode",
    "VerificationPackage.storageObjectLockRetainUntilUtc",
    "VerificationPackage.storageObjectLockLegalHoldStatus",
    "Evidence.teamId",
    "Evidence.organizationId",
];
function normaliseObjectLockMode(raw) {
    if (raw === "GOVERNANCE" || raw === "COMPLIANCE")
        return raw;
    return null;
}
function normaliseLegalHold(raw) {
    if (raw === "ON" || raw === "OFF")
        return raw;
    return null;
}
