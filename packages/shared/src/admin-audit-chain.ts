import { createHash } from "node:crypto";

/** PostgreSQL advisory lock id for serializing admin audit log inserts (global chain). */
export const ADMIN_AUDIT_ADVISORY_LOCK_KEY = 918_273_641;

const CANONICAL_JSON_MAX_DEPTH = 8;

/**
 * Recursively sort object keys for stable JSON hashing (same rules for write + verify).
 */
export function sortJsonValueForAuditChain(
  value: unknown,
  depth: number,
  maxDepth: number = CANONICAL_JSON_MAX_DEPTH
): unknown {
  if (depth > maxDepth) return "[max_depth]";
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => sortJsonValueForAuditChain(v, depth + 1, maxDepth));
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    out[k] = sortJsonValueForAuditChain(obj[k], depth + 1, maxDepth);
  }
  return out;
}

export function canonicalJsonForAuditHash(metadata: unknown): string {
  const sorted = sortJsonValueForAuditChain(metadata, 0);
  return JSON.stringify(sorted);
}

/**
 * Segment mixed into the hash (DB `user_id` TEXT NULL → empty string).
 */
export function auditLogHashUserSegment(userId: string | null | undefined): string {
  return userId ?? "";
}

export function computeAuditLogChainHash(params: {
  userId: string | null;
  action: string;
  metadataCanonical: string;
  createdAtIso: string;
  prevHash: string | null;
}): string {
  const segment = auditLogHashUserSegment(params.userId);
  const prev = params.prevHash ?? "";
  const input = `${segment}${params.action}${params.metadataCanonical}${params.createdAtIso}${prev}`;
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export const METADATA_MAX_DEPTH_DEFAULT = 8;

/**
 * Throws if object/array nesting exceeds maxDepth (root depth = 0).
 */
export function assertMetadataMaxDepth(
  value: unknown,
  maxDepth: number = METADATA_MAX_DEPTH_DEFAULT
): void {
  function walk(v: unknown, d: number): void {
    if (d > maxDepth) {
      throw new Error("METADATA_DEPTH_EXCEEDED");
    }
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const el of v) walk(el, d + 1);
      return;
    }
    for (const k of Object.keys(v as object)) {
      walk((v as Record<string, unknown>)[k], d + 1);
    }
  }
  walk(value, 0);
}
