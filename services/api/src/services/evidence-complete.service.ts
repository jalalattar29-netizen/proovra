import { prisma } from "../db.js";
import {
  canonicalJson,
  sha256Hex,
  ed25519SignHexWithKeyPath,
} from "../crypto.js";
import { getObjectStream, headObject } from "../storage.js";
import { sha256HexFromStream } from "../stream-hash.js";
import { createEvidenceTimestamp } from "./timestamp.service.js";
import * as prismaPkg from "@prisma/client";
import { enqueueGenerateReportJob } from "../queue/report-queue.js";
import { CustodyEventType } from "@prisma/client";
import { Readable } from "stream";

type HttpError = Error & { statusCode: number };

type ProcessedPart = {
  id: string;
  partIndex: number;
  sizeBytes: bigint;
  sha256: string;
  mimeType: string | null;
  bucket: string;
  key: string;
};

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function asIso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function mustInt(name: string): number {
  const raw = must(name);
  const v = Number.parseInt(raw, 10);
  if (!Number.isFinite(v)) {
    throw new Error(`${name} must be an integer`);
  }
  return v;
}

function readMaxEvidenceSizeBytes(): number {
  const raw = process.env.MAX_EVIDENCE_SIZE_MB;
  if (!raw) return 1024 * 1024 * 1024;

  const mb = Number.parseInt(raw, 10);
  if (!Number.isFinite(mb) || mb <= 0) return 1024 * 1024 * 1024;

  return mb * 1024 * 1024;
}

function clean(v: string | null | undefined): string | null {
  if (typeof v !== "string") return v ?? null;
  const t = v.trim();
  return t ? t : null;
}

function decimalToNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (
    typeof value === "object" &&
    value !== null &&
    "toNumber" in value &&
    typeof (value as { toNumber: () => number }).toNumber === "function"
  ) {
    const n = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(n) ? n : null;
  }

  if (
    typeof value === "object" &&
    value !== null &&
    "toString" in value &&
    typeof (value as { toString: () => string }).toString === "function"
  ) {
    const n = Number((value as { toString: () => string }).toString());
    return Number.isFinite(n) ? n : null;
  }

  return null;
}

function isNotFoundLike(e: unknown): boolean {
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
    name.includes("notfound") ||
    code.includes("notfound") ||
    code === "nosuchkey" ||
    msg.includes("notfound") ||
    msg.includes("no such key") ||
    msg.includes("not found")
  );
}

async function safeHead(bucket: string, key: string) {
  try {
    return await headObject({ bucket, key });
  } catch (e) {
    const errObj = e as {
      name?: unknown;
      code?: unknown;
      Code?: unknown;
      message?: unknown;
    };

    const detail =
      errObj?.name ?? errObj?.code ?? errObj?.Code ?? errObj?.message ?? "unknown";

    const err: HttpError = Object.assign(
      new Error(`OBJECT_HEAD_FAILED: ${String(detail)} bucket=${bucket} key=${key}`),
      { statusCode: isNotFoundLike(e) ? 404 : 502 }
    );

    throw err;
  }
}

async function safeGetStream(bucket: string, key: string) {
  try {
    return await getObjectStream({ bucket, key });
  } catch (e) {
    const errObj = e as {
      name?: unknown;
      code?: unknown;
      Code?: unknown;
      message?: unknown;
    };

    const detail =
      errObj?.name ?? errObj?.code ?? errObj?.Code ?? errObj?.message ?? "unknown";

    const err: HttpError = Object.assign(
      new Error(`OBJECT_GET_FAILED: ${String(detail)} bucket=${bucket} key=${key}`),
      { statusCode: isNotFoundLike(e) ? 404 : 502 }
    );

    throw err;
  }
}

function buildMultipartSummary(parts: ProcessedPart[], totalSizeBytes: number) {
  const imageCount = parts.filter((p) =>
    String(p.mimeType ?? "").toLowerCase().startsWith("image/")
  ).length;

  const videoCount = parts.filter((p) =>
    String(p.mimeType ?? "").toLowerCase().startsWith("video/")
  ).length;

  const audioCount = parts.filter((p) =>
    String(p.mimeType ?? "").toLowerCase().startsWith("audio/")
  ).length;

  const documentCount = parts.filter((p) => {
    const mime = String(p.mimeType ?? "").toLowerCase();
    return (
      mime === "application/pdf" ||
      mime.startsWith("text/") ||
      mime.includes("document") ||
      mime.includes("msword") ||
      mime.includes("officedocument")
    );
  }).length;

  const mimeTypes = Array.from(
    new Set(
      parts
        .map((p) => clean(p.mimeType))
        .filter((v): v is string => Boolean(v))
    )
  );

  return {
    itemCount: parts.length,
    totalSizeBytes,
    mimeTypes,
    imageCount,
    videoCount,
    audioCount,
    documentCount,
  };
}

