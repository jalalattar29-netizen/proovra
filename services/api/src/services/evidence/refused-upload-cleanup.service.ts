/**
 * A REFUSED UPLOAD LEAVES NOTHING BEHIND (PRO-051 / INGEST-001).
 *
 * When the seal refuses a record because its bytes exceed the one effective
 * limit (EVIDENCE_TOO_LARGE), those bytes can never become this record's
 * evidence. They used to stay in storage, uncounted, with the record left
 * UPLOADING and no delete issued. This removes them at once. The record is read
 * under the lock the seal takes, so a record a concurrent seal has just sealed
 * is never touched; a seal starting after the removal finds no object and
 * refuses as it would for any missing upload.
 *
 * Only a record that is still unsealed (CREATED / UPLOADING, never locked) is
 * touched, and only its own part objects and its legacy single object. Removal
 * is version-aware (the shared destruction port): a version under retention or a
 * legal hold is retained and reported, never attempted. The part rows stay, so
 * the owner can upload a smaller file to the same index; the reservation reaper
 * still releases the record if it is abandoned.
 */
import * as prismaPkg from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import {
  removeObjectVersions,
  type EvidenceDestructionStoragePort,
} from "@proovra/shared-runtime";

import { prisma as defaultPrisma } from "../../db.js";
import { apiEvidenceDestructionStorage } from "./destruction-storage-port.js";

export type RefusedUploadCleanup = {
  objects: number;
  deletedVersions: number;
  retainedVersions: number;
  failed: number;
};

const UNSEALED = new Set<string>([prismaPkg.EvidenceStatus.CREATED, prismaPkg.EvidenceStatus.UPLOADING]);

export async function discardRefusedUploadObjects(
  evidenceId: string,
  options: {
    client?: PrismaClient;
    storage?: Pick<EvidenceDestructionStoragePort, "listObjectVersions" | "deleteObjectVersion">;
  } = {},
): Promise<RefusedUploadCleanup> {
  const client = options.client ?? defaultPrisma;
  const storage = options.storage ?? apiEvidenceDestructionStorage;
  const out: RefusedUploadCleanup = { objects: 0, deletedVersions: 0, retainedVersions: 0, failed: 0 };

  const targets = await client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${evidenceId}))`;
    const record = await tx.evidence.findUnique({
      where: { id: evidenceId },
      select: { status: true, lockedAt: true, storageBucket: true, storageKey: true },
    });
    if (!record || !UNSEALED.has(record.status) || record.lockedAt) return [];
    const parts = await tx.evidencePart.findMany({
      where: { evidenceId },
      select: { storageBucket: true, storageKey: true },
    });
    const keys = new Map<string, { bucket: string; key: string }>();
    for (const o of [...parts, record]) {
      if (o.storageBucket && o.storageKey) keys.set(`${o.storageBucket}/${o.storageKey}`, { bucket: o.storageBucket, key: o.storageKey });
    }
    return [...keys.values()];
  });

  for (const target of targets) {
    out.objects++;
    try {
      const removal = await removeObjectVersions(storage, target);
      out.deletedVersions += removal.deletedVersions;
      out.retainedVersions += removal.retainedVersions;
      out.failed += removal.failed;
    } catch {
      out.failed++;
    }
  }
  return out;
}
