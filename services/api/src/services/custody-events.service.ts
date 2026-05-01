import * as prismaPkg from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import {
  classifyCustodyEventType,
  isAccessCustodyEventType,
} from "@proovra/shared";
import { buildCustodyEventHash } from "@proovra/shared/custody-hash";
export { buildCustodyEventHash } from "@proovra/shared/custody-hash";
export { classifyCustodyEventType, isAccessCustodyEventType } from "@proovra/shared";

type TxClient = Prisma.TransactionClient;

type AppendCustodyEventParams = {
  evidenceId: string;
  eventType: prismaPkg.CustodyEventType;
  atUtc?: Date;
  payload?: Prisma.InputJsonValue | null;
  ip?: string | null;
  userAgent?: string | null;
};

type CustodyChainRecord = {
  sequence: number;
  eventType: string;
  atUtc: Date;
  payload: Prisma.JsonValue | null;
  prevEventHash: string | null;
  eventHash: string | null;
};


export function isForensicCustodyEventType(eventType: string): boolean {
  return !isAccessCustodyEventType(eventType);
}

function normalizePayload(
  payload: Prisma.InputJsonValue | Prisma.JsonValue | null | undefined
): Prisma.InputJsonValue | null {
  if (payload === undefined || payload === null) {
    return null;
  }
  return payload as Prisma.InputJsonValue;
}

export async function appendCustodyEventTx(
  tx: TxClient,
  params: AppendCustodyEventParams
) {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext(${params.evidenceId}))
  `;

  const atUtc = params.atUtc ?? new Date();

  const last = await tx.custodyEvent.findFirst({
    where: { evidenceId: params.evidenceId },
    orderBy: { sequence: "desc" },
    select: {
      sequence: true,
      eventHash: true,
    },
  });

  const nextSequence = (last?.sequence ?? 0) + 1;
  const prevEventHash = last?.eventHash ?? null;
  const payload = normalizePayload(params.payload);

  const eventHash = buildCustodyEventHash({
    evidenceId: params.evidenceId,
    sequence: nextSequence,
    eventType: params.eventType,
    atUtc,
    payload,
    prevEventHash,
  });

  return tx.custodyEvent.create({
    data: {
      evidenceId: params.evidenceId,
      eventType: params.eventType,
      atUtc,
      sequence: nextSequence,
      payload: (payload ?? prismaPkg.Prisma.JsonNull) as Prisma.InputJsonValue,
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
      prevEventHash,
      eventHash,
    },
  });
}

export async function appendCustodyEvent(params: AppendCustodyEventParams) {
  return prisma.$transaction(async (tx) => {
    return appendCustodyEventTx(tx, params);
  });
}

export function evaluateCustodyChain(params: {
  evidenceId: string;
  records: CustodyChainRecord[];
}) {
  const records = [...params.records].sort((a, b) => a.sequence - b.sequence);

  if (records.length === 0) {
    return {
      valid: true,
      mode: "empty" as const,
      reason: null as string | null,
    };
  }

  const hasAnyHashes = records.some((r) => r.eventHash || r.prevEventHash);

  let previousSequence: number | null = null;
  let previousExpectedHash: string | null = null;

  for (const record of records) {
    if (previousSequence !== null && record.sequence !== previousSequence + 1) {
      return {
        valid: false,
        mode: hasAnyHashes ? ("hashed" as const) : ("legacy" as const),
        reason: "sequence_gap",
      };
    }

    const expectedHash = buildCustodyEventHash({
      evidenceId: params.evidenceId,
      sequence: record.sequence,
      eventType: record.eventType,
      atUtc: record.atUtc,
      payload: record.payload,
      prevEventHash: previousExpectedHash,
    });

    if (hasAnyHashes) {
      if ((record.prevEventHash ?? null) !== (previousExpectedHash ?? null)) {
        return {
          valid: false,
          mode: "hashed" as const,
          reason: "prev_hash_mismatch",
        };
      }

      if (!record.eventHash || record.eventHash !== expectedHash) {
        return {
          valid: false,
          mode: "hashed" as const,
          reason: "event_hash_mismatch",
        };
      }
    }

    previousSequence = record.sequence;
    previousExpectedHash = expectedHash;
  }

  return {
    valid: true,
    mode: hasAnyHashes ? ("hashed" as const) : ("legacy" as const),
    reason: null as string | null,
  };
}
