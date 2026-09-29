import type { Prisma } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import {
  appendCustodyEventTx as appendCustodyEventTxCore,
  evaluateCustodyChain as evaluateCustodyChainCore,
} from "@proovra/shared-runtime";
// Phase O1.4 — bounded custody.event.append span. Attributes carry
// the evidence id + bounded event type + sequence. NEVER the
// payload contents, IP, or user agent.
import { PROOVRA_SPAN_NAMES, withProovraSpan, withProovraSpanSync } from "./otel.js";

type TxClient = Prisma.TransactionClient;

/**
 * The Worker's face of THE custody appender (@proovra/shared-runtime
 * custody/custody-chain). Only the tracing span is added here; the lock,
 * sequence, hash and insert are the shared authority's.
 */
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
  return withProovraSpan(
    PROOVRA_SPAN_NAMES.CUSTODY_EVENT_APPEND,
    {
      "proovra.evidence_id": params.evidenceId,
      "proovra.operation": "custody_event_append",
      "proovra.event_type": String(params.eventType),
    },
    () =>
      appendCustodyEventTxCore(tx, params, {
        // Phase O1.5B — bounded canonical digest span. evidenceId only;
        // NEVER the payload contents.
        digest: (compute) =>
          withProovraSpanSync(
            PROOVRA_SPAN_NAMES.INTEGRITY_CANONICAL_DIGEST,
            {
              "proovra.evidence_id": params.evidenceId,
              "proovra.operation": "integrity_canonical_digest",
            },
            compute,
          ),
      }),
  );
}

export function evaluateCustodyChain(params: {
  evidenceId: string;
  records: Array<{
    sequence: number;
    eventType: string;
    atUtc: Date;
    payload: Prisma.JsonValue | null;
    prevEventHash: string | null;
    eventHash: string | null;
  }>;
}) {
  // Phase O1.5B — sync-safe bounded custody.chain.verify span.
  return withProovraSpanSync(
    PROOVRA_SPAN_NAMES.CUSTODY_CHAIN_VERIFY,
    {
      "proovra.evidence_id": params.evidenceId,
      "proovra.operation": "custody_chain_verify",
      "proovra.size_bytes": params.records.length,
    },
    () => evaluateCustodyChainCore(params),
  );
}
