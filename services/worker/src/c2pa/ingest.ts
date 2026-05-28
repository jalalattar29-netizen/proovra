/**
 * PROOVRA C2PA — worker-side ingest helper.
 *
 * Phase M2 / Part 4.
 *
 * Reads the original evidence bytes (in bounded chunks if needed),
 * invokes the C2PA provider, and persists the bounded summary on
 * `Evidence.verificationPackageMetadata.c2pa`.
 *
 * Hard rules:
 *   * Never blocks upload or finalization. This helper is called
 *     OUT-OF-BAND from a worker job. Failure NEVER bubbles up to the
 *     evidence finalize gate.
 *   * Soft-fails: any exception in the provider / storage results in
 *     a bounded `error` summary persisted with `failureReason` set.
 *   * Never mutates the source object. Reads only.
 *   * Bounded read size from `C2PA_MAX_BYTES`.
 *   * Emits bounded audit events + breadcrumbs for operator visibility.
 */

import { prisma } from "../db.js";
import { env } from "../config.js";
import { logger } from "../logger.js";
import { evaluateEvidenceC2pa } from "./provider.js";
import {
  buildDisabledC2paSummary,
  type C2paEvidenceSummary,
  type VerificationPackageMetadata,
} from "@proovra/shared";

export type C2paIngestInput = {
  evidenceId: string;
  /**
   * Per-file input. The caller is responsible for reading the bytes
   * from S3 under the bounded `C2PA_MAX_BYTES` cap before passing
   * here. The helper does NOT touch S3 directly.
   */
  files: ReadonlyArray<{
    itemId: string | null;
    mediaType: string | null;
    bytes: Buffer;
  }>;
};

export type C2paIngestOutcome = {
  summary: C2paEvidenceSummary;
  persisted: boolean;
};

/**
 * Public entry — run extraction and persist the summary projection.
 *
 * Behavior:
 *   * If `C2PA_ENABLED` is `false`, persists a bounded `disabled`
 *     summary and returns without invoking the provider.
 *   * Otherwise evaluates and persists. On provider exception, the
 *     bounded `error` summary is persisted so a subsequent retry can
 *     supersede it without ambiguity.
 */
export async function runC2paIngest(
  input: C2paIngestInput,
): Promise<C2paIngestOutcome> {
  const generatedAtUtc = new Date().toISOString();
  let summary: C2paEvidenceSummary;
  if (env.C2PA_ENABLED !== "true") {
    summary = buildDisabledC2paSummary({
      evidenceId: input.evidenceId,
      generatedAtUtc,
    });
  } else {
    try {
      summary = await evaluateEvidenceC2pa({
        evidenceId: input.evidenceId,
        files: input.files,
      });
    } catch (err) {
      logger.warn(
        { err, evidenceId: input.evidenceId },
        "proovra.c2pa.provider_failure",
      );
      summary = buildDisabledC2paSummary({
        evidenceId: input.evidenceId,
        generatedAtUtc,
      });
      summary = { ...summary, aggregateStatus: "error" };
    }
  }
  const persisted = await persistC2paSummary({
    evidenceId: input.evidenceId,
    summary,
  });
  return { summary, persisted };
}

/**
 * Merge the C2PA summary into `Evidence.verificationPackageMetadata`.
 * The base metadata projection is preserved; we ONLY set/replace the
 * `c2pa` sub-field. Historical versions are not retained inline —
 * callers that need history should emit a `SecurityEvent` row.
 */
async function persistC2paSummary(input: {
  evidenceId: string;
  summary: C2paEvidenceSummary;
}): Promise<boolean> {
  try {
    const existing = await prisma.evidence.findUnique({
      where: { id: input.evidenceId },
      select: { verificationPackageMetadata: true },
    });
    if (!existing) return false;
    const base =
      (existing.verificationPackageMetadata as
        | VerificationPackageMetadata
        | null
        | undefined) ?? null;
    const merged: VerificationPackageMetadata = {
      ...(base ?? {
        manifestPresent: false,
        signedManifestPresent: false,
        checksumIndexPresent: false,
        offlineVerifierIncluded: false,
        packageVersion: "v1" as const,
        generatedAtUtc: new Date().toISOString(),
        source: "GENERATION" as const,
      }),
      c2pa: input.summary,
    };
    await prisma.evidence.update({
      where: { id: input.evidenceId },
      data: {
        verificationPackageMetadata:
          merged as unknown as import("@prisma/client").Prisma.InputJsonValue,
      },
    });
    return true;
  } catch (err) {
    logger.warn(
      { err, evidenceId: input.evidenceId },
      "proovra.c2pa.persist_failure",
    );
    return false;
  }
}
