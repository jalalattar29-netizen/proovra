/**
 * Wave 5 — Internal worker → API callback for automatic provider extraction.
 *
 * TENANT_SCOPE_EXCEPTION: internal_service_token_workspace_anchored
 *
 * This route is service-to-service: the caller is the worker container,
 * authenticated by `requireInternalServiceAuth` (constant-time
 * `X-Internal-Service-Token` compare against `INTERNAL_SERVICE_TOKEN`).
 * It is NEVER reachable from a public/user-authenticated session. The
 * tenant claim does NOT come from a user session — the worker supplies
 * `teamId` in the body and the route validates the row exists in that
 * team before any mutation. Standard `userId + teamId` shape does not
 * apply.
 *
 * The worker (services/worker/src/media-intelligence.processor.ts) MUST NOT
 * import from `services/api/src/...` because the worker Docker image
 * deliberately omits `services/api/src` (only `services/api/prisma` is
 * copied at build time for `prisma generate`). This route is the
 * boundary: the worker invokes the canonical
 *   - `runProviderOperation` (Azure DI / Deepgram)
 *   - `runExtractionInline` (unified EvidenceExtractedText writer)
 * orchestration over HTTP, preserving the budget + entitlement + policy
 * gates that live on the API side.
 *
 * Hard contract:
 *
 *   POST /v1/internal/media-intelligence/extract
 *
 *   Auth: `requireInternalServiceAuth` — `X-Internal-Service-Token`
 *         constant-time-compared to `INTERNAL_SERVICE_TOKEN`. NEVER
 *         reachable from a public / user-authenticated session.
 *
 *   Body (bounded):
 *     {
 *       teamId: UUID,
 *       evidenceId: UUID,
 *       kind: 'ocr_azure' | 'transcript_deepgram',
 *       runId?: UUID | null
 *     }
 *
 *   Response (200 always when the route is reached — the API converts
 *   provider failures to `{ success: false, error: <bounded> }` so the
 *   worker can decide retry vs persist-failure):
 *     {
 *       success: boolean,
 *       partsProcessed: number,
 *       recordsCreated: number,
 *       extractedTextChars: number,
 *       error?: string  // bounded, <= 240 chars, no stack traces
 *     }
 *
 *   The response NEVER includes the raw extracted text — it is custody-
 *   sensitive content. Only counts and bounded error preview cross the
 *   wire.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { prisma } from "../db.js";
import { requireInternalServiceAuth } from "../middleware/internal-service-auth.js";
import { runProviderOperation } from "../services/intelligence/media-intelligence.service.js";
import { runExtractionInline } from "../services/intelligence/extraction.service.js";
import { getObjectRange } from "../storage.js";

// 50 MB cap mirrors the worker's OCR_EXTRACTION_MAX_BYTES /
// TRANSCRIPT_EXTRACTION_MAX_BYTES. Anything larger collapses to a
// "part_too_large" skip with no provider call.
const EXTRACTION_MAX_BYTES = 50 * 1024 * 1024;

// Bounded error preview length. Provider stack traces / SDK error
// blobs MUST be truncated before crossing the wire — the worker logs
// them and the operator only sees the prefix.
const ERROR_PREVIEW_MAX_CHARS = 240;

const BodySchema = z
  .object({
    teamId: z.string().uuid(),
    evidenceId: z.string().uuid(),
    kind: z.enum(["ocr_azure", "transcript_deepgram"]),
    runId: z.string().uuid().nullable().optional(),
  })
  .strict();

type Part = {
  id: string;
  storage_bucket: string | null;
  storage_key: string | null;
  mime_type: string | null;
  size_bytes: bigint | number | null;
};

type ExtractKind = "ocr_azure" | "transcript_deepgram";

function partFilterSql(kind: ExtractKind): string {
  if (kind === "ocr_azure") {
    return `(p."mime_type" ILIKE 'image/%' OR p."mime_type" = 'application/pdf')`;
  }
  return `(p."mime_type" ILIKE 'audio/%' OR p."mime_type" ILIKE 'video/%')`;
}

function boundedError(reason: unknown, fallback: string): string {
  if (reason instanceof Error) {
    return reason.message.slice(0, ERROR_PREVIEW_MAX_CHARS);
  }
  if (typeof reason === "string") {
    return reason.slice(0, ERROR_PREVIEW_MAX_CHARS);
  }
  return fallback;
}

export async function internalMediaIntelligenceExtractRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.post(
    "/v1/internal/media-intelligence/extract",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ok = await requireInternalServiceAuth(req, reply);
      if (!ok) return;

      let body: z.infer<typeof BodySchema>;
      try {
        body = BodySchema.parse(req.body);
      } catch (err) {
        return reply.code(200).send({
          success: false,
          partsProcessed: 0,
          recordsCreated: 0,
          extractedTextChars: 0,
          error: boundedError(err, "bad_request"),
        });
      }

      const { teamId, evidenceId, kind } = body;

      // Workspace anchoring — the row must exist in the supplied team.
      const evidence = await prisma.evidence.findUnique({
        where: { id: evidenceId },
        select: { id: true, teamId: true },
      });
      if (!evidence || evidence.teamId !== teamId) {
        return reply.code(200).send({
          success: false,
          partsProcessed: 0,
          recordsCreated: 0,
          extractedTextChars: 0,
          error: "evidence_not_found",
        });
      }

      let parts: Part[] = [];
      try {
        parts = (await prisma.$queryRawUnsafe(
          `SELECT p."id", p."storage_bucket", p."storage_key",
                  p."mime_type", p."size_bytes"
             FROM "evidence_parts" p
             JOIN "evidence" e ON e."id" = p."evidence_id"
            WHERE e."team_id" = $1
              AND e."id" = $2
              AND ${partFilterSql(kind)}
            ORDER BY p."size_bytes" ASC NULLS LAST
            LIMIT 5`,
          teamId,
          evidenceId,
        )) as Part[];
      } catch (err) {
        return reply.code(200).send({
          success: false,
          partsProcessed: 0,
          recordsCreated: 0,
          extractedTextChars: 0,
          error: boundedError(err, "parts_lookup_failed"),
        });
      }

      if (parts.length === 0) {
        return reply.code(200).send({
          success: true,
          partsProcessed: 0,
          recordsCreated: 0,
          extractedTextChars: 0,
        });
      }

      let totalInserted = 0;
      let totalChars = 0;
      let partsProcessed = 0;
      let firstFailureReason: string | null = null;

      for (const part of parts) {
        if (!part.storage_bucket || !part.storage_key || !part.mime_type) {
          continue;
        }
        const sizeBytes = Number(part.size_bytes ?? 0);
        if (sizeBytes > 0 && sizeBytes > EXTRACTION_MAX_BYTES) {
          // Skip oversize parts — preserves the worker's cap behavior.
          continue;
        }
        let bytes: Buffer | null = null;
        try {
          bytes = await getObjectRange({
            bucket: part.storage_bucket,
            key: part.storage_key,
            range: `bytes=0-${EXTRACTION_MAX_BYTES - 1}`,
          });
        } catch (err) {
          firstFailureReason ??= boundedError(err, "fetch_failed");
          continue;
        }
        if (!bytes || bytes.byteLength === 0) continue;

        partsProcessed += 1;

        const isPdf = part.mime_type === "application/pdf";
        const isVideo = part.mime_type.toLowerCase().startsWith("video/");

        try {
          const providerResult =
            kind === "ocr_azure"
              ? await runProviderOperation({
                  teamId,
                  evidenceId,
                  provider: "AZURE_DOCUMENT_INTELLIGENCE",
                  operation: isPdf ? "OCR_DOCUMENT" : "OCR_IMAGE",
                  byteSource: {
                    bytes: new Uint8Array(
                      bytes.buffer,
                      bytes.byteOffset,
                      bytes.byteLength,
                    ),
                    url: null,
                    contentType: part.mime_type,
                  },
                })
              : await runProviderOperation({
                  teamId,
                  evidenceId,
                  provider: "DEEPGRAM_TRANSCRIPT",
                  operation: isVideo
                    ? "TRANSCRIBE_VIDEO_AUDIO_TRACK"
                    : "TRANSCRIBE_AUDIO",
                  byteSource: {
                    bytes: new Uint8Array(
                      bytes.buffer,
                      bytes.byteOffset,
                      bytes.byteLength,
                    ),
                    url: null,
                    contentType: part.mime_type,
                  },
                });

          if (!providerResult.ok) {
            firstFailureReason ??=
              providerResult.reason?.slice(0, ERROR_PREVIEW_MAX_CHARS) ??
              "provider_block";
            continue;
          }

          totalInserted += providerResult.insertedRecords;
          const text = providerResult.extractedText ?? null;
          if (text && text.length > 0) {
            totalChars += text.length;
            try {
              await runExtractionInline(
                {
                  evidenceId,
                  teamId,
                  mimeType: part.mime_type,
                  kind:
                    kind === "ocr_azure"
                      ? isPdf
                        ? "OCR_PDF"
                        : "OCR_IMAGE"
                      : isVideo
                        ? "TRANSCRIPT_VIDEO"
                        : "TRANSCRIPT_AUDIO",
                  jobKind: kind === "ocr_azure" ? "OCR" : "TRANSCRIPT",
                },
                prisma,
              );
            } catch {
              /* extraction writer is best-effort */
            }
          }
        } catch (err) {
          firstFailureReason ??= boundedError(err, "provider_failed");
          req.log.warn(
            {
              teamId,
              evidenceId,
              partId: part.id,
              kind,
              err: err instanceof Error ? err.message.slice(0, 120) : "unknown",
            },
            "internal.media_intelligence.extract.provider_threw",
          );
          continue;
        }
      }

      const success = totalInserted > 0 || firstFailureReason === null;
      return reply.code(200).send({
        success,
        partsProcessed,
        recordsCreated: totalInserted,
        extractedTextChars: totalChars,
        ...(success || !firstFailureReason
          ? {}
          : { error: firstFailureReason.slice(0, ERROR_PREVIEW_MAX_CHARS) }),
      });
    },
  );
}
