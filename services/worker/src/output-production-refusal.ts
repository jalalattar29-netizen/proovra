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

/**
 * F-07 (independent forward audit) — the run admission refused at a COMMIT:
 * the record's workspace moved, its organization was suspended, or a legal
 * hold now preserves what a regeneration would replace. A policy block, not a
 * failure: the reserved package rows are released, the request is settled
 * BLOCKED_POLICY with this bounded reason, nothing is published, retried or
 * alerted, and no artifact pointer advances (the commit rolls back).
 */
export class OutputPolicyBlockedError extends Error {
  readonly retriable = false as const;
  readonly businessBlock = true as const;
  constructor(readonly reasonCode: string) {
    super(`OUTPUT_POLICY_BLOCKED:${reasonCode}`);
    this.name = "OutputPolicyBlockedError";
  }
}

export function isOutputPolicyBlockedError(err: unknown): err is OutputPolicyBlockedError {
  return (
    err instanceof OutputPolicyBlockedError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { businessBlock?: unknown }).businessBlock === true &&
      typeof (err as { reasonCode?: unknown }).reasonCode === "string")
  );
}
