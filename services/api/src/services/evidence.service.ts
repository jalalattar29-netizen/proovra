import { prisma } from "../db.js";
import { getPublicBaseUrl, presignPutObject } from "../storage.js";
import * as prismaPkg from "@prisma/client";
import { ensureGuestIdentity } from "./auth.service.js";
import { appendCustodyEventTx } from "./custody-events.service.js";

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

function normalizeChecksumSha256Base64(input?: string | null): string | null {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) return null;
  if (raw.length > 128) return null;
  if (/[\r\n]/.test(raw)) return null;
  if (!/^[A-Za-z0-9+/=]+$/.test(raw)) return null;
  return raw;
}

const { EvidenceStatus } = prismaPkg;

export async function createEvidence(params: {
  ownerUserId: string;
  type: prismaPkg.EvidenceType;
  mimeType?: string;
  deviceTimeIso?: string;
  gps?: { lat: number; lng: number; accuracyMeters?: number };
  checksumSha256Base64?: string | null;
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
  const normalizedChecksum = normalizeChecksumSha256Base64(
    params.checksumSha256Base64
  );

  if (params.checksumSha256Base64 && !normalizedChecksum) {
    const err = new Error("INVALID_CHECKSUM_SHA256_BASE64") as Error & {
      statusCode?: number;
    };
    err.statusCode = 400;
    throw err;
  }

  const created = await prisma.$transaction(async (tx) => {
    const evidence = await tx.evidence.create({
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
        status: true,
      },
    });

    const key = `evidence/${evidence.id}/original`;

    await appendCustodyEventTx(tx, {
      evidenceId: evidence.id,
      eventType: prismaPkg.CustodyEventType.EVIDENCE_CREATED,
      atUtc: capturedAt,
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
    });

    await appendCustodyEventTx(tx, {
      evidenceId: evidence.id,
      eventType: prismaPkg.CustodyEventType.UPLOAD_STARTED,
      atUtc: new Date(),
      payload: {
        phase: "upload_started",
        uploadKind: "single",
        bucket,
        key,
        contentType: normalizedMimeType,
        checksumSha256Base64: normalizedChecksum,
      } as prismaPkg.Prisma.InputJsonValue,
    });

    await tx.evidence.update({
      where: { id: evidence.id },
      data: {
        status: EvidenceStatus.UPLOADING,
        storageBucket: bucket,
        storageKey: key,
      },
    });

    return {
      id: evidence.id,
      key,
    };
  });

  const putUrl = await presignPutObject({
    bucket,
    key: created.key,
    contentType: normalizedMimeType,
    checksumSha256Base64: normalizedChecksum,
    expiresInSeconds: 600,
  });

  const publicUrl = publicBase
    ? `${publicBase.replace(/\/+$/, "")}/${created.key}`
    : null;

  return {
    id: created.id,
    status: EvidenceStatus.UPLOADING,
    upload: {
      bucket,
      key: created.key,
      putUrl,
      publicUrl,
      checksumRequired: Boolean(normalizedChecksum),
      expiresInSeconds: 600,
    },
  };
}