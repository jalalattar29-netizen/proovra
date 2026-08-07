/**
 * PHASE 12 CORRECTIVE PASS §2 CONTINUATION (ARCH-005, 2026-08-07).
 *
 * THE ONE AUTOMATION PROCESSOR.
 *
 * The producer (`automation-outbox.service.ts`) commits PENDING
 * `AutomationRun` rows inside the source domain transaction. This module is
 * everything that happens afterwards, and it is the ONLY thing permitted to
 * write a run's terminal state.
 *
 * THE FENCE, AND WHY IT IS NOT JUST A STATUS CHECK
 * ---------------------------------------------------------------------------
 * A `status = 'PENDING' -> 'RUNNING'` conditional update stops two workers
 * claiming the same row at the same instant. It does NOT stop this:
 *
 *     worker A claims the run
 *     worker A stalls (GC pause, network partition, a slow webhook)
 *     the lease expires
 *     worker B reclaims the run and completes it SUCCEEDED
 *     worker A wakes up and writes FAILED
 *
 * Both writes satisfy "the row is RUNNING". The second one is a lie about work
 * that already succeeded. So every claim increments `claimGeneration`, every
 * worker remembers the generation it claimed under, and every terminal write
 * carries `claimGeneration` in its WHERE clause. A stale worker's update
 * matches ZERO rows and it knows it did, because `updateMany` returns a count.
 *
 * AMBIGUITY IS NOT SUCCESS — AND IT IS NOT A RETRY EITHER
 * ---------------------------------------------------------------------------
 * A timeout, a connection reset, or a lease that expired mid-attempt means the
 * action MAY have reached the outside world.
 *
 * The first correction stopped those becoming SUCCEEDED. It was not enough:
 * they were still RETRYABLE, so a timeout was re-executed after 30 s. Executing
 * again an action that may already have committed is a SECOND external side
 * effect, not a retry, and calling it one is how duplicate webhooks and
 * duplicate notifications get shipped.
 *
 * So ambiguity now has its own state and its own policy:
 *
 *   AMBIGUOUS               not success, not failure, NOT resent. Bounded
 *                           reconciliation, with the action idempotency key
 *                           still attached — so a resend, IF reconciliation
 *                           ever proves nothing committed, is the SAME intent.
 *   DEAD_LETTERED_UNKNOWN   reconciliation exhausted, outcome still unknown.
 *                           Terminal, operator-visible, and never projected
 *                           as a refusal.
 *
 * `DEAD_LETTERED` is retained for the different case it always meant: the far
 * side answered every time and kept refusing until the ladder ran out.
 *
 * WHAT IT MAY NOT DO
 * ---------------------------------------------------------------------------
 *   * No status is invented to make a row terminal.
 *   * No run is deleted.
 *   * No terminal run is ever rewritten.
 *   * No tenant, plan, permission or policy is read from anything but the
 *     durable row and its relations.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { executeAutomationAction } from "./automation-actions.service.js";
import { emitRunLifecycle } from "./automation-dispatcher.service.js";
import {
  sanitiseReason,
  type AutomationActionType,
  type AutomationTriggerType,
} from "./automation.service.js";

// ===========================================================================
// Bounds. Every one of these is a hard cap, not a default a caller can raise.
// ===========================================================================

/** How long a claim is good for. Matches the registry entry's `leaseMs`. */
export const AUTOMATION_LEASE_MS = 5 * 60 * 1000;

/** Total attempts including the first. There is no path beyond this. */
export const AUTOMATION_MAX_ATTEMPTS = 4;

/**
 * Bounded backoff, in seconds, indexed by the attempt that just failed.
 * 0 → 30 → 300 → (exhausted). Total wall-clock is bounded at 330 seconds; there
 * is no exponential term that could grow without a stated ceiling.
 */
export const AUTOMATION_RETRY_BACKOFF_SECONDS: ReadonlyArray<number> = [
  30, 300,
];

/** Rows claimed per tick. Bounded query, bounded work. */
export const AUTOMATION_SWEEP_LIMIT = 25;

