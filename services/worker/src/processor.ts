import type { Job } from "bullmq";
import type { Readable } from "node:stream";
import * as prismaPkg from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { prisma } from "./db.js";
import { env } from "./config.js";
import { logger, withJobContext } from "./logger.js";
import { getObjectStream, headObject, putObjectBuffer } from "./storage.js";
import { createHash, randomUUID } from "node:crypto";
import { buildReportPdf } from "./pdf/report.js";
import {
  generateReportJobName,
  reportDlqQueue,
  reportQueue,
} from "./queue.js";
import { captureException } from "./sentry.js";
import { createVerificationPackage } from "./verification-package.js";

type GenerateReportJobData = {
  evidenceId: string;
};

type WorkerError = Error & {
  code: string;
  retriable: boolean;
};

function buildPublicUrl(key: string): string | null {
  if (!env.S3_PUBLIC_BASE_URL) return null;
  return `${env.S3_PUBLIC_BASE_URL.replace(/\/+$/, "")}/${key}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries = keys.map(
    (key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`
  );
  return `{${entries.join(",")}}`;
}

function summarizePayload(payload: unknown): string {
  if (!payload) return "N/A";
  try {
    const json = stableStringify(payload);
    if (json.length <= 200) return json;
    return `${json.slice(0, 197)}...`;
  } catch {
    return "UNSERIALIZABLE_PAYLOAD";
  }
}

function sha256HexFromStrings(parts: string[]) {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("|");
  }
  return hash.digest("hex");
}

function createWorkerError(code: string, retriable: boolean): WorkerError {
  const err = new Error(code) as WorkerError;
  err.code = code;
  err.retriable = retriable;
  return err;
}

