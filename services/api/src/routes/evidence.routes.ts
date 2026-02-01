import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDevUserId } from "../auth";
import { createEvidence } from "../services/evidence.service";
import { completeEvidence } from "../services/evidence-complete.service";
import { EvidenceType } from "@prisma/client";
import { prisma } from "../db";
import { presignGetObject } from "../storage";

const CreateEvidenceBody = z.object({
  type: z.nativeEnum(EvidenceType),
  mimeType: z.string().min(1).max(128).optional(),
});

export async function evidenceRoutes(app: FastifyInstance) {
  function buildPublicUrl(key: string): string | null {
    const base = process.env.S3_PUBLIC_BASE_URL;
    if (!base) return null;
    return `${base.replace(/\\/+$/, "")}/${key}`;
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

  app.post("/v1/evidence/:id/complete", async (req, reply) => {
    const ownerUserId = getDevUserId(req);
    const id = z.string().uuid().parse((req.params as any).id);

    const result = await completeEvidence({ evidenceId: id, ownerUserId });

    return reply.code(200).send(result);
  });

  app.get("/v1/evidence/:id/report/latest", async (req, reply) => {
    const ownerUserId = getDevUserId(req);
    const id = z.string().uuid().parse((req.params as any).id);

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
  });

  app.get("/public/verify/:id", async (req, reply) => {
    const id = z.string().uuid().parse((req.params as any).id);

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
