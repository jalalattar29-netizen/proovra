import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { getAuthUserId } from "../auth.js";
import { createEvidence } from "../services/evidence.service.js";
import { completeEvidence } from "../services/evidence-complete.service.js";
import * as prismaPkg from "@prisma/client";
import { prisma } from "../db.js";
import {
  presignGetObject,
  presignPutObject,
  headObject,
} from "../storage.js";
import { verifyJwt } from "../services/jwt.js";
import { enforceRateLimit } from "../services/rate-limit.js";

const EvidenceTypeSchema = prismaPkg.EvidenceType
  ? z.nativeEnum(prismaPkg.EvidenceType)
  : z.enum(["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"]);

const CreateEvidenceBody = z.object({
  type: EvidenceTypeSchema,
  mimeType: z.string().min(1).max(128).optional(),
  deviceTimeIso: z.string().min(1).max(64).optional(),
  gps: z
    .object({
      lat: z.number(),
      lng: z.number(),
      accuracyMeters: z.number().positive().optional(),
    })
    .optional(),
});

const ClaimBody = z.object({
  guestToken: z.string().min(1).optional(),
  evidenceIds: z.array(z.string().uuid()).optional(),
});

const LockBody = z.object({
  locked: z.boolean().optional().default(true),
});

const CreatePartBody = z.object({
  partIndex: z.number().int().min(0),
  mimeType: z.string().min(1).max(128).optional(),
  durationMs: z.number().int().positive().optional(),
});

type ParamsId = { id: string };

const { EvidenceStatus, PlanType } = prismaPkg;

const SAFE_EVIDENCE_SELECT = {
  id: true,
  ownerUserId: true,
  type: true,
  status: true,
  createdAt: true,
  uploadedAtUtc: true,
  signedAtUtc: true,
  capturedAtUtc: true,
  deviceTimeIso: true,
  lat: true,
  lng: true,
  accuracyMeters: true,
  mimeType: true,
  storageBucket: true,
  storageKey: true,
  sizeBytes: true,
  fileSha256: true,
  fingerprintHash: true,
  signatureBase64: true,
  signingKeyId: true,
  signingKeyVersion: true,
  lockedAt: true,
  lockedByUserId: true,
  archivedAt: true,
  caseId: true,
  teamId: true,
  deletedAt: true,
} as const;

type SelectedEvidence = prismaPkg.Prisma.EvidenceGetPayload<{
  select: typeof SAFE_EVIDENCE_SELECT;
}>;

function getTierLimit(plan: prismaPkg.PlanType) {
  switch (plan) {
    case PlanType.PAYG:
      return { max: 30, windowSec: 60 };
    case PlanType.PRO:
    case PlanType.TEAM:
      return { max: 60, windowSec: 60 };
    case PlanType.FREE:
    default:
      return { max: 10, windowSec: 60 };
  }
}

function getVerifyLimit() {
  return { max: 60, windowSec: 60 };
}

async function getUserPlan(userId: string) {
  const entitlement = await prisma.entitlement.findFirst({
    where: { userId, active: true },
  });
  return entitlement?.plan ?? PlanType.FREE;
}

function bigintToString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function decimalToNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;

  if (typeof v === "number") {
    return Number.isFinite(v) ? v : null;
  }

  if (
    typeof v === "object" &&
    v !== null &&
    "toNumber" in v &&
    typeof (v as { toNumber: () => number }).toNumber === "function"
  ) {
    const n = (v as { toNumber: () => number }).toNumber();
    return Number.isFinite(n) ? n : null;
  }

  if (
    typeof v === "object" &&
    v !== null &&
    "toString" in v &&
    typeof (v as { toString: () => string }).toString === "function"
  ) {
    const n = Number((v as { toString: () => string }).toString());
    return Number.isFinite(n) ? n : null;
  }

  return null;
}

function shortHash(value: string | null | undefined, head = 12, tail = 10): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  if (text.length <= head + tail + 3) return text;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

function normalizeMimeType(value: string | null | undefined): string | null {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!text) return null;
  if (text.length > 128) return null;
  if (/[\r\n]/.test(text)) return null;
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(text)) return null;
  return text;
}

function normalizePublicPayloadValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const t = value.trim();
    return t || null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function summarizePublicPayload(
  eventType: prismaPkg.CustodyEventType,
  payload: prismaPkg.Prisma.JsonValue | null
): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    if (eventType === prismaPkg.CustodyEventType.VERIFY_VIEWED) {
      return "Public verification page viewed.";
    }
    return null;
  }

  const obj = payload as Record<string, unknown>;

  switch (eventType) {
    case prismaPkg.CustodyEventType.EVIDENCE_CREATED: {
      const type = normalizePublicPayloadValue(obj.type);
      const mimeType = normalizePublicPayloadValue(obj.mimeType);
      return [type ? `Type: ${type}` : null, mimeType ? `MIME: ${mimeType}` : null]
        .filter(Boolean)
        .join(" • ") || "Evidence record created.";
    }

    case prismaPkg.CustodyEventType.UPLOAD_STARTED: {
      const mimeType = normalizePublicPayloadValue(obj.mimeType);
      const uploadKind =
        normalizePublicPayloadValue(obj.uploadKind) ??
        normalizePublicPayloadValue(obj.mode);
      return [
        uploadKind ? `Upload: ${uploadKind}` : "Upload initialized",
        mimeType ? `MIME: ${mimeType}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case prismaPkg.CustodyEventType.UPLOAD_COMPLETED: {
      const multipart = obj.multipart === true ? "Multipart" : "Single file";
      const itemCount =
        typeof obj.itemCount === "number" && Number.isFinite(obj.itemCount)
          ? String(obj.itemCount)
          : null;
      const sizeBytes = normalizePublicPayloadValue(obj.sizeBytes);
      return [
        "Upload completed",
        multipart,
        itemCount ? `Items: ${itemCount}` : null,
        sizeBytes ? `Size: ${sizeBytes} bytes` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case prismaPkg.CustodyEventType.SIGNATURE_APPLIED: {
      const signingKeyId = normalizePublicPayloadValue(obj.signingKeyId);
      const signingKeyVersion = normalizePublicPayloadValue(obj.signingKeyVersion);
      const tsaStatus = normalizePublicPayloadValue(obj.tsaStatus);
      const tsaProvider = normalizePublicPayloadValue(obj.tsaProvider);
      return [
        "Cryptographic signature applied",
        signingKeyId ? `Key: ${signingKeyId}` : null,
        signingKeyVersion ? `Version: ${signingKeyVersion}` : null,
        tsaStatus ? `Timestamp: ${tsaStatus}` : null,
        tsaProvider ? `TSA: ${tsaProvider}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case prismaPkg.CustodyEventType.TIMESTAMP_APPLIED: {
      const tsaStatus = normalizePublicPayloadValue(obj.tsaStatus);
      const tsaProvider = normalizePublicPayloadValue(obj.tsaProvider);
      return [
        "Timestamp applied",
        tsaStatus ? `Status: ${tsaStatus}` : null,
        tsaProvider ? `TSA: ${tsaProvider}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case prismaPkg.CustodyEventType.TIMESTAMP_FAILED: {
      const tsaStatus = normalizePublicPayloadValue(obj.tsaStatus);
      const tsaProvider = normalizePublicPayloadValue(obj.tsaProvider);
      return [
        "Timestamp failed",
        tsaStatus ? `Status: ${tsaStatus}` : null,
        tsaProvider ? `TSA: ${tsaProvider}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case prismaPkg.CustodyEventType.REPORT_GENERATED: {
      const reportVersion = normalizePublicPayloadValue(obj.reportVersion);
      return reportVersion
        ? `Verification report generated • Version: ${reportVersion}`
        : "Verification report generated.";
    }

    case prismaPkg.CustodyEventType.REPORT_DOWNLOADED: {
      const reportVersion = normalizePublicPayloadValue(obj.reportVersion);
      return reportVersion
        ? `Report downloaded • Version: ${reportVersion}`
        : "Report downloaded.";
    }

    case prismaPkg.CustodyEventType.VERIFY_VIEWED:
      return "Public verification page viewed.";

    case prismaPkg.CustodyEventType.EVIDENCE_VIEWED:
      return "Protected evidence file accessed.";

    case prismaPkg.CustodyEventType.EVIDENCE_LOCKED:
      return "Evidence record locked.";

    case prismaPkg.CustodyEventType.EVIDENCE_ARCHIVED:
      return "Evidence record archived.";

    case prismaPkg.CustodyEventType.EVIDENCE_RESTORED:
      return "Evidence record restored.";

    case prismaPkg.CustodyEventType.EVIDENCE_DELETED:
      return "Evidence record deleted.";

    case prismaPkg.CustodyEventType.EVIDENCE_CLAIMED:
      return "Guest evidence ownership claimed.";

    default: {
      const safeEntries = Object.entries(obj)
        .filter(([key, value]) => {
          const lowered = key.toLowerCase();
          if (
            lowered.includes("bucket") ||
            lowered.includes("storagekey") ||
            lowered.includes("key") ||
            lowered.includes("token") ||
            lowered.includes("secret") ||
            lowered.includes("password") ||
            lowered.includes("lat") ||
            lowered.includes("lng") ||
            lowered.includes("accuracy") ||
            lowered.includes("ip") ||
            lowered.includes("useragent")
          ) {
            return false;
          }

          return (
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
          );
        })
        .slice(0, 5)
        .map(([key, value]) => `${key}: ${String(value)}`);

      return safeEntries.length > 0 ? safeEntries.join(" • ") : null;
    }
  }
}

type SafeEvidence = {
  id: string;
  type: prismaPkg.EvidenceType;
  status: prismaPkg.EvidenceStatus;
  createdAt: string;
  uploadedAtUtc: string | null;
  signedAtUtc: string | null;
  capturedAtUtc: string | null;
  deviceTimeIso: string | null;
  lat: number | null;
  lng: number | null;
  accuracyMeters: number | null;
  mimeType: string | null;
  storageBucket: string | null;
  storageKey: string | null;
  sizeBytes: string | null;
  fileSha256: string | null;
  fingerprintHash: string | null;
  signatureBase64: string | null;
  signingKeyId: string | null;
  signingKeyVersion: number | null;
  lockedAt: string | null;
  lockedByUserId: string | null;
  archivedAt: string | null;
  caseId: string | null;
  teamId: string | null;
};

function toSafeEvidence(e: SelectedEvidence): SafeEvidence {
  return {
    id: e.id,
    type: e.type,
    status: e.status,
    createdAt: e.createdAt.toISOString(),
    uploadedAtUtc: e.uploadedAtUtc ? e.uploadedAtUtc.toISOString() : null,
    signedAtUtc: e.signedAtUtc ? e.signedAtUtc.toISOString() : null,
    capturedAtUtc: e.capturedAtUtc ? e.capturedAtUtc.toISOString() : null,
    deviceTimeIso: e.deviceTimeIso ?? null,
    lat: decimalToNumber(e.lat),
    lng: decimalToNumber(e.lng),
    accuracyMeters: decimalToNumber(e.accuracyMeters),
    mimeType: e.mimeType ?? null,
    storageBucket: e.storageBucket ?? null,
    storageKey: e.storageKey ?? null,
    sizeBytes: bigintToString(e.sizeBytes),
    fileSha256: e.fileSha256 ?? null,
    fingerprintHash: e.fingerprintHash ?? null,
    signatureBase64: e.signatureBase64 ?? null,
    signingKeyId: e.signingKeyId ?? null,
    signingKeyVersion: e.signingKeyVersion ?? null,
    lockedAt: e.lockedAt ? e.lockedAt.toISOString() : null,
    lockedByUserId: e.lockedByUserId ?? null,
    archivedAt: e.archivedAt ? e.archivedAt.toISOString() : null,
    caseId: e.caseId ?? null,
    teamId: e.teamId ?? null,
  };
}

async function appendCustodyEvent(params: {
  evidenceId: string;
  eventType: prismaPkg.CustodyEventType;
  payload?: prismaPkg.Prisma.InputJsonValue | null;
  ip?: string | null;
  userAgent?: string | null;
}) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${params.evidenceId}))
    `;

    const last = await tx.custodyEvent.findFirst({
      where: { evidenceId: params.evidenceId },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });

    const nextSeq = (last?.sequence ?? 0) + 1;

    await tx.custodyEvent.create({
      data: {
        evidenceId: params.evidenceId,
        eventType: params.eventType,
        atUtc: new Date(),
        sequence: nextSeq,
        payload:
          (params.payload ?? prismaPkg.Prisma.JsonNull) as prismaPkg.Prisma.InputJsonValue,
        ip: params.ip ?? null,
        userAgent: params.userAgent ?? null,
      },
    });
  });
}

async function assertCaseAccess(userId: string, caseId: string) {
  const item = await prisma.case.findUnique({
    where: { id: caseId },
    include: { access: true },
  });

  if (!item) {
    const err: Error & { statusCode?: number } = new Error("Case not found");
    err.statusCode = 404;
    throw err;
  }

  if (item.ownerUserId === userId) return;
  if (item.access.some((a) => a.userId === userId)) return;

  if (item.teamId && item.access.length === 0) {
    const member = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: item.teamId, userId } },
    });
    if (member) return;
  }

  const err: Error & { statusCode?: number } = new Error("Forbidden");
  err.statusCode = 403;
  throw err;
}

async function getEvidenceWithReadAccess(
  userId: string,
  evidenceId: string
): Promise<SelectedEvidence> {
  const evidence = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    select: SAFE_EVIDENCE_SELECT,
  });

  if (!evidence || evidence.deletedAt) {
    const err: Error & { statusCode?: number } = new Error("Evidence not found");
    err.statusCode = 404;
    throw err;
  }

  if (evidence.ownerUserId === userId) {
    return evidence;
  }

  if (evidence.caseId) {
    const caseItem = await prisma.case.findUnique({
      where: { id: evidence.caseId },
      include: { access: true },
    });

    if (caseItem) {
      if (caseItem.ownerUserId === userId) {
        return evidence;
      }

      if (caseItem.access.some((a) => a.userId === userId)) {
        return evidence;
      }

      if (caseItem.teamId && caseItem.access.length === 0) {
        const member = await prisma.teamMember.findUnique({
          where: {
            teamId_userId: {
              teamId: caseItem.teamId,
              userId,
            },
          },
        });

        if (member) {
          return evidence;
        }
      }
    }
  }

  if (evidence.teamId) {
    const member = await prisma.teamMember.findUnique({
      where: {
        teamId_userId: {
          teamId: evidence.teamId,
          userId,
        },
      },
    });

    if (member) {
      return evidence;
    }
  }

  const err: Error & { statusCode?: number } = new Error("Forbidden");
  err.statusCode = 403;
  throw err;
}

async function getEvidenceWithOwnerAccess(
  userId: string,
  evidenceId: string
): Promise<SelectedEvidence> {
  const evidence = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    select: SAFE_EVIDENCE_SELECT,
  });

  if (!evidence || evidence.deletedAt) {
    const err: Error & { statusCode?: number } = new Error("Evidence not found");
    err.statusCode = 404;
    throw err;
  }

  if (evidence.ownerUserId !== userId) {
    const err: Error & { statusCode?: number } = new Error("Forbidden");
    err.statusCode = 403;
    throw err;
  }

  return evidence;
}

export async function evidenceRoutes(app: FastifyInstance) {
  function must(name: string): string {
    const v = process.env[name];
    if (!v || !v.trim()) throw new Error(`${name} is not set`);
    return v.trim();
  }

  function toJsonSafe<T>(value: T): T {
    return JSON.parse(
      JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))
    );
  }

  app.post("/v1/evidence", { preHandler: requireAuth }, async (req, reply) => {
    const body = CreateEvidenceBody.parse(req.body);
    const ownerUserId = getAuthUserId(req);
    const plan = await getUserPlan(ownerUserId);
    const limit = getTierLimit(plan);
    const rate = await enforceRateLimit({
      key: `ratelimit:evidence:create:${plan}:${ownerUserId}`,
      max: limit.max,
      windowSec: limit.windowSec,
    });

    if (!rate.allowed) {
      return reply.code(429).send({ message: "Rate limit exceeded" });
    }

    try {
      const result = await createEvidence({
        ownerUserId,
        type: body.type,
        mimeType: body.mimeType,
        deviceTimeIso: body.deviceTimeIso,
        gps: body.gps,
      });

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = result.id;
      req.log = req.log.child({ evidenceId: result.id });
      req.log.info(
        { userId: ownerUserId, evidenceId: result.id },
        "evidence.created"
      );

      return reply.code(201).send(result);
    } catch (err) {
      if (err instanceof Error && err.message === "PAYG_CREDITS_REQUIRED") {
        return reply.code(402).send({ message: "Pay-per-evidence credits required" });
      }

      if (err instanceof Error && err.message === "FREE_LIMIT_REACHED") {
        return reply.code(402).send({ message: "Free plan limit reached" });
      }

      throw err;
    }
  });

  app.post(
    "/v1/evidence/:id/parts",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      const body = CreatePartBody.parse(req.body);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      try {
        await getEvidenceWithOwnerAccess(ownerUserId, id);
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      try {
        const result = await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`
            SELECT pg_advisory_xact_lock(hashtext(${id}))
          `;

          const evidence = await tx.evidence.findUnique({
            where: { id },
            select: SAFE_EVIDENCE_SELECT,
          });

          if (!evidence || evidence.deletedAt) {
            const err: Error & { statusCode?: number } = new Error("Evidence not found");
            err.statusCode = 404;
            throw err;
          }

          if (evidence.ownerUserId !== ownerUserId) {
            const err: Error & { statusCode?: number } = new Error("Forbidden");
            err.statusCode = 403;
            throw err;
          }

          if (
            evidence.status === EvidenceStatus.SIGNED ||
            evidence.status === EvidenceStatus.REPORTED ||
            evidence.lockedAt
          ) {
            const err: Error & { statusCode?: number } = new Error("Evidence is immutable");
            err.statusCode = 409;
            throw err;
          }

          const existing = await tx.evidencePart.findFirst({
            where: { evidenceId: id, partIndex: body.partIndex },
          });

          if (existing) {
            return { part: existing, created: false as const };
          }

          const bucket = must("S3_BUCKET");
          const key = `evidence/${id}/parts/${body.partIndex}`;
          const normalizedMimeType =
            normalizeMimeType(body.mimeType) ?? "application/octet-stream";

          const part = await tx.evidencePart.create({
            data: {
              evidenceId: id,
              partIndex: body.partIndex,
              storageBucket: bucket,
              storageKey: key,
              mimeType: normalizedMimeType,
              durationMs: body.durationMs ?? null,
            },
          });

          return { part, created: true as const };
        });

        const putUrl = await presignPutObject({
          bucket: result.part.storageBucket,
          key: result.part.storageKey,
          contentType: result.part.mimeType ?? "application/octet-stream",
          expiresInSeconds: 600,
        });

        if (!result.created) {
          return reply.code(200).send({
            part: result.part,
            upload: {
              bucket: result.part.storageBucket,
              key: result.part.storageKey,
              putUrl,
              expiresInSeconds: 600,
            },
          });
        }

        return reply.code(201).send({
          part: result.part,
          upload: {
            bucket: result.part.storageBucket,
            key: result.part.storageKey,
            putUrl,
            expiresInSeconds: 600,
          },
        });
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }
    }
  );

  app.get(
    "/v1/evidence/:id/parts",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      let evidence: SelectedEvidence;
      try {
        evidence = await getEvidenceWithReadAccess(ownerUserId, id);
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      const parts = await prisma.evidencePart.findMany({
        where: { evidenceId: id },
        orderBy: { partIndex: "asc" },
      });

      const enrichedParts = await Promise.all(
        parts.map(async (part) => {
          const url = await presignGetObject({
            bucket: part.storageBucket,
            key: part.storageKey,
            expiresInSeconds: 600,
          });

          return {
            ...toJsonSafe(part),
            url,
            isPrimary:
              evidence.storageBucket === part.storageBucket &&
              evidence.storageKey === part.storageKey,
          };
        })
      );

      return reply.code(200).send({
        evidenceId: id,
        multipart: enrichedParts.length > 1,
        primary:
          evidence.storageBucket && evidence.storageKey
            ? {
                bucket: evidence.storageBucket,
                key: evidence.storageKey,
              }
            : null,
        parts: enrichedParts,
      });
    }
  );

  app.post("/v1/evidence/claim", { preHandler: requireAuth }, async (req, reply) => {
    const body = ClaimBody.parse(req.body);

    if (!body.guestToken) {
      return reply.code(400).send({ message: "guest_token_required" });
    }

    const secret = process.env.AUTH_JWT_SECRET;
    if (!secret) {
      return reply.code(500).send({ message: "AUTH_JWT_SECRET is not set" });
    }

    const payload = verifyJwt(body.guestToken, secret);
    if (payload.provider !== "GUEST") {
      return reply.code(400).send({ message: "invalid_guest_token" });
    }

    const guestUserId = payload.sub;
    const userId = getAuthUserId(req);

    const where = {
      ownerUserId: guestUserId,
      deletedAt: null,
      status: { notIn: [EvidenceStatus.SIGNED, EvidenceStatus.REPORTED] as prismaPkg.EvidenceStatus[] },
      ...(body.evidenceIds?.length ? { id: { in: body.evidenceIds } } : {}),
    };

    const evidence = await prisma.evidence.findMany({
      where,
      select: { id: true },
    });

    if (evidence.length === 0) {
      return reply.code(200).send({ claimed: 0 });
    }

    await prisma.evidence.updateMany({
      where,
      data: { ownerUserId: userId },
    });

    await prisma.guestIdentity.updateMany({
      where: { userId: guestUserId },
      data: { claimedByUserId: userId, claimedAt: new Date() },
    });

    for (const item of evidence) {
      await appendCustodyEvent({
        evidenceId: item.id,
        eventType: prismaPkg.CustodyEventType.EVIDENCE_CLAIMED,
        payload: { fromUserId: guestUserId, toUserId: userId },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
    }

    return reply.code(200).send({ claimed: evidence.length });
  });

  app.post(
    "/v1/evidence/:id/lock",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      const body = LockBody.parse(req.body);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      let evidence: SelectedEvidence;
      try {
        evidence = await getEvidenceWithOwnerAccess(ownerUserId, id);
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      if (
        evidence.status !== prismaPkg.EvidenceStatus.SIGNED &&
        evidence.status !== prismaPkg.EvidenceStatus.REPORTED
      ) {
        return reply.code(400).send({ message: "Evidence must be signed before lock" });
      }

      if (body.locked) {
        const updated = await prisma.evidence.update({
          where: { id },
          data: { lockedAt: new Date(), lockedByUserId: ownerUserId },
          select: SAFE_EVIDENCE_SELECT,
        });

        await appendCustodyEvent({
          evidenceId: id,
          eventType: prismaPkg.CustodyEventType.EVIDENCE_LOCKED,
          payload: { lockedByUserId: ownerUserId },
          ip: req.ip,
          userAgent: req.headers["user-agent"],
        }).catch(() => null);

        return reply.code(200).send({ evidence: toSafeEvidence(updated) });
      }

      return reply.code(400).send({ message: "Unlock is not allowed" });
    }
  );

  app.post(
    "/v1/evidence/:id/archive",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      let evidence: SelectedEvidence;
      try {
        evidence = await getEvidenceWithOwnerAccess(ownerUserId, id);
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      if (evidence.archivedAt) {
        return reply.code(200).send({ evidence: toSafeEvidence(evidence) });
      }

      const updated = await prisma.evidence.update({
        where: { id },
        data: { archivedAt: new Date() },
        select: SAFE_EVIDENCE_SELECT,
      });

      await appendCustodyEvent({
        evidenceId: id,
        eventType: prismaPkg.CustodyEventType.EVIDENCE_ARCHIVED,
        payload: { archivedByUserId: ownerUserId },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      }).catch(() => null);

      return reply.code(200).send({ evidence: toSafeEvidence(updated) });
    }
  );

  app.post(
    "/v1/evidence/:id/unarchive",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      let evidence: SelectedEvidence;
      try {
        evidence = await getEvidenceWithOwnerAccess(ownerUserId, id);
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      if (!evidence.archivedAt) {
        return reply.code(200).send({ evidence: toSafeEvidence(evidence) });
      }

      const updated = await prisma.evidence.update({
        where: { id },
        data: { archivedAt: null },
        select: SAFE_EVIDENCE_SELECT,
      });

      await appendCustodyEvent({
        evidenceId: id,
        eventType: prismaPkg.CustodyEventType.EVIDENCE_RESTORED,
        payload: { restoredByUserId: ownerUserId },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      }).catch(() => null);

      return reply.code(200).send({ evidence: toSafeEvidence(updated) });
    }
  );

  app.delete(
    "/v1/evidence/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      let evidence: SelectedEvidence;
      try {
        evidence = await getEvidenceWithOwnerAccess(ownerUserId, id);
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      if (
        evidence.status === EvidenceStatus.SIGNED ||
        evidence.status === EvidenceStatus.REPORTED ||
        evidence.lockedAt
      ) {
        return reply.code(409).send({ message: "Cannot delete signed or locked evidence" });
      }

      const now = new Date();
      await prisma.evidence.update({
        where: { id },
        data: { deletedAt: now, deletedAtUtc: now },
      });

      await appendCustodyEvent({
        evidenceId: id,
        eventType: prismaPkg.CustodyEventType.EVIDENCE_DELETED,
        payload: { deletedByUserId: ownerUserId },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });

      return reply.code(200).send({ deleted: true });
    }
  );

  app.get("/v1/evidence", { preHandler: requireAuth }, async (req, reply) => {
    const ownerUserId = getAuthUserId(req);
    const caseIdRaw = (req.query as { caseId?: string }).caseId;
    const includeArchivedRaw = (req.query as { includeArchived?: string }).includeArchived;
    const caseId = caseIdRaw ? z.string().uuid().parse(caseIdRaw) : null;
    const includeArchived = includeArchivedRaw === "true";

    if (caseId) {
      await assertCaseAccess(ownerUserId, caseId);

      const items = await prisma.evidence.findMany({
        where: {
          deletedAt: null,
          ...(includeArchived ? {} : { archivedAt: null }),
          caseId,
        },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
          id: true,
          type: true,
          status: true,
          createdAt: true,
          archivedAt: true,
          caseId: true,
          teamId: true,
          ownerUserId: true,
        },
      });

      return reply.code(200).send({ items });
    }

    const memberTeams = await prisma.teamMember.findMany({
      where: { userId: ownerUserId },
      select: { teamId: true },
    });
    const memberTeamIds = memberTeams.map((t) => t.teamId);

    const accessibleCases = await prisma.case.findMany({
      where: {
        OR: [
          { ownerUserId: ownerUserId },
          { access: { some: { userId: ownerUserId } } },
          ...(memberTeamIds.length > 0
            ? [
                {
                  teamId: { in: memberTeamIds },
                  access: { none: {} },
                },
              ]
            : []),
        ],
      },
      select: { id: true },
    });
    const accessibleCaseIds = accessibleCases.map((c) => c.id);

    const items = await prisma.evidence.findMany({
      where: {
        deletedAt: null,
        ...(includeArchived ? {} : { archivedAt: null }),
        OR: [
          { ownerUserId: ownerUserId },
          ...(accessibleCaseIds.length > 0 ? [{ caseId: { in: accessibleCaseIds } }] : []),
          ...(memberTeamIds.length > 0 ? [{ teamId: { in: memberTeamIds } }] : []),
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        type: true,
        status: true,
        createdAt: true,
        archivedAt: true,
        caseId: true,
        teamId: true,
        ownerUserId: true,
      },
    });

    return reply.code(200).send({ items });
  });

  app.get("/v1/evidence/:id", { preHandler: requireAuth }, async (req, reply) => {
    const id = z.string().uuid().parse((req.params as ParamsId).id);
    const ownerUserId = getAuthUserId(req);

    (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
    req.log = req.log.child({ evidenceId: id });

    try {
      const evidence = await getEvidenceWithReadAccess(ownerUserId, id);
      return reply.code(200).send({ evidence: toJsonSafe(evidence) });
    } catch (err) {
      const statusCode =
        err instanceof Error && "statusCode" in err
          ? (err as Error & { statusCode?: number }).statusCode ?? 500
          : 500;
      const message = err instanceof Error ? err.message : "Unexpected error";
      return reply.code(statusCode).send({ message });
    }
  });

  app.post(
    "/v1/evidence/:id/complete",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      try {
        await getEvidenceWithOwnerAccess(ownerUserId, id);
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      const plan = await getUserPlan(ownerUserId);
      const limit = getTierLimit(plan);
      const rate = await enforceRateLimit({
        key: `ratelimit:evidence:complete:${plan}:${ownerUserId}`,
        max: limit.max,
        windowSec: limit.windowSec,
      });

      if (!rate.allowed) {
        return reply.code(429).send({ message: "Rate limit exceeded" });
      }

      try {
        const result = await completeEvidence({ evidenceId: id, ownerUserId });
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof Error && err.message === "PAYG_CREDITS_REQUIRED") {
          return reply.code(402).send({ message: "Pay-per-evidence credits required" });
        }
        throw err;
      }
    }
  );

  app.get(
    "/v1/evidence/:id/report/latest",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      try {
        await getEvidenceWithReadAccess(ownerUserId, id);
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      const latest = await prisma.report.findFirst({
        where: { evidenceId: id },
        orderBy: { version: "desc" },
        select: {
          version: true,
          storageBucket: true,
          storageKey: true,
          generatedAtUtc: true,
        },
      });

      if (!latest) {
        return reply.code(404).send({ message: "Report not found" });
      }

      await appendCustodyEvent({
        evidenceId: id,
        eventType: prismaPkg.CustodyEventType.REPORT_DOWNLOADED,
        payload: { reportVersion: latest.version },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      }).catch(() => null);

      const url = await presignGetObject({
        bucket: latest.storageBucket,
        key: latest.storageKey,
        expiresInSeconds: 600,
      });

      return reply.code(200).send({
        evidenceId: id,
        version: latest.version,
        bucket: latest.storageBucket,
        key: latest.storageKey,
        url,
        generatedAtUtc: latest.generatedAtUtc.toISOString(),
      });
    }
  );

  app.get(
    "/v1/evidence/:id/original",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      let evidence: SelectedEvidence;
      try {
        evidence = await getEvidenceWithReadAccess(ownerUserId, id);
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      if (!evidence.storageBucket || !evidence.storageKey) {
        return reply.code(404).send({ message: "Original file not found" });
      }

      const url = await presignGetObject({
        bucket: evidence.storageBucket,
        key: evidence.storageKey,
        expiresInSeconds: 600,
      });

      await appendCustodyEvent({
        evidenceId: id,
        eventType: prismaPkg.CustodyEventType.EVIDENCE_VIEWED,
        payload: {
          mimeType: evidence.mimeType ?? null,
          accessMode: "authenticated_original_access",
        },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      }).catch(() => null);

      return reply.code(200).send({
        evidenceId: id,
        bucket: evidence.storageBucket,
        key: evidence.storageKey,
        url,
        mimeType: evidence.mimeType,
        sizeBytes: evidence.sizeBytes?.toString() ?? null,
      });
    }
  );

  app.get(
    "/v1/evidence/:id/verification-package",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      try {
        await getEvidenceWithReadAccess(ownerUserId, id);
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      const bucket = must("S3_BUCKET");
      const key = `verification/${id}/package.zip`;

      try {
        const meta = await headObject({ bucket, key });
        if (!meta.sizeBytes || meta.sizeBytes <= 0) {
          return reply.code(404).send({ message: "Verification package not found" });
        }
      } catch {
        return reply.code(404).send({ message: "Verification package not found" });
      }

      const url = await presignGetObject({
        bucket,
        key,
        expiresInSeconds: 600,
      });

      return reply.code(200).send({
        evidenceId: id,
        key,
        url,
      });
    }
  );

  app.get("/public/verify/:id", async (req: FastifyRequest, reply) => {
    const limit = getVerifyLimit();
    const rate = await enforceRateLimit({
      key: `ratelimit:verify:${req.ip}`,
      max: limit.max,
      windowSec: limit.windowSec,
    });

    if (!rate.allowed) {
      return reply.code(429).send({ message: "Rate limit exceeded" });
    }

    const id = z.string().uuid().parse((req.params as ParamsId).id);

    (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
    req.log = req.log.child({ evidenceId: id });

    const evidence = await prisma.evidence.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        status: true,
        mimeType: true,
        reportGeneratedAtUtc: true,

        fingerprintCanonicalJson: true,
        fingerprintHash: true,
        signatureBase64: true,
        signingKeyId: true,
        signingKeyVersion: true,
        fileSha256: true,

        tsaProvider: true,
        tsaUrl: true,
        tsaSerialNumber: true,
        tsaGenTimeUtc: true,
        tsaMessageImprint: true,
        tsaHashAlgorithm: true,
        tsaStatus: true,
        tsaFailureReason: true,
      },
    });

    if (!evidence) {
      return reply.code(404).send({ message: "Evidence not found" });
    }

    if (
      !evidence.fingerprintCanonicalJson ||
      !evidence.fingerprintHash ||
      !evidence.signatureBase64 ||
      !evidence.signingKeyId ||
      !evidence.signingKeyVersion ||
      !evidence.fileSha256
    ) {
      return reply.code(404).send({ message: "Evidence not signed" });
    }

    const signingKey = await prisma.signingKey.findUnique({
      where: {
        keyId_version: {
          keyId: evidence.signingKeyId,
          version: evidence.signingKeyVersion,
        },
      },
      select: { publicKeyPem: true },
    });

    if (!signingKey) {
      return reply.code(404).send({ message: "Signing key not found" });
    }

    await appendCustodyEvent({
      evidenceId: id,
      eventType: prismaPkg.CustodyEventType.VERIFY_VIEWED,
      payload: {
        accessMode: "public_verify",
      },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    }).catch(() => null);

    const custodyEvents = await prisma.custodyEvent.findMany({
      where: { evidenceId: id },
      orderBy: { sequence: "asc" },
      take: 200,
      select: {
        sequence: true,
        atUtc: true,
        eventType: true,
        payload: true,
      },
    });

    const latestReport = await prisma.report.findFirst({
      where: { evidenceId: id },
      orderBy: { version: "desc" },
      select: {
        version: true,
        generatedAtUtc: true,
      },
    });

    return reply.code(200).send({
      evidenceId: evidence.id,
      status: evidence.status,
      mimeType: evidence.mimeType,

      reportGeneratedAtUtc: latestReport?.generatedAtUtc
        ? latestReport.generatedAtUtc.toISOString()
        : evidence.reportGeneratedAtUtc
          ? evidence.reportGeneratedAtUtc.toISOString()
          : null,
      reportVersion: latestReport?.version ?? null,

      fileSha256: evidence.fileSha256,
      fingerprintHash: evidence.fingerprintHash,
      signatureBase64: evidence.signatureBase64,
      signingKeyId: evidence.signingKeyId,
      signingKeyVersion: evidence.signingKeyVersion,
      publicKeyPem: signingKey.publicKeyPem,

      tsaStatus: evidence.tsaStatus,
      tsaProvider: evidence.tsaProvider,
      tsaUrl: evidence.tsaUrl,
      tsaSerialNumber: evidence.tsaSerialNumber,
      tsaGenTimeUtc: evidence.tsaGenTimeUtc
        ? evidence.tsaGenTimeUtc.toISOString()
        : null,
      tsaMessageImprint: shortHash(evidence.tsaMessageImprint),
      tsaHashAlgorithm: evidence.tsaHashAlgorithm,
      tsaFailureReason: evidence.tsaFailureReason,

      tsa: {
        status: evidence.tsaStatus,
        provider: evidence.tsaProvider,
        url: evidence.tsaUrl,
        serialNumber: evidence.tsaSerialNumber,
        genTimeUtc: evidence.tsaGenTimeUtc
          ? evidence.tsaGenTimeUtc.toISOString()
          : null,
        hashAlgorithm: evidence.tsaHashAlgorithm,
        messageImprint: shortHash(evidence.tsaMessageImprint),
        failureReason: evidence.tsaFailureReason,
      },

      custodyEvents: custodyEvents.map((ev) => ({
        sequence: ev.sequence,
        atUtc: ev.atUtc.toISOString(),
        eventType: ev.eventType,
        payloadSummary: summarizePublicPayload(ev.eventType, ev.payload),
      })),
    });
  });
}