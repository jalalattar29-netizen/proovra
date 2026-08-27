/**
 * THE DEPENDENT-CANCELLATION RETRY SWEEP.
 *
 * WHY IT EXISTS
 * ---------------------------------------------------------------------------
 * A base plan cancellation succeeded and one of its recurring Storage add-ons
 * did not stop. The obligation to stop it is durable, but a durable obligation
 * nobody acts on is just a better-recorded orphan. This is what acts on it.
 *
 * WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 * It is not a second cancellation implementation. Every attempt goes through
 * `attemptDependentCancellations`, the same authority the customer's retry
 * action and the reconciliation sweep use, which in turn goes through the one
 * canonical provider service. This file decides only WHICH obligations are due.
 *
 * IT NEVER RE-CANCELS THE BASE
 * ---------------------------------------------------------------------------
 * The base subscription is not selected, not read and not touched. The
 * obligation lives on the add-on, so the retry can only ever be about add-ons.
 *
 * BOUNDED IN EVERY DIRECTION
 * ---------------------------------------------------------------------------
 *   * `SUBJECT_BATCH` billing subjects per tick, ordered by the oldest due
 *     retry, so nothing starves.
 *   * `dueOnly` — an obligation whose backoff has not elapsed is skipped, so a
 *     failing provider is asked on the schedule, not on every tick.
 *   * a durable per-add-on lease inside the authority, so two workers — or a
 *     worker and a customer pressing retry — cannot attempt the same add-on.
 *   * one try/catch per subject: one broken account cannot end the tick.
 *   * restart-safe: every piece of state is a column, and there is no
 *     in-memory timer anywhere in the path.
 */

import * as prismaPkg from "@prisma/client";

import { prisma } from "../db.js";
import { log as logInfo, warn as logWarn } from "../utils/logger.js";
import {
  attemptDependentCancellations,
  UNRESOLVED_STATES,
} from "../services/billing/dependent-cancellation.service.js";
import { syncDependentCancellationConditions } from "../services/billing/dependent-cancellation-conditions.service.js";
import type { StorageAddonProviderCanceller } from "../services/billing/storage-addon-cancellation.service.js";

/** Billing subjects offered per tick. */
export const SUBJECT_BATCH = 25;

type Subject = { ownerUserId: string; teamId: string | null };

/**
 * The billing subjects with an obligation that is DUE.
 *
 * Selected from the partial index on unresolved obligations, so on a healthy
 * system this reads zero rows rather than scanning the add-on table.
 */
export async function selectDueCancellationSubjects(
  now: Date,
  limit: number = SUBJECT_BATCH,
): Promise<Subject[]> {
  const rows = await prisma.workspaceStorageAddon.findMany({
    where: {
      dependentCancellationState: { in: [...UNRESOLVED_STATES] },
      dependentCancellationNextRetryAtUtc: { lte: now },
    },
    orderBy: { dependentCancellationNextRetryAtUtc: "asc" },
    take: limit * 4,
    select: { ownerUserId: true, teamId: true },
  });

  // Deduplicate to SUBJECTS: the authority attempts every obligation a subject
  // owns in one pass, so a subject with four stuck add-ons is one unit of work.
  const seen = new Set<string>();
  const out: Subject[] = [];
  for (const r of rows) {
    const key = `${r.teamId ?? "personal"}:${r.ownerUserId}`;
    if (seen.has(key) || out.length >= limit) continue;
    seen.add(key);
    out.push({ ownerUserId: r.ownerUserId, teamId: r.teamId });
  }
  return out;
}

export async function runDependentCancellationRetrySweep(input?: {
  limit?: number;
  now?: Date;
  cancelAtProvider?: StorageAddonProviderCanceller;
}): Promise<{
  subjects: number;
  attempted: number;
  confirmed: number;
  failed: number;
  escalated: number;
  conditionsOpened: number;
}> {
  const now = input?.now ?? new Date();
  const subjects = await selectDueCancellationSubjects(
    now,
    input?.limit ?? SUBJECT_BATCH,
  );

  let attempted = 0;
  let confirmed = 0;
  let failed = 0;
  let escalated = 0;

  for (const subject of subjects) {
    try {
      const r = await attemptDependentCancellations({
        ownerUserId: subject.ownerUserId,
        teamId: subject.teamId,
        cancelAtProvider: input?.cancelAtProvider,
        now,
        dueOnly: true,
      });
      attempted += r.attempted;
      confirmed += r.confirmed;
      failed += r.failed;
      escalated += r.escalated;
    } catch (err) {
      // Per-subject isolation. The obligation stays durable and due, so the
      // next tick retries it — a thrown error loses nothing.
      logWarn("billing.dependent_cancellation.subject_failed", {
        scope: subject.teamId ? "WORKSPACE" : "PERSONAL",
        err: err instanceof Error ? err.message : "unknown",
      });
    }
  }

  // The condition sweep runs AFTER the attempts, so a subject that just
  // converged does not get an incident opened one tick before its probe
  // closes it again.
  let conditionsOpened = 0;
  try {
    conditionsOpened = (await syncDependentCancellationConditions()).opened;
  } catch (err) {
    logWarn("billing.dependent_cancellation.conditions_failed", {
      err: err instanceof Error ? err.message : "unknown",
    });
  }

  logInfo("billing.dependent_cancellation.sweep_completed", {
    subjects: subjects.length,
    attempted,
    confirmed,
    failed,
    escalated,
    conditionsOpened,
  });

  return {
    subjects: subjects.length,
    attempted,
    confirmed,
    failed,
    escalated,
    conditionsOpened,
  };
}

/** Kept explicit so the scheduler's import is a value, not a type. */
export const DEPENDENT_CANCELLATION_PROVIDERS = prismaPkg.PaymentProvider;
