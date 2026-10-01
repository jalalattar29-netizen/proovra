/**
 * Phase 1B — Capture Trust Event emitter.
 *
 * The single emitter that all capture-trust mutations call. Wraps:
 *
 *   1. The existing `custody-events` chain — every trust event with
 *      an `evidenceId` writes a `CustodyEvent` row of type
 *      `CAPTURE_TRUST_EVENT`. This means the existing chain-of-custody
 *      hash + sequence + audit query model applies unchanged.
 *
 *   2. The Phase 1B `capture_trust_events` table — a dedicated
 *      timeline that supports the per-session query surface (when
 *      `evidenceId` is null because the evidence row has not been
 *      finalised yet) and a parallel hash chain.
 *
 * Hard rules:
 *   * NEVER a parallel audit system. The custody chain remains the
 *     authoritative chain-of-custody record; this table is a
 *     per-session query optimisation + a pre-finalise placeholder.
 *   * Bounded code (CAPTURE_TRUST_EVENT_CODES). Append-only.
 *   * Bounded payload — no provider raw bytes; only hashes + bounded
 *     metadata.
 *   * Workspace-anchored: every row carries `teamId`.
 *   * Per-(session|evidence) sequence is enforced via a lookup +
 *     increment; the chain is hashed locally so the trust-event
 *     sub-chain can be verified independently of the main custody
 *     chain.
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import {
  CAPTURE_TRUST_EVENT_CODES,
  type CaptureTrustEventCode,
} from "@proovra/shared";

import { buildTrustEventHashV2 } from "@proovra/shared-runtime";

import { prisma as defaultPrisma } from "../../db.js";
import { appendCustodyEvent } from "../custody-events.service.js";
import { warn as logWarn } from "../../utils/logger.js";

export type EmitCaptureTrustEventInput = {
  prisma?: PrismaClient;
  teamId: string;
  code: CaptureTrustEventCode;
  /**
   * Optional capture session id (pre-finalise events have one; post-finalise
   * events may omit). UC-0: must name a server-issued direct-capture
   * CaptureSession of `teamId`, or the emit is refused.
   */
  captureSessionId: string | null;
  /** Optional evidence id (post-finalise events have one; pre-finalise events do not). */
  evidenceId: string | null;
  /** Optional device id. */
  deviceId: string | null;
  /** Bounded payload — no raw provider bytes. */
  payload?: Record<string, unknown>;
};

export type EmitCaptureTrustEventResult = {
  trustEventRecordId: string;
  custodyEventId: string | null;
  sequence: number;
  eventHash: string;
};

