/**
 * OPS closure 2 (2026-11-21), closure 3 (2026-11-22) — the external uptime
 * check (scripts/ops/uptime-probe.mjs, run by .github/workflows/uptime.yml
 * outside the production host). Driven here against a local fake HTTP server
 * standing in for the probed endpoints, the Actions API (the previous run, its
 * jobs and their check-run annotations) and the webhook receiver — the
 * isolated test receiver: nothing reaches production or Discord.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  checkWebhook,
  decideNotification,
  formatAttempt,
  runUptimeProbe,
  sanitizeSnippet,
  type UptimeProbe,
} from "../../../scripts/ops/uptime-probe.mjs";

const SECRET_HOOK_PATH = "/api/webhooks/42/uptime-token-SECRET";

type PrevRun = { id: number; conclusion: string; titles: string[] };
type WebReply = { status: number; headers?: Record<string, string>; body?: string };

let server: Server;
let base = "";
const fresh = () => ({
  health: { status: 200, body: JSON.stringify({ ok: true, db: "up", revision: "x" }) },
  readyz: 200,
  webSeq: [] as WebReply[],
  webDefault: { status: 200, body: "{}" } as WebReply,
  runsError: false,
  annotationsError: false,
  // The current run (1000) can already be listed; it must be skipped.
  prevRuns: [{ id: 998, conclusion: "success", titles: ["uptime-outcome: UP"] }] as PrevRun[],
  hookStatus: 204,
  hookGetStatus: 200,
  hookGets: 0,
  hooks: [] as Array<Record<string, unknown>>,
});
let state = fresh();

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const u = new URL(req.url ?? "/", "http://x");
      const json = (code: number, body: unknown) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (u.pathname === "/health") return res.writeHead(state.health.status, { "content-type": "application/json" }).end(state.health.body);
      if (u.pathname === "/readyz") return res.writeHead(state.readyz).end("{}");
      if (u.pathname === "/api/health") {
        const r = state.webSeq.shift() ?? state.webDefault;
        return res.writeHead(r.status, r.headers ?? {}).end(r.body ?? "");
      }
      if (u.pathname === "/__uptime_selftest_404") return res.writeHead(404, { server: "caddy" }).end("not found");
      if (u.pathname.startsWith("/repos/owner/repo/actions/workflows/uptime.yml/runs")) {
        if (state.runsError) return res.writeHead(500).end();
        return json(200, { workflow_runs: [{ id: 1000, conclusion: null }, ...state.prevRuns.map((r) => ({ id: r.id, conclusion: r.conclusion }))] });
      }
      let m = /^\/repos\/owner\/repo\/actions\/runs\/(\d+)\/jobs$/.exec(u.pathname);
      if (m) return json(200, { jobs: [{ id: Number(m[1]) * 10 }] });
      m = /^\/repos\/owner\/repo\/check-runs\/(\d+)\/annotations$/.exec(u.pathname);
      if (m) {
        if (state.annotationsError) return res.writeHead(403).end();
        const run = state.prevRuns.find((r) => r.id * 10 === Number(m![1]));
        return json(200, (run?.titles ?? []).map((title) => ({ title, annotation_level: "notice" })));
      }
      if (u.pathname === SECRET_HOOK_PATH && req.method === "GET") {
        state.hookGets += 1;
        // Discord answers a live webhook's GET with its object, token included: the probe must never print it.
        return res.writeHead(state.hookGetStatus, { "content-type": "application/json" }).end(JSON.stringify({ id: "42", token: "uptime-token-SECRET" }));
      }
      if (u.pathname === SECRET_HOOK_PATH) {
        state.hooks.push(JSON.parse(raw) as Record<string, unknown>);
        return res.writeHead(state.hookStatus).end();
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
afterEach(() => {
  state = fresh();
});

const probes = (): UptimeProbe[] => [
  { name: "api-health", url: `${base}/health`, expectJson: { ok: true, db: "up" } },
  { name: "api-readyz", url: `${base}/readyz` },
  { name: "web-health", url: `${base}/api/health` },
];

async function run(env: Record<string, string | undefined> = {}) {
  const lines: string[] = [];
  const summaryFile = join(mkdtempSync(join(tmpdir(), "uptime-")), "summary.md");
  const code = await runUptimeProbe({
    env: {
      OPS_ALERT_WEBHOOK_URL: `${base}${SECRET_HOOK_PATH}`,
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_TOKEN: "gh-token",
      GITHUB_RUN_ID: "1000",
      GITHUB_API_URL: base,
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_STEP_SUMMARY: summaryFile,
      UPTIME_ATTEMPTS: "2",
      UPTIME_RETRY_DELAY_MS: "1",
      UPTIME_TIMEOUT_MS: "2000",
      ...env,
    },
    log: (l) => lines.push(l),
    probes: probes(),
  });
  let summary = "";
  try {
    summary = readFileSync(summaryFile, "utf8");
  } catch {
    summary = "";
  }
  const out = lines.join("\n");
  return { code, out, summary, outcome: /^uptime-outcome: (\S+)$/m.exec(out)?.[1] };
}

const hookText = (i = 0) => String(state.hooks[i]!.text ?? state.hooks[i]!.content);

describe("uptime probe — transitions", () => {
  it("UP -> UP: exit 0, no message, outcome UP", async () => {
    const r = await run();
    expect(r.code, r.out).toBe(0);
    expect(r.outcome).toBe("UP");
    expect(r.out).toMatch(/PASS api-health/);
    expect(r.out).toMatch(/notification: none \(still up\)/);
    expect(r.out).toMatch(/^::notice title=uptime-outcome: UP::all probes passed$/m);
    expect(state.hooks).toEqual([]);
  });

  it("UP -> DOWN: ONE labelled DOWN message naming the probe; the job fails; outcome DOWN", async () => {
    state.readyz = 503;
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.outcome).toBe("DOWN");
    expect(r.out).toMatch(/FAIL api-readyz: HTTP 503 \(status 503, 2 attempt\(s\)\)/);
    expect(r.out).toMatch(/::error title=PROOVRA down::api-readyz: HTTP 503/);
    expect(state.hooks).toHaveLength(1);
    expect(hookText()).toMatch(/^\*\*\[PROOVRA UPTIME\] DOWN — 1 of 3 external probe\(s\) failing\*\*/);
    expect(hookText()).toContain("https://github.com/owner/repo/actions/runs/1000");
    expect(r.out).not.toContain("uptime-token-SECRET");
  });

  it("DOWN -> DOWN: silent, the job stays red", async () => {
    state.webDefault = { status: 502 };
    state.prevRuns = [{ id: 998, conclusion: "failure", titles: ["PROOVRA down", "uptime-outcome: DOWN"] }];
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.outcome).toBe("DOWN");
    expect(r.out).toMatch(/already reported down by an earlier run/);
    expect(state.hooks).toEqual([]);
  });

  it("DOWN -> UP: ONE RECOVERED message", async () => {
    state.prevRuns = [{ id: 998, conclusion: "failure", titles: ["PROOVRA down", "uptime-outcome: DOWN"] }];
    const r = await run();
    expect(r.code, r.out).toBe(0);
    expect(r.outcome).toBe("UP");
    expect(state.hooks).toHaveLength(1);
    expect(hookText()).toMatch(/^\*\*\[PROOVRA UPTIME\] RECOVERED — all 3 external probes pass again\*\*/);
  });

  it("CONFIG_MISSING -> UP: NO RECOVERED; one 'monitoring configured' message that says it is not a recovery", async () => {
    state.prevRuns = [{ id: 998, conclusion: "failure", titles: ["OPS_ALERT_WEBHOOK_URL missing", "uptime-outcome: CONFIG_MISSING"] }];
    const r = await run();
    expect(r.code, r.out).toBe(0);
    expect(r.outcome).toBe("UP");
    expect(state.hooks).toHaveLength(1);
    expect(hookText()).not.toMatch(/RECOVERED/);
    expect(hookText()).toMatch(/Monitoring configured — production up/);
    expect(hookText()).toMatch(/not an outage recovery/);
  });

  it("legacy runs (before outcomes): a config-only failure is CONFIG_MISSING, never a reason for RECOVERED", async () => {
    // Every scheduled run since 2026-11-21 18:54Z: the secret check returned before any down annotation.
    state.prevRuns = [{ id: 998, conclusion: "failure", titles: ["OPS_ALERT_WEBHOOK_URL missing"] }];
    const r = await run();
    expect(r.out).toMatch(/previous outcome: CONFIG_MISSING \(run 998 legacy annotation\)/);
    expect(hookText()).not.toMatch(/RECOVERED/);
    // A legacy real outage is DOWN.
    state.hooks = [];
    state.prevRuns = [{ id: 997, conclusion: "failure", titles: ["PROOVRA down"] }];
    const r2 = await run();
    expect(r2.out).toMatch(/previous outcome: DOWN/);
    expect(hookText()).toMatch(/RECOVERED/);
  });

  it("CONFIG_MISSING -> DOWN: DOWN is posted (nobody was told before)", async () => {
    state.prevRuns = [{ id: 998, conclusion: "failure", titles: ["uptime-outcome: CONFIG_MISSING"] }];
    state.readyz = 500;
    const r = await run();
    expect(r.outcome).toBe("DOWN");
    expect(state.hooks).toHaveLength(1);
    expect(hookText()).toMatch(/DOWN/);
  });

  it("unknown -> DOWN posts DOWN; unknown -> UP posts nothing", async () => {
    state.runsError = true;
    state.readyz = 500;
    expect((await run()).code).toBe(1);
    expect(state.hooks).toHaveLength(1);
    expect(hookText()).toMatch(/DOWN/);
    state.hooks = [];
    state.readyz = 200;
    const ok = await run();
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/previous outcome: UNKNOWN \(unreadable/);
    expect(state.hooks).toEqual([]);
    // Annotations unreadable (no checks:read) is unknown too.
    state.runsError = false;
    state.annotationsError = true;
    state.prevRuns = [{ id: 998, conclusion: "failure", titles: ["uptime-outcome: DOWN"] }];
    const r3 = await run();
    expect(r3.out).toMatch(/previous outcome: UNKNOWN/);
    expect(state.hooks).toEqual([]);
  });

  it("NOTIFY_FAILED -> UP posts nothing; NOTIFY_FAILED -> DOWN posts DOWN again", async () => {
    state.prevRuns = [{ id: 998, conclusion: "failure", titles: ["PROOVRA down", "Uptime notification failed", "uptime-outcome: NOTIFY_FAILED"] }];
    await run();
    expect(state.hooks).toEqual([]);
    state.readyz = 503;
    await run();
    expect(state.hooks).toHaveLength(1);
  });

  it("cancelled -> UP: nothing; a cancelled infra run is passed over, so DOWN, cancelled -> UP still recovers", async () => {
    state.prevRuns = [{ id: 999, conclusion: "cancelled", titles: [] }];
    const r = await run();
    expect(r.out).toMatch(/previous outcome: UNKNOWN \(only runs without an outcome \(999:cancelled\)\)/);
    expect(state.hooks).toEqual([]);

    state.prevRuns = [
      { id: 999, conclusion: "cancelled", titles: [] },
      { id: 998, conclusion: "failure", titles: ["uptime-outcome: DOWN"] },
    ];
    const r2 = await run();
    expect(r2.out).toMatch(/previous outcome: DOWN \(run 998 \(passed over 999:cancelled\) outcome annotation\)/);
    expect(hookText()).toMatch(/RECOVERED/);
  });

  it("a self-test run never feeds a transition", async () => {
    state.prevRuns = [
      { id: 999, conclusion: "success", titles: ["uptime-outcome: SELFTEST"] },
      { id: 998, conclusion: "success", titles: ["uptime-outcome: UP"] },
    ];
    const r = await run();
    expect(r.out).toMatch(/previous outcome: UP/);
  });
});

