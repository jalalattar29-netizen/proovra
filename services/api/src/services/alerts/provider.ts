/**
 * Phase 21 — AlertProvider interface.
 *
 * Single seam between PROOVRA and any out-of-band alerting channel
 * (PagerDuty webhook, ops Slack hook, ops email). Phase 21 ships:
 *
 *   - NoopAlertProvider — used when OPS_ALERT_WEBHOOK_URL +
 *     OPS_ALERT_EMAIL are both unset. Every dispatch is a no-op.
 *   - WebhookAlertProvider — POSTs the safe payload JSON to
 *     OPS_ALERT_WEBHOOK_URL with a short timeout. Fire-and-forget.
 *
 * Hard invariants:
 *   - Alerts are rate-limited per (category, fingerprint) — at most
 *     1 alert per ~5 minutes for a given fingerprint, max 60 alerts
 *     per process per hour. The throttle is in-memory (per-instance);
 *     multi-instance deployments accept some duplicate alerts in
 *     exchange for avoiding a Redis dependency in this layer.
 *   - Payloads are constructed by the incident service from the
 *     already-sanitised safeSummary. The provider DOES NOT re-sanitise
 *     — its only responsibility is dispatch.
 *   - Dispatch failures bump `alert_provider_failed` and surface
 *     nowhere else. They never throw to the caller.
 */

import type { AlertCategory } from "@proovra/shared";

export type AlertInput = {
  category: AlertCategory;
  severity: "INFO" | "WARNING" | "HIGH" | "CRITICAL";
  /** Operator-visible, already sanitised. Bounded to 400 chars. */
  safeSummary: string;
  /** Short title — bounded to 180 chars. */
  title: string;
  /** Fingerprint used for rate-limit dedup. Bounded to 200 chars. */
  fingerprint: string;
  /** Optional correlation hints (already sanitised). */
  requestId?: string | null;
  traceId?: string | null;
  /** Optional incident pointer for operator linkback. */
  incidentId?: string | null;
  runbookSlug?: string | null;
};

export type AlertDispatchResult =
  | { ok: true; provider: string }
  | { ok: false; provider: string; reason: string };

export interface AlertProvider {
  readonly name: "noop" | "webhook" | "email";
  /** True iff the provider has the env it needs. */
  isReady(): boolean;
  /** Fire-and-forget dispatch. Never throws. */
  dispatch(input: AlertInput): Promise<AlertDispatchResult>;
}
