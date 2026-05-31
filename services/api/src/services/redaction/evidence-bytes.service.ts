/**
 * PROOVRA Phase 3A Closure — Evidence-bytes helper.
 *
 * Bounded fetch of an evidence object's bytes from S3 so the
 * redaction providers can run real cloud detection without the
 * orchestrator hard-coupling to the storage layer.
 *
 * Hard rules:
 *   * Workspace-anchored. The caller passes a teamId; the helper
 *     refuses to read an evidence row that doesn't belong to the
 *     team.
 *   * NEVER caches bytes. Each call hits S3 fresh and returns a
 *     Uint8Array. The bounded fetch budget is 256 MiB; anything
 *     larger returns `ARTIFACT_TOO_LARGE` and the orchestrator
 *     honestly records the gap.
 *   * The original storage key is NEVER altered.
 */

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

import type { PrismaClient } from "@prisma/client";

import type { RedactionDenialReason } from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { captureException } from "../../observability/sentry.js";

const MAX_BYTES = 256 * 1024 * 1024;

let cachedS3: S3Client | null = null;

function s3Client(): S3Client {
  if (cachedS3) return cachedS3;
  cachedS3 = new S3Client({});
  return cachedS3;
}

export type FetchEvidenceBytesInput = {
  prisma?: PrismaClient;
  teamId: string;
  evidenceId: string;
};

export type FetchEvidenceBytesResult =
  | {
      ok: true;
      bytes: Uint8Array;
      contentType: string | null;
      byteSize: number;
      storageKey: string;
      storageBucket: string;
    }
  | { ok: false; denial: RedactionDenialReason; reason: string };

export async function fetchEvidenceBytes(
  input: FetchEvidenceBytesInput,
): Promise<FetchEvidenceBytesResult> {
  const prisma = input.prisma ?? defaultPrisma;
  const evidence = await prisma.evidence.findFirst({
    where: { id: input.evidenceId, teamId: input.teamId },
    select: {
      storageKey: true,
      storageBucket: true,
      storageRegion: true,
      sizeBytes: true,
      mimeType: true,
    },
  });
  if (!evidence) {
    return {
      ok: false,
      denial: "PROJECT_NOT_FOUND",
      reason: "evidence_not_found_for_team",
    };
  }
  if (!evidence.storageBucket || !evidence.storageKey) {
    return {
      ok: false,
      denial: "ARTIFACT_NOT_REDACTABLE",
      reason: "evidence_has_no_storage_location",
    };
  }
  if (evidence.sizeBytes !== null && Number(evidence.sizeBytes) > MAX_BYTES) {
    return {
      ok: false,
      denial: "ARTIFACT_NOT_REDACTABLE",
      reason: `evidence_exceeds_redaction_byte_budget_${MAX_BYTES}`,
    };
  }
  try {
    const client = s3Client();
    const res = await client.send(
      new GetObjectCommand({
        Bucket: evidence.storageBucket,
        Key: evidence.storageKey,
      }),
    );
    const body = res.Body;
    if (!body) {
      return {
        ok: false,
        denial: "ARTIFACT_NOT_REDACTABLE",
        reason: "s3_get_returned_empty_body",
      };
    }
    const bytes = await streamToBytes(body, MAX_BYTES);
    if (!bytes) {
      return {
        ok: false,
        denial: "ARTIFACT_NOT_REDACTABLE",
        reason: `evidence_exceeds_redaction_byte_budget_${MAX_BYTES}`,
      };
    }
    return {
      ok: true,
      bytes,
      contentType: evidence.mimeType ?? res.ContentType ?? null,
      byteSize: bytes.length,
      storageKey: evidence.storageKey,
      storageBucket: evidence.storageBucket,
    };
  } catch (err) {
    captureException(err, {
      operation: "fetch_evidence_bytes",
      evidenceId: input.evidenceId,
    });
    return {
      ok: false,
      denial: "ARTIFACT_NOT_REDACTABLE",
      reason: "s3_get_failed",
    };
  }
}

// ---------------------------------------------------------------------------
// Internal — bounded stream reader.
// ---------------------------------------------------------------------------

async function streamToBytes(
  body: unknown,
  maxBytes: number,
): Promise<Uint8Array | null> {
  // The AWS SDK v3 returns a Node Readable on Node runtimes. We
  // handle both the Node stream interface and the WHATWG ReadableStream
  // for forward-compat.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyBody = body as any;
  if (typeof anyBody?.transformToByteArray === "function") {
    const out = (await anyBody.transformToByteArray()) as Uint8Array;
    if (out.length > maxBytes) return null;
    return out;
  }
  if (typeof anyBody?.getReader === "function") {
    // WHATWG ReadableStream.
    const reader = anyBody.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) continue;
      total += value.length;
      if (total > maxBytes) return null;
      chunks.push(value);
    }
    return concat(chunks, total);
  }
  if (typeof anyBody?.[Symbol.asyncIterator] === "function") {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of anyBody as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      if (total > maxBytes) return null;
      chunks.push(chunk);
    }
    return concat(chunks, total);
  }
  return null;
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Test helpers — bounded injection for the closure test.
// ---------------------------------------------------------------------------

export function __setTestS3(client: S3Client | null): void {
  cachedS3 = client;
}
