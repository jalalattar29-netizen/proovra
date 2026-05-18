/**
 * Worker-side reviewer-ops reconciliation tick.
 *
 * The api exposes `POST /v1/reviewer-ops/reconcile` (protected by
 * `REVIEWER_OPS_CRON_SECRET` / `INTEGRATION_CRON_SECRET`). The endpoint
 * orchestrates the entire reviewer-ops lifecycle for one team or all
 * teams in a sweep:
 *
 *   - SLA progression (DUE_SOON → BREACHED)
 *   - Escalation generation for newly-breached workflows
 *   - Workload snapshot per reviewer
 *   - Due-soon reminder fan-out
 *   - Inactivity reminder fan-out
 *
 * Before this worker existed, that endpoint had no scheduled caller in
 * the deployed system — so the lifecycle was effectively dormant.
 * Pages loaded but counters stayed at zero. This worker is the
 * "scheduler" for reviewer ops, calling the endpoint on a fixed
 * interval AND on a per-process startup probe.
 *
 * Hard rules:
 *   - The worker calls the api over HTTP, not in-process. This keeps
 *     the worker decoupled from the api's full module graph and lets
 *     the api control its own database access patterns.
 *   - Errors are LOGGED + SENTRY-CAPTURED, never thrown. A stuck
 *     reconcile must not crash the worker — the next tick retries.
 *   - The endpoint is idempotent + bounded (caps escalation creation
 *     per run, dedupes by fingerprint). Re-running is safe.
 */

import { newCorrelationId } from "@proovra/shared";
import { logger } from "../logger.js";
import { captureException } from "../sentry.js";

export type ReviewerReconciliationOptions = {
  trigger?: string;
  batchSize?: number;
  maxTeamsPerSweep?: number;
  /** Per-call HTTP timeout. Defaults to 60s. */
  timeoutMs?: number;
};

export type ReviewerReconciliationResult = {
  ok: boolean;
  correlationId: string;
  teams: number;
  failedTeams: number;
  totalEscalationsCreated: number;
  totalFlippedBreached: number;
  totalFlippedDueSoon: number;
  totalDueSoonReminders: number;
  totalInactivityReminders: number;
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
  return (
    process.env.REVIEWER_OPS_CRON_SECRET?.trim() ||
    process.env.INTEGRATION_CRON_SECRET?.trim() ||
    ""
  );
}

/**
 * Invoke the api reconcile endpoint in allTeams mode. Returns a
 * structured result regardless of success / failure — never throws.
 * Sentry-captures unexpected errors so the on-call sees them.
 */
export async function runReviewerReconciliation(
  options: ReviewerReconciliationOptions = {},
): Promise<ReviewerReconciliationResult> {
  const startedAt = Date.now();
  const correlationId = newCorrelationId();
  const trigger = options.trigger ?? "interval";
  const baseUrl = apiBaseUrl();
  const secret = cronSecret();

  if (!baseUrl) {
    const err = "INTERNAL_API_BASE_URL not configured";
    logger.error({ trigger, correlationId }, `reviewer_reconcile.${err}`);
    return {
      ok: false,
      correlationId,
      teams: 0,
      failedTeams: 0,
      totalEscalationsCreated: 0,
      totalFlippedBreached: 0,
      totalFlippedDueSoon: 0,
      totalDueSoonReminders: 0,
      totalInactivityReminders: 0,
      durationMs: 0,
      error: err,
    };
  }
  if (!secret) {
    const err = "REVIEWER_OPS_CRON_SECRET / INTEGRATION_CRON_SECRET not configured";
    logger.error({ trigger, correlationId }, `reviewer_reconcile.${err}`);
    return {
      ok: false,
      correlationId,
      teams: 0,
      failedTeams: 0,
      totalEscalationsCreated: 0,
      totalFlippedBreached: 0,
      totalFlippedDueSoon: 0,
      totalDueSoonReminders: 0,
      totalInactivityReminders: 0,
      durationMs: 0,
      error: err,
    };
  }

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 60_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/v1/reviewer-ops/reconcile`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cron-secret": secret,
        "x-correlation-id": correlationId,
        "x-trigger": trigger,
      },
      body: JSON.stringify({
        allTeams: true,
        batchSize: options.batchSize,
        maxTeamsPerSweep: options.maxTeamsPerSweep,
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    let body: Record<string, unknown> | null = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }

    if (!response.ok) {
      logger.error(
        {
          trigger,
          correlationId,
          status: response.status,
          body: body ?? text.slice(0, 400),
        },
        "reviewer_reconcile.http_error",
      );
      return {
        ok: false,
        correlationId,
        teams: 0,
        failedTeams: 0,
        totalEscalationsCreated: 0,
        totalFlippedBreached: 0,
        totalFlippedDueSoon: 0,
        totalDueSoonReminders: 0,
        totalInactivityReminders: 0,
        durationMs: Date.now() - startedAt,
        error: `http_${response.status}`,
      };
    }

    const payload = body ?? {};
    const result: ReviewerReconciliationResult = {
      ok: true,
      correlationId,
      teams: typeof payload.teams === "number" ? payload.teams : 0,
      failedTeams:
        typeof payload.failedTeams === "number" ? payload.failedTeams : 0,
      totalEscalationsCreated:
        typeof payload.totalEscalationsCreated === "number"
          ? payload.totalEscalationsCreated
          : 0,
      totalFlippedBreached:
        typeof payload.totalFlippedBreached === "number"
          ? payload.totalFlippedBreached
          : 0,
      totalFlippedDueSoon:
        typeof payload.totalFlippedDueSoon === "number"
          ? payload.totalFlippedDueSoon
          : 0,
      totalDueSoonReminders:
        typeof payload.totalDueSoonReminders === "number"
          ? payload.totalDueSoonReminders
          : 0,
      totalInactivityReminders:
        typeof payload.totalInactivityReminders === "number"
          ? payload.totalInactivityReminders
          : 0,
      durationMs: Date.now() - startedAt,
    };

    logger.info(
      {
        trigger,
        ...result,
      },
      "reviewer_reconcile.completed",
    );

    return result;
  } catch (err) {
    captureException(err, { trigger, correlationId });
    logger.error(
      {
        trigger,
        correlationId,
        err,
      },
      "reviewer_reconcile.failed",
    );
    return {
      ok: false,
      correlationId,
      teams: 0,
      failedTeams: 0,
      totalEscalationsCreated: 0,
      totalFlippedBreached: 0,
      totalFlippedDueSoon: 0,
      totalDueSoonReminders: 0,
      totalInactivityReminders: 0,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : "unknown_error",
    };
  } finally {
    clearTimeout(timer);
  }
}
