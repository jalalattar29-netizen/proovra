/**
 * UC-4 — Report bridge: build the bounded DERIVED review summary for a report.
 *
 * Reads the ONE persisted screen_reconstruction descriptor (via the shared
 * reader + the worker's object storage) and projects provenance-only counts.
 * NEVER returns reconstructed prose or OCR text. Failure-safe: returns null so
 * the report renders byte-identical for evidence without UC-4.
 */

import { UC4_RESOURCE_BOUNDS } from "@proovra/shared";

import { prisma } from "../db.js";
import { getObjectStream } from "../storage.js";
import type { DerivedReviewSection } from "./sections/derived-review.js";

export async function buildReportDerivedReview(input: {
  teamId: string | null;
  evidenceId: string;
}): Promise<DerivedReviewSection | null> {
  if (!input.teamId) return null;
  try {
    const { readScreenReconstructionDescriptor } = await import(
      "@proovra/shared-runtime/media-intelligence"
    );
    const read = await readScreenReconstructionDescriptor(
      input.teamId,
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
          return Buffer.concat(chunks);
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
    };
  } catch {
    return null;
  }
}