export async function emitCaptureTrustEvent(
  input: EmitCaptureTrustEventInput,
): Promise<EmitCaptureTrustEventResult> {
  // Bounded enum gate — refuse unknown codes loudly to prevent
  // append-only chain drift.
  if (
    !(CAPTURE_TRUST_EVENT_CODES as ReadonlyArray<string>).includes(input.code)
  ) {
    throw new Error(`capture-trust: unknown event code "${input.code}"`);
  }

  const prisma = input.prisma ?? defaultPrisma;
  const now = new Date();
  const payload = input.payload ?? {};

  // UC-0 — a trust event can only describe a SERVER-ISSUED session of the same
  // workspace. Client-invented session ids (the retired mobile ingest and
  // citizen routes minted their own) cannot anchor a timeline any more.
  if (input.captureSessionId !== null) {
    const session = await prisma.captureSession.findFirst({
      where: {
        id: input.captureSessionId,
        teamId: input.teamId,
        acquisitionMode: { not: null },
      },
      select: { id: true },
    });
    if (!session) {
      throw new Error("capture-trust: unknown capture session");
    }
  }

  // ET-DC-10 — the sub-chain is extended under a lock on every chain it
  // belongs to (its session's and its record's, taken in one sorted order so
  // two appenders never deadlock). The read of the chain's head and the insert
  // of the next link were two unlocked statements, so concurrent declarations
  // read the same head and forked the chain with duplicate sequences. A
  // partial unique index on (chain, sequence) backs this up
  // (migration 20280813000000).
  const chainKeys = [
    input.captureSessionId !== null ? `capture-trust:session:${input.captureSessionId}` : null,
    input.evidenceId !== null ? `capture-trust:evidence:${input.evidenceId}` : null,
  ]
    .filter((k): k is string => k !== null)
    .sort();
  const { record, nextSequence, eventHash } = await prisma.$transaction(async (tx) => {
    for (const k of chainKeys) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${k}))`;
    }

    // Resolve previous-event hash for the (session, evidence) pair so
    // the trust-event sub-chain is verifiable independently.
    const last = await tx.captureTrustEventRecord.findFirst({
      where: {
        teamId: input.teamId,
        OR: [
          input.evidenceId !== null
            ? { evidenceId: input.evidenceId }
            : { id: "00000000-0000-0000-0000-000000000000" },
          input.captureSessionId !== null
            ? { captureSessionId: input.captureSessionId }
            : { id: "00000000-0000-0000-0000-000000000000" },
        ],
      },
      orderBy: { sequence: "desc" },
      select: { sequence: true, eventHash: true },
    });
    const nextSequence = (last?.sequence ?? 0) + 1;
    const prevEventHash = last?.eventHash ?? null;

    // Local hash for the trust-event sub-chain.
    // UC-TRUST-004 — THE v2 hash (full-depth canonical JSON, v:2), shared with
    // the provenance verifier, so the link is reproducible from the stored
    // JSONB. The rows are append-only (migration 20281001000500): this module
    // only INSERTS them.
    const eventHash = buildTrustEventHashV2({
      teamId: input.teamId,
      code: input.code,
      captureSessionId: input.captureSessionId,
      evidenceId: input.evidenceId,
      deviceId: input.deviceId,
      sequence: nextSequence,
      atUtc: now,
      payload,
      prevEventHash,
    });

    const record = await tx.captureTrustEventRecord.create({
      data: {
        teamId: input.teamId,
        captureSessionId: input.captureSessionId,
        // R7-capture-trust: evidenceId is now schema-nullable for pre-finalise events
        // (CAPTURE_STARTED / DEVICE_REGISTERED). The custody-chain mirror below already
        // guards on `input.evidenceId !== null`, so chain integrity is preserved:
        // pre-finalise events live ONLY in capture_trust_event_records (correlated by
        // captureSessionId), and post-finalise events also chain into custody.
        evidenceId: input.evidenceId,
        deviceId: input.deviceId,
        code: input.code,
        sequence: nextSequence,
        atUtc: now,
        // R7-capture-trust: payload is JSONB. Use Prisma.JsonNull for null vs
        // Prisma.InputJsonValue for present, replacing the legacy `as never` cast.
        payload:
          payload === null || payload === undefined
            ? Prisma.JsonNull
            : (payload as Prisma.InputJsonValue),
        prevEventHash,
        eventHash,
      },
      select: { id: true },
    });
    return { record, nextSequence, eventHash };
  });

  // Mirror to the canonical custody chain when the evidence row is
  // finalised. Pre-finalise events live ONLY in capture_trust_events.
  let custodyEventId: string | null = null;
  if (input.evidenceId !== null) {
    try {
      const ce = await appendCustodyEvent({
        evidenceId: input.evidenceId,
        eventType: "CAPTURE_TRUST_EVENT" as never,
        atUtc: now,
        payload: {
          code: input.code,
          trustEventRecordId: record.id,
          deviceId: input.deviceId,
          captureSessionId: input.captureSessionId,
          ...payload,
        },
      });
      custodyEventId = ce?.id ?? null;
    } catch {
      // Custody-event mirroring failure is non-fatal — the trust-event
      // row is the source of truth for the pre-finalise timeline and
      // custody chain can be re-emitted via a worker. It is NOT silent:
      // bounded identifiers only (no payload, no driver text).
      logWarn("capture_trust.custody_mirror_failed", {
        code: input.code,
        trustEventRecordId: record.id,
      });
    }
  }

  return {
    trustEventRecordId: record.id,
    custodyEventId,
    sequence: nextSequence,
    eventHash,
  };
}

/**
 * Read the trust-event timeline for a session OR an evidence id.
 * Bounded by `limit` (≤ 500).
 */
export async function readCaptureTrustTimeline(input: {
  prisma?: PrismaClient;
  teamId: string;
  captureSessionId?: string;
  evidenceId?: string;
  limit?: number;
}) {
  const prisma = input.prisma ?? defaultPrisma;
  if (!input.captureSessionId && !input.evidenceId) {
    return [];
  }
  return prisma.captureTrustEventRecord.findMany({
    where: {
      teamId: input.teamId,
      ...(input.captureSessionId
        ? { captureSessionId: input.captureSessionId }
        : {}),
      ...(input.evidenceId ? { evidenceId: input.evidenceId } : {}),
    },
    orderBy: { sequence: "asc" },
    take: Math.min(input.limit ?? 200, 500),
    select: {
      id: true,
      code: true,
      sequence: true,
      atUtc: true,
      deviceId: true,
      payload: true,
      eventHash: true,
      prevEventHash: true,
    },
  });
}