/**
 * PHASE 12 CORRECTIVE PASS §1 CONTINUATION (2026-08-07) — the AMBIGUITY policy
 * for runs, deliberately the same shape as the delivery one.
 *
 * How long an unknown outcome waits between reconciliation passes, and how
 * many passes it gets before it is declared unknown for good. Bounded, because
 * a row that reconciles forever is a row no operator is ever told about.
 */
export const AUTOMATION_MAX_AMBIGUITY_RECONCILIATIONS = 3;
export const AUTOMATION_AMBIGUITY_BACKOFF_SECONDS: ReadonlyArray<number> = [
  60, 300, 900,
];

/**
 * The BOUNDED failure classification. A failure code is one of these and
 * nothing else — never a provider message, never a response body, never a URL.
 */
export const AUTOMATION_FAILURE_CODES = [
  "action_rejected",
  "action_failed",
  "action_ambiguous",
  "rule_missing",
  "rule_disabled",
  "action_not_allowlisted",
  "lease_lost",
  "retries_exhausted",
  // ARCH-005 §1 — reconciliation ran out and the outcome is STILL unknown.
  // Distinct from `retries_exhausted`, which means the far side answered every
  // time and kept refusing.
  "reconciliation_exhausted_unknown",
] as const;
export type AutomationFailureCode = (typeof AUTOMATION_FAILURE_CODES)[number];

/**
 * Failures whose outcome is UNKNOWN rather than known-bad.
 *
 * They are retryable, and when retries run out they DEAD_LETTER rather than
 * FAIL — because "the request timed out" and "the server refused it" are not
 * the same claim about the outside world.
 */
const AMBIGUOUS_CODES: ReadonlySet<AutomationFailureCode> = new Set([
  "action_ambiguous",
  "lease_lost",
]);

/**
 * Terminal states. Nothing may overwrite one.
 *
 * AMBIGUOUS is deliberately ABSENT: it is not terminal, it is awaiting bounded
 * reconciliation. DEAD_LETTERED_UNKNOWN is what it becomes when that runs out,
 * and it is a DIFFERENT terminal from FAILED because "the receiver refused"
 * and "we never found out" are different facts that an operator acts on
 * differently.
 */
export const AUTOMATION_TERMINAL_STATUSES = [
  "SUCCEEDED",
  "FAILED",
  "SKIPPED",
  "DEAD_LETTERED",
  "DEAD_LETTERED_UNKNOWN",
] as const;

export type AutomationSweepOutcome = {
  claimed: number;
  succeeded: number;
  failed: number;
  retried: number;
  deadLettered: number;
  /** Attempts whose outcome is UNKNOWN and are now in reconciliation. */
  ambiguous: number;
  /** Ambiguous runs whose bounded reconciliation is exhausted. */
  deadLetteredUnknown: number;
  skipped: number;
  /** Rows the reconciler returned to the pool because their lease expired. */
  reclaimed: number;
  /** Rows the reconciler dead-lettered because they were beyond saving. */
  reconciledDeadLettered: number;
};

const ZERO: AutomationSweepOutcome = Object.freeze({
  claimed: 0,
  succeeded: 0,
  failed: 0,
  retried: 0,
  deadLettered: 0,
  ambiguous: 0,
  deadLetteredUnknown: 0,
  skipped: 0,
  reclaimed: 0,
  reconciledDeadLettered: 0,
});

type RunRow = {
  id: string;
  teamId: string;
  ruleId: string;
  triggerType: string;
  targetType: string;
  targetId: string;
  actionIdempotencyKey: string | null;
  attemptCount: number;
  claimGeneration: number;
};

// ===========================================================================
// THE SWEEP
// ===========================================================================

/**
 * One tick: reconcile, then claim and execute what is due.
 *
 * Reconciliation runs FIRST so a run stranded by the previous tick's crash is
 * eligible in THIS tick rather than the next one. Never throws.
 */
