/**
 * OPS closure 2 (2026-11-21) — the alert transport and its delivery proof.
 *
 * Production's OPS_ALERT_WEBHOOK_URL is a Discord webhook. Discord refuses a
 * body without `content` or `embeds` (400 "Cannot send an empty message"), and
 * the provider sent only its generic envelope: every watchdog alert would have
 * been refused. The provider now shapes the body for the receiver, and
 * src/scripts/ops-alert-delivery-test.ts proves delivery through that SAME
 * transport: synthetic alert + recovery, each created with ?wait=true and read
 * back with GET /webhooks/<id>/<token>/messages/<id>.
 *
 * The receiver here is a local fake Discord HTTP server (no network).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AlertInput } from "../src/services/alerts/provider.js";
import {
  WebhookAlertProvider,
  buildWebhookBody,
  detectWebhookFormat,
  postWebhookAlert,
} from "../src/services/alerts/webhook-provider.js";
import { discordMessageUrl, runAlertDeliveryTest } from "../src/scripts/ops-alert-delivery-test.js";

const TOKEN = "tok-SECRET-abcdef0123456789";
const HOOK_ID = "112233445566778899";

const sample: AlertInput = {
  category: "BACKUP_OFFHOST_COPY_MISSING",
  severity: "HIGH",
  title: "Off-host backup copy failed @everyone",
  safeSummary: "No successful off-host backup copy is recorded.",
  fingerprint: "backup-offhost-copy-missing",
  runbookSlug: "disaster-recovery",
};

describe("the webhook body follows the receiver", () => {
  it("detects Discord and Slack by host and path; everything else is generic; the override wins", () => {
    expect(detectWebhookFormat(`https://discord.com/api/webhooks/${HOOK_ID}/${TOKEN}`)).toBe("discord");
    expect(detectWebhookFormat(`https://discordapp.com/api/webhooks/${HOOK_ID}/${TOKEN}`)).toBe("discord");
    expect(detectWebhookFormat("https://discord.com/channels/1/2")).toBe("generic");
    expect(detectWebhookFormat("https://hooks.slack.com/services/T/B/x")).toBe("slack");
    expect(detectWebhookFormat("https://events.pagerduty.com/x")).toBe("generic");
    expect(detectWebhookFormat("https://relay.example/x", "discord")).toBe("discord");
    expect(detectWebhookFormat("not a url")).toBe("generic");
  });

  it("Discord gets content (with every mention disabled); Slack gets text; generic keeps its envelope plus text", () => {
    const d = buildWebhookBody(sample, "discord", "2026-11-21T16:00:00.000Z");
    expect(d).toEqual({
      content: expect.stringContaining("**[HIGH] Off-host backup copy failed @everyone**"),
      username: "PROOVRA ops",
      allowed_mentions: { parse: [] },
    });
    expect(String(d.content)).toContain("category BACKUP_OFFHOST_COPY_MISSING · fingerprint backup-offhost-copy-missing");
    expect(String(d.content).length).toBeLessThanOrEqual(2000);
    expect(buildWebhookBody(sample, "slack", "t")).toEqual({ text: expect.stringContaining("No successful off-host") });
    expect(buildWebhookBody(sample, "generic", "t")).toMatchObject({ kind: "proovra.ops_alert", version: 1, category: sample.category, text: expect.any(String) });
  });

  it("the provider's own dispatch to a Discord URL sends a body Discord accepts (content), not the bare envelope", async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubEnv("OPS_ALERT_WEBHOOK_URL", `https://discord.com/api/webhooks/${HOOK_ID}/${TOKEN}`);
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      seen.push({ url, body });
      // What Discord answers a body without content/embeds.
      if (typeof body.content !== "string" || body.content.length === 0) {
        return new Response(JSON.stringify({ message: "Cannot send an empty message", code: 50006 }), { status: 400 });
      }
      return new Response(null, { status: 204 });
    });
    try {
      const result = await new WebhookAlertProvider().dispatch(sample);
      expect(result).toEqual({ ok: true, provider: "webhook" });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.body.content).toEqual(expect.stringContaining("Off-host backup copy failed"));
      expect(seen[0]!.url).not.toContain("wait=");
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("a refusal is reported with its status only, never the URL", async () => {
    const r = await postWebhookAlert(`https://discord.com/api/webhooks/${HOOK_ID}/${TOKEN}`, sample, {
      fetchImpl: (async () => new Response("nope", { status: 401 })) as typeof fetch,
    });
    expect(r).toEqual({ ok: false, format: "discord", status: 401, messageId: null, reason: "webhook_http_401" });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("the message URL keeps thread_id and drops wait", () => {
    expect(discordMessageUrl(`https://discord.com/api/webhooks/${HOOK_ID}/${TOKEN}?wait=true&thread_id=9`, "77")).toBe(
      `https://discord.com/api/webhooks/${HOOK_ID}/${TOKEN}/messages/77?thread_id=9`,
    );
    expect(discordMessageUrl("https://discord.com/elsewhere", "77")).toBeNull();
  });
});

/** A fake Discord webhook endpoint. */
type Mode = { honourWait: boolean; getStatus: number; tamperContent: boolean; postStatus: number };
let mode: Mode = { honourWait: true, getStatus: 200, tamperContent: false, postStatus: 200 };
const messages = new Map<string, { content: string }>();
const requests: Array<{ method: string; path: string; query: string; body: Record<string, unknown> | null }> = [];
let server: Server;
let base = "";

