/**
 * PHASE 12 CORRECTIVE PASS §2 CONTINUATION (ARCH-005, 2026-08-07).
 *
 * THE ONE AUTOMATION PRODUCER.
 *
 * The finding
 * ---------------------------------------------------------------------------
 * Automation was configurable and inert. `dispatchAutomationTrigger` had ZERO
 * production callers: a customer could build a rule in the UI, enable it, and
 * nothing would ever run it. Where execution existed at all it ran
 * synchronously inside the API request that happened to call it, and webhook
 * delivery rode an in-process `setImmediate` — so a restart mid-flight lost
 * the work with no durable record that anything was owed.
 *
 * Why the run row IS the outbox row
 * ---------------------------------------------------------------------------
 * The obvious repair — "call the dispatcher after the database commits" —
 * leaves the crash window open:
 *
 *     source transaction commits
 *       → process dies
 *       → the dispatcher never runs
 *       → the event is gone, and nothing anywhere knows it existed
 *
 * So this function writes inside the CALLER'S TRANSACTION. `AutomationRun` is
 * the durable event: it is committed atomically with the evidence, review,
 * hold or package change that produced it, or it is rolled back with it. There
 * is no second event table and no second outbox — adding one would mean two
 * places could disagree about whether something happened.
 *
 * What it may not do
 * ---------------------------------------------------------------------------
 *   * It must NOT throw. It runs inside somebody else's transaction, and an
 *     exception here would roll back a legitimate domain change because an
 *     automation rule was misconfigured. Every failure path returns a count.
 *   * It must NOT rely on catching a unique violation. A constraint violation
 *     inside a PostgreSQL transaction POISONS that transaction — catching the
 *     `P2002` in JavaScript does not un-poison it, and the caller's own commit
 *     then fails. Idempotency therefore uses `createMany({ skipDuplicates })`,
 *     which is `ON CONFLICT DO NOTHING`: the duplicate is discarded by the
 *     database without raising.
 *   * It must NOT take the tenant from anything a caller could forge. The
 *     `teamId` is the tenant of the row being changed in the source
 *     transaction, and the rule query is scoped by it, so a trigger for
 *     workspace A can never match a rule on workspace B.
 *   * It must NOT execute anything. Execution belongs to the sweep, under a
 *     lease and a fence. This function's only side effect is rows.
 */

import { createHash, randomUUID } from "node:crypto";

import type { Prisma, PrismaClient } from "@prisma/client";

import {
  AUTOMATION_ACTION_TYPES,
  AUTOMATION_TRIGGER_TYPES,
  computeIdempotencyKey,
  type AutomationTriggerType,
} from "./automation.service.js";
import { evaluateCondition } from "./automation-dispatcher.service.js";

/**
 * Any Prisma handle. The transaction client is the one that matters: passing
 * it is what makes the run atomic with the source change.
 */
export type AutomationOutboxClient = PrismaClient | Prisma.TransactionClient;

export type EnqueueAutomationTriggerInput = {
  /** The tenant of the row being changed. Never supplied by a request body. */
  teamId: string;
  triggerType: AutomationTriggerType;
  targetType: string;
  targetId: string;
  /**
   * The durable identity of the SOURCE event.
   *
   * Two dispatches of the same domain event — a retried request, a replayed
   * sweep, a double-submitted mutation — must produce ONE run per rule. When
   * the caller can name a durable identity (a lifecycle event id, a delivery
   * id, a sweep window key) it should; when it cannot, the deterministic
   * fallback below is derived from the trigger and target, which is the same
   * identity the E3 `idempotencyKey` has always used.
   */
  sourceEventId?: string;
  /** Bounded operator-safe metadata for condition evaluation. */
  context?: Readonly<Record<string, unknown>>;
};

export type EnqueueAutomationTriggerOutcome = {
  considered: number;
  /** Rows the database actually inserted — duplicates are not counted. */
  enqueued: number;
  /** Rules whose condition did not match. No run is written for these. */
  unmatched: number;
  /** Rules whose action type is not on the allowlist. */
  rejected: number;
};

const EMPTY: EnqueueAutomationTriggerOutcome = Object.freeze({
  considered: 0,
  enqueued: 0,
  unmatched: 0,
  rejected: 0,
});

/** Bounded so one pathological workspace cannot make a source commit slow. */
export const AUTOMATION_MAX_RULES_PER_TRIGGER = 50;

/**
 * The durable ACTION intent identity.
 *
 * Derived from the run's own id, so a retry of the same run reuses it and a
 * genuinely new run cannot collide. The backfill migration derives exactly
 * this shape for historical rows, so the retry path cannot tell an old row
 * from a new one.
 */
export function actionIdempotencyKeyForRun(runId: string): string {
  return `automation-run:${runId}`;
}

/**
 * The deterministic fallback source-event identity.
 *
 * Hashed rather than concatenated because `targetType` is free-form and the
 * column is bounded at 160 characters; a truncated concatenation could make
 * two different events look like one.
 *
 * The field separator between the three parts is U+0000, and it is written as
 * a unicode ESCAPE rather than as that byte typed literally into the file. The
 * hashed string is identical either way, so no previously derived identity
 * changes — but a source file that CONTAINS the byte is classified by git as
 * binary, which left this module's diff unreviewable by default in a service
 * whose whole correctness argument is about deduplication.
 */
