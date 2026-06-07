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

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { verifyObjectLockConfiguration } from "../../storage.js";

// ---------------------------------------------------------------------------
// Bounded enums
// ---------------------------------------------------------------------------

export const EXPORT_KINDS = [
  "report_pdf",
  "verification_package_zip",
] as const;

export type ExportKind = (typeof EXPORT_KINDS)[number];

export const OBJECT_LOCK_PLATFORM_MODES = [
  "verified",
  "claimed-but-unsupported",
  "disabled",
  "skipped",
] as const;

export type ObjectLockPlatformMode = (typeof OBJECT_LOCK_PLATFORM_MODES)[number];

// ---------------------------------------------------------------------------
// Manifest shape (canonical)
// ---------------------------------------------------------------------------

export type ExportManifest = {
  /** Schema version. Bump only when the canonical shape changes. */
  manifestVersion: 1;
  kind: ExportKind;
  /** Synthetic composite id (`report:<uuid>` or `vpkg:<uuid>`). */
  exportId: string;
  /** Numeric version of the underlying row (Report.version / VerificationPackage.version). */
  exportVersion: number;
  /** Operator-readable kind label. */
  kindLabel: string;

  evidenceId: string;
  teamId: string;
  organizationId: string | null;

  generatedAtUtc: string;

  artifact: {
    storageBucket: string;
    storageKey: string;
    storageRegion: string | null;
    sizeBytes: string | null;
    contentType: string;
  };

  objectLock: {
    /** Platform-wide capability — derived from `verifyObjectLockConfiguration()`. */
    platformMode: ObjectLockPlatformMode;
    /** The Object Lock metadata persisted on the export row at PUT time. */
    storedMode: "GOVERNANCE" | "COMPLIANCE" | null;
    storedRetainUntilUtc: string | null;
    storedLegalHoldStatus: "ON" | "OFF" | null;
  };

  signing: {
    /** True when the artifact itself carries a cryptographic signature
     *  (PDF signing for reports today). */
    artifactSigned: boolean;
    artifactSigningKeyId: string | null;
    artifactSignedAtUtc: string | null;
    /** True when the artifact is the unsigned-opt-out path. */
    artifactUnsignedOptOut: boolean;
  };

  reproducibility: {
    /** Always true for the kinds we surface — the manifest is a
     *  deterministic projection. */
    deterministicProjection: true;
    /** Field names in the projection. Order is stable; the canonical
     *  hash is computed AFTER alphabetising. */
    sourceFields: ReadonlyArray<string>;
  };
};

export type ExportManifestEnvelope = {
  manifest: ExportManifest;
  /** SHA-256 of the canonical JSON serialisation. */
  manifestHash: string;
  /** ISO timestamp of when this envelope was assembled. NOT part of
   *  the canonical manifest — separate field so re-runs produce the
   *  same `manifest` + `manifestHash`. */
  generatedAtUtc: string;
};

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
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, raw) => {
    if (raw === null || typeof raw !== "object") return raw;
    if (Array.isArray(raw)) return raw;
    const obj = raw as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
    return sorted;
  });
}