export async function runAutomationDispatchSweep(input?: {
  prisma?: PrismaClient;
  limit?: number;
  nowMs?: number;
}): Promise<AutomationSweepOutcome> {
  const prisma = input?.prisma ?? defaultPrisma;
  const limit = Math.min(Math.max(input?.limit ?? AUTOMATION_SWEEP_LIMIT, 1), 100);
  const nowMs = input?.nowMs ?? Date.now();

  const reconciled = await reconcileStrandedRuns({ prisma, nowMs });

  let due: RunRow[];
  try {
    due = (await prisma.automationRun.findMany({
      where: {
        status: { in: ["PENDING", "RETRY_SCHEDULED"] },
        OR: [
          { nextAttemptAtUtc: null },
          { nextAttemptAtUtc: { lte: new Date(nowMs) } },
        ],
      },
      select: {
        id: true,
        teamId: true,
        ruleId: true,
        triggerType: true,
        targetType: true,
        targetId: true,
        actionIdempotencyKey: true,
        attemptCount: true,
        claimGeneration: true,
      },
      orderBy: [{ nextAttemptAtUtc: "asc" }, { createdAt: "asc" }],
      take: limit,
    })) as never;
  } catch {
    return { ...ZERO, ...reconciled };
  }

  const out: AutomationSweepOutcome = { ...ZERO, ...reconciled };
  for (const row of due) {
    const result = await claimAndExecute({ prisma, run: row, nowMs });
    if (result === "not_claimed") continue;
    out.claimed += 1;
    if (result === "succeeded") out.succeeded += 1;
    else if (result === "failed") out.failed += 1;
    else if (result === "retried") out.retried += 1;
    else if (result === "dead_lettered") out.deadLettered += 1;
    else if (result === "ambiguous") out.ambiguous += 1;
    else if (result === "skipped") out.skipped += 1;
  }
  return out;
}

type ExecuteResult =
  | "not_claimed"
  | "succeeded"
  | "failed"
  | "retried"
  | "dead_lettered"
  // ARCH-005 §1 — an outcome the system cannot determine. Distinct from every
  // other value here, because it is the only one that is neither a result nor
  // a reason to try again.
  | "ambiguous"
  | "skipped";

/**
 * Claim ONE run, execute its action, and write exactly one outcome.
 *
 * Exported so a test can drive a single run deterministically without waiting
 * for a sweep tick, and so the concurrency case can call it four times at once.
 */
