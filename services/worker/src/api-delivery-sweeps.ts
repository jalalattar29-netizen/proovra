/**
 * WORKFLOW-008 — the delivery sweeps nothing was running.
 *
 * Failed email and SMS sit in RETRY_SCHEDULED, digests and evidence-request
 * reminders wait for a run, and each of these is a cron-secret API route whose
 * comment said "called by an external scheduler". The repository defines no such
 * scheduler. A host crontab may exist, but that cannot be seen from here, so this
 * is the same worker-to-API pattern as the org-invite and lifecycle sweeps, under
 * the same cron lock:
 *
 *   - HTTP, never an in-process import of API modules.
 *   - Errors are logged and captured, never thrown. The next tick retries.
 *   - A missing base URL or secret is a warning on every tick: a delivery sweep
 *     that is not running must say so.
 *
 * Running alongside a host crontab is safe: email retries claim each row, a digest
 * is idempotent per bucket, and an SMS retry claims its row before it sends.
 */

import {
  INTEGRATION_CRON_HEADER,
  NOTIFICATION_CRON_HEADER,
  REVIEWER_OPS_CRON_HEADER,
  newCorrelationId,
} from "@proovra/shared";

import { logger } from "./logger.js";
import { reportSweepNotConfigured, resolveInternalApiBase } from "./internal-api.js";
import { captureException } from "./sentry.js";

export type ApiDeliverySweep = {
  /** Also the cron lock's name. */
  name: string;
  path: string;
  header: string;
  secretEnv: "NOTIFICATION_CRON_SECRET" | "INTEGRATION_CRON_SECRET" | "IDENTITY_RECONCILE_CRON_SECRET";
  /** Read when `secretEnv` is unset: the order the route itself reads them in. */
  secretFallbackEnv?: "INTEGRATION_CRON_SECRET";
  intervalMs: number;
};

const MINUTE = 60_000;

export const API_DELIVERY_SWEEPS: ReadonlyArray<ApiDeliverySweep> = [
  {
    name: "notification-retries",
    path: "/v1/notifications/process-retries",
    header: NOTIFICATION_CRON_HEADER,
    secretEnv: "NOTIFICATION_CRON_SECRET",
    intervalMs: MINUTE,
  },
  {
    name: "communication-retries",
    path: "/v1/communications/process-retries",
    header: INTEGRATION_CRON_HEADER,
    secretEnv: "INTEGRATION_CRON_SECRET",
    intervalMs: MINUTE,
  },
  {
    // The route's own NOTIFICATION_REMINDERS_ENABLED still decides whether a
    // reminder is sent.
    name: "notification-reminders",
    path: "/v1/notifications/run-reminders",
    header: NOTIFICATION_CRON_HEADER,
    secretEnv: "NOTIFICATION_CRON_SECRET",
    intervalMs: 15 * MINUTE,
  },
  {
    name: "notification-digests",
    path: "/v1/notifications/run-digests",
    header: NOTIFICATION_CRON_HEADER,
    secretEnv: "NOTIFICATION_CRON_SECRET",
    intervalMs: 15 * MINUTE,
  },
  // AUD-0003 — five more maintenance routes with no caller. A webhook retry due
  // in 30 s was still waiting 40 s later and went out only when the route was
  // called by hand. Each claims or bounds its own work, so a host crontab
  // running alongside is safe.
  {
    // Claims each RETRY_SCHEDULED delivery whose next attempt is due.
    name: "integration-webhook-retries",
    path: "/v1/integrations/process-webhook-retries",
    header: INTEGRATION_CRON_HEADER,
    secretEnv: "INTEGRATION_CRON_SECRET",
    intervalMs: MINUTE,
  },
  {
    // Deletes only terminal deliveries older than the retention window.
    name: "integration-webhook-delivery-cleanup",
    path: "/v1/integrations/webhooks/cleanup-deliveries",
    header: INTEGRATION_CRON_HEADER,
    secretEnv: "INTEGRATION_CRON_SECRET",
    intervalMs: 360 * MINUTE,
  },
  {
    // Clears rotated-out key and secret material once its grace window closed.
    name: "integration-secret-cleanup",
    path: "/v1/integrations/process-secret-cleanup",
    header: INTEGRATION_CRON_HEADER,
    secretEnv: "INTEGRATION_CRON_SECRET",
    intervalMs: 60 * MINUTE,
  },
  {
    // Flags records past their retention date for an operator; deletes nothing.
    name: "governance-retention-reconcile",
    path: "/v1/governance/reconcile-retention",
    header: INTEGRATION_CRON_HEADER,
    secretEnv: "INTEGRATION_CRON_SECRET",
    intervalMs: 60 * MINUTE,
  },
  {
    name: "review-sla-reconcile",
    path: "/v1/review-operations/reconcile-slas",
    header: INTEGRATION_CRON_HEADER,
    secretEnv: "INTEGRATION_CRON_SECRET",
    intervalMs: 15 * MINUTE,
  },
  {
    // WS-SCHED / PRO-W2C2-02 — the identity runtime sweeps (risk recompute,
    // quarantine release, stale-session detection, geo-cache and callback
    // retention) for every workspace, paged by a durable cursor on the API.
    // The route answers on the identity reconcile secret when the API sets
    // one and on INTEGRATION_CRON_SECRET otherwise; the legs that remove
    // access wait for the API's IDENTITY_RUNTIME_SCHEDULED_ENFORCEMENT.
    name: "identity-runtime-reconcile",
    path: "/v1/admin/identity/runtime/reconcile",
    header: REVIEWER_OPS_CRON_HEADER,
    secretEnv: "IDENTITY_RECONCILE_CRON_SECRET",
    secretFallbackEnv: "INTEGRATION_CRON_SECRET",
    intervalMs: 5 * MINUTE,
  },
];

