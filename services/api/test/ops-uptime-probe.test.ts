/**
 * OPS closure 2 (2026-11-21) — the external uptime check
 * (scripts/ops/uptime-probe.mjs, run by .github/workflows/uptime.yml outside
 * the production host). Driven here against local fake HTTP servers: the
 * probed endpoints, the Actions API (previous run) and the webhook.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { runUptimeProbe, type UptimeProbe } from "../../../scripts/ops/uptime-probe.mjs";

const SECRET_HOOK_PATH = "/api/webhooks/42/uptime-token-SECRET";

let server: Server;
let base = "";
const state = {
  health: { status: 200, body: JSON.stringify({ ok: true, db: "up", revision: "x" }) },
  readyz: 200,
  web: 200,
  previous: "success" as "success" | "failure" | "error",
  hookStatus: 204,
  hooks: [] as Array<Record<string, unknown>>,
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const u = new URL(req.url ?? "/", "http://x");
      if (u.pathname === "/health") return res.writeHead(state.health.status, { "content-type": "application/json" }).end(state.health.body);
      if (u.pathname === "/readyz") return res.writeHead(state.readyz).end("{}");
      if (u.pathname === "/api/health") return res.writeHead(state.web).end("{}");
      if (u.pathname.startsWith("/repos/owner/repo/actions/workflows/uptime.yml/runs")) {
        if (state.previous === "error") return res.writeHead(500).end();
        // The current run (1000) can already be listed; it must be skipped.
        return res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ workflow_runs: [{ id: 1000, conclusion: "failure" }, { id: 998, conclusion: state.previous }] }),
        );
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
  state.health = { status: 200, body: JSON.stringify({ ok: true, db: "up", revision: "x" }) };
  state.readyz = 200;
  state.web = 200;
  state.previous = "success";
  state.hookStatus = 204;
  state.hooks = [];
});

const probes = (): UptimeProbe[] => [
  { name: "api-health", url: `${base}/health`, expectJson: { ok: true, db: "up" } },
  { name: "api-readyz", url: `${base}/readyz` },
  { name: "web-health", url: `${base}/api/health` },
];

async function run(env: Record<string, string | undefined> = {}) {
  const lines: string[] = [];
  const code = await runUptimeProbe({
    env: {
      OPS_ALERT_WEBHOOK_URL: `${base}${SECRET_HOOK_PATH}`,
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_TOKEN: "gh-token",
      GITHUB_RUN_ID: "1000",
      GITHUB_API_URL: base,
      GITHUB_SERVER_URL: "https://github.com",
      UPTIME_ATTEMPTS: "2",
      UPTIME_RETRY_DELAY_MS: "1",
      UPTIME_TIMEOUT_MS: "2000",
      ...env,
    },
    log: (l) => lines.push(l),
    probes: probes(),
  });
  return { code, out: lines.join("\n") };
}

describe("uptime probe", () => {
  it("all up after an up run: exit 0, no message", async () => {
    const { code, out } = await run();
    expect(code, out).toBe(0);
    expect(out).toMatch(/PASS api-health/);
    expect(out).toMatch(/notification: none \(still up\)/);
    expect(state.hooks).toEqual([]);
  });

  it("the first failing run posts ONE labelled DOWN message naming the probe, and fails the job", async () => {
    state.readyz = 503;
    const { code, out } = await run();
    expect(code).toBe(1);
    expect(out).toMatch(/FAIL api-readyz: HTTP 503 \(status 503, 2 attempt\(s\)\)/);
    expect(out).toMatch(/::error title=PROOVRA down::api-readyz: HTTP 503/);
    expect(state.hooks).toHaveLength(1);
    expect(String(state.hooks[0]!.content ?? state.hooks[0]!.text)).toMatch(/^\*\*\[PROOVRA UPTIME\] DOWN — 1 of 3 external probe\(s\) failing\*\*/);
    expect(String(state.hooks[0]!.text)).toContain("https://github.com/owner/repo/actions/runs/1000");
    expect(out).not.toContain("uptime-token-SECRET");
  });

  it("a health body that is not ok/db up is a failure", async () => {
    state.health = { status: 200, body: JSON.stringify({ ok: false, db: "down" }) };
    const { code, out } = await run();
    expect(code).toBe(1);
    expect(out).toMatch(/FAIL api-health: unexpected body \(ok, db\)/);
  });

  it("a failure that persists is not re-posted, but the job stays red", async () => {
    state.web = 502;
    state.previous = "failure";
    const { code, out } = await run();
    expect(code).toBe(1);
    expect(out).toMatch(/already reported down by an earlier run/);
    expect(state.hooks).toEqual([]);
  });

  it("recovery after a failed run posts ONE RECOVERED message", async () => {
    state.previous = "failure";
    const { code, out } = await run();
    expect(code, out).toBe(0);
    expect(state.hooks).toHaveLength(1);
    expect(String(state.hooks[0]!.text)).toMatch(/^\*\*\[PROOVRA UPTIME\] RECOVERED — all 3 external probes pass again\*\*/);
  });

  it("an unreadable previous run is 'unknown': a failure is posted, a pass posts no false recovery", async () => {
    state.previous = "error";
    state.readyz = 500;
    expect((await run()).code).toBe(1);
    expect(state.hooks).toHaveLength(1);
    state.hooks = [];
    state.readyz = 200;
    const ok = await run();
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/previous run: unknown/);
    expect(state.hooks).toEqual([]);
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
    expect(state.hooks).toHaveLength(1);
  });

  it("without the OPS_ALERT_WEBHOOK_URL secret the run FAILS with an explicit error, even when everything is up", async () => {
    const { code, out } = await run({ OPS_ALERT_WEBHOOK_URL: "" });
    expect(code).toBe(1);
    expect(out).toMatch(/::error title=OPS_ALERT_WEBHOOK_URL missing::The repository secret OPS_ALERT_WEBHOOK_URL is not set/);
  });

  it("a webhook that refuses the message fails the run", async () => {
    state.readyz = 503;
    state.hookStatus = 400;
    const { code, out } = await run();
    expect(code).toBe(1);
    expect(out).toMatch(/notification down: FAILED \(status 400\)/);
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
    expect(wf).toMatch(/permissions:\n\s+contents: read\n\s+actions: read\n/);
    expect(wf).toMatch(/OPS_ALERT_WEBHOOK_URL: \$\{\{ secrets\.OPS_ALERT_WEBHOOK_URL \}\}/);
    expect(wf).toMatch(/run: node scripts\/ops\/uptime-probe\.mjs/);
    expect(wf).toMatch(/timeout-minutes: 5/);
  });
});
