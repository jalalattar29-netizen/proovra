import { prisma } from "../db.js";
import { getPublicBaseUrl, presignPutObject } from "../storage.js";
import {
  assertWorkspaceAllowsEvidenceCreation,
  resolveWorkspaceScopeForUser,
  assertWorkspaceAllowsStorageGrowth,
} from "./billing-enforcement.service.js";
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

function resolveIdentityLevel(params: {
  provider: prismaPkg.AuthProvider;
  emailVerifiedAt: Date | null;
  currentWorkspaceVerified: boolean;
  currentWorkspaceId: string | null;
}): prismaPkg.IdentityLevel {
  if (params.currentWorkspaceVerified) {
    return prismaPkg.IdentityLevel.VERIFIED_ORGANIZATION;
  }

  if (params.currentWorkspaceId) {
    return prismaPkg.IdentityLevel.ORGANIZATION_ACCOUNT;
  }

  if (
    params.provider === prismaPkg.AuthProvider.GOOGLE ||
    params.provider === prismaPkg.AuthProvider.APPLE
  ) {
    return prismaPkg.IdentityLevel.OAUTH_BACKED_IDENTITY;
  }

  if (params.emailVerifiedAt) {
    return prismaPkg.IdentityLevel.VERIFIED_EMAIL;
  }

  return prismaPkg.IdentityLevel.BASIC_ACCOUNT;
}

const { EvidenceStatus } = prismaPkg;

function sanitizeFileName(value: string | null | undefined): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;

  const normalized = raw.replace(/\\/g, "/").split("/").pop()?.trim() ?? "";
  if (!normalized || normalized === "." || normalized === "..") return null;

  return normalized.slice(0, 255);
}