export type ApiDeliverySweepResult = {
  ok: boolean;
  sweep: string;
  correlationId: string;
  durationMs: number;
  error?: string;
};

// PRO-W2-10 — the one resolver (with the bootstrap's default).
function apiBaseUrl(): string {
  return resolveInternalApiBase();
}

/** Calls one sweep route once. Reports its outcome and never throws. */
export async function runApiDeliverySweep(
  sweep: ApiDeliverySweep,
  opts: { trigger?: string; timeoutMs?: number } = {},
): Promise<ApiDeliverySweepResult> {
  const correlationId = newCorrelationId();
  const startedAt = Date.now();
  const finish = (ok: boolean, error?: string): ApiDeliverySweepResult => {
    const result = { ok, sweep: sweep.name, correlationId, durationMs: Date.now() - startedAt, ...(error ? { error } : {}) };
    if (!ok) logger.warn({ ...result, trigger: opts.trigger }, "api_delivery_sweep.failed");
    return result;
  };

  const base = apiBaseUrl();
  const secret =
    process.env[sweep.secretEnv]?.trim() ||
    (sweep.secretFallbackEnv ? process.env[sweep.secretFallbackEnv]?.trim() : "") ||
    "";
  if (!base || !secret) {
    logger.warn(
      { sweep: sweep.name, secretEnv: sweep.secretEnv, hasBaseUrl: Boolean(base), hasSecret: Boolean(secret) },
      "api_delivery_sweep.not_configured",
    );
    reportSweepNotConfigured({ sweep: sweep.name, missing: [sweep.secretEnv] });
    return { ok: false, sweep: sweep.name, correlationId, durationMs: Date.now() - startedAt, error: "not_configured" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000);
  try {
    const res = await fetch(`${base}${sweep.path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [sweep.header]: secret,
        "x-correlation-id": correlationId,
      },
      body: "{}",
      signal: controller.signal,
    });
    if (!res.ok) return finish(false, `http_${res.status}`);
    const result = finish(true);
    logger.debug({ ...result, trigger: opts.trigger }, "api_delivery_sweep.completed");
    return result;
  } catch (err) {
    captureException(err, { tags: { sweep: sweep.name } });
    return finish(false, err instanceof Error ? err.name : "unknown_error");
  } finally {
    clearTimeout(timeout);
  }
}
