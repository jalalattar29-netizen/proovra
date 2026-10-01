/**
 * UC-4 — Report bridge: build the bounded DERIVED review summary for a report.
 *
 * Reads the ONE persisted screen_reconstruction descriptor (via the shared
 * reader + the worker's object storage) and projects provenance-only counts.
 * NEVER returns reconstructed prose or OCR text. Failure-safe: returns null so
 * the report renders byte-identical for evidence without UC-4.
 */

import { createHash } from "node:crypto";

import { UC4_RESOURCE_BOUNDS, resolveScreenOcrStatus } from "@proovra/shared";
import { resolveEvidenceWorkspaceId } from "@proovra/shared-runtime";

import { prisma } from "../db.js";
import { getObjectStream } from "../storage.js";
import type { DerivedReviewSection } from "./sections/derived-review.js";

export async function buildReportDerivedReview(input: {
  teamId: string | null;
  evidenceId: string;
  /** The record's owner — resolves a legacy NULL-team record's personal workspace. */
  ownerUserId?: string | null;
}): Promise<DerivedReviewSection | null> {
  try {
    // UC-DER-010 (report half) — a legacy Personal record stored with team_id
    // NULL belongs to its owner's personal workspace; it is not skipped.
    const owner =
      input.teamId
        ? null
        : (input.ownerUserId ??
          (await prisma.evidence.findUnique({ where: { id: input.evidenceId }, select: { ownerUserId: true } }))
            ?.ownerUserId ??
          null);
    const workspaceId = input.teamId ?? (await resolveEvidenceWorkspaceId({ teamId: null, ownerUserId: owner }, prisma));
    if (!workspaceId) return null;
    const { readScreenReconstructionDescriptor } = await import(
      "@proovra/shared-runtime/media-intelligence"
    );
    // UC-DER-015 — the digest of the EXACT descriptor bytes this section is
    // built from, so the report is bound to the reconstruction it describes.
    let descriptorBytes: Buffer | null = null;
    const read = await readScreenReconstructionDescriptor(
      workspaceId,
      input.evidenceId,
      {
        prisma,
        getObjectBytes: async ({ bucket, key }) => {
          const stream = (await getObjectStream({ bucket, key })) as unknown as AsyncIterable<
            Buffer | string
          >;
          const chunks: Buffer[] = [];
          let total = 0;
          for await (const chunk of stream) {
            const buf =
              typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
            total += buf.byteLength;
            if (total > UC4_RESOURCE_BOUNDS.maxDescriptorBytes) {
              throw new Error("descriptor_too_large");
            }
            chunks.push(buf);
          }
          descriptorBytes = Buffer.concat(chunks);
          return descriptorBytes;
        },
      },
    );
    if (!read) return null;
    const d = read.descriptor;
    return {
      coverage: d.coverage,
      ocrEnabled: d.ocrEnabled,
      acquisitionComplete: d.acquisitionComplete,
      sourcePartCount: d.stats.sourcePartCount,
      keyframeCount: d.stats.keyframeCount,
      observationCount: d.stats.observationCount,
      blockCount: d.stats.blockCount,
      transformationVersions: {
        keyframe: d.transformationVersions.keyframe,
        ocr: d.transformationVersions.ocr,
        reconstruction: d.transformationVersions.reconstruction,
      },
      limitations: d.limitations,
      generatedAtUtc: d.generatedAtUtc,
      // UC-DER-008 — policy-off vs engine-missing, from the descriptor itself.
      ocrStatus: resolveScreenOcrStatus(d),
      descriptorSha256: descriptorBytes
        ? createHash("sha256").update(descriptorBytes as Buffer).digest("hex")
        : null,
    };
  } catch {
    return null;
  }
}