export function hashManifest(manifest: ExportManifest): string {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

// ---------------------------------------------------------------------------
// Export id encoding (route layer uses this)
// ---------------------------------------------------------------------------

const KIND_PREFIX: Record<ExportKind, string> = {
  report_pdf: "report",
  verification_package_zip: "vpkg",
};

export function encodeExportId(kind: ExportKind, rowId: string): string {
  return `${KIND_PREFIX[kind]}:${rowId}`;
}

export function decodeExportId(
  exportId: string,
): { kind: ExportKind; rowId: string } | null {
  const [prefix, rest] = exportId.split(":", 2);
  if (!prefix || !rest) return null;
  const kindEntry = (Object.entries(KIND_PREFIX) as Array<[ExportKind, string]>).find(
    ([, p]) => p === prefix,
  );
  if (!kindEntry) return null;
  return { kind: kindEntry[0], rowId: rest };
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export type ExportListItem = {
  exportId: string;
  kind: ExportKind;
  kindLabel: string;
  exportVersion: number;
  evidenceId: string;
  teamId: string;
  generatedAtUtc: string;
  sizeBytes: string | null;
  objectLockStoredMode: "GOVERNANCE" | "COMPLIANCE" | null;
  artifactSigned: boolean;
  artifactSigningKeyId: string | null;
  artifactSignedAtUtc: string | null;
  artifactUnsignedOptOut: boolean;
  artifactSigningWarning: string | null;
  verificationPackageSignatureStatus: "SIGNED" | "UNSIGNED" | "NOT_APPLICABLE";
};

export async function listExports(
  input: { teamId: string; limit?: number; kinds?: ReadonlyArray<ExportKind> },
  client: PrismaClient = defaultPrisma,
): Promise<ReadonlyArray<ExportListItem>> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const kinds = input.kinds ?? EXPORT_KINDS;

  const out: ExportListItem[] = [];

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
        pdfSignerKeyId: true,
        pdfSignedAtUtc: true,
        pdfSigningWarning: true,
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
        artifactSigningKeyId: r.pdfSignerKeyId ?? null,
        artifactSignedAtUtc: r.pdfSignedAtUtc ? r.pdfSignedAtUtc.toISOString() : null,
        artifactUnsignedOptOut: r.pdfSignatureStatus === "UNSIGNED_OPT_OUT",
        artifactSigningWarning: r.pdfSigningWarning ?? null,
        verificationPackageSignatureStatus: "NOT_APPLICABLE",
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
        evidence: { select: { teamId: true, verificationPackageMetadata: true } },
      },
      orderBy: { generatedAtUtc: "desc" },
      take: limit,
    });
    for (const p of packages) {
      const packageMetadata = p.evidence
        .verificationPackageMetadata as
        | { signedManifestPresent?: boolean }
        | null
        | undefined;
      const packageSigned = packageMetadata?.signedManifestPresent === true;
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
        artifactSigned: packageSigned,
        artifactSigningKeyId: null,
        artifactSignedAtUtc: null,
        artifactUnsignedOptOut: false,
        artifactSigningWarning: null,
        verificationPackageSignatureStatus: packageSigned ? "SIGNED" : "UNSIGNED",
      });
    }
  }

  return out
    .sort((a, b) => b.generatedAtUtc.localeCompare(a.generatedAtUtc))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Detail / manifest assembly
// ---------------------------------------------------------------------------

export type ResolveManifestResult =
  | { ok: true; envelope: ExportManifestEnvelope }
  | { ok: false; code: "not_found"; message: string };

export async function resolveExportManifest(
  input: { teamId: string; exportId: string },
  client: PrismaClient = defaultPrisma,
): Promise<ResolveManifestResult> {
  const decoded = decodeExportId(input.exportId);
  if (!decoded) {
    return { ok: false, code: "not_found", message: "Unknown export id." };
  }

  const objectLockResult = await verifyObjectLockConfiguration();
  const platformMode: ObjectLockPlatformMode =
    objectLockResult.mode === "verified"
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
    if (!r) return { ok: false, code: "not_found", message: "Export not found." };
    const manifest: ExportManifest = {
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
        evidence: { select: { teamId: true, organizationId: true, verificationPackageMetadata: true } },
      },
    });
    if (!p) return { ok: false, code: "not_found", message: "Export not found." };
    const manifest: ExportManifest = {
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
        artifactSigned:
          (p.evidence.verificationPackageMetadata as
            | { signedManifestPresent?: boolean }
            | null
            | undefined)?.signedManifestPresent === true,
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

function buildEnvelope(manifest: ExportManifest): ExportManifestEnvelope {
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
] as const;

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
] as const;

function normaliseObjectLockMode(
  raw: string | null | undefined,
): "GOVERNANCE" | "COMPLIANCE" | null {
  if (raw === "GOVERNANCE" || raw === "COMPLIANCE") return raw;
  return null;
}

function normaliseLegalHold(
  raw: string | null | undefined,
): "ON" | "OFF" | null {
  if (raw === "ON" || raw === "OFF") return raw;
  return null;
}
