/**
 * PROOVRA C2PA — bounded raw-manifest export decision (Phase M2.1).
 *
 * Decides whether a discovered raw C2PA manifest should be:
 *   * exported to the Verification Package as
 *     `provenance/c2pa-manifests/<item-id>.c2pa`,
 *   * exported to a separate artifact store,
 *   * skipped because the manifest exceeds the configured cap,
 *   * skipped because the operator has disabled the export, or
 *   * not_exported because the provider could not surface it.
 *
 * Hard rules:
 *   * Bytes are NEVER inlined in the C2PA summary projection — only
 *     a bounded `C2paRawManifestReference` with hash + size is.
 *   * Per-evidence raw-manifest path is `provenance/c2pa-manifests/
 *     <bounded-itemId>.c2pa`. The item id is sanitized to a filesystem-
 *     safe slug; bytes are written by the package builder, never here.
 *   * Failure to evaluate is bounded — `disabled` / `unsupported` —
 *     never throws.
 */

import { createHash } from "node:crypto";
import {
  type C2paRawManifestReference,
  type C2paRawManifestStorageStatus,
} from "@proovra/shared";
import { env } from "../config.js";

export type RawManifestDecisionInput = {
  /** Bounded item id; null means single-item evidence. */
  itemId: string | null;
  /** The raw manifest bytes if the provider surfaced them. */
  rawManifestBytes: Buffer | null;
};

export type RawManifestDecisionOutput = {
  reference: C2paRawManifestReference;
  /** Bytes to bundle into the package, or null when nothing should
   *  be written. The package builder MUST honor `reference.status` —
   *  it must write the bytes ONLY when `status === "exported_to_package"`. */
  packageBytes: Buffer | null;
};

/**
 * Decide raw-manifest export for one file. Pure-ish: only reads
 * `env.C2PA_RAW_MANIFEST_EXPORT_ENABLED` + `env.C2PA_RAW_MANIFEST_MAX_BYTES`.
 */
export function decideRawManifestExport(
  input: RawManifestDecisionInput,
): RawManifestDecisionOutput {
  const exportEnabled = env.C2PA_RAW_MANIFEST_EXPORT_ENABLED === "true";
  if (!exportEnabled) {
    return {
      reference: {
        status: "disabled",
        sha256Hex: null,
        sizeBytes: null,
        packageRelativePath: null,
      },
      packageBytes: null,
    };
  }
  const bytes = input.rawManifestBytes;
  if (!bytes || bytes.byteLength === 0) {
    return {
      reference: {
        status: "not_exported",
        sha256Hex: null,
        sizeBytes: null,
        packageRelativePath: null,
      },
      packageBytes: null,
    };
  }
  if (bytes.byteLength > env.C2PA_RAW_MANIFEST_MAX_BYTES) {
    return {
      reference: {
        status: "too_large_to_export",
        sha256Hex: null,
        sizeBytes: bytes.byteLength,
        packageRelativePath: null,
      },
      packageBytes: null,
    };
  }
  const sha256Hex = createHash("sha256").update(bytes).digest("hex");
  const safeItemId = sanitizeItemId(input.itemId);
  return {
    reference: {
      status: "exported_to_package",
      sha256Hex,
      sizeBytes: bytes.byteLength,
      packageRelativePath: `provenance/c2pa-manifests/${safeItemId}.c2pa`,
    },
    packageBytes: bytes,
  };
}

/**
 * Aggregate per-file raw-manifest statuses into a bounded summary
 * value. Priority: `too_large_to_export > exported_to_package >
 * exported_to_artifact_store > not_exported > unsupported > disabled`.
 */
export function aggregateRawManifestExportStatus(
  perFile: ReadonlyArray<C2paRawManifestReference | null | undefined>,
): C2paRawManifestStorageStatus {
  const ordered: ReadonlyArray<C2paRawManifestStorageStatus> = [
    "too_large_to_export",
    "exported_to_package",
    "exported_to_artifact_store",
    "not_exported",
    "unsupported",
    "disabled",
  ];
  for (const candidate of ordered) {
    if (perFile.some((p) => p?.status === candidate)) return candidate;
  }
  return "disabled";
}

function sanitizeItemId(itemId: string | null): string {
  if (!itemId) return "item-single";
  const cleaned = itemId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
  return cleaned || "item-single";
}

/**
 * Bounded reference for the "preservation not run" code path used by
 * callers that don't have raw manifest bytes at all.
 */
export function rawManifestReferenceForMissingProvider(): C2paRawManifestReference {
  return {
    status: env.C2PA_RAW_MANIFEST_EXPORT_ENABLED === "true"
      ? "not_exported"
      : "disabled",
    sha256Hex: null,
    sizeBytes: null,
    packageRelativePath: null,
  };
}
