import { prisma } from "../db";
import { canonicalJson, sha256Hex, ed25519SignHexWithKeyPath } from "../crypto";
import { getObjectStream, headObject } from "../storage";
import { sha256HexFromStream } from "../stream-hash";
import { EvidenceStatus } from "@prisma/client";
import { enqueueGenerateReportJob } from "../queue/report-queue";
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

  if (!evidence.storageBucket || !evidence.storageKey) {
    const err: HttpError = Object.assign(new Error("EVIDENCE_STORAGE_NOT_SET"), {
      statusCode: 400,
    });
    throw err;
  }

  // 2) Verify object exists + get size/content-type
  const meta = await headObject({
    bucket: evidence.storageBucket,
    key: evidence.storageKey,
  });

  const sizeBytesNum = meta.sizeBytes;
  if (!sizeBytesNum || sizeBytesNum <= 0) {
    const err: HttpError = Object.assign(new Error("OBJECT_NOT_FOUND"), {
      statusCode: 404,
    });
    throw err;
  }

  // 3) Hash file stream (SHA-256)
  const body = await getObjectStream({
    bucket: evidence.storageBucket,
    key: evidence.storageKey,
  });

  // بدون any: نمرره كـ ReadableStream عام
  const fileSha256 = await sha256HexFromStream(body as unknown as Readable);

  // 4) Build fingerprint canonical JSON
  const now = new Date();
  const fingerprint = {
    v: 1,
    evidenceId: evidence.id,
    type: evidence.type,
    file: {
      bucket: evidence.storageBucket,
      key: evidence.storageKey,
      sizeBytes: sizeBytesNum,
      mimeType: meta.contentType ?? evidence.mimeType ?? null,
      sha256: fileSha256,
      etag: meta.etag ?? null,
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
    const ev = await tx.evidence.update({
      where: { id: evidence.id },
      data: {
        status: EvidenceStatus.SIGNED,
        uploadedAtUtc: now,
        signedAtUtc: now,
        sizeBytes: BigInt(sizeBytesNum),
        mimeType: meta.contentType ?? evidence.mimeType ?? null,
        fileSha256,
        fingerprintCanonicalJson: canonical,
        fingerprintHash,
        signatureBase64,
        signingKeyId,
        signingKeyVersion,
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
