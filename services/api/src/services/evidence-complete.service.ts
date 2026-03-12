import { prisma } from "../db.js";
import {
  canonicalJson,
  sha256Hex,
  ed25519SignHexWithKeyPath,
} from "../crypto.js";
import { getObjectStream, headObject } from "../storage.js";
import { sha256HexFromStream } from "../stream-hash.js";
import * as prismaPkg from "@prisma/client";
import { enqueueGenerateReportJob } from "../queue/report-queue.js";
import { CustodyEventType } from "@prisma/client";
import { Readable } from "stream";

type HttpError = Error & { statusCode: number };

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
      new Error("EVIDENCE_STORAGE_NOT_SET"),
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
  let uploadContentType: string | null = null;

  if (parts.length > 0) {
    const updatedParts: Array<{
      id: string;
      sizeBytes: bigint;
      sha256: string;
      mimeType: string | null;
      bucket: string;
      key: string;
    }> = [];

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
        sizeBytes: BigInt(size),
        sha256,
        mimeType,
        bucket,
        key,
      });

      if (!primaryBucket) primaryBucket = bucket;
      if (!primaryKey) primaryKey = key;
      if (!primaryMimeType) primaryMimeType = mimeType;
      if (!uploadContentType) uploadContentType = mimeType;
    }

    const maxBytes = readMaxEvidenceSizeBytes();
    if (sizeBytesNum > maxBytes) {
      const err: HttpError = Object.assign(new Error("EVIDENCE_TOO_LARGE"), {
        statusCode: 413,
      });
      throw err;
    }

    const combined = updatedParts.map((p) => p.sha256).join("|");
    fileSha256 = sha256Hex(combined);

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
    uploadContentType = meta.contentType ?? evidenceMime ?? null;

    const body = await safeGetStream(bucket, key);
    fileSha256 = await sha256HexFromStream(body as unknown as Readable);

    if (!primaryBucket) primaryBucket = bucket;
    if (!primaryKey) primaryKey = key;
  }

  const now = new Date();

  const fingerprint = {
    v: 1,
    evidenceId: evidence.id,
    type: evidence.type,
    file: parts.length
      ? {
          multipart: true,
          parts: await prisma.evidencePart.findMany({
            where: { evidenceId: evidence.id },
            orderBy: { partIndex: "asc" },
            select: {
              partIndex: true,
              storageBucket: true,
              storageKey: true,
              sizeBytes: true,
              mimeType: true,
              sha256: true,
            },
          }),
        }
      : {
          bucket: primaryBucket,
          key: primaryKey,
          sizeBytes: sizeBytesNum,
          mimeType: primaryMimeType,
          sha256: fileSha256,
          etag: null,
        },
    capturedAtUtc: asIso(evidence.capturedAtUtc),
    deviceTimeIso: evidence.deviceTimeIso ?? null,
    gps: {
      lat: evidence.lat ?? null,
      lng: evidence.lng ?? null,
      accuracyMeters: evidence.accuracyMeters ?? null,
    },
    uploadedAtUtc: now.toISOString(),
  };

  const canonical = canonicalJson(fingerprint);
  const fingerprintHash = sha256Hex(canonical);

  must("SIGNING_PRIVATE_KEY_PATH");
  const signingKeyId = must("SIGNING_KEY_ID");
  const signingKeyVersion = mustInt("SIGNING_KEY_VERSION");

  const signatureBase64 = ed25519SignHexWithKeyPath(
    fingerprintHash,
    "SIGNING_PRIVATE_KEY_PATH"
  );

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
        eventType: CustodyEventType.UPLOAD_COMPLETED,
        atUtc: now,
        sequence: ++seq,
        payload: {
          sizeBytes: sizeBytesNum,
          contentType: uploadContentType ?? null,
        } as prismaPkg.Prisma.InputJsonValue,
      },
      {
        evidenceId: evidence.id,
        eventType: CustodyEventType.SIGNATURE_APPLIED,
        atUtc: now,
        sequence: ++seq,
        payload: {
          fingerprintHash,
          signingKeyId,
          signingKeyVersion,
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