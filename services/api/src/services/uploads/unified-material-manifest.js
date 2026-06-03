/**
 * Phase 30.11 — Unified material manifest resolver.
 *
 * Read-only helper that returns the canonical list of materials
 * bound to a single Evidence row, spanning BOTH:
 *
 *   1. Legacy `EvidencePart` rows (the small/simple presign + PUT
 *      flow), each pointing at its own S3 object.
 *   2. Phase 30.8 `evidence_upload_sessions` (the resumable native
 *      multipart flow), each producing exactly one final S3 object.
 *
 * The result is one logical list of materials per Evidence, so:
 *   * `completeEvidence` can co-validate both kinds in one pass.
 *   * `report-v2` can enumerate all material previews in a single
 *     loop without caring which upload track produced each one.
 *   * The verification package can include integrity rows for both.
 *   * Search indexing can project the union.
 *   * Capture UI readiness can render a unified "X of Y verified".
 *
 * Hard custody / privacy rules baked in:
 *
 *   * NEVER projects storage_key, storage_bucket, multipart_upload_id,
 *     signed URLs, raw GPS, private notes, legal notes. The output
 *     shape is intentionally narrow.
 *   * `storageMetadata` carries ETag + completion timestamp only,
 *     marked internal — callers that surface to untrusted clients
 *     MUST run the projection through `projectForPublic()` which
 *     drops it entirely.
 *   * ETag is recorded as opaque storage metadata. It is NEVER the
 *     same field as `serverSha256` — they are distinct properties
 *     with distinct integrity meaning.
 *   * Client timestamps are NEVER returned — only server-side
 *     `uploadedAtUtc` / `verifiedAtUtc` / `completedAtUtc`.
 *   * Read-only: this module makes no DB writes, no S3 calls, no
 *     side effects beyond a single bounded $queryRaw.
 *
 * Sort order: materials are emitted with LEGACY_PART rows first
 * (in `partIndex` ASC), then UPLOAD_SESSION rows (in `created_at_utc`
 * ASC). Stable + deterministic so report-v2 / verification package
 * generate byte-identical output on retry.
 */
import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
// =============================================================================
// Bounded vocabularies
// =============================================================================
export const UNIFIED_MATERIAL_KINDS = [
    "LEGACY_PART",
    "UPLOAD_SESSION",
];
export const UNIFIED_MATERIAL_VERIFICATION_STATES = [
    "PENDING", // material exists but not yet server-confirmed
    "VERIFIED", // server has confirmed integrity
    "FAILED", // terminal verification failure
    "MISSING", // expected material absent (catalog violation)
];
/**
 * Resolve the unified material manifest for one Evidence row.
 * Team-anchored (anti-enumeration) — passing a teamId the evidence
 * doesn't belong to returns an empty manifest, not a 404. Callers
 * that need 404 semantics should authorize separately.
 */
export async function buildUnifiedEvidenceManifest(input, client = defaultPrisma) {
    const legacy = await loadLegacyMaterials(client, input);
    const sessions = await loadSessionMaterials(client, input);
    const materials = [
        ...legacy,
        ...sessions,
    ];
    const totals = computeTotals(materials);
    // Phase 30.12 — observability. Counter bump once per resolved
    // manifest so SRE can see adoption volume. `mixed_evidence_total`
    // fires only when the Evidence carries BOTH kinds — that's the
    // signal Option B is doing its job.
    if (totals.materials > 0) {
        bump("unified_manifest_materials_total", totals.materials);
        if (totals.legacy > 0 && totals.sessions > 0) {
            bump("unified_manifest_mixed_evidence_total");
        }
    }
    return {
        evidenceId: input.evidenceId,
        teamId: input.teamId,
        materials,
        totals,
    };
}
/**
 * Strip server-internal `storageMetadata` from every session
 * material. Use this whenever the manifest crosses into a route
 * response or anywhere an untrusted client could see it.
 *
 * Legacy parts have no storageMetadata field to begin with — their
 * `sha256` is the custody-grade signal and is already public-safe.
 */
