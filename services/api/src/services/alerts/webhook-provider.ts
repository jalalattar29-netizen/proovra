/**
 * Phase 21 — Webhook alert provider.
 *
 * POSTs the safe payload to OPS_ALERT_WEBHOOK_URL. The body is shaped for the
 * receiver the URL names (OPS closure 2, 2026-11-21):
 *
 *   discord   https://discord.com/api/webhooks/<id>/<token> (also discordapp.com
 *             and the canary/ptb hosts). Discord REFUSES a body without
 *             `content` or `embeds` (HTTP 400 "Cannot send an empty message"),
 *             so the generic envelope below never reached the production
 *             receiver, which is a Discord webhook. It gets a `content` text,
 *             with every mention disabled (`allowed_mentions.parse: []`), so a
 *             title can never ping @everyone.
 *   slack     https://hooks.slack.com/... gets `{ text }` (Slack refuses a
 *             body without it, too).
 *   generic   anything else: the stable JSON envelope
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
 *     "sentAtUtc": "ISO",
 *     "text": "<the same one-message text>"
 *   }
 *
 * OPS_ALERT_WEBHOOK_FORMAT (auto | discord | slack | generic, default auto)
 * overrides the detection, e.g. for a Discord-compatible relay on another host.
 *
 * `postWebhookAlert` is the ONE transport: the provider below and the delivery
 * proof (src/scripts/ops-alert-delivery-test.ts) both send through it, so the
 * proof exercises the exact formatter and request the watchdog uses.
 *
 * Hard invariants:
 *   - Outbound payload contains NO secrets (the provider sees only
 *     pre-sanitised fields from the alert service).
 *   - Outbound URL is read at construction time; bad URL → not ready.
 *   - The URL (which carries the receiver's token) is never logged or
 *     returned; results carry the HTTP status and a reason code only.
 *   - Short timeout (5s). Fails fast; never blocks the calling
 *     incident/security path.
 */

import type {
  AlertDispatchResult,
  AlertInput,
  AlertProvider,
} from "./provider.js";

const WEBHOOK_ENV = "OPS_ALERT_WEBHOOK_URL";
const FORMAT_ENV = "OPS_ALERT_WEBHOOK_FORMAT";
const TIMEOUT_MS = 5000;

export type WebhookFormat = "discord" | "slack" | "generic";

const DISCORD_HOSTS = new Set(["discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"]);

/** Which body the receiver at `url` accepts. Never throws. */
export function detectWebhookFormat(url: string, override?: string | null): WebhookFormat {
  const o = (override ?? "").trim().toLowerCase();
  if (o === "discord" || o === "slack" || o === "generic") return o;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (DISCORD_HOSTS.has(host) && u.pathname.startsWith("/api/webhooks/")) return "discord";
    if (host === "hooks.slack.com") return "slack";
  } catch {
    /* an unparsable URL is not ready anyway */
  }
  return "generic";
}

/** The one-message text every format carries. Bounded well under Discord's 2000. */
export function formatAlertText(input: AlertInput, sentAtUtc: string): string {
  const lines = [
    `**[${input.severity}] ${input.title}**`,
    input.safeSummary,
    `category ${input.category} · fingerprint ${input.fingerprint}` +
      (input.runbookSlug ? ` · runbook ${input.runbookSlug}` : "") +
      ` · ${sentAtUtc}`,
  ];
  return lines.join("\n").slice(0, 1900);
}

/** The request body for `format`. */
export function buildWebhookBody(input: AlertInput, format: WebhookFormat, sentAtUtc: string): Record<string, unknown> {
  const text = formatAlertText(input, sentAtUtc);
  if (format === "discord") {
    return { content: text, username: "PROOVRA ops", allowed_mentions: { parse: [] } };
  }
  if (format === "slack") {
    return { text };
  }
  return {
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
    sentAtUtc,
    text,
  };
}

export type WebhookPostResult = {
  ok: boolean;
  format: WebhookFormat;
  /** HTTP status, or null when no response arrived. */
  status: number | null;
  /** Discord with `wait`: the created message's id. */
  messageId: string | null;
  /** On failure: a closed reason code (never the URL or a response body). */
  reason: string | null;
};

/**
 * POST one alert to `url`. With `wait` and a Discord receiver, `?wait=true`
 * makes Discord answer 200 with the created message, whose id is returned.
 */
export async function postWebhookAlert(
  url: string,
  input: AlertInput,
  options: { format?: WebhookFormat; wait?: boolean; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<WebhookPostResult> {
  const format = options.format ?? detectWebhookFormat(url, process.env[FORMAT_ENV]);
  let target = url;
  if (options.wait && format === "discord") {
    const u = new URL(url);
    u.searchParams.set("wait", "true");
    target = u.toString();
  }
  const body = buildWebhookBody(input, format, new Date().toISOString());
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), options.timeoutMs ?? TIMEOUT_MS);
  try {
    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "proovra-ops-alerts/1",
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    };
    // A plain `fetch(target, …)` in production, so the call stays visible to the
    // capability analyzer (dynamic-resolutions.json names this line).
    const res = options.fetchImpl ? await options.fetchImpl(target, init) : await fetch(target, init);
    let messageId: string | null = null;
    if (res.ok && options.wait && format === "discord") {
      const parsed = (await res.json().catch(() => null)) as { id?: unknown } | null;
      messageId = parsed && typeof parsed.id === "string" ? parsed.id : null;
    } else {
      // Drain it to keep the connection friendly to keep-alive pools.
      await res.text().catch(() => null);
    }
    if (!res.ok) {
      return { ok: false, format, status: res.status, messageId: null, reason: `webhook_http_${res.status}` };
    }
    return { ok: true, format, status: res.status, messageId, reason: null };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      format,
      status: null,
      messageId: null,
      reason: aborted ? "webhook_timeout" : "webhook_transport_error",
    };
  } finally {
    clearTimeout(timer);
  }
}

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
    const result = await postWebhookAlert(this.url, input);
    return result.ok
      ? { ok: true, provider: "webhook" }
      : { ok: false, provider: "webhook", reason: result.reason ?? "webhook_failed" };
  }
}
