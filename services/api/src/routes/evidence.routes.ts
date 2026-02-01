import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getDevUserId } from "../auth.js";
import { createEvidence } from "../services/evidence.service.js";
import { completeEvidence } from "../services/evidence-complete.service.js";
import * as prismaPkg from "@prisma/client";
import { prisma } from "../db.js";
import { presignGetObject } from "../storage.js";

const CreateEvidenceBody = z.object({
  type: z.nativeEnum(prismaPkg.EvidenceType),
  mimeType: z.string().min(1).max(128).optional(),
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
  function buildPublicUrl(key: string): string | null {
    const base = process.env.S3_PUBLIC_BASE_URL;
    if (!base) return null;
    return `${base.replace(/\/+$/, "")}/${key}`;
  }

  app.post("/v1/evidence", async (req, reply) => {
    const body = CreateEvidenceBody.parse(req.body);
    const ownerUserId = getDevUserId(req);

    const result = await createEvidence({
      ownerUserId,
      type: body.type,
      mimeType: body.mimeType,
    });

    return reply.code(201).send(result);
  });

  app.post("/v1/evidence/:id/complete", async (req: FastifyRequest, reply) => {
    const ownerUserId = getDevUserId(req);
    const id = z.string().uuid().parse((req.params as ParamsId).id);

    const result = await completeEvidence({ evidenceId: id, ownerUserId });

    return reply.code(200).send(result);
  });

  app.get(
    "/v1/evidence/:id/report/latest",
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getDevUserId(req);
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
}
