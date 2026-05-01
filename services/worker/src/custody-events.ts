import type { Prisma } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import { buildCustodyEventHash } from "@proovra/shared/custody-hash";

type TxClient = Prisma.TransactionClient;

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
