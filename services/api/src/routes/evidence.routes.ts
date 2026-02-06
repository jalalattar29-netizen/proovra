import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { getAuthUserId } from "../auth.js";
import { createEvidence } from "../services/evidence.service.js";
import { completeEvidence } from "../services/evidence-complete.service.js";
import * as prismaPkg from "@prisma/client";
import { prisma } from "../db.js";
import { presignGetObject, presignPutObject } from "../storage.js";
import { verifyJwt } from "../services/jwt.js";

const CreateEvidenceBody = z.object({
  type: z.nativeEnum(prismaPkg.EvidenceType),
  mimeType: z.string().min(1).max(128).optional(),
});

const ClaimBody = z.object({
  guestToken: z.string().min(1).optional(),
  evidenceIds: z.array(z.string().uuid()).optional()
});
const LockBody = z.object({
  locked: z.boolean().optional().default(true)
});

const CreatePartBody = z.object({
  partIndex: z.number().int().min(0),
  mimeType: z.string().min(1).max(128).optional(),
  durationMs: z.number().int().positive().optional()
});

type ParamsId = { id: string };

type RateLimitEntry = { count: number; windowStartMs: number };
const verifyRateLimitStore = new Map<string, RateLimitEntry>();

function readRateLimitMax(): number {
  const raw = process.env.VERIFY_RATE_LIMIT_MAX;
  const value = raw ? Number.parseInt(raw, 10) : 60;
  return Number.isFinite(value) && value > 0 ? value : 60;
}

function readRateLimitWindowMs(): number {
  const raw = process.env.VERIFY_RATE_LIMIT_WINDOW_SEC;
  const value = raw ? Number.parseInt(raw, 10) : 60;
  return (Number.isFinite(value) && value > 0 ? value : 60) * 1000;
}

function enforceVerifyRateLimit(
  req: FastifyRequest,
  reply: FastifyReply
): boolean {
  const max = readRateLimitMax();
  const windowMs = readRateLimitWindowMs();
  const key = req.ip;
  const now = Date.now();
  const entry = verifyRateLimitStore.get(key);
  if (!entry || now - entry.windowStartMs >= windowMs) {
    verifyRateLimitStore.set(key, { count: 1, windowStartMs: now });
    return true;
  }
  if (entry.count >= max) {
    reply.code(429).send({ message: "Rate limit exceeded" });
    return false;
  }
  entry.count += 1;
  return true;
}

