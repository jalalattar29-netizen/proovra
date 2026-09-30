/**
 * ET-COM-04 (owner decision 2026-09-30) — what a lapsed paid plan means, in
 * one place for web and native.
 *
 * A billing lapse is not a suspension. Existing evidence, and reports and
 * packages already issued, stay available. NEW records fall back to the Free
 * allowance; a purchased credit funds one past it. The server says which of
 * the three states the account is in (`planLapse.state` on the Billing
 * projection — the same decision the creation gate takes); this file only
 * words it.
 */
export const PLAN_LAPSE_STATES = [
  /** The Free allowance still has room: the next record is included. */
  "FREE_ALLOWANCE_AVAILABLE",
  /** The Free allowance is used up and a credit will fund the next record. */
  "FREE_ALLOWANCE_EXHAUSTED_CREDIT_AVAILABLE",
  /** The Free allowance is used up and no credit is available: refused. */
  "FREE_ALLOWANCE_EXHAUSTED_NO_CREDIT",
] as const;
export type PlanLapseState = (typeof PLAN_LAPSE_STATES)[number];

export type PlanLapseCopy = {
  /** "Your Pro plan has lapsed." */
  headline: string;
  /** What happens to the next record. */
  nextRecord: string;
  /** What stays, and what needs a renewal. */
  outputs: string;
};

export const PLAN_LAPSE_OUTPUTS_COPY =
  "Your existing evidence, and reports and verification packages already issued or earned before the lapse, stay available. A record funded by a credit includes its report and package. Renew the plan for plan-included reports on new records.";

export function planLapseCopy(input: {
  state: PlanLapseState;
  /** The lapsed plan's display name, e.g. "Pro". */
  lapsedPlanLabel: string;
  freeAllowanceRemaining: number;
  creditsAvailable: number;
}): PlanLapseCopy {
  const remaining = Math.max(0, Math.floor(input.freeAllowanceRemaining));
  const credits = Math.max(0, Math.floor(input.creditsAvailable));
  const nextRecord =
    input.state === "FREE_ALLOWANCE_AVAILABLE"
      ? `New records use the Free allowance: ${remaining.toLocaleString()} more record${remaining === 1 ? "" : "s"} included.`
      : input.state === "FREE_ALLOWANCE_EXHAUSTED_CREDIT_AVAILABLE"
        ? `The Free allowance is used up. The next record uses 1 of your ${credits.toLocaleString()} credit${credits === 1 ? "" : "s"}.`
        : "The Free allowance is used up and you have no evidence credits. Renew your plan or buy a credit to record more.";
  return {
    headline: `Your ${input.lapsedPlanLabel} plan has lapsed.`,
    nextRecord,
    outputs: PLAN_LAPSE_OUTPUTS_COPY,
  };
}
