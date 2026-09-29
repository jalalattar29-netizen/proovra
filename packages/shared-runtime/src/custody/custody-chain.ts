/**
 * THE ONE CUSTODY SERIALIZATION AUTHORITY (2026-09-29).
 *
 * Every custody event in the platform is appended here and every chain is
 * evaluated here. Until 2026-09-29 the same append lived three times — the API
 * (custody-events.service), the Worker (custody-events.ts) and the destruction
 * executor — each re-implementing the lock, the sequence read, the hash and the
 * insert. The hash itself was already shared (@proovra/shared/custody-hash), but
 * a rule fixed in one appender (the lock, the null-payload encoding) could keep
 * failing in the other two. Both hosts now delegate here; a structural guard
 * allows exactly one `custodyEvent.create` in the source trees.
 *
 * Serialization: the evidence advisory lock `hashtext(evidenceId)` — the same
 * lock finalization, the EvidencePart writer, the destruction decision and the
 * lifecycle writers take — then read the head, then insert sequence+1 with its
 * hash chained to the head. Callers pass their own transaction.
 */
import type { Prisma } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import { buildCustodyEventHash } from "@proovra/shared/custody-hash";

type TxClient = Prisma.TransactionClient;

export type AppendCustodyEventParams = {
  evidenceId: string;
  eventType: prismaPkg.CustodyEventType;
  atUtc?: Date;
  payload?: Prisma.InputJsonValue | null;
  ip?: string | null;
  userAgent?: string | null;
};

export type CustodyChainRecord = {
  sequence: number;
  eventType: string;
  atUtc: Date;
  payload: Prisma.JsonValue | null;
  prevEventHash: string | null;
  eventHash: string | null;
};

/** Optional host observation of the canonical digest step (e.g. a tracing span). */
export type CustodyAppendHooks = { digest?: <T>(compute: () => T) => T };

export async function appendCustodyEventTx(
  tx: TxClient,
  params: AppendCustodyEventParams,
  hooks: CustodyAppendHooks = {},
) {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext(${params.evidenceId}))
  `;

  const atUtc = params.atUtc ?? new Date();
  const last = await tx.custodyEvent.findFirst({
    where: { evidenceId: params.evidenceId },
    orderBy: { sequence: "desc" },
    select: { sequence: true, eventHash: true },
  });

  const sequence = (last?.sequence ?? 0) + 1;
  const prevEventHash = last?.eventHash ?? null;
  const payload =
    params.payload === undefined || params.payload === null ? null : params.payload;

  const compute = () =>
    buildCustodyEventHash({
      evidenceId: params.evidenceId,
      sequence,
      eventType: params.eventType,
      atUtc,
      payload,
      prevEventHash,
    });
  const eventHash = hooks.digest ? hooks.digest(compute) : compute();

  return tx.custodyEvent.create({
    data: {
      evidenceId: params.evidenceId,
      eventType: params.eventType,
      atUtc,
      sequence,
      payload: (payload ?? prismaPkg.Prisma.JsonNull) as Prisma.InputJsonValue,
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
      prevEventHash,
      eventHash,
    },
  });
}

export type CustodyChainEvaluation = {
  valid: boolean;
  mode: "empty" | "hashed" | "legacy";
  reason: "sequence_gap" | "prev_hash_mismatch" | "event_hash_mismatch" | "hash_missing" | null;
};

/**
 * ET-CUS-04: the hash columns exist on every environment since the Phase 0
 * schema catch-up (20260925000000); every event recorded from then on carries
 * a hash. An unhashed chain is accepted as "legacy" only when EVERY event
 * predates it — a fully hash-stripped chain used to verify as valid legacy.
 */
export const CUSTODY_HASH_REQUIRED_SINCE_UTC = new Date("2026-09-25T00:00:00.000Z");

export function evaluateCustodyChain(params: {
  evidenceId: string;
  records: CustodyChainRecord[];
}): CustodyChainEvaluation {
  const records = [...params.records].sort((a, b) => a.sequence - b.sequence);
  if (records.length === 0) return { valid: true, mode: "empty", reason: null };

  const hasAnyHashes = records.some((r) => r.eventHash || r.prevEventHash);
  const mode = hasAnyHashes ? "hashed" : "legacy";
  if (
    !hasAnyHashes &&
    records.some((r) => r.atUtc.getTime() >= CUSTODY_HASH_REQUIRED_SINCE_UTC.getTime())
  ) {
    return { valid: false, mode: "legacy", reason: "hash_missing" };
  }
  let previousSequence: number | null = null;
  let previousExpectedHash: string | null = null;

  for (const record of records) {
    if (previousSequence !== null && record.sequence !== previousSequence + 1) {
      return { valid: false, mode, reason: "sequence_gap" };
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
        return { valid: false, mode: "hashed", reason: "prev_hash_mismatch" };
      }
      if (!record.eventHash || record.eventHash !== expectedHash) {
        return { valid: false, mode: "hashed", reason: "event_hash_mismatch" };
      }
    }
    previousSequence = record.sequence;
    previousExpectedHash = expectedHash;
  }
  return { valid: true, mode, reason: null };
}
