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

const { EvidenceStatus } = prismaPkg;

export async function completeEvidence(params: {
  evidenceId: string;
  ownerUserId: string;
}) {
  // 1) Load evidence and verify ownership
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

  // If already reported, be idempotent and do not enqueue
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

  // If already signed, be idempotent but ensure report job is enqueued
  if (evidence.status === EvidenceStatus.SIGNED) {
    await enqueueGenerateReportJob(evidence.id);
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
    orderBy: { partIndex: "asc" }
  });
  if (parts.length === 0 && (!evidence.storageBucket || !evidence.storageKey)) {
    const err: HttpError = Object.assign(new Error("EVIDENCE_STORAGE_NOT_SET"), {
      statusCode: 400,
    });
    throw err;
  }

  const entitlement = await prisma.entitlement.findFirst({
    where: { userId: params.ownerUserId, active: true }
  });
  if (entitlement?.plan === prismaPkg.PlanType.PAYG && entitlement.credits <= 0) {
    const err: HttpError = Object.assign(new Error("PAYG_CREDITS_REQUIRED"), {
      statusCode: 402
    });
    throw err;
  }

  // 2) Verify object(s) + hash
  let sizeBytesNum = 0;
  let fileSha256 = "";
  let primaryBucket = evidence.storageBucket ?? null;
  let primaryKey = evidence.storageKey ?? null;
  let primaryMimeType = evidence.mimeType ?? null;

  if (parts.length > 0) {
    const updatedParts = [];
    for (const part of parts) {
      const meta = await headObject({
        bucket: part.storageBucket,
        key: part.storageKey
      });
      const size = meta.sizeBytes;
      if (!size || size <= 0) {
        const err: HttpError = Object.assign(new Error("OBJECT_NOT_FOUND"), {
          statusCode: 404,
        });
        throw err;
      }
      const body = await getObjectStream({
        bucket: part.storageBucket,
        key: part.storageKey
      });
      const sha256 = await sha256HexFromStream(body as unknown as Readable);
      sizeBytesNum += size;
      updatedParts.push({
        id: part.id,
        sizeBytes: BigInt(size),
        sha256,
        mimeType: meta.contentType ?? part.mimeType ?? null
      });
      if (!primaryBucket) primaryBucket = part.storageBucket;
      if (!primaryKey) primaryKey = part.storageKey;
      if (!primaryMimeType) primaryMimeType = meta.contentType ?? part.mimeType ?? null;
    }
    const combined = updatedParts.map((p) => p.sha256).join("|");
    fileSha256 = sha256Hex(combined);
    await prisma.$transaction(
      updatedParts.map((part) =>
        prisma.evidencePart.update({
          where: { id: part.id },
          data: {
            sizeBytes: part.sizeBytes,
            sha256: part.sha256,
            mimeType: part.mimeType
          }
        })
      )
    );
  } else {
    const meta = await headObject({
      bucket: evidence.storageBucket!,
      key: evidence.storageKey!,
    });
    const size = meta.sizeBytes;
    if (!size || size <= 0) {
      const err: HttpError = Object.assign(new Error("OBJECT_NOT_FOUND"), {
        statusCode: 404,
      });
      throw err;
    }
    sizeBytesNum = size;
    primaryMimeType = meta.contentType ?? evidence.mimeType ?? null;
    const body = await getObjectStream({
      bucket: evidence.storageBucket!,
      key: evidence.storageKey!,
    });
    fileSha256 = await sha256HexFromStream(body as unknown as Readable);
  }

  // 4) Build fingerprint canonical JSON
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
              sha256: true
            }
          })
        }
      : {
          bucket: evidence.storageBucket,
          key: evidence.storageKey,
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

  // 5) Sign fingerprint hash (Ed25519) using PRIVATE KEY from file path env
  // Requires: SIGNING_PRIVATE_KEY_PATH in .env
  // Example: SIGNING_PRIVATE_KEY_PATH=keys/signing-private.pem
  must("SIGNING_PRIVATE_KEY_PATH");
  const signingKeyId = must("SIGNING_KEY_ID");
  const signingKeyVersion = mustInt("SIGNING_KEY_VERSION");

  const signatureBase64 = ed25519SignHexWithKeyPath(
    fingerprintHash,
    "SIGNING_PRIVATE_KEY_PATH"
  );

  // 6) Determine next custody sequence
  const last = await prisma.custodyEvent.findFirst({
    where: { evidenceId: evidence.id },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });

  let seq = last?.sequence ?? 0;

  // 7) Transaction: update evidence + append custody events
  const updated = await prisma.$transaction(async (tx) => {
    if (entitlement?.plan === prismaPkg.PlanType.PAYG) {
      await tx.entitlement.updateMany({
        where: { userId: params.ownerUserId, active: true },
        data: { credits: { decrement: 1 } }
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
        storageBucket: primaryBucket ?? evidence.storageBucket,
        storageKey: primaryKey ?? evidence.storageKey
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

    await tx.custodyEvent.createMany({
      data: [
        {
          evidenceId: evidence.id,
          eventType: "UPLOAD_COMPLETED",
          atUtc: now,
          sequence: ++seq,
          payload: {
            sizeBytes: sizeBytesNum,
            contentType: meta.contentType ?? null,
          },
        },
        {
          evidenceId: evidence.id,
          eventType: "SIGNATURE_APPLIED",
          atUtc: now,
          sequence: ++seq,
          payload: { fingerprintHash, signingKeyId, signingKeyVersion },
        },
      ],
    });

    return ev;
  });

  await enqueueGenerateReportJob(updated.id);
  return updated;
}
