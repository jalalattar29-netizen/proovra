/**
 * PHASE 12 CORRECTIVE PASS §2 CONTINUATION (ARCH-005, 2026-08-07).
 *
 * The worker-side tick for `AutomationDispatchSweep`.
 *
 * The API exposes `POST /v1/automation/runs/process`, guarded by
 * `INTEGRATION_CRON_SECRET`. That endpoint claims due `AutomationRun` rows
 * under a lease and a monotonic fence, executes each one's bounded action,
 * persists exactly one outcome, schedules retries, dead-letters exhausted
 * runs, and reconciles runs whose holder died — then sweeps the durable
 * webhook-delivery outbox the same way.
 *
 * This file only SCHEDULES it, over HTTP, exactly like
 * `org-invite-delivery.worker.ts` and `reviewer-ops/reviewer-reconciliation`:
 *
 *   - HTTP call, never an in-process import of API modules. The seven bounded
 *     action handlers reach the notification, reviewer-assignment and comment
 *     authorities, which live API-side; a worker-side copy of them would be a
 *     second authority for every one.
 *   - Errors are LOGGED and SENTRY-CAPTURED, never thrown. A stuck sweep must
 *     not crash the worker — the next tick retries, and every claim is
 *     idempotent, so an overlapping tick executes nothing twice.
 *   - Nothing here decides anything. There is no tenant, no batch policy and
 *     no retry rule in this file; all of it lives with the durable rows.
 */

import { newCorrelationId } from "@proovra/shared";
import { logger } from "./logger.js";
import { captureException } from "./sentry.js";

export type AutomationDispatchSweepOptions = {
  trigger?: string;
  batchSize?: number;
  deliveryBatchSize?: number;
  /** Per-call HTTP timeout. Defaults to 120s — a tick may make N webhook attempts. */
  timeoutMs?: number;
};

export type AutomationDispatchSweepResult = {
  ok: boolean;
  correlationId: string;
  claimed: number;
  succeeded: number;
  failed: number;
  retried: number;
  deadLettered: number;
  skipped: number;
  reclaimed: number;
  deliveriesProcessed: number;
  deliveriesReclaimed: number;
  durationMs: number;
  error?: string;
};

function apiBaseUrl(): string {
  const v =
    process.env.INTERNAL_API_BASE_URL?.trim() ||
    process.env.API_BASE_URL?.trim() ||
    "";
  return v.replace(/\/+$/, "");
}

function cronSecret(): string {
  return process.env.INTEGRATION_CRON_SECRET?.trim() || "";
}

function emptyResult(
  correlationId: string,
  durationMs: number,
  error?: string,
): AutomationDispatchSweepResult {
  return {
    ok: false,
    correlationId,
    claimed: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
    deadLettered: 0,
    skipped: 0,
    reclaimed: 0,
    deliveriesProcessed: 0,
    deliveriesReclaimed: 0,
    durationMs,
    error,
  };
}

/**
 * Invoke the API sweep endpoint once. Returns a structured result regardless
 * of success or failure — never throws.
 */
export async function runAutomationDispatchSweepTick(
  opts: AutomationDispatchSweepOptions = {},
): Promise<AutomationDispatchSweepResult> {
  const correlationId = newCorrelationId();
  const startedAt = Date.now();
  const base = apiBaseUrl();
  const secret = cronSecret();

  // FAIL CLOSED AND SAY SO. A missing base URL or secret means the sweep is
  // not running at all — the exact condition that made Automation inert for
  // its whole existence — so it is logged at WARN every tick rather than
  // silently returning zero.
  if (!base || !secret) {
    logger.warn(
      {
        correlationId,
        hasBaseUrl: Boolean(base),
        hasSecret: Boolean(secret),
      },
      "automation_dispatch_sweep.not_configured",
    );
    return emptyResult(correlationId, Date.now() - startedAt, "not_configured");
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.min(Math.max(opts.timeoutMs ?? 120_000, 1_000), 600_000),
  );
  try {
    const res = await fetch(`${base}/v1/automation/runs/process`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cron-secret": secret,
        "x-correlation-id": correlationId,
      },
      body: JSON.stringify({
        ...(opts.batchSize ? { batchSize: opts.batchSize } : {}),
        ...(opts.deliveryBatchSize
          ? { deliveryBatchSize: opts.deliveryBatchSize }
          : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const result = emptyResult(
        correlationId,
        Date.now() - startedAt,
        `http_${res.status}`,
      );
      logger.warn({ ...result, trigger: opts.trigger }, "automation_dispatch_sweep.failed");
      return result;
    }
    const json = (await res.json()) as {
      summary?: {
        runs?: Record<string, number>;
        deliveries?: Record<string, number>;
      };
    };
    const runs = json.summary?.runs ?? {};
    const deliveries = json.summary?.deliveries ?? {};
    const result: AutomationDispatchSweepResult = {
      ok: true,
      correlationId,
      claimed: runs.claimed ?? 0,
      succeeded: runs.succeeded ?? 0,
      failed: runs.failed ?? 0,
      retried: runs.retried ?? 0,
      deadLettered: (runs.deadLettered ?? 0) + (runs.reconciledDeadLettered ?? 0),
      skipped: runs.skipped ?? 0,
      reclaimed: runs.reclaimed ?? 0,
      deliveriesProcessed: deliveries.processed ?? 0,
      deliveriesReclaimed: deliveries.reclaimed ?? 0,
      durationMs: Date.now() - startedAt,
    };
    // Only log a tick that did something. A sweep that finds nothing is the
    // normal case and does not need a line every interval.
    if (
      result.claimed > 0 ||
      result.reclaimed > 0 ||
      result.deliveriesProcessed > 0 ||
      result.deliveriesReclaimed > 0
    ) {
      logger.info({ ...result, trigger: opts.trigger }, "automation_dispatch_sweep.completed");
    }
    return result;
  } catch (err) {
    captureException(err, { tags: { sweep: "automation_dispatch" } });
    const result = emptyResult(
      correlationId,
      Date.now() - startedAt,
      err instanceof Error ? err.name : "unknown_error",
    );
    logger.warn({ ...result, trigger: opts.trigger }, "automation_dispatch_sweep.error");
    return result;
  } finally {
    clearTimeout(timeout);
  }
}
