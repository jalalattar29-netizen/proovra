/**
 * WS-SCHED / PRO-W2-10 — ONE resolver for the internal API base, and one
 * escalation when a worker-driven API sweep cannot run.
 *
 * Four sweep modules (api-delivery-sweeps, automation-dispatch,
 * lifecycle-sweep, org-invite-delivery) each had a private `apiBaseUrl()`
 * WITHOUT the default the worker bootstrap uses for the demo follow-up and the
 * readiness probe. A worker started without INTERNAL_API_BASE_URL therefore
 * probed the API successfully while every sweep answered `not_configured`, and
 * a missing cron secret was a warn line per tick: retries, reminders, digests,
 * automation runs, invite retries and closures stopped with no alert.
 *
 * This module imports only the logger, so the sweep modules (and their unit
 * tests) do not pull the queue or database in.
 */
import { randomUUID } from "node:crypto";

import { logger } from "./logger.js";

/** The compose-network address of the API; the bootstrap's default. */
export const INTERNAL_API_BASE_DEFAULT = "http://proovra-api:8080";

/** The internal API base, without a trailing slash. Never empty. */
export function resolveInternalApiBase(env: NodeJS.ProcessEnv = process.env): string {
  const v =
    env.INTERNAL_API_BASE_URL?.trim() ||
    env.API_BASE_URL?.trim() ||
    INTERNAL_API_BASE_DEFAULT;
  return v.replace(/\/+$/, "");
}

const alerted = new Set<string>();

/**
 * A sweep that cannot run for lack of configuration raises ONE operational
 * alert per sweep per process (the per-tick warn line stays with the caller).
 * Names the missing variable, never a value.
 */
export function reportSweepNotConfigured(input: {
  sweep: string;
  missing: readonly string[];
}): void {
  if (alerted.has(input.sweep)) return;
  alerted.add(input.sweep);
  logger.error(
    {
      alert: true,
      severity: "critical",
      requestId: randomUUID(),
      reason: "worker_api_sweep_not_configured",
      sweep: input.sweep,
      missing: [...input.missing],
    },
    "operational.alert",
  );
}

/** Test seam: forget which sweeps have alerted. */
export function resetSweepNotConfiguredAlerts(): void {
  alerted.clear();
}
