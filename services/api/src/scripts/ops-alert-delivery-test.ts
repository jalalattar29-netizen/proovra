/**
 * OPERATOR COMMAND — prove that an ops alert reaches the configured receiver.
 *
 *   docker compose --env-file /opt/proovra/app/.env -f infra/docker/docker-compose.prod.yml \
 *     exec -T proovra-api node dist/scripts/ops-alert-delivery-test.js
 *
 * OPS closure 2 (2026-11-21). The outage watchdog sends through
 * `postWebhookAlert` (src/services/alerts/webhook-provider.ts). This sends
 * through that SAME function, with the same body builder, to the same
 * OPS_ALERT_WEBHOOK_URL the API process already has:
 *
 *   1. a SYNTHETIC alert, labelled "[PROOVRA SYNTHETIC TEST] … no action needed";
 *   2. for a Discord receiver, with `?wait=true`, so Discord answers with the
 *      created message, then GETs /webhooks/<id>/<token>/messages/<messageId>
 *      and requires 200 and the same id: the message exists in the channel;
 *   3. the matching labelled RECOVERY message, verified the same way.
 *
 * It prints the receiver's HOST, the message ids and the HTTP statuses only:
 * never the URL, the webhook id or its token, and never a response body.
 *
 * Exit: 0 both messages delivered and (Discord) verified; 2 delivered, but the
 * receiver is not Discord, so existence cannot be read back; 1 failed or not
 * configured. Writes nothing anywhere except the two messages.
 */
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

import type { AlertInput } from "../services/alerts/provider.js";
import { detectWebhookFormat, postWebhookAlert, type WebhookFormat } from "../services/alerts/webhook-provider.js";

type Log = (line: string) => void;

export const SYNTHETIC_LABEL = "[PROOVRA SYNTHETIC TEST]";

/** The Discord message URL for a webhook URL, keeping thread_id; null when not a webhook path. */
export function discordMessageUrl(webhookUrl: string, messageId: string): string | null {
  const u = new URL(webhookUrl);
  const m = /^\/api\/webhooks\/([^/]+)\/([^/]+)\/?$/.exec(u.pathname);
  if (!m) return null;
  u.pathname = `/api/webhooks/${m[1]}/${m[2]}/messages/${encodeURIComponent(messageId)}`;
  u.searchParams.delete("wait");
  return u.toString();
}

async function verifyDiscordMessage(
  webhookUrl: string,
  messageId: string,
  runId: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; status: number | null; reason: string | null }> {
  const target = discordMessageUrl(webhookUrl, messageId);
  if (!target) return { ok: false, status: null, reason: "not_a_discord_webhook_path" };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    const res = await fetchImpl(target, { method: "GET", headers: { "User-Agent": "proovra-ops-alerts/1" }, signal: ac.signal });
    const body = (await res.json().catch(() => null)) as { id?: unknown; content?: unknown } | null;
    if (res.status !== 200) return { ok: false, status: res.status, reason: `http_${res.status}` };
    if (!body || body.id !== messageId) return { ok: false, status: res.status, reason: "message_id_mismatch" };
    if (typeof body.content !== "string" || !body.content.includes(runId)) {
      return { ok: false, status: res.status, reason: "message_content_mismatch" };
    }
    return { ok: true, status: res.status, reason: null };
  } catch (err) {
    return { ok: false, status: null, reason: err instanceof Error && err.name === "AbortError" ? "timeout" : "transport_error" };
  } finally {
    clearTimeout(timer);
  }
}

export async function runAlertDeliveryTest(
  input: { env?: NodeJS.ProcessEnv; log?: Log; fetchImpl?: typeof fetch; runId?: string } = {},
): Promise<number> {
  const env = input.env ?? process.env;
  // eslint-disable-next-line no-console
  const log: Log = input.log ?? ((l) => console.log(l));
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = (env.OPS_ALERT_WEBHOOK_URL ?? "").trim();
  if (!url) {
    log("alert-delivery-test: FAILED — OPS_ALERT_WEBHOOK_URL is not set in this process");
    return 1;
  }
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("scheme");
    host = u.hostname;
  } catch {
    log("alert-delivery-test: FAILED — OPS_ALERT_WEBHOOK_URL is not an http(s) URL (the value is not printed)");
    return 1;
  }
  const format: WebhookFormat = detectWebhookFormat(url, env.OPS_ALERT_WEBHOOK_FORMAT);
  const runId = input.runId ?? randomBytes(4).toString("hex");
  log(`alert-delivery-test: receiver host=${host} format=${format} run=${runId}`);

  const alert: AlertInput = {
    category: "OPS_ALERT_DELIVERY_TEST",
    severity: "WARNING",
    title: `${SYNTHETIC_LABEL} Alert delivery check ${runId} — no action needed`,
    safeSummary:
      `${SYNTHETIC_LABEL} A synthetic alert sent by ops-alert-delivery-test through the watchdog's own webhook ` +
      `formatter and transport. Nothing is wrong. No action needed. Run ${runId}.`,
    fingerprint: `ops-alert-delivery-test:${runId}`,
    runbookSlug: "disaster-recovery",
  };
  const recovery: AlertInput = {
    ...alert,
    severity: "INFO",
    title: `${SYNTHETIC_LABEL} Resolved: Alert delivery check ${runId} — no action needed`,
    safeSummary: `${SYNTHETIC_LABEL} The synthetic alert of run ${runId} is resolved. Nothing is wrong. No action needed.`,
    fingerprint: `ops-alert-delivery-test:${runId}:resolved`,
  };

  let verifiedAll = true;
  for (const [label, message] of [["alert", alert], ["recovery", recovery]] as const) {
    const sent = await postWebhookAlert(url, message, { format, wait: true, fetchImpl });
    log(
      `alert-delivery-test: ${label} POST status=${sent.status ?? "none"}` +
        (sent.messageId ? ` messageId=${sent.messageId}` : "") +
        (sent.ok ? "" : ` reason=${sent.reason}`),
    );
    if (!sent.ok) {
      log(`alert-delivery-test: FAILED — the ${label} was not accepted by the receiver`);
      return 1;
    }
    if (format !== "discord") {
      verifiedAll = false;
      continue;
    }
    if (!sent.messageId) {
      log(`alert-delivery-test: FAILED — the receiver accepted the ${label} but returned no message id (wait=true not honoured)`);
      return 1;
    }
    const check = await verifyDiscordMessage(url, sent.messageId, runId, fetchImpl);
    log(
      `alert-delivery-test: ${label} GET message status=${check.status ?? "none"} ` +
        (check.ok ? `id-match=yes` : `reason=${check.reason}`),
    );
    if (!check.ok) {
      log(`alert-delivery-test: FAILED — the ${label} message could not be read back from the channel`);
      return 1;
    }
  }
  if (!verifiedAll) {
    log("alert-delivery-test: DELIVERED — both messages were accepted (2xx); this receiver is not Discord, so their existence was not read back");
    return 2;
  }
  log("alert-delivery-test: PASS — alert and recovery were delivered and read back from the channel");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAlertDeliveryTest().then(
    (code) => process.exit(code),
    (err: unknown) => {
      // The error NAME only: a message could carry the URL.
      // eslint-disable-next-line no-console
      console.error(`alert-delivery-test: FAILED — ${err instanceof Error ? err.name : "unknown error"}`);
      process.exit(1);
    },
  );
}