function isRetriableError(error: unknown): boolean {
  if (error && typeof error === "object" && "retriable" in error) {
    return (error as WorkerError).retriable === true;
  }
  return true;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

const { EvidenceStatus } = prismaPkg;

export async function processGenerateReport(job: Job<GenerateReportJobData>) {
  const start = Date.now();
  const evidenceId = job.data.evidenceId;
  const requestId = randomUUID();

  const ctx = withJobContext({
    requestId,
    jobId: job.id,
    evidenceId,
    attempt: job.attemptsMade + 1,
    status: "started",
  });

  logger.info(ctx, "GenerateReportJob started");

  try {
    const evidence = await prisma.evidence.findFirst({
      where: { id: evidenceId, deletedAt: null },
    });

    if (!evidence) throw createWorkerError("EVIDENCE_NOT_FOUND", false);
    if (evidence.status !== EvidenceStatus.SIGNED) {
      throw createWorkerError(`EVIDENCE_NOT_SIGNED:${evidence.status}`, false);
    }

    if (!evidence.fileSha256) {
      throw createWorkerError("EVIDENCE_FILE_SHA256_MISSING", false);
    }

    if (!evidence.fingerprintCanonicalJson) {
      throw createWorkerError(
        "EVIDENCE_FINGERPRINT_CANONICAL_JSON_MISSING",
        false
      );
    }

    if (!evidence.fingerprintHash) {
      throw createWorkerError("EVIDENCE_FINGERPRINT_HASH_MISSING", false);
    }

    if (!evidence.signatureBase64) {
      throw createWorkerError("EVIDENCE_SIGNATURE_MISSING", false);
    }

    if (!evidence.signingKeyId || evidence.signingKeyVersion == null) {
      throw createWorkerError("EVIDENCE_SIGNING_KEY_MISSING", false);
    }

    const fingerprintCanonicalJson = evidence.fingerprintCanonicalJson;
    const fingerprintHash = evidence.fingerprintHash;
    const signatureBase64 = evidence.signatureBase64;
    const signingKeyId = evidence.signingKeyId;
    const signingKeyVersion = evidence.signingKeyVersion;

    const parts = await prisma.evidencePart.findMany({
      where: { evidenceId: evidence.id },
      orderBy: { partIndex: "asc" },
    });

    if (parts.length === 0 && (!evidence.storageBucket || !evidence.storageKey)) {
      throw createWorkerError("EVIDENCE_STORAGE_NOT_SET", false);
    }

    let storageBucket = evidence.storageBucket ?? null;
    let storageKey = evidence.storageKey ?? null;
    let fileSha256 = "";
    let verificationEvidenceBuffer: Buffer | null = null;

    if (parts.length > 0) {
      const hashes: string[] = [];

      for (const [index, part] of parts.entries()) {
        const head = await headObject({
          bucket: part.storageBucket,
          key: part.storageKey,
        });

        if (!head.sizeBytes || head.sizeBytes <= 0) {
          throw createWorkerError("EVIDENCE_OBJECT_NOT_FOUND", true);
        }

        const body = await getObjectStream({
          bucket: part.storageBucket,
          key: part.storageKey,
        });

        const partBuffer = await streamToBuffer(body as unknown as Readable);
        const partSha = createHash("sha256").update(partBuffer).digest("hex");
        hashes.push(partSha);

        if (index === 0) {
          verificationEvidenceBuffer = partBuffer;
        }
      }

      fileSha256 = sha256HexFromStrings(hashes);

      if (fileSha256 !== evidence.fileSha256) {
        throw createWorkerError("EVIDENCE_FILE_SHA256_MISMATCH", false);
      }

      storageBucket = storageBucket ?? parts[0]?.storageBucket ?? null;
      storageKey = storageKey ?? parts[0]?.storageKey ?? null;
    } else {
      const head = await headObject({
        bucket: evidence.storageBucket!,
        key: evidence.storageKey!,
      });

      if (!head.sizeBytes || head.sizeBytes <= 0) {
        throw createWorkerError("EVIDENCE_OBJECT_NOT_FOUND", true);
      }

      const body = await getObjectStream({
        bucket: evidence.storageBucket!,
        key: evidence.storageKey!,
      });

      verificationEvidenceBuffer = await streamToBuffer(body as unknown as Readable);
      fileSha256 = createHash("sha256")
        .update(verificationEvidenceBuffer)
        .digest("hex");

      if (fileSha256 !== evidence.fileSha256) {
        throw createWorkerError("EVIDENCE_FILE_SHA256_MISMATCH", false);
      }
    }

    const custodyEvents = await prisma.custodyEvent.findMany({
      where: { evidenceId: evidence.id },
      orderBy: { sequence: "asc" },
      select: {
        sequence: true,
        atUtc: true,
        eventType: true,
        payload: true,
      },
    });

    const lastSeq = custodyEvents.at(-1)?.sequence ?? 0;

    const maxReport = await prisma.report.aggregate({
      where: { evidenceId: evidence.id },
      _max: { version: true },
    });

    const version = (maxReport._max.version ?? 0) + 1;

    const signingKey = await prisma.signingKey.findUnique({
      where: {
        keyId_version: {
          keyId: signingKeyId,
          version: signingKeyVersion,
        },
      },
    });

    if (!signingKey) {
      throw createWorkerError("SIGNING_KEY_NOT_FOUND", false);
    }

    const now = new Date();
    const reportKey = `reports/${evidence.id}/v${version}.pdf`;
    const publicUrl = storageKey ? buildPublicUrl(storageKey) : null;

    const reportPdf = await buildReportPdf({
      evidence: {
        id: evidence.id,
        status: evidence.status,
        capturedAtUtc: evidence.capturedAtUtc?.toISOString() ?? null,
        uploadedAtUtc: evidence.uploadedAtUtc?.toISOString() ?? null,
        signedAtUtc: evidence.signedAtUtc?.toISOString() ?? null,
        reportGeneratedAtUtc: now.toISOString(),
        mimeType: evidence.mimeType,
        sizeBytes: evidence.sizeBytes?.toString() ?? null,
        durationSec: evidence.durationSec?.toString() ?? null,
        storageBucket: storageBucket ?? "unknown",
        storageKey: storageKey ?? "multipart",
        publicUrl,
        gps: {
          lat: evidence.lat?.toString() ?? null,
          lng: evidence.lng?.toString() ?? null,
          accuracyMeters: evidence.accuracyMeters?.toString() ?? null,
        },
        fileSha256,
        fingerprintCanonicalJson,
        fingerprintHash,
        signatureBase64,
        signingKeyId,
        signingKeyVersion,
        publicKeyPem: signingKey.publicKeyPem,

        tsaProvider: null,
        tsaUrl: null,
        tsaSerialNumber: null,
        tsaGenTimeUtc: null,
        tsaTokenBase64: null,
        tsaMessageImprint: null,
        tsaHashAlgorithm: null,
        tsaStatus: null,
        tsaFailureReason: null,
      },
      custodyEvents: custodyEvents.map((ev) => ({
        sequence: ev.sequence,
        atUtc: ev.atUtc.toISOString(),
        eventType: ev.eventType,
        payloadSummary: summarizePayload(ev.payload),
      })),
      version,
      generatedAtUtc: now.toISOString(),
      buildInfo: env.WORKER_BUILD_INFO ?? null,
    });

    await putObjectBuffer({
      bucket: env.S3_BUCKET,
      key: reportKey,
      body: reportPdf,
      contentType: "application/pdf",
    });

    if (verificationEvidenceBuffer) {
      const verificationZip = await createVerificationPackage({
        evidenceBuffer: verificationEvidenceBuffer,
        fingerprint: fingerprintCanonicalJson,
        signature: signatureBase64,
        timestampToken: null,
        publicKey: signingKey.publicKeyPem,
        custody: custodyEvents.map((ev) => ({
          sequence: ev.sequence,
          atUtc: ev.atUtc.toISOString(),
          eventType: ev.eventType,
          payload: ev.payload,
        })),
      });

      const verificationKey = `verification/${evidence.id}/package.zip`;

      await putObjectBuffer({
        bucket: env.S3_BUCKET,
        key: verificationKey,
        body: verificationZip,
        contentType: "application/zip",
      });
    }

    await prisma.$transaction(async (tx) => {
      await tx.report.create({
        data: {
          evidenceId: evidence.id,
          version,
          storageBucket: env.S3_BUCKET,
          storageKey: reportKey,
          generatedAtUtc: now,
        },
      });

      await tx.custodyEvent.create({
        data: {
          evidenceId: evidence.id,
          eventType: "REPORT_GENERATED" as prismaPkg.CustodyEventType,
          atUtc: now,
          sequence: lastSeq + 1,
          payload: {
            reportVersion: version,
            storageBucket: env.S3_BUCKET,
            storageKey: reportKey,
          } as Prisma.InputJsonValue,
        },
      });

      await tx.evidence.update({
        where: { id: evidence.id },
        data: {
          status: EvidenceStatus.REPORTED,
          reportGeneratedAtUtc: now,
        },
      });
    });

    const durationMs = Date.now() - start;

    logger.info(
      withJobContext({
        requestId,
        jobId: job.id,
        evidenceId,
        attempt: job.attemptsMade + 1,
        durationMs,
        status: "completed",
      }),
      "GenerateReportJob completed"
    );
  } catch (error) {
    captureException(error, { requestId, evidenceId, jobId: job.id ?? null });

    const durationMs = Date.now() - start;

    logger.error(
      {
        ...withJobContext({
          requestId,
          jobId: job.id,
          evidenceId,
          attempt: job.attemptsMade + 1,
          durationMs,
          status: "failed",
        }),
        err: error,
      },
      "GenerateReportJob failed"
    );

    const attempts = job.opts.attempts ?? 1;
    const retriable = isRetriableError(error);

    if (!retriable) {
      await job.discard();
      await reportDlqQueue.add(
        "ReportDLQ",
        {
          evidenceId,
          jobId: job.id,
          errorMessage: (error as Error).message,
          errorStack: (error as Error).stack ?? null,
          retriable: false,
        },
        { removeOnComplete: true, removeOnFail: false }
      );

      logger.error(
        {
          ...withJobContext({
            requestId,
            jobId: job.id,
            evidenceId,
            attempt: job.attemptsMade + 1,
            durationMs,
            status: "dlq",
          }),
          moved_to_dlq: true,
        },
        "GenerateReportJob moved to DLQ (non-retriable)"
      );

      throw error;
    }

    if (job.attemptsMade + 1 >= attempts) {
      await reportDlqQueue.add(
        "ReportDLQ",
        {
          evidenceId,
          jobId: job.id,
          errorMessage: (error as Error).message,
          errorStack: (error as Error).stack ?? null,
          retriable: true,
        },
        { removeOnComplete: true, removeOnFail: false }
      );

      logger.error(
        {
          ...withJobContext({
            requestId,
            jobId: job.id,
            evidenceId,
            attempt: job.attemptsMade + 1,
            durationMs,
            status: "dlq",
          }),
          moved_to_dlq: true,
        },
        "GenerateReportJob moved to DLQ"
      );
    }

    throw error;
  }
}

export async function enqueueReportJob(evidenceId: string) {
  const jobId = `report-${evidenceId}`;

  const existing = await reportQueue.getJob(jobId);

  if (existing) {
    const state = await existing.getState();
    return { enqueued: false, reason: `job_${state}` };
  }

  await reportQueue.add(
    generateReportJobName,
    { evidenceId },
    {
      jobId,
      attempts: 5,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: 100,
      removeOnFail: false,
    }
  );

  return { enqueued: true };
}