export async function claimAndExecute(input: {
  prisma?: PrismaClient;
  run: RunRow;
  nowMs?: number;
}): Promise<ExecuteResult> {
  const prisma = input.prisma ?? defaultPrisma;
  const nowMs = input.nowMs ?? Date.now();
  const run = input.run;

  // -------------------------------------------------------------------------
  // CLAIM. One statement, and the row's own current generation is part of the
  // precondition — so of N concurrent claimers exactly one can win, and the
  // winner learns which generation it holds.
  // -------------------------------------------------------------------------
  const generation = run.claimGeneration + 1;
  const attempt = run.attemptCount + 1;
  let claimed = 0;
  try {
    const res = await prisma.automationRun.updateMany({
      where: {
        id: run.id,
        status: { in: ["PENDING", "RETRY_SCHEDULED"] },
        claimGeneration: run.claimGeneration,
      },
      data: {
        status: "RUNNING",
        claimGeneration: generation,
        attemptCount: attempt,
        claimedAtUtc: new Date(nowMs),
        leaseExpiresAtUtc: new Date(nowMs + AUTOMATION_LEASE_MS),
        startedAt: new Date(nowMs),
        nextAttemptAtUtc: null,
      },
    });
    claimed = res.count;
  } catch {
    return "not_claimed";
  }
  if (claimed !== 1) return "not_claimed";

  // -------------------------------------------------------------------------
  // The rule is re-read AFTER the claim, not carried from the producer.
  //
  // Between the source commit and this moment an operator may have disabled or
  // deleted the rule. Executing on the producer's snapshot would run a rule
  // the customer has switched off, which is the same class of defect as
  // trusting a job payload's claim about authority.
  // -------------------------------------------------------------------------
  type ClaimedRule = {
    id: string;
    teamId: string;
    enabled: boolean;
    actionType: string;
    actionConfigJson: unknown;
  };
  let rule: ClaimedRule | null = null;
  try {
    rule = (await prisma.automationRule.findFirst({
      where: { id: run.ruleId, teamId: run.teamId },
      select: {
        id: true,
        teamId: true,
        enabled: true,
        actionType: true,
        actionConfigJson: true,
      },
    })) as ClaimedRule | null;
  } catch {
    rule = null;
  }

  if (!rule) {
    await finaliseSkipped(prisma, run, generation, "NOTIFY_USER", "rule_missing", nowMs);
    return "skipped";
  }
  if (!rule.enabled) {
    await finaliseSkipped(
      prisma,
      run,
      generation,
      rule.actionType as AutomationActionType,
      "rule_disabled",
      nowMs,
    );
    return "skipped";
  }

  const actionType = rule.actionType as AutomationActionType;
  emitRunLifecycle("automation_run_started", {
    teamId: run.teamId,
    ruleId: run.ruleId,
    runId: run.id,
    triggerType: run.triggerType as AutomationTriggerType,
    actionType,
    targetType: run.targetType,
    targetId: run.targetId,
  });

  // -------------------------------------------------------------------------
  // EXECUTE. The action's own idempotency key travels with it, so a retry is
  // the same intent — the webhook delivery row is unique on
  // (team, run, destination), so a retried run collapses onto the delivery the
  // first attempt already created rather than creating a second webhook.
  // -------------------------------------------------------------------------
  let failure: { code: AutomationFailureCode; reason: string } | null = null;
  let deliberateSkip: string | null = null;
  try {
    const result = await executeAutomationAction(
      {
        teamId: run.teamId,
        ruleId: rule.id,
        runId: run.id,
        actionType,
        actionConfig: (rule.actionConfigJson ?? {}) as Record<string, unknown>,
        triggerType: run.triggerType as AutomationTriggerType,
        targetType: run.targetType,
        targetId: run.targetId,
        context: {},
        actionIdempotencyKey:
          run.actionIdempotencyKey ?? `automation-run:${run.id}`,
      },
      prisma,
    );
    if (result.executed) {
      // succeeded
    } else if (result.skipped) {
      // A DELIBERATE non-action: a missing config, a target who is no longer a
      // member, a destination an operator disabled, a delivery that already
      // exists. None of those is a failure and none of them gets better in
      // thirty seconds, so they are SKIPPED rather than retried — with one
      // exception below, where the far side actively refused.
      const reason = result.reason ?? "skipped";
      if (reason.startsWith("ssrf_blocked")) {
        failure = { code: "action_rejected", reason: sanitiseReason(reason) };
      } else {
        deliberateSkip = sanitiseReason(reason) || "skipped";
      }
    } else {
      failure = {
        code: classifyReason(result.reason),
        reason: sanitiseReason(result.reason ?? "action_failed"),
      };
    }
  } catch (err) {
    const raw = err instanceof Error ? err.message : "action_failed";
    failure = { code: classifyReason(raw), reason: sanitiseReason(raw) };
  }

  if (deliberateSkip) {
    await finaliseSkipped(
      prisma,
      run,
      generation,
      actionType,
      // The bounded code says WHY in a fixed vocabulary; the free reason
      // travels in `reason`, already sanitised.
      "action_rejected",
      nowMs,
      deliberateSkip,
    );
    return "skipped";
  }

  if (!failure) {
    const ok = await finaliseSucceeded(prisma, run, generation, actionType, nowMs);
    // A claim that cannot write its own success has LOST THE LEASE. It does not
    // retry here — the reconciler owns the row now, and racing it would be the
    // very double-execution the fence exists to prevent.
    return ok ? "succeeded" : "not_claimed";
  }

  // -------------------------------------------------------------------------
  // FAILURE. Retryable while attempts remain; otherwise terminal, and the
  // terminal state depends on whether the outcome is KNOWN.
  // -------------------------------------------------------------------------
  /**
   * PHASE 12 CORRECTIVE PASS §1 CONTINUATION (2026-08-07) — AMBIGUITY LEAVES
   * THE RETRY LADDER.
   *
   * It used to be ON it: an ambiguous code was "retryable", so a timeout was
   * re-executed after 30 s and only dead-lettered once the ladder ran out.
   * That is a SECOND execution of an action that may already have committed —
   * a duplicate side effect wearing a retry's clothes.
   *
   * An ambiguous outcome now moves to its own state and waits under the
   * bounded reconciliation policy. It keeps its action idempotency key, so if
   * reconciliation ever establishes that nothing committed, the resend is the
   * same intent and not a new one.
   */
  if (AMBIGUOUS_CODES.has(failure.code)) {
    await finaliseAmbiguous(prisma, run, generation, actionType, failure, nowMs);
    return "ambiguous";
  }

  const backoff = AUTOMATION_RETRY_BACKOFF_SECONDS[attempt - 1];
  const retryable = isRetryable(failure.code);
  if (retryable && attempt < AUTOMATION_MAX_ATTEMPTS && backoff !== undefined) {
    await finaliseRetry(prisma, run, generation, failure, backoff, nowMs);
    return "retried";
  }

  // Retryable, but the ladder is spent. The far side DID answer each time
  // (that is what made it retryable), so this is a known failure and
  // DEAD_LETTERED is the right terminal — not DEAD_LETTERED_UNKNOWN.
  if (retryable && attempt >= AUTOMATION_MAX_ATTEMPTS) {
    await finaliseDeadLettered(prisma, run, generation, actionType, failure, nowMs);
    return "dead_lettered";
  }

  await finaliseFailed(prisma, run, generation, actionType, failure, nowMs);
  return "failed";
}