function formatCaptureFileTimestamp(value: Date): string {
  const yyyy = value.getUTCFullYear();
  const mm = String(value.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(value.getUTCDate()).padStart(2, "0");
  const hh = String(value.getUTCHours()).padStart(2, "0");
  const mi = String(value.getUTCMinutes()).padStart(2, "0");
  const ss = String(value.getUTCSeconds()).padStart(2, "0");
  const ms = String(value.getUTCMilliseconds()).padStart(3, "0");

  return `${yyyy}-${mm}-${dd}_${hh}-${mi}-${ss}.${ms}Z`;
}

function buildGeneratedCaptureFileName(params: {
  mimeType?: string | null;
  capturedAt: Date;
}): string {
  const ext = normalizeUploadMimeType(params.mimeType)
    ? (() => {
        const mime = normalizeUploadMimeType(params.mimeType);
        if (mime === "image/jpeg") return "jpg";
        if (mime === "image/png") return "png";
        if (mime === "image/webp") return "webp";
        if (mime === "video/mp4") return "mp4";
        if (mime === "video/webm") return "webm";
        if (mime === "audio/mpeg") return "mp3";
        if (mime === "audio/wav") return "wav";
        if (mime === "application/pdf") return "pdf";
        return "bin";
      })()
    : "bin";

  return `PROOVRA-CAPTURE-${formatCaptureFileTimestamp(params.capturedAt)}.${ext}`;
}

function resolveRootEvidenceDisplayFileName(params: {
  originalFileName?: string | null;
  captureFileName?: string | null;
  mimeType?: string | null;
  capturedAt: Date;
}): {
  originalFileName: string | null;
  displayFileName: string;
} {
  const original = sanitizeFileName(params.originalFileName);
  const captureName = sanitizeFileName(params.captureFileName);

  if (original) {
    return {
      originalFileName: original,
      displayFileName: original,
    };
  }

  if (captureName) {
    return {
      originalFileName: null,
      displayFileName: captureName,
    };
  }

  return {
    originalFileName: null,
    displayFileName: buildGeneratedCaptureFileName({
      mimeType: params.mimeType,
      capturedAt: params.capturedAt,
    }),
  };
}

export async function createEvidence(params: {
  ownerUserId: string;
  teamId?: string | null;
  type: prismaPkg.EvidenceType;
  mimeType?: string;
  originalFileName?: string | null;
  captureFileName?: string | null;
  deviceTimeIso?: string;
  gps?: { lat: number; lng: number; accuracyMeters?: number };
  checksumSha256Base64?: string | null;
  contentMd5Base64?: string | null;
})
{
  const owner = await prisma.user.findUnique({
    where: { id: params.ownerUserId },
    select: {
      id: true,
      email: true,
      provider: true,
      emailVerifiedAt: true,
      currentWorkspaceId: true,
    },
  });

  if (!owner) {
    throw new Error("OWNER_NOT_FOUND");
  }

  const effectiveTeamId = params.teamId ?? owner.currentWorkspaceId ?? null;

  if (effectiveTeamId) {
    const membership = await prisma.teamMember.findUnique({
      where: {
        teamId_userId: {
          teamId: effectiveTeamId,
          userId: params.ownerUserId,
        },
      },
      select: { teamId: true },
    });

    if (!membership) {
      const err: Error & { statusCode?: number; code?: string } = new Error(
        "Forbidden team workspace"
      );
      err.statusCode = 403;
      err.code = "TEAM_WORKSPACE_FORBIDDEN";
      throw err;
    }
  }

  const workspaceTeam = effectiveTeamId
    ? await prisma.team.findUnique({
        where: { id: effectiveTeamId },
        select: {
          id: true,
          name: true,
          legalName: true,
          verificationState: true,
          evidenceWorkspaceLabel: true,
        },
      })
    : null;

  const scope = await resolveWorkspaceScopeForUser({
    ownerUserId: params.ownerUserId,
    teamId: effectiveTeamId,
  });

  await assertWorkspaceAllowsEvidenceCreation(scope);
  await assertWorkspaceAllowsStorageGrowth({
    scope,
    incomingBytes: 0n,
  });

  const guestIdentity =
    owner.provider === prismaPkg.AuthProvider.GUEST
      ? await ensureGuestIdentity(params.ownerUserId)
      : null;

  const bucket = must("S3_BUCKET");
  const publicBase = getPublicBaseUrl();
  const capturedAt = new Date();
  const normalizedMimeType = normalizeUploadMimeType(params.mimeType);
  const resolvedFileNames = resolveRootEvidenceDisplayFileName({
  originalFileName: params.originalFileName ?? null,
  captureFileName: params.captureFileName ?? null,
  mimeType: normalizedMimeType,
  capturedAt,
});

  const organizationVerifiedSnapshot =
    workspaceTeam?.verificationState ===
    prismaPkg.OrganizationVerificationState.VERIFIED;

  const identityLevelSnapshot = resolveIdentityLevel({
    provider: owner.provider,
    emailVerifiedAt: owner.emailVerifiedAt ?? null,
    currentWorkspaceVerified: organizationVerifiedSnapshot,
    currentWorkspaceId: effectiveTeamId,
  });

  const workspaceNameSnapshot =
    workspaceTeam?.evidenceWorkspaceLabel?.trim() ||
    workspaceTeam?.name?.trim() ||
    null;

  const organizationNameSnapshot =
    workspaceTeam?.legalName?.trim() ||
    workspaceTeam?.name?.trim() ||
    null;

  const created = await prisma.$transaction(async (tx) => {
    const evidence = await tx.evidence.create({
      data: {
        ownerUserId: params.ownerUserId,
        originalFileName: resolvedFileNames.originalFileName,
        displayFileName: resolvedFileNames.displayFileName,
        teamId: scope.teamId,
        organizationId: scope.teamId,
        type: params.type,
        status: EvidenceStatus.CREATED,
        verificationStatus: prismaPkg.VerificationStatus.MATERIALS_AVAILABLE,
        mimeType: normalizedMimeType,
        captureMethod: prismaPkg.CaptureMethod.UPLOADED_FILE,
        identityLevelSnapshot,
        submittedByEmail: owner.email ?? null,
        submittedByAuthProvider: owner.provider,
        submittedByUserId: params.ownerUserId,
        createdByUserId: params.ownerUserId,
        uploadedByUserId: params.ownerUserId,
        workspaceNameSnapshot,
        organizationNameSnapshot,
        organizationVerifiedSnapshot,
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

const key = `evidence/${evidence.id}/original-${resolvedFileNames.displayFileName}`;

    await appendCustodyEventTx(tx, {
      evidenceId: evidence.id,
      eventType: prismaPkg.CustodyEventType.EVIDENCE_CREATED,
      atUtc: capturedAt,
      payload: {
        phase: "evidence_created",
        type: params.type,
        mimeType: normalizedMimeType,
        captureMethod: prismaPkg.CaptureMethod.UPLOADED_FILE,
        verificationStatus: prismaPkg.VerificationStatus.MATERIALS_AVAILABLE,
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
      eventType: prismaPkg.CustodyEventType.IDENTITY_SNAPSHOT_RECORDED,
      atUtc: capturedAt,
      payload: {
        identityLevelSnapshot,
        submittedByEmail: owner.email ?? null,
        submittedByAuthProvider: owner.provider,
        submittedByUserId: params.ownerUserId,
        createdByUserId: params.ownerUserId,
        uploadedByUserId: params.ownerUserId,
        workspaceNameSnapshot,
        organizationNameSnapshot,
        organizationVerifiedSnapshot,
      } as prismaPkg.Prisma.InputJsonValue,
    });

    await appendCustodyEventTx(tx, {
      evidenceId: evidence.id,
      eventType: prismaPkg.CustodyEventType.UPLOAD_STARTED,
      atUtc: new Date(),
      payload: {
        phase: "upload_started",
        uploadKind: "single",
        captureMethod: prismaPkg.CaptureMethod.UPLOADED_FILE,
        bucket,
        key,
        contentType: normalizedMimeType,
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
    checksumSha256Base64: params.checksumSha256Base64 ?? null,
    contentMd5Base64: params.contentMd5Base64 ?? null,
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
      expiresInSeconds: 600,
    },
  };
}