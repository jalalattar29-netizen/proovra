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

type VerificationEvidenceFile = {
  name: string;
  buffer: Buffer;
};

type PreparedReportArtifacts = {
  reportPdf: Buffer;
  verificationZip: Buffer | null;
  reportKey: string;
  verificationKey: string;
  version: number;
  now: Date;
  evidenceId: string;
};

function envValue(name: string, fallback?: string): string {
  const raw = process.env[name];
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed) return trimmed;
  if (typeof fallback === "string") return fallback;
  throw new Error(`${name} is not set`);
}

function buildPublicUrl(key: string): string | null {
  if (!env.S3_PUBLIC_BASE_URL) return null;
  return `${env.S3_PUBLIC_BASE_URL.replace(/\/+$/, "")}/${key}`;
}

function buildVerifyUrl(evidenceId: string): string {
  const base = envValue(
    "REPORT_VERIFY_BASE_URL",
    "https://app.proovra.com/verify"
  ).replace(/\/+$/, "");

  return `${base}/${encodeURIComponent(evidenceId)}`;
}

function buildEvidenceDetailUrl(evidenceId: string): string {
  const base = envValue(
    "REPORT_APP_BASE_URL",
    "https://app.proovra.com"
  ).replace(/\/+$/, "");
  return `${base}/evidence/${encodeURIComponent(evidenceId)}`;
}

function shortHash(
  value: string | null | undefined,
  head = 12,
  tail = 10
): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  if (text.length <= head + tail + 3) return text;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