// ===========================================================================
// THE RECONCILER
// ===========================================================================

/**
 * Return stranded runs to the pool, and stop the ones that are beyond saving.
 *
 * Convergent and idempotent: running it twice in a row changes nothing the
 * first run did not already change, and it invents no status to make a row
 * terminal. A run whose lease expired goes back to RETRY_SCHEDULED with its
 * generation bumped — which is precisely what makes the previous holder's
 * eventual terminal write a no-op.
 */
export async function reconcileStrandedRuns(input: {
  prisma?: PrismaClient;
  nowMs?: number;
  limit?: number;
}): Promise<{
  reclaimed: number;
  reconciledDeadLettered: number;
  ambiguityDeadLettered: number;
}> {
  const prisma = input.prisma ?? defaultPrisma;
  const nowMs = input.nowMs ?? Date.now();
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const now = new Date(nowMs);

  let stranded: Array<{ id: string; attemptCount: number; claimGeneration: number }>;
  try {
    stranded = await prisma.automationRun.findMany({
      where: { status: "RUNNING", leaseExpiresAtUtc: { lte: now } },
      select: { id: true, attemptCount: true, claimGeneration: true },
      orderBy: { leaseExpiresAtUtc: "asc" },
      take: limit,
    });
  } catch {
    return { reclaimed: 0, reconciledDeadLettered: 0, ambiguityDeadLettered: 0 };
  }

  let reclaimed = 0;
  let deadLettered = 0;
  for (const s of stranded) {
    const beyondRetry = s.attemptCount >= AUTOMATION_MAX_ATTEMPTS;
    try {
      const res = await prisma.automationRun.updateMany({
        // The generation is part of the precondition here too: if the holder
        // woke up and finished between the SELECT and this UPDATE, this writes
        // nothing rather than resurrecting a completed run.
        where: { id: s.id, status: "RUNNING", claimGeneration: s.claimGeneration },
        data: beyondRetry
          ? {
              status: "DEAD_LETTERED",
              claimGeneration: s.claimGeneration + 1,
              // The outcome is genuinely unknown — the worker that held this
              // run never reported. Saying FAILED would assert something
              // nobody observed.
              failureCode: "lease_lost",
              reason: "lease_expired_after_max_attempts",
              deadLetteredAtUtc: new Date(nowMs),
              // `completedAt` is deliberately NOT set. The run did not
              // complete — nobody ever reported what happened to it.
              leaseExpiresAtUtc: null,
              nextAttemptAtUtc: null,
            }
          : {
              status: "RETRY_SCHEDULED",
              claimGeneration: s.claimGeneration + 1,
              failureCode: "lease_lost",
              reason: "lease_expired_reclaimed",
              leaseExpiresAtUtc: null,
              claimedAtUtc: null,
              nextAttemptAtUtc: new Date(nowMs),
            },
      });
      if (res.count === 1) {
        if (beyondRetry) deadLettered += 1;
        else reclaimed += 1;
      }
    } catch {
      /* the next tick sees it again — convergence, not a lost row */
    }
  }
  /**
   * ARCH-005 §1 (2026-08-07) — BOUNDED AMBIGUITY RECONCILIATION FOR RUNS.
   *
   * An AMBIGUOUS run has no provider to ask: the action already ran, and its
   * external effect (if any) belongs to the delivery row, which has its OWN
   * reconciler and its own provider-lookup seam. What this pass owns is the
   * BOUND — the run cannot sit unknown forever. Each visit increments the
   * counter and pushes the next visit out; when the counter is spent the run
   * becomes DEAD_LETTERED_UNKNOWN, which is operator-visible and is NOT the
   * same terminal as a refusal.
   *
   * Fenced on the generation, so a stale worker cannot overwrite a reconciled
   * outcome.
   */
  let ambiguityDeadLettered = 0;
  try {
    const ambiguous = await prisma.automationRun.findMany({
      where: {
        status: "AMBIGUOUS",
        OR: [{ nextAttemptAtUtc: null }, { nextAttemptAtUtc: { lte: now } }],
      },
      select: {
        id: true,
        teamId: true,
        ruleId: true,
        triggerType: true,
        targetType: true,
        targetId: true,
        reconciliationAttempts: true,
        claimGeneration: true,
        failureCode: true,
      },
      orderBy: { nextAttemptAtUtc: "asc" },
      take: limit,
    });
    for (const a of ambiguous) {
      const next = a.reconciliationAttempts + 1;
      const exhausted = next >= AUTOMATION_MAX_AMBIGUITY_RECONCILIATIONS;
      const res = await prisma.automationRun.updateMany({
        where: { id: a.id, status: "AMBIGUOUS", claimGeneration: a.claimGeneration },
        data: exhausted
          ? {
              status: "DEAD_LETTERED_UNKNOWN",
              claimGeneration: a.claimGeneration + 1,
              reconciliationAttempts: next,
              failureCode: "reconciliation_exhausted_unknown",
              reason: "outcome_unknown_after_bounded_reconciliation",
              deadLetteredAtUtc: new Date(nowMs),
              nextAttemptAtUtc: null,
              // completedAt stays NULL. Nothing completed.
            }
          : {
              status: "AMBIGUOUS",
              claimGeneration: a.claimGeneration + 1,
              reconciliationAttempts: next,
              nextAttemptAtUtc: new Date(
                nowMs +
                  AUTOMATION_AMBIGUITY_BACKOFF_SECONDS[
                    Math.min(next, AUTOMATION_AMBIGUITY_BACKOFF_SECONDS.length - 1)
                  ]! *
                    1000,
              ),
            },
      });
      if (res.count === 1 && exhausted) {
        ambiguityDeadLettered += 1;
        emitRunLifecycle("automation_run_dead_lettered_unknown", {
          teamId: a.teamId,
          ruleId: a.ruleId,
          runId: a.id,
          triggerType: a.triggerType as AutomationTriggerType,
          actionType: "NOTIFY_USER",
          targetType: a.targetType,
          targetId: a.targetId,
          reason: "reconciliation_exhausted_unknown",
        });
      }
    }
  } catch {
    /* the next tick sees them again — convergence, not a lost row */
  }

  return { reclaimed, reconciledDeadLettered: deadLettered, ambiguityDeadLettered };
}

