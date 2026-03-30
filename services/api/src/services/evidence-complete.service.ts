import { prisma } from "../db.js";
import { canonicalJson, sha256Hex } from "../crypto.js";
import { getEvidenceSigner } from "../signing/signer.js";
import { getObjectStream, headObject } from "../storage.js";
import { sha256HexFromStream } from "../stream-hash.js";
import { createEvidenceTimestamp } from "./timestamp.service.js";
import * as prismaPkg from "@prisma/client";
import { enqueueGenerateReportJob } from "../queue/report-queue.js";
import { Readable } from "stream";
import { appendCustodyEventTx } from "./custody-events.service.js";

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

const { EvidenceStatus } = prismaPkg;

type CompleteEvidenceReturn = {
  id: string;
  status: prismaPkg.EvidenceStatus;
  fileSha256: string | null;
  fingerprintHash: string | null;
  signatureBase64: string | null;
  signingKeyId: string | null;
  signingKeyVersion: number | null;
};

function asIso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
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

function normalizeObservedMimeType(value: string | null | undefined): string | null {
  const raw = clean(value)?.toLowerCase() ?? null;
  if (!raw) return null;
  if (raw.length > 128) return null;
  if (/[\r\n]/.test(raw)) return null;
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(raw)) return null;
  return raw;
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

export async function completeEvidence(params: {
  evidenceId: string;
  ownerUserId: string;
}): Promise<CompleteEvidenceReturn> {
  const signer = getEvidenceSigner();

  const final = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${params.evidenceId}))
      `;

      const evidence = await tx.evidence.findFirst({
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
      const evidenceMime = normalizeObservedMimeType(evidence.mimeType);

      const entitlement = await tx.entitlement.findFirst({
        where: { userId: params.ownerUserId, active: true },
      });
      const plan = entitlement?.plan ?? prismaPkg.PlanType.FREE;

      if (evidence.status === EvidenceStatus.REPORTED) {
        return {
          result: {
            id: evidence.id,
            status: evidence.status,
            fileSha256: evidence.fileSha256,
            fingerprintHash: evidence.fingerprintHash,
            signatureBase64: evidence.signatureBase64,
            signingKeyId: evidence.signingKeyId,
            signingKeyVersion: evidence.signingKeyVersion,
          },
          shouldEnqueueReport: false,
        };
      }

      if (evidence.status === EvidenceStatus.SIGNED) {
        return {
          result: {
            id: evidence.id,
            status: evidence.status,
            fileSha256: evidence.fileSha256,
            fingerprintHash: evidence.fingerprintHash,
            signatureBase64: evidence.signatureBase64,
            signingKeyId: evidence.signingKeyId,
            signingKeyVersion: evidence.signingKeyVersion,
          },
          shouldEnqueueReport: plan !== prismaPkg.PlanType.FREE,
        };
      }

      const parts = await tx.evidencePart.findMany({
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

      if (
        plan === prismaPkg.PlanType.PAYG &&
        (entitlement?.credits ?? 0) <= 0
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

          const mimeType =
            normalizeObservedMimeType(meta.contentType) ??
            normalizeObservedMimeType(part.mimeType) ??
            null;

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

        primaryBucket = updatedParts[0].bucket;
        primaryKey = updatedParts[0].key;
        primaryMimeType = updatedParts[0].mimeType ?? primaryMimeType ?? evidenceMime;

        fileSha256 = sha256Hex(updatedParts.map((p) => p.sha256).join("|"));
        multipart = true;
        multipartItemCount = updatedParts.length;

        await Promise.all(
          updatedParts.map((p) =>
            tx.evidencePart.update({
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

        primaryMimeType =
          normalizeObservedMimeType(meta.contentType) ?? evidenceMime ?? null;
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

      const signResult = await signer.signFingerprintHex(fingerprintHash);

      const tsaResult = await createEvidenceTimestamp({
        digestHex: fileSha256,
      });

      if (plan === prismaPkg.PlanType.PAYG) {
        const decremented = await tx.entitlement.updateMany({
          where: {
            userId: params.ownerUserId,
            active: true,
            plan: prismaPkg.PlanType.PAYG,
            credits: { gt: 0 },
          },
          data: { credits: { decrement: 1 } },
        });

        if (decremented.count !== 1) {
          const err: HttpError = Object.assign(
            new Error("PAYG_CREDITS_REQUIRED"),
            { statusCode: 402 }
          );
          throw err;
        }
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
          signatureBase64: signResult.signatureBase64,
          signingKeyId: signResult.keyId,
          signingKeyVersion: signResult.keyVersion,
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

      await appendCustodyEventTx(tx, {
        evidenceId: evidence.id,
        eventType: prismaPkg.CustodyEventType.UPLOAD_COMPLETED,
        atUtc: now,
        payload: {
          phase: "upload_completed",
          multipart,
          itemCount: multipartItemCount,
          sizeBytes: sizeBytesNum,
          mimeType: primaryMimeType,
          fileSha256,
        } as prismaPkg.Prisma.InputJsonValue,
      });

      await appendCustodyEventTx(tx, {
        evidenceId: evidence.id,
        eventType: prismaPkg.CustodyEventType.SIGNATURE_APPLIED,
        atUtc: now,
        payload: {
          phase: "signature_applied",
          fingerprintHash,
          signingKeyId: signResult.keyId,
          signingKeyVersion: signResult.keyVersion,
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
      });

      if (tsaResult) {
        await appendCustodyEventTx(tx, {
          evidenceId: evidence.id,
          eventType:
            tsaResult.status === "STAMPED"
              ? prismaPkg.CustodyEventType.TIMESTAMP_APPLIED
              : prismaPkg.CustodyEventType.TIMESTAMP_FAILED,
          atUtc: now,
          payload: {
            tsaProvider: tsaResult.provider,
            tsaUrl: tsaResult.url,
            tsaSerialNumber: tsaResult.serialNumber,
            tsaGenTimeUtc: tsaResult.genTimeUtc?.toISOString() ?? null,
            tsaMessageImprint: tsaResult.messageImprint,
            tsaHashAlgorithm: tsaResult.hashAlgorithm,
            tsaStatus: tsaResult.status,
            tsaFailureReason: tsaResult.failureReason,
          } as prismaPkg.Prisma.InputJsonValue,
        });
      }

      return {
        result: ev,
        shouldEnqueueReport: plan !== prismaPkg.PlanType.FREE,
      };
    },
    {
      maxWait: 10_000,
      timeout: 120_000,
    }
  );

  if (final.shouldEnqueueReport) {
    await enqueueGenerateReportJob(final.result.id);
  }

  return final.result;
}