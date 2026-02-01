import { prisma } from "../db";
import { presignPutObject } from "../storage";
import { EvidenceStatus, EvidenceType } from "@prisma/client";

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export async function createEvidence(params: {
  ownerUserId: string;
  type: EvidenceType;
  mimeType?: string;
}) {
  const bucket = must("S3_BUCKET");
  const publicBase = process.env.S3_PUBLIC_BASE_URL ?? null;

  // create DB record first
  const evidence = await prisma.evidence.create({
    data: {
      ownerUserId: params.ownerUserId,
      type: params.type,
      status: EvidenceStatus.CREATED,
      mimeType: params.mimeType ?? null,
      capturedAtUtc: new Date(),
    },
    select: {
      id: true,
      ownerUserId: true,
      status: true,
      type: true,
      createdAt: true,
    },
  });

  // deterministic storage key pattern
  const key = `evidence/${evidence.id}/original`;

  const putUrl = await presignPutObject({
    bucket,
    key,
    contentType: params.mimeType ?? "application/octet-stream",
    expiresInSeconds: 600,
  });

  // record upload started custody event (sequence 1 for first event, sequence 2 here)
  // We'll keep it simple for now: create 2 events with sequences 1 and 2
  await prisma.custodyEvent.createMany({
    data: [
      {
        evidenceId: evidence.id,
        eventType: "EVIDENCE_CREATED",
        atUtc: new Date(),
        sequence: 1,
        payload: { type: params.type, mimeType: params.mimeType ?? null },
      },
      {
        evidenceId: evidence.id,
        eventType: "UPLOAD_STARTED",
        atUtc: new Date(),
        sequence: 2,
        payload: { bucket, key },
      },
    ],
  });

  // set evidence to UPLOADING and store intended storage path
  await prisma.evidence.update({
    where: { id: evidence.id },
    data: {
      status: EvidenceStatus.UPLOADING,
      storageBucket: bucket,
      storageKey: key,
    },
  });

  const publicUrl =
    publicBase ? `${publicBase.replace(/\/+$/, "")}/${key}` : null;

  return {
    id: evidence.id,
    status: EvidenceStatus.UPLOADING,
    upload: {
      bucket,
      key,
      putUrl,
      publicUrl,
      expiresInSeconds: 600,
    },
  };
}