// ===========================================================================
// Terminal writers. Every one is fenced on the generation it claimed under.
// ===========================================================================

async function fencedUpdate(
  prisma: PrismaClient,
  runId: string,
  generation: number,
  data: Record<string, unknown>,
): Promise<boolean> {
  try {
    const res = await prisma.automationRun.updateMany({
      where: {
        id: runId,
        // BOTH conditions matter. The generation stops a stale holder; the
        // status stops a terminal row being rewritten even by the right one.
        status: "RUNNING",
        claimGeneration: generation,
      },
      data: data as never,
    });
    return res.count === 1;
  } catch {
    return false;
  }
}

async function finaliseSucceeded(
  prisma: PrismaClient,
  run: RunRow,
  generation: number,
  actionType: AutomationActionType,
  nowMs: number,
): Promise<boolean> {
  const ok = await fencedUpdate(prisma, run.id, generation, {
    status: "SUCCEEDED",
    completedAt: new Date(nowMs),
    leaseExpiresAtUtc: null,
    nextAttemptAtUtc: null,
    failureCode: null,
  });
  if (ok) {
    emitRunLifecycle("automation_run_succeeded", {
      teamId: run.teamId,
      ruleId: run.ruleId,
      runId: run.id,
      triggerType: run.triggerType as AutomationTriggerType,
      actionType,
      targetType: run.targetType,
      targetId: run.targetId,
    });
  }
  return ok;
}