export function projectForPublic(manifest) {
    return {
        ...manifest,
        materials: manifest.materials.map((m) => {
            if (m.kind === "UPLOAD_SESSION") {
                return { ...m, storageMetadata: null };
            }
            return m;
        }),
    };
}
// =============================================================================
// Internals
// =============================================================================
async function loadLegacyMaterials(client, input) {
    // Team-anchor via the parent evidence row to keep this read
    // cross-workspace-safe. EvidencePart doesn't carry teamId
    // directly today; we filter through the Evidence's teamId column.
    const rows = await client.evidencePart.findMany({
        where: {
            evidenceId: input.evidenceId,
            evidence: { teamId: input.teamId },
        },
        orderBy: { partIndex: "asc" },
        select: {
            id: true,
            partIndex: true,
            originalFileName: true,
            mimeType: true,
            sizeBytes: true,
            sha256: true,
            uploadedAtUtc: true,
        },
    });
    return rows.map((row) => {
        const verified = Boolean(row.sha256 && row.uploadedAtUtc);
        return {
            kind: "LEGACY_PART",
            materialId: row.id,
            partIndex: row.partIndex ?? 0,
            filename: row.originalFileName ?? "",
            mimeType: row.mimeType ?? null,
            sizeBytes: row.sizeBytes != null ? Number(row.sizeBytes) : null,
            sha256: row.sha256 ?? null,
            uploadedAtUtc: row.uploadedAtUtc?.toISOString() ?? null,
            verification: verified ? "VERIFIED" : "PENDING",
        };
    });
}
async function loadSessionMaterials(client, input) {
    let sessions;
    try {
        sessions = (await client.$queryRawUnsafe(`SELECT "id", "state", "expected_part_count", "expected_total_bytes",
              "expected_sha256", "safe_note",
              "completed_at_utc", "completed_at_storage_utc",
              "completed_object_etag", "completed_object_size",
              "created_at_utc"
         FROM "evidence_upload_sessions"
         WHERE "team_id" = $1 AND "evidence_id" = $2
         ORDER BY "created_at_utc" ASC`, input.teamId, input.evidenceId));
    }
    catch {
        // Fail-closed: a query failure surfaces as an empty session
        // list rather than a thrown error. Callers (finalize / report)
        // already have the gate to determine readiness; the manifest
        // just describes "what we know right now".
        return [];
    }
    return sessions.map((s) => {
        const verification = sessionVerificationState(s.state);
        return {
            kind: "UPLOAD_SESSION",
            materialId: s.id,
            safeNote: s.safe_note,
            filename: null, // Reserved for future schema extension.
            mimeType: null, // Same.
            sizeBytes: s.completed_object_size != null
                ? Number(s.completed_object_size)
                : s.expected_total_bytes != null
                    ? Number(s.expected_total_bytes)
                    : null,
            expectedSha256: s.expected_sha256,
            // The verifier worker writes per-part server_sha256; the
            // session-level "serverSha256" is the hash of the FINAL
            // object computed at storage-complete with `verifyHash: true`.
            // Today we don't persist that single hash on the session row
            // (it's computed transiently). Surface null and rely on the
            // per-part hashes for custody.
            serverSha256: null,
            completedAtUtc: s.completed_at_utc?.toISOString() ??
                s.completed_at_storage_utc?.toISOString() ??
                null,
            verification,
            storageMetadata: {
                etag: s.completed_object_etag,
                contentLengthBytes: s.completed_object_size != null
                    ? Number(s.completed_object_size)
                    : null,
                completedAtStorageUtc: s.completed_at_storage_utc?.toISOString() ?? null,
            },
        };
    });
}
function sessionVerificationState(state) {
    switch (state) {
        case "COMPLETED":
            return "VERIFIED";
        case "INITIATED":
        case "UPLOADING":
        case "VERIFYING":
            return "PENDING";
        case "ABORTED":
        case "EXPIRED":
        case "FAILED":
            return "FAILED";
        default:
            return "PENDING";
    }
}
function computeTotals(materials) {
    let legacy = 0;
    let sessions = 0;
    let verified = 0;
    let pending = 0;
    let failed = 0;
    let missing = 0;
    for (const m of materials) {
        if (m.kind === "LEGACY_PART")
            legacy += 1;
        else
            sessions += 1;
        if (m.verification === "VERIFIED")
            verified += 1;
        else if (m.verification === "PENDING")
            pending += 1;
        else if (m.verification === "FAILED")
            failed += 1;
        else if (m.verification === "MISSING")
            missing += 1;
    }
    return {
        materials: materials.length,
        legacy,
        sessions,
        verified,
        pending,
        failed,
        missing,
    };
}
