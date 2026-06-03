import * as prismaPkg from "@prisma/client";
import { prisma } from "../db.js";
// Phase O1.5B — bounded custody chain verify + canonical digest spans.
// NEVER the payload contents.
import { PROOVRA_SPAN_NAMES, withProovraSpanSync, } from "../observability/otel.js";
import { isAccessCustodyEventType, } from "@proovra/shared";
import { buildCustodyEventHash } from "@proovra/shared/custody-hash";
export { buildCustodyEventHash } from "@proovra/shared/custody-hash";
export { classifyCustodyEventType, isAccessCustodyEventType } from "@proovra/shared";
export function isForensicCustodyEventType(eventType) {
    return !isAccessCustodyEventType(eventType);
}
function normalizePayload(payload) {
    if (payload === undefined || payload === null) {
        return null;
    }
    return payload;
}
export async function appendCustodyEventTx(tx, params) {
    await tx.$executeRaw `
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
            payload: (payload ?? prismaPkg.Prisma.JsonNull),
            ip: params.ip ?? null,
            userAgent: params.userAgent ?? null,
            prevEventHash,
            eventHash,
        },
    });
}
export async function appendCustodyEvent(params) {
    return prisma.$transaction(async (tx) => {
        return appendCustodyEventTx(tx, params);
    });
}
export function evaluateCustodyChain(params) {
    // Phase O1.5B — sync-safe bounded custody.chain.verify span.
    return withProovraSpanSync(PROOVRA_SPAN_NAMES.CUSTODY_CHAIN_VERIFY, {
        "proovra.evidence_id": params.evidenceId,
        "proovra.operation": "custody_chain_verify",
        "proovra.size_bytes": params.records.length,
    }, () => evaluateCustodyChainInner(params));
}
function evaluateCustodyChainInner(params) {
    const records = [...params.records].sort((a, b) => a.sequence - b.sequence);
    if (records.length === 0) {
        return {
            valid: true,
            mode: "empty",
            reason: null,
        };
    }
    const hasAnyHashes = records.some((r) => r.eventHash || r.prevEventHash);
    let previousSequence = null;
    let previousExpectedHash = null;
    for (const record of records) {
        if (previousSequence !== null && record.sequence !== previousSequence + 1) {
            return {
                valid: false,
                mode: hasAnyHashes ? "hashed" : "legacy",
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
                    mode: "hashed",
                    reason: "prev_hash_mismatch",
                };
            }
            if (!record.eventHash || record.eventHash !== expectedHash) {
                return {
                    valid: false,
                    mode: "hashed",
                    reason: "event_hash_mismatch",
                };
            }
        }
        previousSequence = record.sequence;
        previousExpectedHash = expectedHash;
    }
    return {
        valid: true,
        mode: hasAnyHashes ? "hashed" : "legacy",
        reason: null,
    };
}