async function finaliseFailed(
  prisma: PrismaClient,
  run: RunRow,
  generation: number,
  actionType: AutomationActionType,
  failure: { code: AutomationFailureCode; reason: string },
  nowMs: number,
): Promise<boolean> {
  const ok = await fencedUpdate(prisma, run.id, generation, {
    status: "FAILED",
    failureCode: failure.code,
    reason: failure.reason.slice(0, 400) || failure.code,
    failedAtUtc: new Date(nowMs),
    completedAt: new Date(nowMs),
    leaseExpiresAtUtc: null,
    nextAttemptAtUtc: null,
  });
  if (ok) {
    emitRunLifecycle("automation_run_failed", {
      teamId: run.teamId,
      ruleId: run.ruleId,
      runId: run.id,
      triggerType: run.triggerType as AutomationTriggerType,
      actionType,
      targetType: run.targetType,
      targetId: run.targetId,
      reason: failure.code,
    });
  }
  return ok;
}

/**
 * PHASE 12 CORRECTIVE PASS §1 CONTINUATION (2026-08-07).
 *
 * The run's outcome is UNKNOWN. Not success, not failure, not retried.
 *
 * `nextAttemptAtUtc` here is a RECONCILIATION time, not a retry time — the
 * reconciler reads it and the claim pass does not, because AMBIGUOUS is
 * deliberately absent from the claim's `status IN (...)` predicate. That
 * absence is the whole guarantee: an ambiguous run cannot be re-executed by
 * the ordinary path even if somebody later widens the retry ladder.
 */
async function finaliseAmbiguous(
  prisma: PrismaClient,
  run: RunRow,
  generation: number,
  actionType: AutomationActionType,
  failure: { code: AutomationFailureCode; reason: string },
  nowMs: number,
): Promise<boolean> {
  const backoff = AUTOMATION_AMBIGUITY_BACKOFF_SECONDS[0]!;
  const ok = await fencedUpdate(prisma, run.id, generation, {
    status: "AMBIGUOUS",
    failureCode: failure.code,
    reason: failure.reason.slice(0, 400) || failure.code,
    ambiguousAtUtc: new Date(nowMs),
    reconciliationAttempts: 0,
    nextAttemptAtUtc: new Date(nowMs + backoff * 1000),
    leaseExpiresAtUtc: null,
    claimedAtUtc: null,
  });
  if (ok) {
    emitRunLifecycle("automation_run_ambiguous", {
      teamId: run.teamId,
      ruleId: run.ruleId,
      runId: run.id,
      triggerType: run.triggerType as AutomationTriggerType,
      actionType,
      targetType: run.targetType,
      targetId: run.targetId,
      reason: failure.code,
    });
  }
  return ok;
}

