import { prisma } from "../db.js";
// Phase O1.5B — bounded custody chain verify + canonical digest spans.
// NEVER the payload contents.
import {
  PROOVRA_SPAN_NAMES,
  withProovraSpanSync,
} from "../observability/otel.js";
import {
  isAccessCustodyEventType,
} from "@proovra/shared";
import {
  appendCustodyEventTx,
  evaluateCustodyChain as evaluateCustodyChainCore,
} from "@proovra/shared-runtime";
export { buildCustodyEventHash } from "@proovra/shared/custody-hash";
export { classifyCustodyEventType, isAccessCustodyEventType } from "@proovra/shared";

type AppendCustodyEventParams = Parameters<typeof appendCustodyEventTx>[1];
type CustodyChainRecord = Parameters<typeof evaluateCustodyChainCore>[0]["records"][number];

export function isForensicCustodyEventType(eventType: string): boolean {
  return !isAccessCustodyEventType(eventType);
}

// THE ONE appender lives in @proovra/shared-runtime (custody/custody-chain).
export { appendCustodyEventTx };

export async function appendCustodyEvent(params: AppendCustodyEventParams) {
  return prisma.$transaction(async (tx) => {
    return appendCustodyEventTx(tx, params);
  });
}

export function evaluateCustodyChain(params: {
  evidenceId: string;
  records: CustodyChainRecord[];
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