function buildFingerprint(params: {
  evidence: {
    id: string;
    type: prismaPkg.EvidenceType;
    capturedAtUtc: Date | null;
    deviceTimeIso: string | null;
    lat: unknown;
    lng: unknown;
    accuracyMeters: unknown;
  };
  uploadedAtUtcIso: string;
  singleFile?: {
    bucket: string | null;
    key: string | null;
    sizeBytes: number;
    mimeType: string | null;
    sha256: string;
  };
  multipart?: {
    parts: ProcessedPart[];
    totalSizeBytes: number;
  };
}) {
  const gps = {
    lat: decimalToNumber(params.evidence.lat),
    lng: decimalToNumber(params.evidence.lng),
    accuracyMeters: decimalToNumber(params.evidence.accuracyMeters),
  };

  if (params.multipart) {
    const summary = buildMultipartSummary(
      params.multipart.parts,
      params.multipart.totalSizeBytes
    );

    return {
      v: 1,
      evidenceId: params.evidence.id,
      type: params.evidence.type,
      file: {
        multipart: true,
        summary,
        parts: params.multipart.parts.map((p) => ({
          partIndex: p.partIndex,
          storageBucket: p.bucket,
          storageKey: p.key,
          sizeBytes: Number(p.sizeBytes),
          mimeType: p.mimeType,
          sha256: p.sha256,
        })),
      },
      capturedAtUtc: asIso(params.evidence.capturedAtUtc),
      deviceTimeIso: params.evidence.deviceTimeIso ?? null,
      gps,
      uploadedAtUtc: params.uploadedAtUtcIso,
    };
  }

  return {
    v: 1,
    evidenceId: params.evidence.id,
    type: params.evidence.type,
    file: {
      multipart: false,
      bucket: params.singleFile?.bucket ?? null,
      key: params.singleFile?.key ?? null,
      sizeBytes: params.singleFile?.sizeBytes ?? 0,
      mimeType: params.singleFile?.mimeType ?? null,
      sha256: params.singleFile?.sha256 ?? "",
      etag: null,
    },
    capturedAtUtc: asIso(params.evidence.capturedAtUtc),
    deviceTimeIso: params.evidence.deviceTimeIso ?? null,
    gps,
    uploadedAtUtc: params.uploadedAtUtcIso,
  };
}

const { EvidenceStatus } = prismaPkg;