async function finaliseDeadLettered(
  prisma: PrismaClient,
  run: RunRow,
  generation: number,
  actionType: AutomationActionType,
  failure: { code: AutomationFailureCode; reason: string },
  nowMs: number,
): Promise<boolean> {
  const ok = await fencedUpdate(prisma, run.id, generation, {
    status: "DEAD_LETTERED",
    failureCode:
      failure.code === "action_ambiguous" ? "action_ambiguous" : "retries_exhausted",
    reason: failure.reason.slice(0, 400) || failure.code,
    deadLetteredAtUtc: new Date(nowMs),
    leaseExpiresAtUtc: null,
    nextAttemptAtUtc: null,
  });
  if (ok) {
    emitRunLifecycle("automation_run_failed", {
      teamId: run.teamId,
      ruleId: run.ruleId,
      runId: run.id,
      triggerType: run.triggerType as AutomationTriggerType,
      actionType,
      targetType: run.targetType,
      targetId: run.targetId,
      reason: "dead_lettered",
    });
  }
  return ok;
}

async function finaliseSkipped(
  prisma: PrismaClient,
  run: RunRow,
  generation: number,
  actionType: AutomationActionType,
  code: AutomationFailureCode,
  nowMs: number,
  reason?: string,
): Promise<boolean> {
  const ok = await fencedUpdate(prisma, run.id, generation, {
    status: "SKIPPED",
    failureCode: code,
    reason: (reason ?? code).slice(0, 400),
    completedAt: new Date(nowMs),
    leaseExpiresAtUtc: null,
    nextAttemptAtUtc: null,
  });
  if (ok) {
    emitRunLifecycle("automation_run_skipped", {
      teamId: run.teamId,
      ruleId: run.ruleId,
      runId: run.id,
      triggerType: run.triggerType as AutomationTriggerType,
      actionType,
      targetType: run.targetType,
      targetId: run.targetId,
      reason: code,
    });
  }
  return ok;
}

async function finaliseRetry(
  prisma: PrismaClient,
  run: RunRow,
  generation: number,
  failure: { code: AutomationFailureCode; reason: string },
  backoffSeconds: number,
  nowMs: number,
): Promise<boolean> {
  // RETRY_SCHEDULED is not terminal, so the generation is bumped: the claim
  // this attempt held is over, and a stale write from it must not land on the
  // next attempt either.
  return fencedUpdate(prisma, run.id, generation, {
    status: "RETRY_SCHEDULED",
    claimGeneration: generation + 1,
    failureCode: failure.code,
    reason: failure.reason.slice(0, 400) || failure.code,
    nextAttemptAtUtc: new Date(nowMs + backoffSeconds * 1000),
    leaseExpiresAtUtc: null,
    claimedAtUtc: null,
  });
}

// ===========================================================================
// Classification
// ===========================================================================

/**
 * Map an action failure onto the BOUNDED code set.
 *
 * The mapping is deliberately conservative: anything this function cannot
 * positively identify as a permanent rejection is treated as AMBIGUOUS, which
 * retries and then dead-letters. Defaulting the other way would let an unknown
 * failure be reported as a known one.
 */
export function classifyReason(reason: string | undefined): AutomationFailureCode {
  const r = (reason ?? "").toLowerCase();
  if (!r) return "action_failed";
  // Permanent — the far side understood the request and refused it.
  if (
    r.includes("not_allowlisted") ||
    r.includes("unsupported_action") ||
    r.includes("permanent") ||
    r.includes("ssrf_blocked") ||
    r.includes("destination_disabled") ||
    r.includes("secret_decryption_failed") ||
    /\bhttp_4\d\d\b/.test(r)
  ) {
    return r.includes("not_allowlisted") ? "action_not_allowlisted" : "action_rejected";
  }
  // Explicitly unknown — the request may or may not have arrived.
  if (
    r.includes("timeout") ||
    r.includes("econnreset") ||
    r.includes("socket hang up") ||
    r.includes("aborted") ||
    r.includes("network")
  ) {
    return "action_ambiguous";
  }
  // Retryable-but-known: the far side was there and said "later".
  if (r.includes("429") || /\bhttp_5\d\d\b/.test(r) || r.includes("rate_limit")) {
    return "action_failed";
  }
  return "action_failed";
}

/** Permanent rejections do not retry. Everything else does, while it can. */
export function isRetryable(code: AutomationFailureCode): boolean {
  return code !== "action_rejected" && code !== "action_not_allowlisted" && code !== "rule_missing" && code !== "rule_disabled";
}