function handle(req: IncomingMessage, res: ServerResponse) {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const u = new URL(req.url ?? "/", "http://x");
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    requests.push({ method: req.method ?? "", path: u.pathname, query: u.search, body });
    const hook = `/api/webhooks/${HOOK_ID}/${TOKEN}`;
    if (req.method === "POST" && u.pathname === hook) {
      if (mode.postStatus !== 200) return res.writeHead(mode.postStatus).end();
      if (typeof body?.content !== "string" || !body.content) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ message: "Cannot send an empty message", code: 50006 }));
      }
      const id = String(1_000_000 + messages.size);
      messages.set(id, { content: body.content });
      if (u.searchParams.get("wait") === "true" && mode.honourWait) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ id, content: body.content, channel_id: "c" }));
      }
      return res.writeHead(204).end();
    }
    const m = new RegExp(`^${hook}/messages/(\\d+)$`).exec(u.pathname);
    if (req.method === "GET" && m) {
      const msg = messages.get(m[1]!);
      if (!msg || mode.getStatus !== 200) {
        res.writeHead(mode.getStatus === 200 ? 404 : mode.getStatus, { "content-type": "application/json" });
        return res.end(JSON.stringify({ message: "Unknown Message", code: 10008 }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id: m[1], content: mode.tamperContent ? "something else" : msg.content }));
    }
    res.writeHead(404).end();
  });
}

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
afterEach(() => {
  mode = { honourWait: true, getStatus: 200, tamperContent: false, postStatus: 200 };
  messages.clear();
  requests.length = 0;
});

async function run(env: NodeJS.ProcessEnv) {
  const lines: string[] = [];
  const code = await runAlertDeliveryTest({ env, log: (l) => lines.push(l), runId: "r7f3a9c1" });
  return { code, out: lines.join("\n") };
}

const discordEnv = () => ({ OPS_ALERT_WEBHOOK_URL: `${base}/api/webhooks/${HOOK_ID}/${TOKEN}`, OPS_ALERT_WEBHOOK_FORMAT: "discord" });

