import { createHash } from "node:crypto";
/** PostgreSQL advisory lock id for serializing admin audit log inserts (global chain). */
export const ADMIN_AUDIT_ADVISORY_LOCK_KEY = 918_273_641;
const CANONICAL_JSON_MAX_DEPTH = 8;
export const METADATA_MAX_DEPTH_DEFAULT = 8;
export function sortJsonValueForAuditChain(value, depth, maxDepth = CANONICAL_JSON_MAX_DEPTH) {
    if (depth > maxDepth)
        return "[max_depth]";
    if (value === null || typeof value !== "object") {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((v) => sortJsonValueForAuditChain(v, depth + 1, maxDepth));
    }
    const obj = value;
    const keys = Object.keys(obj).sort();
    const out = {};
    for (const k of keys) {
        out[k] = sortJsonValueForAuditChain(obj[k], depth + 1, maxDepth);
    }
    return out;
}
export function canonicalJsonForAuditHash(metadata) {
    const sorted = sortJsonValueForAuditChain(metadata, 0);
    return JSON.stringify(sorted);
}
export function auditLogHashUserSegment(userId) {
    return userId ?? "";
}
export function assertMetadataMaxDepth(value, maxDepth = METADATA_MAX_DEPTH_DEFAULT) {
    function walk(v, d) {
        if (d > maxDepth) {
            throw new Error("METADATA_DEPTH_EXCEEDED");
        }
        if (v === null || typeof v !== "object")
            return;
        if (Array.isArray(v)) {
            for (const el of v)
                walk(el, d + 1);
            return;
        }
        for (const k of Object.keys(v)) {
            walk(v[k], d + 1);
        }
    }
    walk(value, 0);
}
function computeAuditLogChainHashV1(params) {
    const segment = auditLogHashUserSegment(params.userId);
    const prev = params.prevHash ?? "";
    const input = `${segment}${params.action}${params.metadataCanonical}${params.createdAtIso}${prev}`;
    return createHash("sha256").update(input, "utf8").digest("hex");
}
function computeAuditLogChainHashV2(params) {
    const segment = auditLogHashUserSegment(params.userId);
    const prev = params.prevHash ?? "";
    const input = [
        "v2",
        segment,
        params.action,
        params.category ?? "",
        params.severity ?? "",
        params.source ?? "",
        params.outcome ?? "",
        params.resourceType ?? "",
        params.resourceId ?? "",
        params.requestId ?? "",
        params.metadataCanonical,
        params.createdAtIso,
        prev,
    ].join("|");
    return createHash("sha256").update(input, "utf8").digest("hex");
}
export function computeAuditLogChainHash(params) {
    if (params.chainVersion === 2) {
        return computeAuditLogChainHashV2(params);
    }
    return computeAuditLogChainHashV1(params);
}
