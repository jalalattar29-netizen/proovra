import { createHash } from "node:crypto";

/** PostgreSQL advisory lock id for serializing admin audit log inserts (global chain). */
export const ADMIN_AUDIT_ADVISORY_LOCK_KEY = 918_273_641;

const CANONICAL_JSON_MAX_DEPTH = 8;
export const METADATA_MAX_DEPTH_DEFAULT = 8;

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
    return value.map((v) =>
      sortJsonValueForAuditChain(v, depth + 1, maxDepth)
    );
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

export function auditLogHashUserSegment(
  userId: string | null | undefined
): string {
  return userId ?? "";
}

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

type AuditHashParamsV1 = {
  userId: string | null;
  action: string;
  metadataCanonical: string;
  createdAtIso: string;
  prevHash: string | null;
};

type AuditHashParamsV2 = AuditHashParamsV1 & {
  category: string | null;
  severity: string | null;
  source: string | null;
  outcome: string | null;
  resourceType: string | null;
  resourceId: string | null;
  requestId: string | null;
};

function computeAuditLogChainHashV1(params: AuditHashParamsV1): string {
  const segment = auditLogHashUserSegment(params.userId);
  const prev = params.prevHash ?? "";
  const input = `${segment}${params.action}${params.metadataCanonical}${params.createdAtIso}${prev}`;

  return createHash("sha256").update(input, "utf8").digest("hex");
}

function computeAuditLogChainHashV2(params: AuditHashParamsV2): string {
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

export function computeAuditLogChainHash(
  params:
    | ({ chainVersion?: 1 | null } & AuditHashParamsV1)
    | ({ chainVersion: 2 } & AuditHashParamsV2)
): string {
  if (params.chainVersion === 2) {
    return computeAuditLogChainHashV2(params);
  }

  return computeAuditLogChainHashV1(params);
}