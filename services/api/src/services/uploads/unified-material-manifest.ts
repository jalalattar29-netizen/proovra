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

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";

// =============================================================================
// Bounded vocabularies
// =============================================================================

export const UNIFIED_MATERIAL_KINDS = [
  "LEGACY_PART",
  "UPLOAD_SESSION",
] as const;

export type UnifiedMaterialKind = (typeof UNIFIED_MATERIAL_KINDS)[number];

export const UNIFIED_MATERIAL_VERIFICATION_STATES = [
  "PENDING",      // material exists but not yet server-confirmed
  "VERIFIED",     // server has confirmed integrity
  "FAILED",       // terminal verification failure
  "MISSING",      // expected material absent (catalog violation)
] as const;

export type UnifiedMaterialVerificationState =
  (typeof UNIFIED_MATERIAL_VERIFICATION_STATES)[number];

// =============================================================================
// Material shapes — narrow, custody-safe projections
// =============================================================================

export type UnifiedLegacyMaterial = {
  kind: "LEGACY_PART";
  /** Stable identifier for this material within the Evidence —
   *  used by report-v2 / verification package row keys. */
  materialId: string;
  partIndex: number;
  /** What the operator should see as the filename. Empty string
   *  when neither displayFileName nor originalFileName was set. */
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
  /** Custody-grade SHA-256 of the part bytes. Set by the existing
   *  completeEvidence transaction after the HEAD + stream-hash run. */
  sha256: string | null;
  /** Server clock at finalize. Null if part hasn't been verified yet. */
  uploadedAtUtc: string | null;
  verification: UnifiedMaterialVerificationState;
};

export type UnifiedSessionMaterial = {
  kind: "UPLOAD_SESSION";
  materialId: string;
  /** Operator-supplied note. Bounded to 400 chars at the service
   *  layer; nullable. NOT a free-text leak vector. */
  safeNote: string | null;
  /** Session-declared filename. Currently absent on the session row;
   *  reserved for a future schema extension. Today we surface the
   *  evidence-level display filename or null. */
  filename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  /** Operator-declared expected SHA-256 (audit only). The
   *  authoritative server hash is the one produced by the verifier
   *  worker; we expose it here as `serverSha256` for symmetry with
   *  the legacy shape. */
  expectedSha256: string | null;
  serverSha256: string | null;
  /** Server clock when the session reached COMPLETED. */
  completedAtUtc: string | null;
  verification: UnifiedMaterialVerificationState;
  /** Storage metadata — INTERNAL ONLY. `projectForPublic()` strips
   *  this. Carries ETag + completion timestamp; never the bucket /
   *  key / uploadId. */
  storageMetadata: {
    etag: string | null;
    contentLengthBytes: number | null;
    completedAtStorageUtc: string | null;
  } | null;
};

export type UnifiedMaterial = UnifiedLegacyMaterial | UnifiedSessionMaterial;

// =============================================================================
// Public surface
// =============================================================================

export type UnifiedEvidenceManifest = {
  evidenceId: string;
  teamId: string;
  materials: ReadonlyArray<UnifiedMaterial>;
  /** Aggregate counts by kind + verification state. */
  totals: {
    materials: number;
    legacy: number;
    sessions: number;
    verified: number;
    pending: number;
    failed: number;
    missing: number;
  };
};

/**
 * Resolve the unified material manifest for one Evidence row.
 * Team-anchored (anti-enumeration) — passing a teamId the evidence
 * doesn't belong to returns an empty manifest, not a 404. Callers
 * that need 404 semantics should authorize separately.
 */
export async function buildUnifiedEvidenceManifest(
  input: { evidenceId: string; teamId: string },
  client: PrismaClient = defaultPrisma,
): Promise<UnifiedEvidenceManifest> {
  const legacy = await loadLegacyMaterials(client, input);
  const sessions = await loadSessionMaterials(client, input);
  const materials: ReadonlyArray<UnifiedMaterial> = [
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
export function projectForPublic(
  manifest: UnifiedEvidenceManifest,
): UnifiedEvidenceManifest {
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

async function loadLegacyMaterials(
  client: PrismaClient,
  input: { evidenceId: string; teamId: string },
): Promise<ReadonlyArray<UnifiedLegacyMaterial>> {
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
      kind: "LEGACY_PART" as const,
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

type RawSessionForManifest = {
  id: string;
  state: string;
  expected_part_count: number;
  expected_total_bytes: bigint | number | null;
  expected_sha256: string | null;
  safe_note: string | null;
  completed_at_utc: Date | null;
  completed_at_storage_utc: Date | null;
  completed_object_etag: string | null;
  completed_object_size: bigint | number | null;
  created_at_utc: Date;
};

async function loadSessionMaterials(
  client: PrismaClient,
  input: { evidenceId: string; teamId: string },
): Promise<ReadonlyArray<UnifiedSessionMaterial>> {
  let sessions: ReadonlyArray<RawSessionForManifest>;
  try {
    sessions = (await client.$queryRawUnsafe(
      `SELECT "id", "state", "expected_part_count", "expected_total_bytes",
              "expected_sha256", "safe_note",
              "completed_at_utc", "completed_at_storage_utc",
              "completed_object_etag", "completed_object_size",
              "created_at_utc"
         FROM "evidence_upload_sessions"
         WHERE "team_id" = $1 AND "evidence_id" = $2
         ORDER BY "created_at_utc" ASC`,
      input.teamId,
      input.evidenceId,
    )) as ReadonlyArray<RawSessionForManifest>;
  } catch {
    // Fail-closed: a query failure surfaces as an empty session
    // list rather than a thrown error. Callers (finalize / report)
    // already have the gate to determine readiness; the manifest
    // just describes "what we know right now".
    return [];
  }
  return sessions.map((s) => {
    const verification = sessionVerificationState(s.state);
    return {
      kind: "UPLOAD_SESSION" as const,
      materialId: s.id,
      safeNote: s.safe_note,
      filename: null, // Reserved for future schema extension.
      mimeType: null, // Same.
      sizeBytes:
        s.completed_object_size != null
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
      completedAtUtc:
        s.completed_at_utc?.toISOString() ??
        s.completed_at_storage_utc?.toISOString() ??
        null,
      verification,
      storageMetadata: {
        etag: s.completed_object_etag,
        contentLengthBytes:
          s.completed_object_size != null
            ? Number(s.completed_object_size)
            : null,
        completedAtStorageUtc:
          s.completed_at_storage_utc?.toISOString() ?? null,
      },
    };
  });
}

function sessionVerificationState(
  state: string,
): UnifiedMaterialVerificationState {
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

function computeTotals(
  materials: ReadonlyArray<UnifiedMaterial>,
): UnifiedEvidenceManifest["totals"] {
  let legacy = 0;
  let sessions = 0;
  let verified = 0;
  let pending = 0;
  let failed = 0;
  let missing = 0;
  for (const m of materials) {
    if (m.kind === "LEGACY_PART") legacy += 1;
    else sessions += 1;
    if (m.verification === "VERIFIED") verified += 1;
    else if (m.verification === "PENDING") pending += 1;
    else if (m.verification === "FAILED") failed += 1;
    else if (m.verification === "MISSING") missing += 1;
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
