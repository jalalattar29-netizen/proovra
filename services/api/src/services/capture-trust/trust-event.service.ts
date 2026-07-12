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

import { createHash } from "node:crypto";

import { Prisma, type PrismaClient } from "@prisma/client";
import {
  CAPTURE_TRUST_EVENT_CODES,
  type CaptureTrustEventCode,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { appendCustodyEvent } from "../custody-events.service.js";

export type EmitCaptureTrustEventInput = {
  prisma?: PrismaClient;
  teamId: string;
  code: CaptureTrustEventCode;
  /** Optional capture session id (pre-finalise events have one; post-finalise events may omit). */
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

  // Resolve previous-event hash for the (session, evidence) pair so
  // the trust-event sub-chain is verifiable independently.
  const last = await prisma.captureTrustEventRecord.findFirst({
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
  const eventHash = buildTrustEventHash({
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

  const record = await prisma.captureTrustEventRecord.create({
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
      // custody chain can be re-emitted via a worker.
    }
  }

  return {
    trustEventRecordId: record.id,
    custodyEventId,
    sequence: nextSequence,
    eventHash,
  };
}

// -----------------------------------------------------------------------------
// Bounded chain hash
// -----------------------------------------------------------------------------

function buildTrustEventHash(input: {
  teamId: string;
  code: CaptureTrustEventCode;
  captureSessionId: string | null;
  evidenceId: string | null;
  deviceId: string | null;
  sequence: number;
  atUtc: Date;
  payload: Record<string, unknown>;
  prevEventHash: string | null;
}): string {
  // Bounded canonical line for the hash — every field deterministically
  // serialised. We keep this simple (sorted keys via JSON.stringify with
  // a stable replacer) so downstream tooling can re-derive.
  const payloadKeys = Object.keys(input.payload).sort();
  const sortedPayload: Record<string, unknown> = {};
  for (const k of payloadKeys) sortedPayload[k] = input.payload[k];

  const line = JSON.stringify({
    teamId: input.teamId,
    code: input.code,
    captureSessionId: input.captureSessionId,
    evidenceId: input.evidenceId,
    deviceId: input.deviceId,
    sequence: input.sequence,
    atUtc: input.atUtc.toISOString(),
    payload: sortedPayload,
    prevEventHash: input.prevEventHash,
  });
  return createHash("sha256").update(line).digest("hex");
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