describe("ops-alert-delivery-test against a fake Discord receiver", () => {
  it("sends a labelled synthetic alert and its recovery with wait=true, reads both back, and prints no URL or token", async () => {
    const { code, out } = await run(discordEnv());
    expect(code, out).toBe(0);
    expect(out).toContain("receiver host=127.0.0.1 format=discord run=r7f3a9c1");
    expect(out).toMatch(/alert POST status=200 messageId=1000000/);
    expect(out).toMatch(/alert GET message status=200 id-match=yes/);
    expect(out).toMatch(/recovery POST status=200 messageId=1000001/);
    expect(out).toMatch(/recovery GET message status=200 id-match=yes/);
    expect(out).toMatch(/PASS/);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(HOOK_ID);
    expect(out).not.toContain(base);

    const posts = requests.filter((r) => r.method === "POST");
    expect(posts.map((p) => p.query)).toEqual(["?wait=true", "?wait=true"]);
    const [alert, recovery] = posts.map((p) => String(p.body!.content));
    expect(alert).toMatch(/^\*\*\[WARNING\] \[PROOVRA SYNTHETIC TEST\] Alert delivery check r7f3a9c1 — no action needed\*\*/);
    expect(alert).toContain("No action needed");
    expect(recovery).toMatch(/^\*\*\[INFO\] \[PROOVRA SYNTHETIC TEST\] Resolved: Alert delivery check r7f3a9c1/);
    // The same body builder the watchdog's provider uses.
    expect(posts[0]!.body).toMatchObject({ username: "PROOVRA ops", allowed_mentions: { parse: [] } });
    expect(requests.filter((r) => r.method === "GET").map((r) => r.path)).toEqual([
      `/api/webhooks/${HOOK_ID}/${TOKEN}/messages/1000000`,
      `/api/webhooks/${HOOK_ID}/${TOKEN}/messages/1000001`,
    ]);
  });

  it("a receiver that accepts but returns no message id (wait not honoured) fails", async () => {
    mode.honourWait = false;
    const { code, out } = await run(discordEnv());
    expect(code).toBe(1);
    expect(out).toMatch(/returned no message id/);
  });

  it("a message that cannot be read back fails, naming the status", async () => {
    mode.getStatus = 404;
    const { code, out } = await run(discordEnv());
    expect(code).toBe(1);
    expect(out).toMatch(/alert GET message status=404 reason=http_404/);
    expect(out).not.toMatch(/recovery POST/);
  });

  it("a read-back whose content is not this run's message fails", async () => {
    mode.tamperContent = true;
    const { code, out } = await run(discordEnv());
    expect(code).toBe(1);
    expect(out).toMatch(/reason=message_content_mismatch/);
  });

  it("a refused POST fails with its status", async () => {
    mode.postStatus = 403;
    const { code, out } = await run(discordEnv());
    expect(code).toBe(1);
    expect(out).toMatch(/alert POST status=403 reason=webhook_http_403/);
    expect(out).not.toContain(TOKEN);
  });

  it("unset or non-http configuration fails without printing the value", async () => {
    expect((await run({})).code).toBe(1);
    const bad = await run({ OPS_ALERT_WEBHOOK_URL: `ftp://x/${TOKEN}` });
    expect(bad.code).toBe(1);
    expect(bad.out).not.toContain(TOKEN);
  });

  it("a non-Discord receiver: delivered (2xx) but not verifiable, exit 2", async () => {
    const generic = createServer((req, res) => {
      req.resume();
      req.on("end", () => res.writeHead(202).end());
    });
    await new Promise<void>((r) => generic.listen(0, "127.0.0.1", () => r()));
    try {
      const port = (generic.address() as AddressInfo).port;
      const { code, out } = await run({ OPS_ALERT_WEBHOOK_URL: `http://127.0.0.1:${port}/hook/${TOKEN}` });
      expect(code).toBe(2);
      expect(out).toMatch(/format=generic/);
      expect(out).toMatch(/alert POST status=202/);
      expect(out).toMatch(/recovery POST status=202/);
      expect(out).toMatch(/DELIVERED — both messages were accepted/);
      expect(out).not.toContain(TOKEN);
    } finally {
      await new Promise<void>((r) => generic.close(() => r()));
    }
  });
});
