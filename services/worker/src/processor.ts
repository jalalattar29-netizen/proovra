import type { Job } from "bullmq";
import type { Readable } from "node:stream";
import * as prismaPkg from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { appendCustodyEventTx } from "./custody-events.js";
import { prisma } from "./db.js";
import { env } from "./config.js";
import { logger, withJobContext } from "./logger.js";
import {
  applyDefaultObjectRetention,
  getObjectStream,
  headObject,
  putObjectBuffer,
} from "./storage.js";
import { createHash, randomUUID } from "node:crypto";
import { buildReportPdf } from "./pdf/report.js";
import {
  generateReportJobName,
  reportDlqQueue,
  reportQueue,
} from "./queue.js";
import { captureException } from "./sentry.js";
import { createVerificationPackage } from "./verification-package.js";
import { publishAnchorIfConfigured } from "./anchor-publisher.js";
import { createOpenTimestamp, type OtsStampResult } from "./ots.service.js";

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

type AnchorMode = "off" | "ready" | "active";

type AnchorPayload = {
  version: 1;
  evidenceId: string;
  reportVersion: number;
  fileSha256: string;
  fingerprintHash: string;
  lastEventHash: string | null;
  anchorHash: string;
  generatedAtUtc: string;
};

type EvidenceStorageSnapshot = {
  storageRegion: string | null;
  storageObjectLockMode: string | null;
  storageObjectLockRetainUntilUtc: string | null;
  storageObjectLockLegalHoldStatus: string | null;
  storageImmutable: boolean;
};

