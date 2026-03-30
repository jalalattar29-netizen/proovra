import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import * as prismaPkg from "@prisma/client";

type TxClient = Prisma.TransactionClient;

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
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
 * Must stay identical to the API implementation so custody hashes match.
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
  params: {
    evidenceId: string;
    eventType: prismaPkg.CustodyEventType;
    atUtc?: Date;
    payload?: Prisma.InputJsonValue | null;
    ip?: string | null;
    userAgent?: string | null;
  }
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