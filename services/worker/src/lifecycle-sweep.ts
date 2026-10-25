/**
 * MEMBERS AUDIT LIFE-11 (2026-10-25) — the worker-side tick for the lifecycle
 * sweep.
 *
 * Account, organization and workspace closures used to run only inside the
 * notification digest run, behind an empty catch: no log, no metric, no
 * reaper, and nothing at all whenever digests did not run. The API now exposes
 * ONE lifecycle tick (`POST /v1/internal/lifecycle/run`, guarded by
 * `INTEGRATION_CRON_SECRET`) that executes due closures and resumes any an
 * interrupted run left in PROCESSING. This file only SCHEDULES it, over HTTP,
 * exactly like the automation dispatch sweep:
 *
 *   - HTTP, never an in-process import of the API's closure engines.
 *   - Errors are LOGGED and SENTRY-CAPTURED, never thrown; the next tick
 *     retries, and every claim and closure leg is idempotent.
 *   - A missing base URL or secret is logged at WARN every tick: a lifecycle
 *     sweep that is not running must say so.
 */

import { INTEGRATION_CRON_HEADER, newCorrelationId } from "@proovra/shared";
import { logger } from "./logger.js";
import { captureException } from "./sentry.js";

export type LifecycleSweepResult = {
  ok: boolean;
  correlationId: string;
  failures: number;
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

export async function runLifecycleSweepTick(
  opts: { trigger?: string; timeoutMs?: number } = {},
): Promise<LifecycleSweepResult> {
  const correlationId = newCorrelationId();
  const startedAt = Date.now();
  const base = apiBaseUrl();
  const secret = cronSecret();
  if (!base || !secret) {
    logger.warn(
      { correlationId, hasBaseUrl: Boolean(base), hasSecret: Boolean(secret) },
      "lifecycle_sweep.not_configured",
    );
    return { ok: false, correlationId, failures: 0, durationMs: Date.now() - startedAt, error: "not_configured" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.min(Math.max(opts.timeoutMs ?? 120_000, 1_000), 600_000),
  );
  try {
    const res = await fetch(`${base}/v1/internal/lifecycle/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [INTEGRATION_CRON_HEADER]: secret,
        "x-correlation-id": correlationId,
      },
      body: "{}",
      signal: controller.signal,
    });
    if (!res.ok) {
      const result = { ok: false, correlationId, failures: 0, durationMs: Date.now() - startedAt, error: `http_${res.status}` };
      logger.warn({ ...result, trigger: opts.trigger }, "lifecycle_sweep.failed");
      return result;
    }
    const json = (await res.json()) as { summary?: { failures?: number } };
    const result = {
      ok: true,
      correlationId,
      failures: json.summary?.failures ?? 0,
      durationMs: Date.now() - startedAt,
    };
    if (result.failures > 0) {
      logger.warn({ ...result, trigger: opts.trigger }, "lifecycle_sweep.processor_failures");
    }
    return result;
  } catch (err) {
    captureException(err, { tags: { sweep: "lifecycle" } });
    const result = {
      ok: false,
      correlationId,
      failures: 0,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.name : "unknown_error",
    };
    logger.warn({ ...result, trigger: opts.trigger }, "lifecycle_sweep.error");
    return result;
  } finally {
    clearTimeout(timeout);
  }
}
