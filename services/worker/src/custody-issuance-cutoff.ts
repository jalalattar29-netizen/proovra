import type { PrismaClient } from "@prisma/client";

/**
 * THE CHAIN AS IT STOOD AT A REPORT'S ISSUANCE (ET-CUS-06, 2026-09-29).
 *
 * A package built later for an issued report carries the custody chain that
 * report describes. The cut-off is a SEQUENCE, never a time: an event's atUtc
 * is its own time (a timestamp's genTime, a reconciled hold's recording time)
 * and is not monotonic in sequence, so selecting "every event at or before the
 * issuance instant" could skip a sequence number and leave custody.json with a
 * gap and a broken prevEventHash link. The chain at issuance is the contiguous
 * prefix up to the highest sequence recorded at or before it.
 */
export async function custodyThroughIssuance(
  prisma: Pick<PrismaClient, "custodyEvent">,
  evidenceId: string,
  issuedAtUtc: Date,
) {
  const cutoff = await prisma.custodyEvent.aggregate({
    where: { evidenceId, atUtc: { lte: issuedAtUtc } },
    _max: { sequence: true },
  });
  return prisma.custodyEvent.findMany({
    where: { evidenceId, sequence: { lte: cutoff._max.sequence ?? 0 } },
    orderBy: { sequence: "asc" },
    select: {
      sequence: true,
      atUtc: true,
      eventType: true,
      payload: true,
      prevEventHash: true,
      eventHash: true,
    },
  });
}