describe("uptime probe — configuration and failures", () => {
  it("without the secret: FAILS as CONFIG_MISSING even when up, with its own annotation title", async () => {
    const r = await run({ OPS_ALERT_WEBHOOK_URL: "" });
    expect(r.code).toBe(1);
    expect(r.outcome).toBe("CONFIG_MISSING");
    expect(r.out).toMatch(/::error title=OPS_ALERT_WEBHOOK_URL missing::The repository secret OPS_ALERT_WEBHOOK_URL is not set/);
    expect(r.out).not.toMatch(/title=PROOVRA down/);
    expect(r.summary).toMatch(/^uptime-outcome: CONFIG_MISSING$/m);
    expect(r.summary).toMatch(/\| web-health \| PASS \| #1 \| 200 \|/);
  });

  it("without the secret AND a probe failing: the DOWN annotation is still emitted", async () => {
    state.readyz = 503;
    const r = await run({ OPS_ALERT_WEBHOOK_URL: "" });
    expect(r.code).toBe(1);
    expect(r.outcome).toBe("CONFIG_MISSING");
    expect(r.out).toMatch(/::error title=PROOVRA down::api-readyz: HTTP 503/);
    expect(r.out).toMatch(/::error title=OPS_ALERT_WEBHOOK_URL missing::/);
    expect(r.summary).toMatch(/\| api-readyz \| FAIL \| #2 \| 503 \|/);
  });

  it("a webhook that refuses the message: NOTIFY_FAILED, the run fails", async () => {
    state.readyz = 503;
    state.hookStatus = 400;
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.outcome).toBe("NOTIFY_FAILED");
    expect(r.out).toMatch(/notification down FAILED \(status 400\)/);
    expect(r.out).toMatch(/::error title=Uptime notification failed::/);
  });

  it("a health body that is not ok/db up is a failure", async () => {
    state.health = { status: 200, body: JSON.stringify({ ok: false, db: "down" }) };
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL api-health: unexpected body \(ok, db\)/);
  });

  it("an unreachable endpoint (connection refused) is a failure after the retries", async () => {
    const lines: string[] = [];
    const code = await runUptimeProbe({
      env: { OPS_ALERT_WEBHOOK_URL: `${base}${SECRET_HOOK_PATH}`, UPTIME_ATTEMPTS: "2", UPTIME_RETRY_DELAY_MS: "1", UPTIME_TIMEOUT_MS: "1000" },
      log: (l) => lines.push(l),
      probes: [{ name: "dead", url: "http://127.0.0.1:1/health" }],
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/FAIL dead: connection failed \(status none, 2 attempt\(s\)\)/);
    expect(lines.join("\n")).toMatch(/^attempt dead #1: connection failed in \d+ ms$/m);
    expect(state.hooks).toHaveLength(1);
  });
});

describe("uptime probe — every attempt is evidence", () => {
  it("a challenged first attempt is logged with status, time, Cloudflare headers and a sanitized body; a retry pass stays visible", async () => {
    state.webSeq = [
      {
        status: 403,
        headers: { server: "cloudflare", "cf-mitigated": "challenge", "cf-ray": "8f00aa11bb22cc33-IAD" },
        body: "<!DOCTYPE html>\n<html lang=\"en-US\"><head><title>Just a moment...</title>::set-output name=x::%0A|pipe| and a very long tail that must be cut off here",
      },
    ];
    const r = await run();
    expect(r.code, r.out).toBe(0);
    const line = r.out.split("\n").find((l) => l.startsWith("attempt web-health #1:"))!;
    expect(line).toMatch(/^attempt web-health #1: HTTP 403 in \d+ ms server=cloudflare cf-mitigated=challenge cf-ray=8f00aa11bb22cc33-IAD body="<!DOCTYPE html> <html lang="en-US"><head><title>Just a moment\.\.\.<\/title>/);
    const body = /body="(.*)"$/.exec(line)![1]!;
    expect(body.length).toBeLessThanOrEqual(80);
    expect(body).not.toMatch(/::|\||%|\n/);
    expect(r.out).toMatch(/^attempt web-health #2: HTTP 200 in \d+ ms$/m);
    expect(r.out).toMatch(/PASS web-health: ok \(status 200, 2 attempt\(s\)\)/);
    // Job summary: one row per attempt.
    expect(r.summary).toMatch(/\| web-health \| {2}\| #1 \| 403 \| \d+ \| server=cloudflare cf-mitigated=challenge cf-ray=8f00aa11bb22cc33-IAD body="/);
    expect(r.summary).toMatch(/\| web-health \| PASS \| #2 \| 200 \| \d+ \| {2}\|/);
    expect(r.summary).toMatch(/A scheduled monitor run, not a push or an application change\./);
    expect(r.out + r.summary).not.toContain("uptime-token-SECRET");
  });

  it("formatAttempt prints headers only for non-200 attempts, and the timing for all", () => {
    expect(formatAttempt("w", { attempt: 1, status: 200, ms: 12, detail: "ok" })).toBe("attempt w #1: HTTP 200 in 12 ms");
    expect(formatAttempt("w", { attempt: 2, status: null, ms: 15000, detail: "timeout after 15000 ms" })).toBe("attempt w #2: timeout after 15000 ms in 15000 ms");
    expect(formatAttempt("w", { attempt: 3, status: 502, ms: 40, server: "Vercel", cfMitigated: null, cfRay: null, body: "x" })).toBe(
      'attempt w #3: HTTP 502 in 40 ms server=Vercel cf-mitigated=- cf-ray=- body="x"',
    );
    expect(sanitizeSnippet("a\r\nb::c|d%e`f", 80)).toBe("a b: c d e f");
  });

  it("decideNotification covers the transition table", () => {
    expect(decideNotification("CONFIG_MISSING", true)).toBe("configured");
    expect(decideNotification("UP", false)).toBe("down");
    expect(decideNotification("DOWN", false)).toBe(null);
    expect(decideNotification("DOWN", true)).toBe("recovered");
    expect(decideNotification("UNKNOWN", false)).toBe("down");
    expect(decideNotification("UNKNOWN", true)).toBe(null);
    expect(decideNotification("NOTIFY_FAILED", true)).toBe(null);
  });
});

describe("uptime probe — self-test receiver mode", () => {
  it("probes a deliberately failing URL and posts [TEST] DOWN and [TEST] RECOVERED to the configured receiver; outcome SELFTEST", async () => {
    state.prevRuns = [{ id: 998, conclusion: "failure", titles: ["uptime-outcome: DOWN"] }];
    const r = await run({ UPTIME_SELFTEST: "1", UPTIME_SELFTEST_URL: `${base}/__uptime_selftest_404` });
    expect(r.code, r.out).toBe(0);
    expect(r.outcome).toBe("SELFTEST");
    expect(r.out).toMatch(/^attempt selftest-404 #1: HTTP 404 in \d+ ms server=caddy/m);
    expect(state.hooks).toHaveLength(2);
    expect(hookText(0)).toMatch(/^\*\*\[TEST\] \[PROOVRA UPTIME\] DOWN — 1 of 1 external probe\(s\) failing\*\*/);
    expect(hookText(0)).toMatch(/Production was not affected/);
    expect(hookText(1)).toMatch(/^\*\*\[TEST\] \[PROOVRA UPTIME\] RECOVERED/);
    expect(r.out).not.toMatch(/previous outcome/);
    expect(r.out).toMatch(/^::notice title=uptime-outcome: SELFTEST::/m);
  });
});

describe("the workflow cannot block merges or other workflows", () => {
  const wf = readFileSync(resolve(__dirname, "..", "..", "..", ".github", "workflows", "uptime.yml"), "utf8");
  it("runs on a schedule and by hand only, in its own concurrency group, with read-only permissions", () => {
    const on = wf.slice(wf.indexOf("\non:"), wf.indexOf("\npermissions:"));
    expect(on).toMatch(/schedule:\n\s+- cron: "\*\/10 \* \* \* \*"/);
    expect(on).toMatch(/workflow_dispatch:/);
    expect(on).not.toMatch(/push|pull_request/);
    expect(wf).toMatch(/concurrency:\n\s+group: uptime-probe\n/);
    expect(wf).toMatch(/permissions:\n\s+contents: read\n\s+actions: read\n\s+checks: read\n/);
    expect(wf).not.toMatch(/: write/);
    expect(wf).toMatch(/OPS_ALERT_WEBHOOK_URL: \$\{\{ secrets\.OPS_ALERT_WEBHOOK_URL \}\}/);
    expect(wf).toMatch(/UPTIME_SELFTEST: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.selftest && '1' \|\| '0' \}\}/);
    expect(wf).toMatch(/run: node scripts\/ops\/uptime-probe\.mjs/);
    expect(wf).toMatch(/timeout-minutes: 5/);
  });
});

describe("uptime probe — the alert destination is checked every run (CONFIG_INVALID)", () => {
  it("a live Discord-shaped webhook is verified by GET each run, and the run is UP", async () => {
    const r = await run();
    expect(r.outcome).toBe("UP");
    expect(state.hookGets).toBe(1);
    expect(r.out).toMatch(/webhook check: ok \(webhook answered 200\)/);
    expect(r.out + r.summary).not.toContain("uptime-token-SECRET");
  });

  it("a revoked webhook (GET 404 / 401) is CONFIG_INVALID now, even while production is up; nothing is posted", async () => {
    for (const status of [404, 401]) {
      state.hookGetStatus = status;
      const r = await run();
      expect(r.code).toBe(1);
      expect(r.outcome).toBe("CONFIG_INVALID");
      expect(r.out).toMatch(new RegExp(`::error title=OPS_ALERT_WEBHOOK_URL invalid::.*rejected \\(HTTP ${status}\\): revoked`));
      expect(state.hooks).toEqual([]);
      expect(r.out + r.summary).not.toContain("uptime-token-SECRET");
    }
  });

  it("a revoked webhook during an outage: the DOWN annotation is still emitted, outcome CONFIG_INVALID", async () => {
    state.hookGetStatus = 404;
    state.readyz = 503;
    const r = await run();
    expect(r.outcome).toBe("CONFIG_INVALID");
    expect(r.out).toMatch(/::error title=PROOVRA down::api-readyz: HTTP 503/);
  });

  it("malformed values are CONFIG_INVALID and the value is never printed", async () => {
    for (const bad of ["not a url", "http://example.com/hook", "https://discord.com/channels/1/2", "https://user:pw@hooks.example.com/x"]) {
      const r = await run({ OPS_ALERT_WEBHOOK_URL: bad });
      expect(r.code, bad).toBe(1);
      expect(r.outcome, bad).toBe("CONFIG_INVALID");
      expect(r.out, bad).not.toContain(bad);
    }
    expect(state.hooks).toEqual([]);
  });

  it("an inconclusive check (5xx) warns but does not fail a healthy run", async () => {
    state.hookGetStatus = 503;
    const r = await run();
    expect(r.outcome).toBe("UP");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/::warning title=Uptime webhook check inconclusive::webhook check inconclusive \(HTTP 503\)/);
  });

  it("CONFIG_INVALID is never read as an outage: -> UP posts 'monitoring configured', never RECOVERED; -> DOWN posts DOWN", async () => {
    state.prevRuns = [{ id: 998, conclusion: "failure", titles: ["OPS_ALERT_WEBHOOK_URL invalid", "uptime-outcome: CONFIG_INVALID"] }];
    const r = await run();
    expect(r.out).toMatch(/previous outcome: CONFIG_INVALID/);
    expect(state.hooks).toHaveLength(1);
    expect(hookText()).not.toMatch(/RECOVERED/);
    expect(hookText()).toMatch(/Monitoring configured/);
    state.hooks = [];
    state.readyz = 500;
    await run();
    expect(hookText()).toMatch(/DOWN/);
    expect(decideNotification("CONFIG_INVALID", true)).toBe("configured");
    expect(decideNotification("CONFIG_INVALID", false)).toBe("down");
  });

  it("checkWebhook shapes: a non-Discord https webhook is shape-checked only (no GET)", async () => {
    let calls = 0;
    const f = (async () => {
      calls += 1;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await checkWebhook("https://hooks.slack.com/services/T/B/x", { fetchImpl: f })).toMatchObject({ state: "ok" });
    expect(calls).toBe(0);
    expect(await checkWebhook("", { fetchImpl: f })).toMatchObject({ state: "missing" });
    expect(await checkWebhook("https://discord.com/api/webhooks/1/tok", { fetchImpl: f })).toMatchObject({ state: "ok" });
    expect(calls).toBe(1);
  });
});
