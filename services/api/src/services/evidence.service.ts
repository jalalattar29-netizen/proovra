import { prisma } from "../db.js";
import { getPublicBaseUrl, presignPutObject } from "../storage.js";
import * as prismaPkg from "@prisma/client";
import { ensureGuestIdentity } from "./auth.service.js";

function must(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`${name} is not set`);
  return v.trim();
}

function normalizeUploadMimeType(input?: string | null): string {
  const raw = typeof input === "string" ? input.trim().toLowerCase() : "";

  if (!raw) return "application/octet-stream";
  if (raw.length > 128) return "application/octet-stream";
  if (/[\r\n]/.test(raw)) return "application/octet-stream";
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(raw)) {
    return "application/octet-stream";
  }

  return raw;
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
  const publicBase = getPublicBaseUrl();
  const capturedAt = new Date();
  const normalizedMimeType = normalizeUploadMimeType(params.mimeType);

  const evidence = await prisma.evidence.create({
    data: {
      ownerUserId: params.ownerUserId,
      type: params.type,
      status: EvidenceStatus.CREATED,
      mimeType: normalizedMimeType,
      capturedAtUtc: capturedAt,
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
    contentType: normalizedMimeType,
    expiresInSeconds: 600,
  });

  await prisma.custodyEvent.createMany({
    data: [
      {
        evidenceId: evidence.id,
        eventType: prismaPkg.CustodyEventType.EVIDENCE_CREATED,
        atUtc: capturedAt,
        sequence: 1,
        payload: {
          phase: "evidence_created",
          type: params.type,
          mimeType: normalizedMimeType,
          deviceTimeIso: params.deviceTimeIso ?? null,
          gps: params.gps
            ? {
                lat: params.gps.lat,
                lng: params.gps.lng,
                accuracyMeters: params.gps.accuracyMeters ?? null,
              }
            : null,
        } as prismaPkg.Prisma.InputJsonValue,
      },
      {
        evidenceId: evidence.id,
        eventType: prismaPkg.CustodyEventType.UPLOAD_STARTED,
        atUtc: new Date(),
        sequence: 2,
        payload: {
          phase: "upload_started",
          uploadKind: "single",
          bucket,
          key,
          contentType: normalizedMimeType,
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