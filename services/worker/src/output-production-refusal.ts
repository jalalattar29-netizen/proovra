/**
 * THE OUTPUT-PRODUCER GUARD, WORKER SIDE (2026-10-20, AUD-01/02/35/54).
 *
 * The writer (`createReportGenerationRequest`) refuses to create a request for
 * a record that may not receive outputs. A record can still change AFTER its
 * request was created: it is archived while the job waits, trashed while the
 * report renders, or destroyed while the package builds. The worker therefore
 * re-asks the SAME shared decision (`decideOutputProduction` /
 * `outputLifecycleRefusal`) at three more points — the claim, the report
 * commit and the package commit — and refuses with this error.
 *
 * A refusal is an expected business outcome, never a technical failure: the
 * request is settled as not applicable with its bounded `NOT_APPLICABLE_*`
 * reason, nothing is published, nothing is retried, and no incident, alert
 * or Sentry event follows.
 */
import { isOutputProductionRefusal, type OutputProductionRefusal } from "@proovra/shared";

import { settleReportRequestNotApplicable } from "@proovra/shared-runtime/reports";

import { prisma } from "./db.js";

export class OutputProductionRefusedError extends Error {
  readonly retriable = false as const;
  readonly businessRefusal = true as const;
  readonly code: OutputProductionRefusal;
  constructor(readonly refusal: OutputProductionRefusal) {
    super(refusal);
    this.name = "OutputProductionRefusedError";
    this.code = refusal;
  }
}

export function isOutputProductionRefusedError(err: unknown): err is OutputProductionRefusedError {
  return (
    err instanceof OutputProductionRefusedError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { businessRefusal?: unknown }).businessRefusal === true &&
      isOutputProductionRefusal((err as { code?: string }).code))
  );
}

/**
 * Settle a request as an expected business refusal. Fenced by the run's claim
 * when the worker ran it; pre-claim refusals use the non-terminal predicate.
 */
export async function settleRequestAsNotApplicable(input: {
  requestId: string;
  refusal: OutputProductionRefusal;
  fence?: { claimedAtUtc: Date };
}): Promise<boolean> {
  return settleReportRequestNotApplicable(prisma as never, input);
}
