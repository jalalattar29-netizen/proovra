import { prisma } from "../db.js";
import { presignPutObject } from "../storage.js";
import * as prismaPkg from "@prisma/client";
import { ensureGuestIdentity } from "./auth.service.js";

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

const { EvidenceStatus } = prismaPkg;

export async function createEvidence(params: {
  ownerUserId: string;
  type: prismaPkg.EvidenceType;
  mimeType?: string;
  deviceTimeIso?: string;
  gps?: { lat: number; lng: number; accuracyMeters?: number };
}) {
  const owner = await prisma.user.findUnique({
    where: { id: params.ownerUserId },
    select: { provider: true },
  });

  const guestIdentity =
    owner?.provider === prismaPkg.AuthProvider.GUEST
      ? await ensureGuestIdentity(params.ownerUserId)
      : null;

  const entitlement = await prisma.entitlement.findFirst({
    where: { userId: params.ownerUserId, active: true },
  });

  if (
    entitlement?.plan === prismaPkg.PlanType.PAYG &&
    (entitlement.credits ?? 0) <= 0
  ) {
    throw new Error("PAYG_CREDITS_REQUIRED");
  }

  if (entitlement?.plan === prismaPkg.PlanType.FREE) {
    const limit = Number.parseInt(process.env.FREE_EVIDENCE_LIMIT ?? "3", 10);

    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);

    const count = await prisma.evidence.count({
      where: {
        ownerUserId: params.ownerUserId,
        createdAt: { gte: monthStart },
      },
    });

    if (count >= limit) {
      throw new Error("FREE_LIMIT_REACHED");
    }
  }

  const bucket = must("S3_BUCKET");
  const publicBase = process.env.S3_PUBLIC_BASE_URL ?? null;

  const evidence = await prisma.evidence.create({
    data: {
      ownerUserId: params.ownerUserId,
      type: params.type,
      status: EvidenceStatus.CREATED,
      mimeType: params.mimeType ?? null,
      capturedAtUtc: new Date(),
      deviceTimeIso: params.deviceTimeIso ?? null,
      lat: params.gps?.lat ?? null,
      lng: params.gps?.lng ?? null,
      accuracyMeters: params.gps?.accuracyMeters ?? null,
      guestIdentityId: guestIdentity?.id ?? null,
    },
    select: {
      id: true,
      ownerUserId: true,
      status: true,
      type: true,
      createdAt: true,
    },
  });

  const key = `evidence/${evidence.id}/original`;

  const putUrl = await presignPutObject({
    bucket,
    key,
    contentType: params.mimeType ?? "application/octet-stream",
    expiresInSeconds: 600,
  });

  await prisma.custodyEvent.createMany({
    data: [
      {
        evidenceId: evidence.id,
        eventType: prismaPkg.CustodyEventType.EVIDENCE_CREATED,
        atUtc: new Date(),
        sequence: 1,
        payload: {
          type: params.type,
          mimeType: params.mimeType ?? null,
        } as prismaPkg.Prisma.InputJsonValue,
      },
      {
        evidenceId: evidence.id,
        eventType: prismaPkg.CustodyEventType.UPLOAD_STARTED,
        atUtc: new Date(),
        sequence: 2,
        payload: {
          bucket,
          key,
        } as prismaPkg.Prisma.InputJsonValue,
      },
    ],
  });

  await prisma.evidence.update({
    where: { id: evidence.id },
    data: {
      status: EvidenceStatus.UPLOADING,
      storageBucket: bucket,
      storageKey: key,
    },
  });

  const publicUrl = publicBase
    ? `${publicBase.replace(/\/+$/, "")}/${key}`
    : null;

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