export async function completeEvidence(params: {
  evidenceId: string;
  ownerUserId: string;
}) {
  const evidence = await prisma.evidence.findFirst({
    where: {
      id: params.evidenceId,
      ownerUserId: params.ownerUserId,
      deletedAt: null,
    },
  });

  if (!evidence) {
    const err: HttpError = Object.assign(new Error("NOT_FOUND"), {
      statusCode: 404,
    });
    throw err;
  }

  const evidenceBucket = clean(evidence.storageBucket);
  const evidenceKey = clean(evidence.storageKey);
  const evidenceMime = clean(evidence.mimeType);

  if (evidence.status === EvidenceStatus.REPORTED) {
    return {
      id: evidence.id,
      status: evidence.status,
      fileSha256: evidence.fileSha256,
      fingerprintHash: evidence.fingerprintHash,
      signatureBase64: evidence.signatureBase64,
      signingKeyId: evidence.signingKeyId,
      signingKeyVersion: evidence.signingKeyVersion,
    };
  }

  if (evidence.status === EvidenceStatus.SIGNED) {
    const entitlement = await prisma.entitlement.findFirst({
      where: { userId: params.ownerUserId, active: true },
    });
    const plan = entitlement?.plan ?? prismaPkg.PlanType.FREE;

    if (plan !== prismaPkg.PlanType.FREE) {
      await enqueueGenerateReportJob(evidence.id);
    }

    return {
      id: evidence.id,
      status: evidence.status,
      fileSha256: evidence.fileSha256,
      fingerprintHash: evidence.fingerprintHash,
      signatureBase64: evidence.signatureBase64,
      signingKeyId: evidence.signingKeyId,
      signingKeyVersion: evidence.signingKeyVersion,
    };
  }

  const parts = await prisma.evidencePart.findMany({
    where: { evidenceId: evidence.id },
    orderBy: { partIndex: "asc" },
  });

  if (parts.length === 0 && (!evidenceBucket || !evidenceKey)) {
    const err: HttpError = Object.assign(
      new Error("Cannot complete evidence without an uploaded file"),
      { statusCode: 400 }
    );
    throw err;
  }

  const entitlement = await prisma.entitlement.findFirst({
    where: { userId: params.ownerUserId, active: true },
  });
  const plan = entitlement?.plan ?? prismaPkg.PlanType.FREE;

  if (
    entitlement?.plan === prismaPkg.PlanType.PAYG &&
    (entitlement.credits ?? 0) <= 0
  ) {
    const err: HttpError = Object.assign(new Error("PAYG_CREDITS_REQUIRED"), {
      statusCode: 402,
    });
    throw err;
  }

  let sizeBytesNum = 0;
  let fileSha256 = "";
  let primaryBucket = evidenceBucket;
  let primaryKey = evidenceKey;
  let primaryMimeType = evidenceMime;
  let multipartItemCount = 1;
  let multipart = false;
  let canonical = "";
  let fingerprintHash = "";

  const now = new Date();
  const uploadedAtUtcIso = now.toISOString();

  if (parts.length > 0) {
    const updatedParts: ProcessedPart[] = [];

    for (const part of parts) {
      const bucket = clean(part.storageBucket);
      const key = clean(part.storageKey);

      if (!bucket || !key) {
        const err: HttpError = Object.assign(
          new Error("PART_STORAGE_NOT_SET"),
          { statusCode: 400 }
        );
        throw err;
      }

      const meta = await safeHead(bucket, key);
      const size = meta.sizeBytes;

      if (!size || size <= 0) {
        const err: HttpError = Object.assign(new Error("OBJECT_NOT_FOUND"), {
          statusCode: 404,
        });
        throw err;
      }

      const body = await safeGetStream(bucket, key);
      const sha256 = await sha256HexFromStream(body as unknown as Readable);

      sizeBytesNum += size;

      const mimeType = meta.contentType ?? clean(part.mimeType) ?? null;

      updatedParts.push({
        id: part.id,
        partIndex: part.partIndex,
        sizeBytes: BigInt(size),
        sha256,
        mimeType,
        bucket,
        key,
      });
    }

    if (updatedParts.length === 0) {
      const err: HttpError = Object.assign(new Error("NO_VALID_PARTS_FOUND"), {
        statusCode: 400,
      });
      throw err;
    }

    const maxBytes = readMaxEvidenceSizeBytes();
    if (sizeBytesNum > maxBytes) {
      const err: HttpError = Object.assign(new Error("EVIDENCE_TOO_LARGE"), {
        statusCode: 413,
      });
      throw err;
    }

    // IMPORTANT:
    // For multipart evidence, always point the main evidence storage
    // to the first real uploaded part, not to the original placeholder.
    primaryBucket = updatedParts[0].bucket;
    primaryKey = updatedParts[0].key;
    primaryMimeType = updatedParts[0].mimeType ?? primaryMimeType ?? evidenceMime;

    fileSha256 = sha256Hex(updatedParts.map((p) => p.sha256).join("|"));
    multipart = true;
    multipartItemCount = updatedParts.length;

    await prisma.$transaction(
      updatedParts.map((p) =>
        prisma.evidencePart.update({
          where: { id: p.id },
          data: {
            sizeBytes: p.sizeBytes,
            sha256: p.sha256,
            mimeType: p.mimeType,
          },
        })
      )
    );

    const fingerprint = buildFingerprint({
      evidence: {
        id: evidence.id,
        type: evidence.type,
        capturedAtUtc: evidence.capturedAtUtc,
        deviceTimeIso: evidence.deviceTimeIso,
        lat: evidence.lat,
        lng: evidence.lng,
        accuracyMeters: evidence.accuracyMeters,
      },
      uploadedAtUtcIso,
      multipart: {
        parts: updatedParts,
        totalSizeBytes: sizeBytesNum,
      },
    });

    canonical = canonicalJson(fingerprint);
    fingerprintHash = sha256Hex(canonical);
  } else {
    const bucket = evidenceBucket!;
    const key = evidenceKey!;

    const meta = await safeHead(bucket, key);
    const size = meta.sizeBytes;

    if (!size || size <= 0) {
      const err: HttpError = Object.assign(new Error("OBJECT_NOT_FOUND"), {
        statusCode: 404,
      });
      throw err;
    }

    sizeBytesNum = size;

    const maxBytes = readMaxEvidenceSizeBytes();
    if (sizeBytesNum > maxBytes) {
      const err: HttpError = Object.assign(new Error("EVIDENCE_TOO_LARGE"), {
        statusCode: 413,
      });
      throw err;
    }

    primaryMimeType = meta.contentType ?? evidenceMime ?? null;
    primaryBucket = bucket;
    primaryKey = key;

    const body = await safeGetStream(bucket, key);
    fileSha256 = await sha256HexFromStream(body as unknown as Readable);

    const fingerprint = buildFingerprint({
      evidence: {
        id: evidence.id,
        type: evidence.type,
        capturedAtUtc: evidence.capturedAtUtc,
        deviceTimeIso: evidence.deviceTimeIso,
        lat: evidence.lat,
        lng: evidence.lng,
        accuracyMeters: evidence.accuracyMeters,
      },
      uploadedAtUtcIso,
      singleFile: {
        bucket: primaryBucket,
        key: primaryKey,
        sizeBytes: sizeBytesNum,
        mimeType: primaryMimeType,
        sha256: fileSha256,
      },
    });

    canonical = canonicalJson(fingerprint);
    fingerprintHash = sha256Hex(canonical);
  }

  must("SIGNING_PRIVATE_KEY_PATH");
  const signingKeyId = must("SIGNING_KEY_ID");
  const signingKeyVersion = mustInt("SIGNING_KEY_VERSION");

  const signatureBase64 = ed25519SignHexWithKeyPath(
    fingerprintHash,
    "SIGNING_PRIVATE_KEY_PATH"
  );

  const tsaResult = await createEvidenceTimestamp({
    digestHex: fileSha256,
  });

  const last = await prisma.custodyEvent.findFirst({
    where: { evidenceId: evidence.id },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });

  let seq = last?.sequence ?? 0;

  const updated = await prisma.$transaction(async (tx) => {
    if (entitlement?.plan === prismaPkg.PlanType.PAYG) {
      await tx.entitlement.updateMany({
        where: { userId: params.ownerUserId, active: true },
        data: { credits: { decrement: 1 } },
      });
    }

    const ev = await tx.evidence.update({
      where: { id: evidence.id },
      data: {
        status: EvidenceStatus.SIGNED,
        uploadedAtUtc: now,
        signedAtUtc: now,
        sizeBytes: BigInt(sizeBytesNum),
        mimeType: primaryMimeType,
        fileSha256,
        fingerprintCanonicalJson: canonical,
        fingerprintHash,
        signatureBase64,
        signingKeyId,
        signingKeyVersion,
        storageBucket: primaryBucket,
        storageKey: primaryKey,

        tsaProvider: tsaResult?.provider ?? null,
        tsaUrl: tsaResult?.url ?? null,
        tsaSerialNumber: tsaResult?.serialNumber ?? null,
        tsaGenTimeUtc: tsaResult?.genTimeUtc ?? null,
        tsaTokenBase64: tsaResult?.tokenBase64 ?? null,
        tsaMessageImprint: tsaResult?.messageImprint ?? null,
        tsaHashAlgorithm: tsaResult?.hashAlgorithm ?? null,
        tsaStatus: tsaResult?.status ?? null,
        tsaFailureReason: tsaResult?.failureReason ?? null,
      },
      select: {
        id: true,
        status: true,
        fileSha256: true,
        fingerprintHash: true,
        signatureBase64: true,
        signingKeyId: true,
        signingKeyVersion: true,
      },
    });

    const custodyEventsData: prismaPkg.Prisma.CustodyEventCreateManyInput[] = [
      {
        evidenceId: evidence.id,
        eventType: CustodyEventType.SIGNATURE_APPLIED,
        atUtc: now,
        sequence: ++seq,
        payload: {
          fingerprintHash,
          signingKeyId,
          signingKeyVersion,
          multipart,
          itemCount: multipartItemCount,
          tsaProvider: tsaResult?.provider ?? null,
          tsaUrl: tsaResult?.url ?? null,
          tsaSerialNumber: tsaResult?.serialNumber ?? null,
          tsaGenTimeUtc: tsaResult?.genTimeUtc?.toISOString() ?? null,
          tsaMessageImprint: tsaResult?.messageImprint ?? null,
          tsaHashAlgorithm: tsaResult?.hashAlgorithm ?? null,
          tsaStatus: tsaResult?.status ?? null,
          tsaFailureReason: tsaResult?.failureReason ?? null,
        } as prismaPkg.Prisma.InputJsonValue,
      },
    ];

    await tx.custodyEvent.createMany({
      data: custodyEventsData,
    });

    return ev;
  });

  if (plan !== prismaPkg.PlanType.FREE) {
    await enqueueGenerateReportJob(updated.id);
  }

  return updated;
}