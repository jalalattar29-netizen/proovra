/**
 * Phase 21 — Webhook alert provider.
 *
 * POSTs the safe payload JSON to OPS_ALERT_WEBHOOK_URL. Designed for
 * a generic incoming-webhook receiver (PagerDuty Events API v2,
 * Slack-style incoming webhook, custom ops endpoint). The provider
 * is uninterested in the receiver's shape — it sends a stable JSON
 * envelope:
 *
 *   {
 *     "kind": "proovra.ops_alert",
 *     "version": 1,
 *     "category": "...",
 *     "severity": "...",
 *     "title": "...",
 *     "safeSummary": "...",
 *     "fingerprint": "...",
 *     "incidentId": null,
 *     "runbookSlug": null,
 *     "requestId": null,
 *     "traceId": null,
 *     "sentAtUtc": "ISO"
 *   }
 *
 * Hard invariants:
 *   - Outbound payload contains NO secrets (the provider sees only
 *     pre-sanitised fields from the alert service).
 *   - Outbound URL is read at construction time; bad URL → not ready.
 *   - Short timeout (5s). Fails fast; never blocks the calling
 *     incident/security path.
 */

import type {
  AlertDispatchResult,
  AlertInput,
  AlertProvider,
} from "./provider.js";

const WEBHOOK_ENV = "OPS_ALERT_WEBHOOK_URL";
const TIMEOUT_MS = 5000;

export class WebhookAlertProvider implements AlertProvider {
  readonly name = "webhook" as const;
  private readonly url: string | null;

  constructor() {
    const raw = (process.env[WEBHOOK_ENV] ?? "").trim();
    if (raw.length === 0) {
      this.url = null;
      return;
    }
    // Defensive: only allow http/https. Other schemes refused.
    if (!/^https?:\/\//i.test(raw)) {
      this.url = null;
      return;
    }
    this.url = raw;
  }

  isReady(): boolean {
    return this.url !== null;
  }

  async dispatch(input: AlertInput): Promise<AlertDispatchResult> {
    if (!this.url) {
      return { ok: false, provider: "webhook", reason: "webhook_unconfigured" };
    }
    const payload = {
      kind: "proovra.ops_alert",
      version: 1,
      category: input.category,
      severity: input.severity,
      title: input.title,
      safeSummary: input.safeSummary,
      fingerprint: input.fingerprint,
      incidentId: input.incidentId ?? null,
      runbookSlug: input.runbookSlug ?? null,
      requestId: input.requestId ?? null,
      traceId: input.traceId ?? null,
      sentAtUtc: new Date().toISOString(),
    };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "proovra-ops-alerts/1",
        },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
      if (!res.ok) {
        return {
          ok: false,
          provider: "webhook",
          reason: `webhook_http_${res.status}`,
        };
      }
      // We don't read the body. Drain it to keep the connection
      // friendly to keep-alive pools.
      await res.text().catch(() => null);
      return { ok: true, provider: "webhook" };
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      return {
        ok: false,
        provider: "webhook",
        reason: aborted ? "webhook_timeout" : "webhook_transport_error",
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
