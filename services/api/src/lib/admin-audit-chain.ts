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

// PHASE 11 §1 — V3 hash-BINDS the authoritative tenant scope. The
// organizationId/workspaceId columns are the query authority for tenant
// isolation, so they MUST be inside the tamper-evident hash: modifying either
// column breaks verification. V3 is the ONLY new write format; V1/V2 rows are
// historical/immutable and verified with their own algorithm.
type AuditHashParamsV3 = AuditHashParamsV2 & {
  organizationId: string | null;
  workspaceId: string | null;
};

/**
 * PHASE 5 — V4 seals the identity and transition contract.
 *
 * The attribution columns could have been added the way the tenant columns
 * first were: stored, but outside the hash. That was reconsidered when V3
 * bound the tenant scope, and the same argument applies with more force here.
 * An audit row exists to be believed. A field that says WHO ACTED and WHAT
 * CHANGED, which an attacker with write access could edit while every hashed
 * field around it stayed valid, is worse than an absent field — verification
 * would pass and the record would lie.
 *
 * So V4 hashes them. V1–V3 rows are never rehashed; each row is still verified
 * with the algorithm of its own `chainVersion`, and the chain links across
 * versions through `prevHash`.
 */
type AuditHashParamsV4 = AuditHashParamsV3 & {
  actorType: string | null;
  actorDisplay: string | null;
  actorAuthority: string | null;
  targetDisplay: string | null;
  previousState: string | null;
  requestedState: string | null;
  resultingState: string | null;
  reasonCode: string | null;
  eventVersion: number;
};

// Deterministic null representation for hashed nullable scope columns.
const NULL_SCOPE = "\0";

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

function computeAuditLogChainHashV3(params: AuditHashParamsV3): string {
  const segment = auditLogHashUserSegment(params.userId);
  const prev = params.prevHash ?? "";

  const input = [
    "v3",
    segment,
    params.action,
    params.category ?? "",
    params.severity ?? "",
    params.source ?? "",
    params.outcome ?? "",
    params.resourceType ?? "",
    params.resourceId ?? "",
    // AUTHORITATIVE tenant scope — bound into the hash (§1).
    params.organizationId ?? NULL_SCOPE,
    params.workspaceId ?? NULL_SCOPE,
    params.requestId ?? "",
    params.metadataCanonical,
    params.createdAtIso,
    prev,
  ].join("|");

  return createHash("sha256").update(input, "utf8").digest("hex");
}

function computeAuditLogChainHashV4(params: AuditHashParamsV4): string {
  const segment = auditLogHashUserSegment(params.userId);
  const prev = params.prevHash ?? "";

  const input = [
    "v4",
    segment,
    params.action,
    params.category ?? "",
    params.severity ?? "",
    params.source ?? "",
    params.outcome ?? "",
    params.resourceType ?? "",
    params.resourceId ?? "",
    params.organizationId ?? NULL_SCOPE,
    params.workspaceId ?? NULL_SCOPE,
    params.requestId ?? "",
    // PHASE 5 — the identity and transition contract, sealed (§3).
    params.actorType ?? NULL_SCOPE,
    params.actorDisplay ?? NULL_SCOPE,
    params.actorAuthority ?? NULL_SCOPE,
    params.targetDisplay ?? NULL_SCOPE,
    params.previousState ?? NULL_SCOPE,
    params.requestedState ?? NULL_SCOPE,
    params.resultingState ?? NULL_SCOPE,
    params.reasonCode ?? NULL_SCOPE,
    String(params.eventVersion),
    params.metadataCanonical,
    params.createdAtIso,
    prev,
  ].join("|");

  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * The ONE version-aware hasher. Supports a continuous mixed V1→V2→V3→V4 chain:
 * each row is verified with the algorithm of its own `chainVersion`, and the
 * chain links across versions via `prevHash`. V4 is the only format written now.
 */
export function computeAuditLogChainHash(
  params:
    | ({ chainVersion?: 1 | null } & AuditHashParamsV1)
    | ({ chainVersion: 2 } & AuditHashParamsV2)
    | ({ chainVersion: 3 } & AuditHashParamsV3)
    | ({ chainVersion: 4 } & AuditHashParamsV4)
): string {
  if (params.chainVersion === 4) {
    return computeAuditLogChainHashV4(params);
  }
  if (params.chainVersion === 3) {
    return computeAuditLogChainHashV3(params);
  }
  if (params.chainVersion === 2) {
    return computeAuditLogChainHashV2(params);
  }

  return computeAuditLogChainHashV1(params);
}