export async function evidenceRoutes(app: FastifyInstance) {
  function must(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is not set`);
    return v;
  }
  function buildPublicUrl(key: string): string | null {
    const base = process.env.S3_PUBLIC_BASE_URL;
    if (!base) return null;
    return `${base.replace(/\/+$/, "")}/${key}`;
  }

  app.post("/v1/evidence", { preHandler: requireAuth }, async (req, reply) => {
    const body = CreateEvidenceBody.parse(req.body);
    const ownerUserId = getAuthUserId(req);
    try {
      const result = await createEvidence({
        ownerUserId,
        type: body.type,
        mimeType: body.mimeType
      });
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

      const evidence = await prisma.evidence.findFirst({
        where: { id, ownerUserId, deletedAt: null },
        select: { id: true }
      });
      if (!evidence) return reply.code(404).send({ message: "Evidence not found" });

      const existing = await prisma.evidencePart.findFirst({
        where: { evidenceId: id, partIndex: body.partIndex }
      });
      if (existing) {
        return reply.code(200).send({ part: existing });
      }

      const bucket = must("S3_BUCKET");
      const key = `evidence/${id}/parts/${body.partIndex}`;
      const putUrl = await presignPutObject({
        bucket,
        key,
        contentType: body.mimeType ?? "application/octet-stream",
        expiresInSeconds: 600
      });

      const part = await prisma.evidencePart.create({
        data: {
          evidenceId: id,
          partIndex: body.partIndex,
          storageBucket: bucket,
          storageKey: key,
          mimeType: body.mimeType ?? null,
          durationMs: body.durationMs ?? null
        }
      });

      return reply.code(201).send({
        part,
        upload: { bucket, key, putUrl, expiresInSeconds: 600 }
      });
    }
  );

  app.get(
    "/v1/evidence/:id/parts",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      const evidence = await prisma.evidence.findFirst({
        where: { id, ownerUserId, deletedAt: null },
        select: { id: true }
      });
      if (!evidence) return reply.code(404).send({ message: "Evidence not found" });
      const parts = await prisma.evidencePart.findMany({
        where: { evidenceId: id },
        orderBy: { partIndex: "asc" }
      });
      return reply.code(200).send({ parts });
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
      ...(body.evidenceIds?.length ? { id: { in: body.evidenceIds } } : {})
    };

    const evidence = await prisma.evidence.findMany({
      where,
      select: { id: true }
    });

    if (evidence.length === 0) {
      return reply.code(200).send({ claimed: 0 });
    }

    await prisma.evidence.updateMany({
      where,
      data: { ownerUserId: userId }
    });

    await prisma.guestIdentity.updateMany({
      where: { userId: guestUserId },
      data: { claimedByUserId: userId, claimedAt: new Date() }
    });

    for (const item of evidence) {
      const last = await prisma.custodyEvent.findFirst({
        where: { evidenceId: item.id },
        orderBy: { sequence: "desc" },
        select: { sequence: true }
      });
      const nextSeq = (last?.sequence ?? 0) + 1;
      await prisma.custodyEvent.create({
        data: {
          evidenceId: item.id,
          eventType: "EVIDENCE_CLAIMED",
          atUtc: new Date(),
          sequence: nextSeq,
          payload: { fromUserId: guestUserId, toUserId: userId }
        }
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
      const evidence = await prisma.evidence.findFirst({
        where: { id, deletedAt: null }
      });
      if (!evidence) return reply.code(404).send({ message: "Evidence not found" });
      if (evidence.ownerUserId !== ownerUserId) {
        return reply.code(403).send({ message: "Forbidden" });
      }
      if (evidence.status !== prismaPkg.EvidenceStatus.SIGNED && evidence.status !== prismaPkg.EvidenceStatus.REPORTED) {
        return reply.code(400).send({ message: "Evidence must be signed before lock" });
      }
      if (body.locked) {
        const updated = await prisma.evidence.update({
          where: { id },
          data: { lockedAt: new Date(), lockedByUserId: ownerUserId }
        });
        return reply.code(200).send({ evidence: updated });
      }
      return reply.code(400).send({ message: "Unlock is not allowed" });
    }
  );

  app.get("/v1/evidence", { preHandler: requireAuth }, async (req, reply) => {
    const ownerUserId = getAuthUserId(req);
    const items = await prisma.evidence.findMany({
      where: { ownerUserId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        type: true,
        status: true,
        createdAt: true
      }
    });
    return reply.code(200).send({ items });
  });

  app.get("/v1/evidence/:id", { preHandler: requireAuth }, async (req, reply) => {
    const id = z.string().uuid().parse((req.params as ParamsId).id);
    const ownerUserId = getAuthUserId(req);
    const evidence = await prisma.evidence.findFirst({
      where: { id, ownerUserId, deletedAt: null }
    });
    if (!evidence) return reply.code(404).send({ message: "Evidence not found" });
    return reply.code(200).send({ evidence });
  });

  app.post(
    "/v1/evidence/:id/complete",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      try {
        const result = await completeEvidence({ evidenceId: id, ownerUserId });
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof Error && err.message === "PAYG_CREDITS_REQUIRED") {
          return reply
            .code(402)
            .send({ message: "Pay-per-evidence credits required" });
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

      const evidence = await prisma.evidence.findFirst({
        where: { id, ownerUserId, deletedAt: null },
        select: { id: true },
      });
      if (!evidence) {
        return reply.code(404).send({ message: "Evidence not found" });
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

      const publicUrl = buildPublicUrl(latest.storageKey);
      const url =
        publicUrl ??
        (await presignGetObject({
          bucket: latest.storageBucket,
          key: latest.storageKey,
          expiresInSeconds: 600,
        }));

      return reply.code(200).send({
        evidenceId: id,
        version: latest.version,
        bucket: latest.storageBucket,
        key: latest.storageKey,
        url,
        publicUrl,
        generatedAtUtc: latest.generatedAtUtc.toISOString(),
      });
    }
  );

  app.get("/public/verify/:id", async (req: FastifyRequest, reply) => {
    if (!enforceVerifyRateLimit(req, reply)) {
      return;
    }
    const id = z.string().uuid().parse((req.params as ParamsId).id);

    const evidence = await prisma.evidence.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        fingerprintCanonicalJson: true,
        fingerprintHash: true,
        signatureBase64: true,
        signingKeyId: true,
        signingKeyVersion: true,
        fileSha256: true,
        storageBucket: true,
        storageKey: true,
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
      !evidence.fileSha256 ||
      !evidence.storageBucket ||
      !evidence.storageKey
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

    const custodyEvents = await prisma.custodyEvent.findMany({
      where: { evidenceId: id },
      orderBy: { sequence: "asc" },
      select: {
        sequence: true,
        atUtc: true,
        eventType: true,
        payload: true,
      },
    });

    return reply.code(200).send({
      evidenceId: evidence.id,
      fingerprintCanonicalJson: evidence.fingerprintCanonicalJson,
      fingerprintHash: evidence.fingerprintHash,
      signatureBase64: evidence.signatureBase64,
      signingKeyId: evidence.signingKeyId,
      signingKeyVersion: evidence.signingKeyVersion,
      publicKeyPem: signingKey.publicKeyPem,
      fileSha256: evidence.fileSha256,
      storageBucket: evidence.storageBucket,
      storageKey: evidence.storageKey,
      publicUrl: buildPublicUrl(evidence.storageKey),
      custodyEvents: custodyEvents.map((ev) => ({
        sequence: ev.sequence,
        atUtc: ev.atUtc.toISOString(),
        eventType: ev.eventType,
        payload: ev.payload,
      })),
    });
  });

  app.get("/public/share/:id", async (req: FastifyRequest, reply) => {
    const id = z.string().uuid().parse((req.params as ParamsId).id);
    const evidence = await prisma.evidence.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        status: true,
        type: true,
        createdAt: true
      }
    });
    if (!evidence) {
      return reply.code(404).send({ message: "Evidence not found" });
    }
    const latest = await prisma.report.findFirst({
      where: { evidenceId: id },
      orderBy: { version: "desc" },
      select: {
        version: true,
        storageBucket: true,
        storageKey: true,
        generatedAtUtc: true
      }
    });
    const publicUrl = latest ? buildPublicUrl(latest.storageKey) : null;
    const url =
      latest && !publicUrl
        ? await presignGetObject({
            bucket: latest.storageBucket,
            key: latest.storageKey,
            expiresInSeconds: 600
          })
        : publicUrl;

    return reply.code(200).send({
      evidenceId: evidence.id,
      status: evidence.status,
      type: evidence.type,
      createdAtUtc: evidence.createdAt.toISOString(),
      report: latest
        ? {
            version: latest.version,
            url,
            publicUrl,
            generatedAtUtc: latest.generatedAtUtc.toISOString()
          }
        : null
    });
  });
}