type PreparedReportArtifacts = {
  reportPdf: Buffer;
  verificationZip: Buffer | null;
  reportKey: string;
  verificationKey: string;
  version: number;
  now: Date;
  evidenceId: string;
  anchorPayload: AnchorPayload | null;
  anchorMode: AnchorMode;
  evidenceStorage: EvidenceStorageSnapshot;
  fingerprintCanonicalJson: string;
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

function getAnchorMode(): AnchorMode {
  const raw = String(env.ANCHOR_MODE ?? "ready").trim().toLowerCase();

  if (raw === "off" || raw === "active") {
    return raw;
  }

  return "ready";
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
      case "ANCHOR_PUBLISHED":
        return "External anchor publication recorded.";
      case "ANCHOR_FAILED":
        return "External anchor publication failed.";
      case "OTS_APPLIED":
        return "OpenTimestamp proof created.";
      case "OTS_FAILED":
        return "OpenTimestamp proof creation failed.";
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
      const itemCountValue =
        typeof obj.itemCount === "number" && Number.isFinite(obj.itemCount)
          ? obj.itemCount
          : null;
      const itemCount =
        itemCountValue !== null ? String(itemCountValue) : null;
      const sizeBytes = normalizePayloadPrimitive(obj.sizeBytes);
      const hash = shortHash(normalizePayloadPrimitive(obj.fileSha256));

      const completionLabel =
        itemCountValue !== null
          ? itemCountValue <= 1
            ? "Single evidence item completed"
            : "Multipart evidence package completed"
          : multipart
            ? "Multipart evidence package completed"
            : "Single evidence item completed";

      return [
        completionLabel,
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

    case "OTS_APPLIED": {
      const otsStatus = normalizePayloadPrimitive(obj.otsStatus);
      const bitcoinTxid = shortHash(normalizePayloadPrimitive(obj.bitcoinTxid));
      const calendar = normalizePayloadPrimitive(obj.calendar);
      return [
        "OpenTimestamp proof created",
        otsStatus ? `Status: ${otsStatus}` : null,
        bitcoinTxid ? `Bitcoin Tx: ${bitcoinTxid}` : null,
        calendar ? `Calendar: ${calendar}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case "OTS_FAILED": {
      const reason = normalizePayloadPrimitive(obj.failureReason);
      return [
        "OpenTimestamp proof creation failed",
        reason ? `Reason: ${reason}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case "REPORT_GENERATED": {
      const reportVersion = normalizePayloadPrimitive(obj.reportVersion);
      const anchorHash = shortHash(normalizePayloadPrimitive(obj.anchorHash));
      return [
        reportVersion
          ? `Verification report generated • Version: ${reportVersion}`
          : "Verification report generated.",
        anchorHash ? `Anchor: ${anchorHash}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case "ANCHOR_PUBLISHED": {
      const provider = normalizePayloadPrimitive(obj.provider);
      const transactionId = shortHash(
        normalizePayloadPrimitive(obj.transactionId)
      );
      const receiptId = shortHash(normalizePayloadPrimitive(obj.receiptId));
      return [
        "External anchor publication recorded",
        provider ? `Provider: ${provider}` : null,
        transactionId ? `Tx: ${transactionId}` : null,
        receiptId ? `Receipt: ${receiptId}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case "ANCHOR_FAILED": {
      const provider = normalizePayloadPrimitive(obj.provider);
      const reason = normalizePayloadPrimitive(obj.reason);
      return [
        "External anchor publication failed",
        provider ? `Provider: ${provider}` : null,
        reason ? `Reason: ${reason}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
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

function isAlreadyObjectLockedLike(e: unknown): boolean {
  const err = e as {
    name?: unknown;
    code?: unknown;
    Code?: unknown;
    message?: unknown;
  };

  const name = String(err?.name ?? "").toLowerCase();
  const code = String(err?.code ?? err?.Code ?? "").toLowerCase();
  const msg = String(err?.message ?? "").toLowerCase();

  return (
    name.includes("accessdenied") ||
    code.includes("accessdenied") ||
    code === "accessdenied" ||
    msg.includes("access denied because object protected by object lock") ||
    msg.includes("object protected by object lock") ||
    msg.includes("object lock") ||
    msg.includes("retention") ||
    msg.includes("legal hold")
  );
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function applyRetentionOrThrow(
  targets: Array<{ bucket: string; key: string }>
) {
  const deduped = Array.from(
    new Map(targets.map((item) => [`${item.bucket}:${item.key}`, item])).values()
  );

  for (const target of deduped) {
    try {
      await applyDefaultObjectRetention({
        bucket: target.bucket,
        key: target.key,
      });
    } catch (error) {
      if (isAlreadyObjectLockedLike(error)) {
        continue;
      }

      const reason =
        error instanceof Error ? error.message : "UNKNOWN_RETENTION_ERROR";

      throw createWorkerError(
        `OBJECT_RETENTION_APPLY_FAILED:${target.bucket}:${target.key}:${reason}`,
        false
      );
    }
  }
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

function buildAnchorPayload(params: {
  evidenceId: string;
  reportVersion: number;
  fileSha256: string;
  fingerprintHash: string;
  lastEventHash: string | null;
  generatedAtUtc: string;
}): AnchorPayload {
  const anchorHash = createHash("sha256")
    .update(
      [
        params.fingerprintHash.trim().toLowerCase(),
        (params.lastEventHash ?? "").trim().toLowerCase(),
      ].join("|")
    )
    .digest("hex");

  return {
    version: 1,
    evidenceId: params.evidenceId,
    reportVersion: params.reportVersion,
    fileSha256: params.fileSha256,
    fingerprintHash: params.fingerprintHash,
    lastEventHash: params.lastEventHash,
    anchorHash,
    generatedAtUtc: params.generatedAtUtc,
  };
}

async function resolveEvidenceStorageSnapshot(params: {
  storageBucket: string | null;
  storageKey: string | null;
  storageRegion?: string | null;
  storageObjectLockMode?: string | null;
  storageObjectLockRetainUntilUtc?: Date | null;
  storageObjectLockLegalHoldStatus?: string | null;
}): Promise<EvidenceStorageSnapshot> {
  const snapshotMode =
    typeof params.storageObjectLockMode === "string"
      ? params.storageObjectLockMode
      : null;

  const snapshotRetainUntil = params.storageObjectLockRetainUntilUtc
    ? params.storageObjectLockRetainUntilUtc.toISOString()
    : null;

  const snapshotLegalHold =
    typeof params.storageObjectLockLegalHoldStatus === "string"
      ? params.storageObjectLockLegalHoldStatus
      : null;

  const snapshotRegion =
    typeof params.storageRegion === "string" && params.storageRegion.trim()
      ? params.storageRegion.trim()
      : process.env.S3_REGION?.trim() || null;

  if (snapshotMode || snapshotRetainUntil || snapshotLegalHold) {
    return {
      storageRegion: snapshotRegion,
      storageObjectLockMode: snapshotMode,
      storageObjectLockRetainUntilUtc: snapshotRetainUntil,
      storageObjectLockLegalHoldStatus: snapshotLegalHold,
      storageImmutable:
        snapshotMode === "COMPLIANCE" && Boolean(snapshotRetainUntil),
    };
  }

  if (!params.storageBucket || !params.storageKey) {
    return {
      storageRegion: snapshotRegion,
      storageObjectLockMode: null,
      storageObjectLockRetainUntilUtc: null,
      storageObjectLockLegalHoldStatus: null,
      storageImmutable: false,
    };
  }

  try {
    const meta = await headObject({
      bucket: params.storageBucket,
      key: params.storageKey,
    });

    const mode = meta.objectLockMode ? String(meta.objectLockMode) : null;
    const retainUntil =
      meta.objectLockRetainUntilDate instanceof Date
        ? meta.objectLockRetainUntilDate.toISOString()
        : null;
    const legalHold = meta.objectLockLegalHoldStatus
      ? String(meta.objectLockLegalHoldStatus)
      : null;

    return {
      storageRegion: snapshotRegion,
      storageObjectLockMode: mode,
      storageObjectLockRetainUntilUtc: retainUntil,
      storageObjectLockLegalHoldStatus: legalHold,
      storageImmutable: mode === "COMPLIANCE" && Boolean(retainUntil),
    };
  } catch {
    return {
      storageRegion: snapshotRegion,
      storageObjectLockMode: null,
      storageObjectLockRetainUntilUtc: null,
      storageObjectLockLegalHoldStatus: null,
      storageImmutable: false,
    };
  }
}

const { EvidenceStatus } = prismaPkg;

async function prepareReportArtifacts(
  evidenceId: string,
  otsResult?: OtsStampResult | null
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

  const evidenceStorage = await resolveEvidenceStorageSnapshot({
    storageBucket: evidence.storageBucket ?? null,
    storageKey: evidence.storageKey ?? null,
    storageRegion: evidence.storageRegion ?? null,
    storageObjectLockMode: evidence.storageObjectLockMode ?? null,
    storageObjectLockRetainUntilUtc:
      evidence.storageObjectLockRetainUntilUtc ?? null,
    storageObjectLockLegalHoldStatus:
      evidence.storageObjectLockLegalHoldStatus ?? null,
  });

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
      eventHash: true,
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
  const anchorMode = getAnchorMode();
  const reportKey = `reports/${evidence.id}/v${provisionalVersion}.pdf`;
  const verificationKey = `verification/${evidence.id}/package.zip`;
  const publicUrl = storageKey ? buildPublicUrl(storageKey) : null;
  const evidenceDetailUrl = buildEvidenceDetailUrl(evidence.id);
  const verifyUrl = buildVerifyUrl(evidence.id);
  const lastEventHash =
    custodyEvents.length > 0
      ? custodyEvents[custodyEvents.length - 1]?.eventHash ?? null
      : null;

  const anchorPayload =
    anchorMode === "off"
      ? null
      : buildAnchorPayload({
          evidenceId: evidence.id,
          reportVersion: provisionalVersion,
          fileSha256,
          fingerprintHash,
          lastEventHash,
          generatedAtUtc: now.toISOString(),
        });

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
        ...(anchorPayload ? { anchorHash: anchorPayload.anchorHash } : {}),
      }),
    },
  ];

  const custodyForVerificationPackage = [
    ...custodyEvents.map((ev) => ({
      sequence: ev.sequence,
      atUtc: ev.atUtc.toISOString(),
      eventType: ev.eventType,
      payload: ev.payload,
      eventHash: ev.eventHash ?? null,
    })),
    {
      sequence: reportGeneratedEventSequence,
      atUtc: now.toISOString(),
      eventType: "REPORT_GENERATED",
      payload: {
        phase: "report_generated",
        reportVersion: provisionalVersion,
        generatedAtUtc: now.toISOString(),
        ...(anchorPayload ? { anchorHash: anchorPayload.anchorHash } : {}),
      } as Prisma.InputJsonValue,
      eventHash: null,
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
      storageRegion: evidenceStorage.storageRegion,
      storageImmutable: evidenceStorage.storageImmutable,
      storageObjectLockMode: evidenceStorage.storageObjectLockMode,
      storageObjectLockRetainUntilUtc:
        evidenceStorage.storageObjectLockRetainUntilUtc,
      storageObjectLockLegalHoldStatus:
        evidenceStorage.storageObjectLockLegalHoldStatus,
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
      otsProofBase64: otsResult?.proofBase64 ?? null,
      otsHash: otsResult?.hash ?? null,
      otsStatus: otsResult?.status ?? null,
      otsCalendar: otsResult?.calendar ?? null,
      otsBitcoinTxid: otsResult?.bitcoinTxid ?? null,
      otsAnchoredAtUtc: otsResult?.anchoredAtUtc ?? null,
      otsUpgradedAtUtc: otsResult?.upgradedAtUtc ?? null,
      otsFailureReason: otsResult?.failureReason ?? null,
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
        anchor: anchorPayload,
        anchorMode,
        anchorProvider: env.ANCHOR_PROVIDER ?? null,
        anchorPublicBaseUrl: env.ANCHOR_PUBLIC_BASE_URL ?? null,
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
    anchorPayload,
    anchorMode,
    evidenceStorage,
    fingerprintCanonicalJson,
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
    // STEP 1: Load evidence and check if report was already generated
    const evidence = await prisma.evidence.findFirst({
      where: { id: evidenceId, deletedAt: null },
    });

    if (!evidence) {
      throw createWorkerError("EVIDENCE_NOT_FOUND", false);
    }

    if (evidence.status === EvidenceStatus.REPORTED) {
      const existingReport = await prisma.report.findFirst({
        where: { evidenceId },
        orderBy: { version: "desc" },
      });
      if (existingReport) {
        logger.info(ctx, "Report already generated, skipping");
        return;
      }
    }

    // STEP 2: Create OpenTimestamp BEFORE building PDF
    let otsData: OtsStampResult | null = null;
    try {
      if (evidence.fingerprintCanonicalJson) {
        // Calculate the version first
        const latestReport = await prisma.report.findFirst({
          where: { evidenceId },
          orderBy: { version: "desc" },
          select: { version: true },
        });
        const reportVersion = latestReport ? latestReport.version + 1 : 1;

        otsData = await createOpenTimestamp({
          content: Buffer.from(evidence.fingerprintCanonicalJson, "utf8"),
          filenameStem: `fingerprint-${evidenceId}-v${reportVersion}`,
        });

        logger.info(
          {
            ...ctx,
            otsStatus: otsData.status,
            otsHash: otsData.hash,
          },
          "OpenTimestamp created"
        );
      }
    } catch (otsError) {
      // OTS failure should not block report generation
      captureException(otsError, {
        ...ctx,
        phase: "ots_stamp_early",
      });

      logger.warn(
        {
          ...ctx,
          err: otsError,
        },
        "OpenTimestamp creation failed, continuing with report generation"
      );
      // otsData remains null, will be handled later
    }

    // STEP 3: Prepare report artifacts (now with OTS data available)
    const prepared = await prepareReportArtifacts(evidenceId, otsData);

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
          immutable: true,
          metadata: {
            evidence_id: prepared.evidenceId,
            report_version: String(prepared.version),
            anchor_hash: prepared.anchorPayload?.anchorHash ?? undefined,
            artifact_type: "report_pdf",
          },
          tags: {
            artifact: "report",
            evidenceId: prepared.evidenceId,
            immutable: "true",
          },
        });

        await applyRetentionOrThrow([
          {
            bucket: env.S3_BUCKET,
            key: prepared.reportKey,
          },
        ]);

        const reportHead = await headObject({
          bucket: env.S3_BUCKET,
          key: prepared.reportKey,
        });

        await tx.report.create({
          data: {
            evidenceId: prepared.evidenceId,
            version: prepared.version,
            storageBucket: env.S3_BUCKET,
            storageKey: prepared.reportKey,
            storageRegion: process.env.S3_REGION?.trim() || null,
            storageObjectLockMode: reportHead.objectLockMode
              ? String(reportHead.objectLockMode)
              : null,
            storageObjectLockRetainUntilUtc:
              reportHead.objectLockRetainUntilDate ?? null,
            storageObjectLockLegalHoldStatus:
              reportHead.objectLockLegalHoldStatus
                ? String(reportHead.objectLockLegalHoldStatus)
                : null,
            generatedAtUtc: prepared.now,
          },
        });

        await appendCustodyEventTx(tx, {
          evidenceId: prepared.evidenceId,
          eventType: prismaPkg.CustodyEventType.REPORT_GENERATED,
          atUtc: prepared.now,
          payload: {
            phase: "report_generated",
            reportVersion: prepared.version,
            generatedAtUtc: prepared.now.toISOString(),
            ...(prepared.anchorPayload
              ? {
                  anchorHash: prepared.anchorPayload.anchorHash,
                  anchorVersion: prepared.anchorPayload.version,
                  anchorMode: prepared.anchorMode,
                }
              : {
                  anchorMode: prepared.anchorMode,
                }),
          } as Prisma.InputJsonValue,
        });

        // STEP 4: Store OTS result in DB (if we have it)
        if (otsData) {
          if (otsData.status === "PENDING" || otsData.status === "ANCHORED") {
            await tx.evidence.update({
              where: { id: prepared.evidenceId },
              data: {
                otsProofBase64: otsData.proofBase64,
                otsHash: otsData.hash,
                otsStatus: otsData.status,
                otsCalendar: otsData.calendar,
                otsBitcoinTxid: otsData.bitcoinTxid,
                otsAnchoredAtUtc: otsData.anchoredAtUtc
                  ? new Date(otsData.anchoredAtUtc)
                  : null,
                otsUpgradedAtUtc: otsData.upgradedAtUtc
                  ? new Date(otsData.upgradedAtUtc)
                  : null,
                otsFailureReason: null,
              },
            });

            await appendCustodyEventTx(tx, {
              evidenceId: prepared.evidenceId,
              eventType: prismaPkg.CustodyEventType.OTS_APPLIED,
              atUtc: new Date(),
              payload: {
                otsStatus: otsData.status,
                hash: otsData.hash,
                calendar: otsData.calendar,
                bitcoinTxid: otsData.bitcoinTxid,
                anchoredAtUtc: otsData.anchoredAtUtc,
                upgradedAtUtc: otsData.upgradedAtUtc,
              } as Prisma.InputJsonValue,
            });
          } else if (otsData.status === "FAILED") {
            await tx.evidence.update({
              where: { id: prepared.evidenceId },
              data: {
                otsProofBase64: null,
                otsHash: otsData.hash,
                otsStatus: otsData.status,
                otsCalendar: otsData.calendar,
                otsBitcoinTxid: null,
                otsAnchoredAtUtc: null,
                otsUpgradedAtUtc: null,
                otsFailureReason: otsData.failureReason,
              },
            });

            await appendCustodyEventTx(tx, {
              evidenceId: prepared.evidenceId,
              eventType: prismaPkg.CustodyEventType.OTS_FAILED,
              atUtc: new Date(),
              payload: {
                failureReason: otsData.failureReason,
              } as Prisma.InputJsonValue,
            });
          } else if (otsData.status === "DISABLED") {
            // OTS is disabled - still record it in DB
            await tx.evidence.update({
              where: { id: prepared.evidenceId },
              data: {
                otsProofBase64: null,
                otsHash: null,
                otsStatus: "DISABLED",
                otsCalendar: null,
                otsBitcoinTxid: null,
                otsAnchoredAtUtc: null,
                otsUpgradedAtUtc: null,
                otsFailureReason: null,
              },
            });
          }
        }

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

    if (!finalized.skipped) {
      // Publish anchor if configured
      if (prepared.anchorPayload && prepared.anchorMode === "active") {
        try {
          await publishAnchorIfConfigured({
            anchor: prepared.anchorPayload,
          });
        } catch (anchorError) {
          captureException(anchorError, {
            ...ctx,
            phase: "anchor_publish",
          });

          logger.error(
            {
              ...ctx,
              err: anchorError,
            },
            "Anchor publication failed"
          );
        }
      }
    }

    if (!finalized.skipped && prepared.verificationZip) {
      try {
        await putObjectBuffer({
          bucket: env.S3_BUCKET,
          key: prepared.verificationKey,
          body: prepared.verificationZip,
          contentType: "application/zip",
          immutable: true,
          metadata: {
            evidence_id: prepared.evidenceId,
            report_version: String(prepared.version),
            anchor_hash: prepared.anchorPayload?.anchorHash ?? undefined,
            artifact_type: "verification_package",
          },
          tags: {
            artifact: "verification-package",
            evidenceId: prepared.evidenceId,
            immutable: "true",
          },
        });

        await applyRetentionOrThrow([
          {
            bucket: env.S3_BUCKET,
            key: prepared.verificationKey,
          },
        ]);
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

    if (
      !finalized.skipped &&
      prepared.anchorMode === "active" &&
      prepared.anchorPayload
    ) {
      const anchorPayload = prepared.anchorPayload;

      try {
        const anchorPublish = await publishAnchorIfConfigured({
          anchor: anchorPayload,
        });

        if (anchorPublish.published) {
          await prisma.$transaction(async (tx) => {
            await tx.evidenceAnchor.upsert({
              where: {
                evidenceId: prepared.evidenceId,
              },
              update: {
                provider: anchorPublish.provider,
                mode: prepared.anchorMode,
                anchorHash: anchorPayload.anchorHash,
                receiptId: anchorPublish.receiptId,
                transactionId: anchorPublish.transactionId,
                publicUrl: anchorPublish.publicUrl,
                anchoredAtUtc: new Date(anchorPublish.anchoredAtUtc),
              },
              create: {
                evidenceId: prepared.evidenceId,
                provider: anchorPublish.provider,
                mode: prepared.anchorMode,
                anchorHash: anchorPayload.anchorHash,
                receiptId: anchorPublish.receiptId,
                transactionId: anchorPublish.transactionId,
                publicUrl: anchorPublish.publicUrl,
                anchoredAtUtc: new Date(anchorPublish.anchoredAtUtc),
              },
            });

            await appendCustodyEventTx(tx, {
              evidenceId: prepared.evidenceId,
              eventType: prismaPkg.CustodyEventType.ANCHOR_PUBLISHED,
              atUtc: new Date(anchorPublish.anchoredAtUtc),
              payload: {
                provider: anchorPublish.provider,
                anchorMode: prepared.anchorMode,
                anchorHash: anchorPayload.anchorHash,
                receiptId: anchorPublish.receiptId,
                transactionId: anchorPublish.transactionId,
                publicUrl: anchorPublish.publicUrl,
                anchoredAtUtc: anchorPublish.anchoredAtUtc,
              } as Prisma.InputJsonValue,
            });
          });
        } else {
          await prisma.$transaction(async (tx) => {
            await appendCustodyEventTx(tx, {
              evidenceId: prepared.evidenceId,
              eventType: prismaPkg.CustodyEventType.ANCHOR_FAILED,
              atUtc: new Date(),
              payload: {
                provider: anchorPublish.provider,
                anchorMode: prepared.anchorMode,
                anchorHash: anchorPayload.anchorHash,
                reason: anchorPublish.reason,
              } as Prisma.InputJsonValue,
            });
          });

          logger.warn(
            {
              ...withJobContext({
                requestId,
                jobId: job.id,
                evidenceId,
                attempt: job.attemptsMade + 1,
                status: "anchor_not_published",
              }),
              anchorMode: prepared.anchorMode,
              reason: anchorPublish.reason,
            },
            "Anchor publication was not completed"
          );
        }
      } catch (anchorError) {
        captureException(anchorError, {
          requestId,
          evidenceId,
          jobId: job.id ?? null,
          phase: "anchor_publish",
        });

        await prisma.$transaction(async (tx) => {
          await appendCustodyEventTx(tx, {
            evidenceId: prepared.evidenceId,
            eventType: prismaPkg.CustodyEventType.ANCHOR_FAILED,
            atUtc: new Date(),
            payload: {
              provider: env.ANCHOR_PROVIDER ?? null,
              anchorMode: prepared.anchorMode,
              anchorHash: anchorPayload.anchorHash,
              reason:
                anchorError instanceof Error
                  ? anchorError.message
                  : "ANCHOR_PUBLISH_FAILED",
            } as Prisma.InputJsonValue,
          });
        });

        logger.error(
          {
            ...withJobContext({
              requestId,
              jobId: job.id,
              evidenceId,
              attempt: job.attemptsMade + 1,
              status: "anchor_failed",
            }),
            err: anchorError,
            anchorMode: prepared.anchorMode,
            anchorHash: anchorPayload.anchorHash,
          },
          "Anchor publication failed after report generation"
        );
      }
    }

    const durationMs = Date.now() - start;

    logger.info(
      {
        ...withJobContext({
          requestId,
          jobId: job.id,
          evidenceId,
          attempt: job.attemptsMade + 1,
          durationMs,
          status: finalized.skipped ? "already_completed" : "completed",
        }),
        anchorMode: prepared.anchorMode,
        anchorHash: prepared.anchorPayload?.anchorHash ?? null,
      },
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