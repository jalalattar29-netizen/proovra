/**
 * Macro-Wave A2 — worker-side Organization-invite delivery sweep tick.
 *
 * The api exposes `POST /v1/org-invite-deliveries/process` (protected by
 * `INTEGRATION_CRON_SECRET`). The endpoint claims due PENDING org-invite
 * delivery outbox rows atomically (lease via nextAttemptAtUtc push-forward)
 * and retries each one with TOKEN ROTATION: a fresh raw token is minted in
 * memory, the invite's tokenHash is swapped (killing the previously emailed
 * accept link), the email is sent through the canonical Resend wrapper, and
 * the outcome is persisted on the durable row. Raw tokens never appear in
 * any durable store, log line, or job payload — which is exactly why the
 * sweep must run API-side (the token/email authorities live there) and the
 * worker only SCHEDULES it.
 *
 * This is the same worker→API machine-auth pattern as
 * `reviewer-ops/reviewer-reconciliation.worker.ts`:
 *   - HTTP call, never an in-process import of api modules;
 *   - errors are LOGGED + SENTRY-CAPTURED, never thrown — a stuck sweep
 *     must not crash the worker (the next tick retries);
 *   - the endpoint is idempotent (state-precondition claims mean a
 *     duplicate/overlapping sweep sends ZERO duplicate emails).
 */

import { newCorrelationId } from "@proovra/shared";
import { logger } from "./logger.js";
import { captureException } from "./sentry.js";

export type OrgInviteDeliverySweepOptions = {
  trigger?: string;
  batchSize?: number;
  /** Per-call HTTP timeout. Defaults to 60s. */
  timeoutMs?: number;
};

export type OrgInviteDeliverySweepResult = {
  ok: boolean;
  correlationId: string;
  pickedUp: number;
  sent: number;
  retried: number;
  failed: number;
  cancelled: number;
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
): OrgInviteDeliverySweepResult {
  return {
    ok: false,
    correlationId,
    pickedUp: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    cancelled: 0,
    durationMs,
    error,
  };
}

/**
 * Invoke the api sweep endpoint once. Returns a structured result
 * regardless of success / failure — never throws. Sentry-captures
 * unexpected errors so the on-call sees them.
 */
export async function runOrgInviteDeliverySweep(
  options: OrgInviteDeliverySweepOptions = {},
): Promise<OrgInviteDeliverySweepResult> {
  const startedAt = Date.now();
  const correlationId = newCorrelationId();
  const trigger = options.trigger ?? "interval";
  const baseUrl = apiBaseUrl();
  const secret = cronSecret();

  if (!baseUrl) {
    const err = "INTERNAL_API_BASE_URL not configured";
    logger.error({ trigger, correlationId }, `org_invite_delivery.${err}`);
    return emptyResult(correlationId, 0, err);
  }
  if (!secret) {
    const err = "INTEGRATION_CRON_SECRET not configured";
    logger.error({ trigger, correlationId }, `org_invite_delivery.${err}`);
    return emptyResult(correlationId, 0, err);
  }

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 60_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/v1/org-invite-deliveries/process`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cron-secret": secret,
        "x-correlation-id": correlationId,
        "x-trigger": trigger,
      },
      body: JSON.stringify(
        options.batchSize ? { batchSize: options.batchSize } : {},
      ),
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
        "org_invite_delivery.sweep.http_error",
      );
      return emptyResult(
        correlationId,
        Date.now() - startedAt,
        `http_${response.status}`,
      );
    }

    const summary = (body?.summary ?? {}) as Record<string, unknown>;
    const num = (k: string): number =>
      typeof summary[k] === "number" ? (summary[k] as number) : 0;

    const result: OrgInviteDeliverySweepResult = {
      ok: true,
      correlationId,
      pickedUp: num("pickedUp"),
      sent: num("sent"),
      retried: num("retried"),
      failed: num("failed"),
      cancelled: num("cancelled"),
      durationMs: Date.now() - startedAt,
    };

    logger.info({ trigger, ...result }, "org_invite_delivery.sweep.completed");
    return result;
  } catch (err) {
    captureException(err, { trigger, correlationId });
    logger.error({ trigger, correlationId, err }, "org_invite_delivery.sweep.failed");
    return emptyResult(
      correlationId,
      Date.now() - startedAt,
      err instanceof Error ? err.message : "unknown_error",
    );
  } finally {
    clearTimeout(timer);
  }
}
