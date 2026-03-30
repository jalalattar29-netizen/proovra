import * as prismaPkg from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { sha256Hex } from "../crypto.js";

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

export const ACCESS_CUSTODY_EVENT_TYPES = new Set<prismaPkg.CustodyEventType>([
  prismaPkg.CustodyEventType.VERIFY_VIEWED,
  prismaPkg.CustodyEventType.EVIDENCE_VIEWED,
  prismaPkg.CustodyEventType.EVIDENCE_DOWNLOADED,
  prismaPkg.CustodyEventType.REPORT_DOWNLOADED,
]);

export function isAccessCustodyEventType(eventType: string): boolean {
  return ACCESS_CUSTODY_EVENT_TYPES.has(
    eventType as prismaPkg.CustodyEventType
  );
}

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

/**
 * Stable canonical JSON serializer for plain JSON values.
 * Keys are sorted recursively so API + worker generate identical hashes.
 */
function canonicalJsonValue(value: unknown): string {
  if (value === null) return "null";

  const t = typeof value;

  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error("canonicalJsonValue: non-finite number is not allowed");
    }
    return JSON.stringify(value);
  }

  if (t === "boolean") return value ? "true" : "false";
  if (t === "string") return JSON.stringify(value);

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonValue(item)).join(",")}]`;
  }

  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJsonValue(obj[key])}`)
      .join(",")}}`;
  }

  throw new Error(`canonicalJsonValue: unsupported value type "${t}"`);
}

export function buildCustodyEventHash(params: {
  evidenceId: string;
  sequence: number;
  eventType: string;
  atUtc: Date;
  payload?: Prisma.InputJsonValue | Prisma.JsonValue | null;
  prevEventHash?: string | null;
}): string {
  const canonical = canonicalJsonValue({
    v: 1,
    evidenceId: params.evidenceId,
    sequence: params.sequence,
    eventType: params.eventType,
    atUtc: params.atUtc.toISOString(),
    payload: normalizePayload(params.payload),
    prevEventHash: params.prevEventHash ?? null,
  });

  return sha256Hex(canonical);
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

  let previousSequence = 0;
  let previousExpectedHash: string | null = null;

  for (const record of records) {
    if (record.sequence !== previousSequence + 1) {
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