function normalizePayloadPrimitive(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const t = value.trim();
    return t || null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function summarizePayloadForReport(
  eventType: string,
  payload: unknown
): string {
  const event = String(eventType || "").toUpperCase();

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    switch (event) {
      case "VERIFY_VIEWED":
        return "Public verification page viewed.";
      case "REPORT_GENERATED":
        return "Verification report generated.";
      case "EVIDENCE_VIEWED":
        return "Protected evidence file accessed.";
      case "TIMESTAMP_APPLIED":
        return "Trusted timestamp applied.";
      case "TIMESTAMP_FAILED":
        return "Timestamp request failed.";
      default:
        return "No structured event details recorded.";
    }
  }

  const obj = payload as Record<string, unknown>;

  switch (event) {
    case "EVIDENCE_CREATED":
      return "Evidence record created.";

    case "UPLOAD_STARTED": {
      const uploadMode =
        normalizePayloadPrimitive(obj.mode) ??
        normalizePayloadPrimitive(obj.uploadKind);

      return ["Upload session started", uploadMode ? `Mode: ${uploadMode}` : null]
        .filter(Boolean)
        .join(" • ");
    }

    case "UPLOAD_COMPLETED": {
      const multipart = obj.multipart === true;
      const itemCount =
        typeof obj.itemCount === "number" && Number.isFinite(obj.itemCount)
          ? String(obj.itemCount)
          : null;
      const sizeBytes = normalizePayloadPrimitive(obj.sizeBytes);
      const hash = shortHash(normalizePayloadPrimitive(obj.fileSha256));

      return [
        multipart
          ? "Multipart evidence package completed"
          : "Single-file upload completed",
        itemCount ? `Items: ${itemCount}` : null,
        sizeBytes ? `Size: ${sizeBytes} bytes` : null,
        hash ? `Hash: ${hash}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case "SIGNATURE_APPLIED": {
      const signingKeyId = normalizePayloadPrimitive(obj.signingKeyId);
      const signingKeyVersion = normalizePayloadPrimitive(obj.signingKeyVersion);
      const fingerprintHash = shortHash(
        normalizePayloadPrimitive(obj.fingerprintHash)
      );
      const tsaStatus = normalizePayloadPrimitive(obj.tsaStatus);
      const tsaProvider = normalizePayloadPrimitive(obj.tsaProvider);

      return [
        "Cryptographic signature applied",
        signingKeyId ? `Key: ${signingKeyId}` : null,
        signingKeyVersion ? `Version: ${signingKeyVersion}` : null,
        fingerprintHash ? `Fingerprint: ${fingerprintHash}` : null,
        tsaStatus ? `Timestamp: ${tsaStatus}` : null,
        tsaProvider ? `TSA: ${tsaProvider}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case "TIMESTAMP_APPLIED": {
      const tsaStatus = normalizePayloadPrimitive(obj.tsaStatus);
      const tsaProvider = normalizePayloadPrimitive(obj.tsaProvider);
      const serial = normalizePayloadPrimitive(obj.tsaSerialNumber);
      return [
        "Trusted timestamp applied",
        tsaStatus ? `Status: ${tsaStatus}` : null,
        tsaProvider ? `TSA: ${tsaProvider}` : null,
        serial ? `Serial: ${serial}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case "TIMESTAMP_FAILED": {
      const tsaStatus = normalizePayloadPrimitive(obj.tsaStatus);
      const reason = normalizePayloadPrimitive(obj.tsaFailureReason);
      return [
        "Timestamp request failed",
        tsaStatus ? `Status: ${tsaStatus}` : null,
        reason ? `Reason: ${reason}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case "REPORT_GENERATED": {
      const reportVersion = normalizePayloadPrimitive(obj.reportVersion);
      return reportVersion
        ? `Verification report generated • Version: ${reportVersion}`
        : "Verification report generated.";
    }

    case "REPORT_DOWNLOADED": {
      const reportVersion = normalizePayloadPrimitive(obj.reportVersion);
      return reportVersion
        ? `Report downloaded • Version: ${reportVersion}`
        : "Report downloaded.";
    }

    case "VERIFY_VIEWED":
      return "Public verification page viewed.";

    case "EVIDENCE_VIEWED":
      return "Protected evidence file accessed.";

    case "EVIDENCE_LOCKED":
      return "Evidence record locked.";

    case "EVIDENCE_ARCHIVED":
      return "Evidence record archived.";

    case "EVIDENCE_RESTORED":
      return "Evidence record restored.";

    case "EVIDENCE_DELETED":
      return "Evidence record deleted.";

    case "EVIDENCE_CLAIMED":
      return "Guest evidence ownership claimed.";

    default: {
      const entries = Object.entries(obj)
        .filter(([key, value]) => {
          const lowered = key.toLowerCase();

          if (
            lowered.includes("bucket") ||
            lowered.includes("storagekey") ||
            lowered === "key" ||
            lowered.includes("token") ||
            lowered.includes("secret") ||
            lowered.includes("password") ||
            lowered.includes("lat") ||
            lowered.includes("lng") ||
            lowered.includes("accuracy") ||
            lowered.includes("ip") ||
            lowered.includes("useragent")
          ) {
            return false;
          }

          return (
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
          );
        })
        .slice(0, 5)
        .map(([key, value]) => `${key}: ${String(value)}`);

      return entries.length > 0
        ? entries.join(" • ")
        : "No structured event details recorded.";
    }
  }
}

function sha256HexFromStrings(parts: string[]) {
  return createHash("sha256").update(parts.join("|")).digest("hex");
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

function extensionFromMimeType(mimeType: string | null | undefined): string {
  const mime = (mimeType ?? "").toLowerCase().trim();

  if (!mime) return "bin";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "video/mp4") return "mp4";
  if (mime === "video/webm") return "webm";
  if (mime === "audio/mpeg") return "mp3";
  if (mime === "audio/wav") return "wav";
  if (mime === "audio/webm") return "webm";
  if (mime === "application/pdf") return "pdf";
  if (mime === "text/plain") return "txt";
  if (mime === "application/json") return "json";

  const slashIndex = mime.indexOf("/");
  if (slashIndex >= 0 && slashIndex < mime.length - 1) {
    return mime.slice(slashIndex + 1).replace(/[^a-z0-9]+/gi, "") || "bin";
  }

  return "bin";
}

function basenameFromStorageKey(
  key: string | null | undefined,
  fallback: string
): string {
  const raw = typeof key === "string" ? key.trim() : "";
  if (!raw) return fallback;
  const parts = raw.split("/");
  const base = parts[parts.length - 1]?.trim();
  return base || fallback;
}

const { EvidenceStatus } = prismaPkg;

async function prepareReportArtifacts(
  evidenceId: string
): Promise<PreparedReportArtifacts> {
  const evidence = await prisma.evidence.findFirst({
    where: { id: evidenceId, deletedAt: null },
  });

  if (!evidence) throw createWorkerError("EVIDENCE_NOT_FOUND", false);
  if (evidence.status !== EvidenceStatus.SIGNED) {
    if (evidence.status === EvidenceStatus.REPORTED) {
      throw createWorkerError("REPORT_ALREADY_GENERATED", false);
    }
    throw createWorkerError(`EVIDENCE_NOT_SIGNED:${evidence.status}`, false);
  }

  if (!evidence.fileSha256) {
    throw createWorkerError("EVIDENCE_FILE_SHA256_MISSING", false);
  }

  if (!evidence.fingerprintCanonicalJson) {
    throw createWorkerError("EVIDENCE_FINGERPRINT_CANONICAL_JSON_MISSING", false);
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
  const verificationEvidenceFiles: VerificationEvidenceFile[] = [];

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

      verificationEvidenceFiles.push({
        name: basenameFromStorageKey(
          part.storageKey,
          `part-${String(index + 1).padStart(4, "0")}.${extensionFromMimeType(
            part.mimeType
          )}`
        ),
        buffer: partBuffer,
      });
    }

    if (verificationEvidenceFiles.length === 0) {
      throw createWorkerError("NO_MULTIPART_FILES_FOUND", false);
    }

    storageBucket = parts[0].storageBucket;
    storageKey = parts[0].storageKey;

    fileSha256 = sha256HexFromStrings(hashes);

    if (fileSha256 !== evidence.fileSha256) {
      throw createWorkerError("EVIDENCE_FILE_SHA256_MISMATCH", false);
    }
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

    const singleEvidenceBuffer = await streamToBuffer(
      body as unknown as Readable
    );

    verificationEvidenceFiles.push({
      name: basenameFromStorageKey(
        evidence.storageKey,
        `evidence-file.${extensionFromMimeType(evidence.mimeType)}`
      ),
      buffer: singleEvidenceBuffer,
    });

    fileSha256 = createHash("sha256")
      .update(singleEvidenceBuffer)
      .digest("hex");

    if (fileSha256 !== evidence.fileSha256) {
      throw createWorkerError("EVIDENCE_FILE_SHA256_MISMATCH", false);
    }

    storageBucket = evidence.storageBucket ?? storageBucket;
    storageKey = evidence.storageKey ?? storageKey;
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

  const currentMaxReport = await prisma.report.aggregate({
    where: { evidenceId: evidence.id },
    _max: { version: true },
  });

  const provisionalVersion = (currentMaxReport._max.version ?? 0) + 1;
  const now = new Date();
  const reportKey = `reports/${evidence.id}/v${provisionalVersion}.pdf`;
  const verificationKey = `verification/${evidence.id}/package.zip`;
  const publicUrl = storageKey ? buildPublicUrl(storageKey) : null;
  const evidenceDetailUrl = buildEvidenceDetailUrl(evidence.id);
  const verifyUrl = buildVerifyUrl(evidence.id);

  const reportGeneratedEventSequence =
    (custodyEvents[custodyEvents.length - 1]?.sequence ?? 0) + 1;

  const custodyEventsForReport = [
    ...custodyEvents.map((ev) => ({
      sequence: ev.sequence,
      atUtc: ev.atUtc.toISOString(),
      eventType: ev.eventType,
      payloadSummary: summarizePayloadForReport(ev.eventType, ev.payload),
    })),
    {
      sequence: reportGeneratedEventSequence,
      atUtc: now.toISOString(),
      eventType: "REPORT_GENERATED",
      payloadSummary: summarizePayloadForReport("REPORT_GENERATED", {
        phase: "report_generated",
        reportVersion: provisionalVersion,
        generatedAtUtc: now.toISOString(),
      }),
    },
  ];

  const custodyForVerificationPackage = [
    ...custodyEvents.map((ev) => ({
      sequence: ev.sequence,
      atUtc: ev.atUtc.toISOString(),
      eventType: ev.eventType,
      payload: ev.payload,
    })),
    {
      sequence: reportGeneratedEventSequence,
      atUtc: now.toISOString(),
      eventType: "REPORT_GENERATED",
      payload: {
        phase: "report_generated",
        reportVersion: provisionalVersion,
        generatedAtUtc: now.toISOString(),
      } as Prisma.InputJsonValue,
    },
  ];

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
      tsaProvider: evidence.tsaProvider ?? null,
      tsaUrl: evidence.tsaUrl ?? null,
      tsaSerialNumber: evidence.tsaSerialNumber ?? null,
      tsaGenTimeUtc: evidence.tsaGenTimeUtc?.toISOString() ?? null,
      tsaTokenBase64: evidence.tsaTokenBase64 ?? null,
      tsaMessageImprint: evidence.tsaMessageImprint ?? null,
      tsaHashAlgorithm: evidence.tsaHashAlgorithm ?? null,
      tsaStatus: evidence.tsaStatus ?? null,
      tsaFailureReason: evidence.tsaFailureReason ?? null,
    },
    custodyEvents: custodyEventsForReport,
    version: provisionalVersion,
    generatedAtUtc: now.toISOString(),
    buildInfo: env.WORKER_BUILD_INFO ?? null,
    verifyUrl,
    downloadUrl: evidenceDetailUrl,
  });

  let verificationZip: Buffer | null = null;

  if (verificationEvidenceFiles.length > 0) {
    try {
      verificationZip = await createVerificationPackage({
        evidenceFiles: verificationEvidenceFiles,
        fingerprint: fingerprintCanonicalJson,
        signature: signatureBase64,
        timestampToken: evidence.tsaTokenBase64 ?? null,
        publicKey: signingKey.publicKeyPem,
        custody: custodyForVerificationPackage,
        evidenceId: evidence.id,
        reportVersion: provisionalVersion,
        signingKeyId,
        signingKeyVersion,
      });
    } catch (verificationError) {
      captureException(verificationError, {
        evidenceId,
        phase: "verification_package_prepare",
      });

      logger.error(
        {
          evidenceId,
          err: verificationError,
        },
        "Verification package generation failed during preparation"
      );
    }
  }

  return {
    reportPdf,
    verificationZip,
    reportKey,
    verificationKey,
    version: provisionalVersion,
    now,
    evidenceId: evidence.id,
  };
}

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
    const prepared = await prepareReportArtifacts(evidenceId);

    const finalized = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtext(${prepared.evidenceId}))
        `;

        const lockedEvidence = await tx.evidence.findFirst({
          where: { id: prepared.evidenceId, deletedAt: null },
          select: {
            id: true,
            status: true,
            reportGeneratedAtUtc: true,
            fileSha256: true,
            fingerprintHash: true,
            signatureBase64: true,
            signingKeyId: true,
            signingKeyVersion: true,
            lockedAt: true,
          },
        });

        if (!lockedEvidence) {
          throw createWorkerError("EVIDENCE_NOT_FOUND", false);
        }

        const existingLatestReport = await tx.report.findFirst({
          where: { evidenceId: prepared.evidenceId },
          orderBy: { version: "desc" },
          select: {
            id: true,
            version: true,
            storageBucket: true,
            storageKey: true,
            generatedAtUtc: true,
          },
        });

        if (
          lockedEvidence.status === EvidenceStatus.REPORTED &&
          existingLatestReport
        ) {
          return {
            skipped: true as const,
            existingReportVersion: existingLatestReport.version,
          };
        }

        if (lockedEvidence.status !== EvidenceStatus.SIGNED) {
          throw createWorkerError(
            `EVIDENCE_NOT_SIGNED:${lockedEvidence.status}`,
            false
          );
        }

        if (
          !lockedEvidence.fileSha256 ||
          !lockedEvidence.fingerprintHash ||
          !lockedEvidence.signatureBase64 ||
          !lockedEvidence.signingKeyId ||
          lockedEvidence.signingKeyVersion == null
        ) {
          throw createWorkerError(
            "SIGNED_EVIDENCE_CRYPTO_STATE_INCOMPLETE",
            false
          );
        }

        await putObjectBuffer({
          bucket: env.S3_BUCKET,
          key: prepared.reportKey,
          body: prepared.reportPdf,
          contentType: "application/pdf",
        });

        await tx.report.create({
          data: {
            evidenceId: prepared.evidenceId,
            version: prepared.version,
            storageBucket: env.S3_BUCKET,
            storageKey: prepared.reportKey,
            generatedAtUtc: prepared.now,
          },
        });

        const lastCustody = await tx.custodyEvent.findFirst({
          where: { evidenceId: prepared.evidenceId },
          orderBy: { sequence: "desc" },
          select: { sequence: true },
        });

        const nextSequence = (lastCustody?.sequence ?? 0) + 1;

        await tx.custodyEvent.create({
          data: {
            evidenceId: prepared.evidenceId,
            eventType: "REPORT_GENERATED" as prismaPkg.CustodyEventType,
            atUtc: prepared.now,
            sequence: nextSequence,
            payload: {
              phase: "report_generated",
              reportVersion: prepared.version,
              generatedAtUtc: prepared.now.toISOString(),
            } as Prisma.InputJsonValue,
          },
        });

        await tx.evidence.update({
          where: { id: prepared.evidenceId },
          data: {
            status: EvidenceStatus.REPORTED,
            reportGeneratedAtUtc: prepared.now,
          },
        });

        return {
          skipped: false as const,
          version: prepared.version,
          reportKey: prepared.reportKey,
        };
      },
      {
        maxWait: 10_000,
        timeout: 120_000,
      }
    );

    if (!finalized.skipped && prepared.verificationZip) {
      try {
        await putObjectBuffer({
          bucket: env.S3_BUCKET,
          key: prepared.verificationKey,
          body: prepared.verificationZip,
          contentType: "application/zip",
        });
      } catch (verificationError) {
        captureException(verificationError, {
          requestId,
          evidenceId,
          jobId: job.id ?? null,
          phase: "verification_package_store",
        });

        logger.error(
          {
            ...withJobContext({
              requestId,
              jobId: job.id,
              evidenceId,
              attempt: job.attemptsMade + 1,
              status: "verification_package_failed",
            }),
            err: verificationError,
          },
          "Verification package upload failed, but report was generated successfully"
        );
      }
    }

    const durationMs = Date.now() - start;

    logger.info(
      withJobContext({
        requestId,
        jobId: job.id,
        evidenceId,
        attempt: job.attemptsMade + 1,
        durationMs,
        status: finalized.skipped ? "already_completed" : "completed",
      }),
      finalized.skipped
        ? "GenerateReportJob skipped because report already exists"
        : "GenerateReportJob completed"
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "REPORT_ALREADY_GENERATED"
    ) {
      const durationMs = Date.now() - start;

      logger.info(
        withJobContext({
          requestId,
          jobId: job.id,
          evidenceId,
          attempt: job.attemptsMade + 1,
          durationMs,
          status: "already_completed",
        }),
        "GenerateReportJob skipped because report already exists"
      );
      return;
    }

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