export function deriveSourceEventId(input: {
  triggerType: string;
  targetType: string;
  targetId: string;
}): string {
  const h = createHash("sha256")
    .update(`${input.triggerType}\u0000${input.targetType}\u0000${input.targetId}`)
    .digest("hex");
  return `derived:${h.slice(0, 48)}`;
}

/**
 * Enqueue an automation trigger DURABLY.
 *
 * Pass the transaction client from the source transaction. Returns a count
 * summary; never throws.
 */
export async function enqueueAutomationTrigger(
  client: AutomationOutboxClient,
  input: EnqueueAutomationTriggerInput,
): Promise<EnqueueAutomationTriggerOutcome> {
  if (!input?.teamId || !input.targetId) return EMPTY;
  if (!(AUTOMATION_TRIGGER_TYPES as readonly string[]).includes(input.triggerType)) {
    return EMPTY;
  }

  const db = client as PrismaClient;
  let rules: Array<{
    id: string;
    teamId: string;
    actionType: string;
    conditionJson: unknown;
  }>;
  try {
    rules = (await db.automationRule.findMany({
      where: {
        // TENANT SCOPE. The rule set is bounded by the tenant of the row that
        // changed, so a trigger for one workspace cannot reach another's rule.
        teamId: input.teamId,
        triggerType: input.triggerType,
        enabled: true,
        // B7B-F02 — a closed workspace runs no automation: its retained
        // records still reach retention dates and fire time-based triggers.
        // (Closure also disables the rules; this holds for any left enabled.)
        team: { closedAtUtc: null },
      },
      select: { id: true, teamId: true, actionType: true, conditionJson: true },
      orderBy: { createdAt: "asc" },
      take: AUTOMATION_MAX_RULES_PER_TRIGGER,
    })) as never;
  } catch {
    // A read failure must not abort the caller's transaction. Note that a
    // FAILED read inside a transaction may already have poisoned it — but a
    // bounded, indexed SELECT on an existing table does not fail for reasons
    // this function could recover from, and rethrowing would guarantee the
    // domain change is lost rather than merely un-automated.
    return EMPTY;
  }

  if (rules.length === 0) return { ...EMPTY, considered: 0 };

  const sourceEventId =
    input.sourceEventId?.slice(0, 160) ??
    deriveSourceEventId({
      triggerType: input.triggerType,
      targetType: input.targetType,
      targetId: input.targetId,
    });
  const ctx = (input.context ?? {}) as Readonly<Record<string, unknown>>;

  let unmatched = 0;
  let rejected = 0;
  const rows: Array<Record<string, unknown>> = [];
  const runIds: string[] = [];

  for (const rule of rules) {
    // Defence in depth: a rule whose action type left the allowlist (an
    // allowlist narrowed by a later migration, say) is not runnable, and
    // writing a run for it would create work nothing can execute.
    if (!(AUTOMATION_ACTION_TYPES as readonly string[]).includes(rule.actionType)) {
      rejected += 1;
      continue;
    }

    // Conditions are EVALUATED, never executed — the same pure descent the
    // dispatcher has always used.
    if (!evaluateCondition(rule.conditionJson, ctx)) {
      // NO ROW. The previous design wrote a SKIPPED run for every
      // non-matching evaluation, which meant a rule that matches one target in
      // a thousand produced 999 rows of noise per trigger and consumed the
      // idempotency key that the eventual MATCH would have needed. A rule that
      // did not match did not run; that is not an execution record.
      unmatched += 1;
      continue;
    }

    // The id is generated here rather than by the database default so the
    // action idempotency key can be derived from it in the same INSERT.
    const runId = randomRunId();
    runIds.push(runId);
    rows.push({
      id: runId,
      teamId: rule.teamId,
      ruleId: rule.id,
      triggerType: input.triggerType,
      targetType: input.targetType.slice(0, 60),
      targetId: input.targetId,
      idempotencyKey: computeIdempotencyKey({
        ruleId: rule.id,
        triggerType: input.triggerType,
        targetType: input.targetType,
        targetId: input.targetId,
      }),
      sourceEventId,
      actionIdempotencyKey: actionIdempotencyKeyForRun(runId),
      status: "PENDING",
      attemptCount: 0,
      claimGeneration: 0,
      // Due immediately. The sweep orders by this, so a retry scheduled into
      // the future does not starve a fresh run.
      nextAttemptAtUtc: new Date(),
    });
  }

  if (rows.length === 0) {
    return { considered: rules.length, enqueued: 0, unmatched, rejected };
  }

  let enqueued = 0;
  try {
    // `skipDuplicates` is ON CONFLICT DO NOTHING. It is the ONLY duplicate
    // strategy admissible here: a raised unique violation would abort the
    // caller's transaction, taking a legitimate domain change down with it.
    const created = await db.automationRun.createMany({
      data: rows as never,
      skipDuplicates: true,
    });
    enqueued = created.count;
  } catch {
    // Nothing was written. The domain change still stands, which is the
    // correct trade: automation is an operator convenience and evidence is not.
    enqueued = 0;
  }

  return { considered: rules.length, enqueued, unmatched, rejected };
}

/**
 * The run id is generated here rather than left to the database default so the
 * ACTION idempotency key can be derived from it in the same INSERT — the key
 * has to exist before the row does, or a retry has nothing stable to reuse.
 */
function randomRunId(): string {
  return randomUUID();
}
