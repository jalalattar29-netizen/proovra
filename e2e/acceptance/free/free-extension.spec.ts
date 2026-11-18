/**
 * FREE ACCEPTANCE — the PROOVRA browser extension, as a new Free user.
 *
 * Real Google Chrome (channel "chrome") with the unpacked extension loaded over
 * CDP (branded Chrome ignores --load-extension). The extension is the E2E TEST
 * build (apps/extension/e2e/free/build-free.mjs: <all_urls> + the fixed public
 * key, because automation cannot click the toolbar to grant activeTab),
 * pointed at the isolated `fa` stack.
 *
 * Every journey step records PASS / FAIL / UNAVAILABLE / FIXTURE into
 * .p7tmp/free-extension/results.json and keeps going, so one failure does not
 * hide the rest.
 *
 *   $env:API_BASE='http://localhost:8691'; $env:WEB_BASE='http://localhost:3711'
 *   $env:ACCEPT_STATE_NAME='free-extension'
 *   npx playwright test --config e2e/acceptance/playwright.config.ts free/free-extension.spec.ts --reporter=list --output=.p7tmp/free-extension/pw
 */
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { assertIsolatedStack } from "../../helpers/stack-isolation";
import { answerCookieBanner } from "../../helpers/consent";
import { PASSWORD, registerAccount, type Person } from "../lib/journey";

// The extension service worker's global, used inside sw.evaluate() callbacks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const chrome: any;

const ROOT = resolve(__dirname, "..", "..", "..");
const API = process.env.API_BASE ?? "";
const WEB = process.env.WEB_BASE ?? "";
const EXT = process.env.FREE_EXT_DIST ?? resolve(ROOT, ".p7tmp", "ext-free-e2e");
const EXT_ID = "cifdmjicbglkaoiagjhikkglbnhibdkd";
const OUT = resolve(ROOT, ".p7tmp", "free-extension");
const SHOTS = resolve(OUT, "shots");
const PG = "acc-fa-postgres";
const PG_DB = "proovra_acceptance_fixture";

type Label = "PASS" | "FAIL" | "UNAVAILABLE" | "FIXTURE" | "INFO";
const results: Array<{ id: string; label: Label; detail: string }> = [];
function record(id: string, label: Label, detail: string): void {
  results.push({ id, label, detail });
  // eslint-disable-next-line no-console
  console.log(`[${label}] ${id} :: ${detail}`);
  writeFileSync(resolve(OUT, "results.json"), JSON.stringify(results, null, 2));
}
async function step(id: string, fn: () => Promise<string | void>): Promise<boolean> {
  try {
    const d = await fn();
    record(id, "PASS", d || "ok");
    return true;
  } catch (e) {
    record(id, "FAIL", (e as Error).message.split("\n").slice(0, 6).join(" | "));
    return false;
  }
}
async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({ path: resolve(SHOTS, `${name}.png`) }).catch(() => undefined);
}

function psql(sql: string): string {
  const r = spawnSync("docker", ["exec", PG, "psql", "-U", "pv", "-d", PG_DB, "-AtF", "|", "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr}`);
  return r.stdout.trim();
}

function dbSnapshot(userId: string): Record<string, string> {
  return {
    evidence: psql(`select count(*) from evidence where owner_user_id='${userId}'`),
    evidenceByStatus: psql(`select coalesce(string_agg(status::text||':'||n::text, ','), '') from (select status, count(*) n from evidence where owner_user_id='${userId}' group by status) s`),
    liveEvidence: psql(`select count(*) from evidence where owner_user_id='${userId}' and deleted_at is null and deleted_at_utc is null`),
    captureSessions: psql(`select coalesce(string_agg(status::text||':'||n::text, ','), '') from (select status, count(*) n from capture_sessions where owner_user_id='${userId}' group by status) s`),
    openCaptureSessions: psql(`select count(*) from capture_sessions where owner_user_id='${userId}' and finalized_evidence_id is null and discarded_at_utc is null`),
    entitlementUsage: psql(`select coalesce(string_agg(key::text||'='||consumed::text, ','), '') from entitlement_usage where team_id in (select team_id from capture_sessions where owner_user_id='${userId}')`),
  };
}

/** A capture target whose bytes differ per capture, so each is new evidence. */
function startFixtureServer(): Promise<{ server: Server; origin: string }> {
  return new Promise((ok) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      const n = u.searchParams.get("n") ?? "0";
      const hue = (Number(n) * 77) % 360;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Free extension page ${n}</title>
<style>body{font-family:system-ui;margin:0;padding:24px}.hero{height:360px;background:hsl(${hue} 60% 30%);color:#fff;padding:40px;border-radius:12px}</style></head>
<body><div class="hero"><h1>Free extension acceptance page ${n}</h1><p>marker ${Date.now()}-${n}</p></div><p>Ordinary content.</p></body></html>`,
      );
    });
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      ok({ server, origin: `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}` });
    });
  });
}

async function launch(): Promise<{ context: BrowserContext; sw: Worker; dir: string; version: string }> {
  const dir = mkdtempSync(resolve(tmpdir(), "fex-chrome-"));
  const context = await chromium.launchPersistentContext(dir, {
    channel: "chrome",
    headless: false,
    baseURL: WEB,
    viewport: { width: 1280, height: 860 },
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--enable-unsafe-extension-debugging"],
  });
  const browser = context.browser();
  if (!browser) throw new Error("no browser handle");
  const swSeen = context.waitForEvent("serviceworker", { predicate: (w) => w.url().startsWith(`chrome-extension://${EXT_ID}/`), timeout: 30_000 });
  const cdp = await browser.newBrowserCDPSession();
  const loaded = (await cdp.send("Extensions.loadUnpacked" as never, { path: EXT } as never)) as { id: string };
  if (loaded.id !== EXT_ID) throw new Error(`loaded id ${loaded.id} is not the E2E id`);
  const sw = context.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${EXT_ID}/`)) ?? (await swSeen);
  return { context, sw, dir, version: browser.version() };
}

async function openPopup(context: BrowserContext, sw: Worker, tabId: number): Promise<Page> {
  const url = `chrome-extension://${EXT_ID}/popup.html?targetTabId=${tabId}`;
  await sw.evaluate(async (u: string) => {
    await chrome.windows.create({ url: u, type: "popup", width: 420, height: 760, focused: true });
  }, url);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const p = context.pages().find((x) => x.url().startsWith(url));
    if (p) {
      await p.waitForLoadState("domcontentloaded");
      return p;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("popup never opened");
}

async function tabIdOf(sw: Worker, urlPrefix: string): Promise<number> {
  const id = await sw.evaluate(async (u: string) => (await chrome.tabs.query({ url: `${u}/*` }))[0]?.id ?? null, urlPrefix);
  if (typeof id !== "number") throw new Error(`tab ${urlPrefix} not found`);
  return id;
}

async function finalState(popup: Page, timeout = 150_000) {
  const status = popup.getByTestId("status");
  await expect(status).toHaveAttribute("data-capture-state", /^(SUCCEEDED|FAILED)$/, { timeout });
  return {
    state: String(await status.getAttribute("data-capture-state")),
    text: String(await status.textContent()),
    evidenceId: String((await status.getAttribute("data-evidence-id")) ?? ""),
    retryVisible: await popup.getByTestId("retry").isVisible(),
    followUp: (await popup.getByTestId("follow-up").isVisible()) ? String(await popup.getByTestId("follow-up").textContent()) : "",
  };
}

async function bgStatus(sw: Worker, tabId: number): Promise<unknown> {
  return sw.evaluate(async (t: number) => {
    const all = (await chrome.storage.session.get("proovra.capture.status"))["proovra.capture.status"] ?? {};
    return all[String(t)] ?? null;
  }, tabId);
}

async function capture(ctx: { popup: Page; fixture: Page; sw: Worker; tabId: number; origin: string }, n: number) {
  await ctx.fixture.goto(`${ctx.origin}/page?n=${n}`);
  await ctx.fixture.bringToFront();
  await ctx.fixture.waitForTimeout(400);
  await ctx.popup.getByTestId("capture-viewport").click();
  const r = await finalState(ctx.popup);
  return { ...r, bg: await bgStatus(ctx.sw, ctx.tabId) };
}

test.describe.configure({ mode: "serial" });

test("Free user: extension sign-in, capture, allowance, sign-out", async () => {
  test.setTimeout(25 * 60_000);
  mkdirSync(SHOTS, { recursive: true });
  expect(API).toBe("http://localhost:8691");
  expect(WEB).toBe("http://localhost:3711");

  // 0 — the stack must be proven isolated before any account exists.
  await assertIsolatedStack();
  record("0.isolation", "PASS", "assertIsolatedStack: API + every live worker isolated (recording email, no secrets, no .env)");

  const runId = Date.now().toString(36);
  const p: Person = { email: `fex-${runId}@free-ext.example.test`, password: PASSWORD, name: `Fex ${runId}` };
  writeFileSync(resolve(OUT, "person.json"), JSON.stringify({ email: p.email, runId }, null, 2));
  const fx = await startFixtureServer();
  const { context, sw, dir, version } = await launch();
  record("0.browser", "INFO", `Chrome ${version}; extension ${EXT_ID} loaded unpacked from ${EXT}`);
  let userId = "";
  try {
    const web = await context.newPage();
    // Console + API errors from the web page, for the evidence log.
    web.on("response", (r) => {
      if (r.status() >= 400 && r.url().startsWith(API)) console.log(`[web api ${r.status()}] ${r.request().method()} ${r.url().slice(API.length).split("?")[0]}`);
    });

    // 1a — a new Free user registers through the web.
    const registered = await step("1a.web-register", async () => {
      await answerCookieBanner(web);
      await registerAccount(web, p);
      await shot(web, "01-web-home-after-register");
      return `registered ${p.email} via /register + recorded verification mail; landed on ${new URL(web.url()).pathname}`;
    });
    if (!registered) throw new Error("registration failed — nothing further can run");
    userId = psql(`select id from users where lower(email)=lower('${p.email}')`);
    record("1a.user", "INFO", `users.id=${userId}`);

    // Web truth: the account's spaces and its allowance meter.
    const ctxRes = await web.request.get(`${API}/v1/platform/context`);
    const platformCtx = (await ctxRes.json()) as { availableWorkspaces?: Array<{ id: string; name: string; scope: string; role: string }>; activeSpace?: { id?: string; type?: string } };
    record("1a.web-context", "INFO", `platform/context ${ctxRes.status()}: active=${JSON.stringify(platformCtx.activeSpace)} available=${JSON.stringify(platformCtx.availableWorkspaces)}`);
    const meter = async (tag: string) => {
      const r = await web.request.get(`${API}/v1/billing/overview`);
      const body = await r.text();
      writeFileSync(resolve(OUT, `billing-overview-${tag}.json`), body);
      let summary = body.slice(0, 200);
      try {
        const j = JSON.parse(body) as { workspaces?: { personal?: { plan?: string; counts?: { evidence?: number }; storage?: { usedLabel?: string; limitLabel?: string } } } };
        const w = j.workspaces?.personal;
        summary = `plan=${w?.plan} counts.evidence=${w?.counts?.evidence} storage=${w?.storage?.usedLabel}/${w?.storage?.limitLabel}`;
      } catch {
        /* raw */
      }
      return { status: r.status(), body: summary };
    };
    const homeMeter = async (tag: string) => {
      await web.bringToFront();
      await web.goto("/home");
      await web.waitForLoadState("networkidle").catch(() => undefined);
      await web.waitForTimeout(1500);
      await shot(web, `web-home-${tag}`);
      const homeText = await web.locator("main").innerText().catch(() => "");
      const lines = homeText.split("\n").map((l) => l.trim()).filter(Boolean);
      const i = lines.findIndex((l) => /RECORDS ON YOUR PLAN/i.test(l));
      return i >= 0 ? lines.slice(i, i + 3).join(" / ") : "(no records meter on /home)";
    };
    const m0 = await meter("0");
    record("1a.web-meter-0", "INFO", `billing/overview ${m0.status}: ${m0.body}; home: ${await homeMeter("0")}`);

    // Fixture tab.
    const fixture = await context.newPage();
    await fixture.goto(`${fx.origin}/page?n=0`);
    const tabId = await tabIdOf(sw, fx.origin);
    const popup = await openPopup(context, sw, tabId);
    await popup.getByTestId("sign-out").or(popup.getByTestId("sign-in")).first().waitFor({ timeout: 15_000 });
    await shot(popup, "02-popup-signed-out");

    // 1b — the REAL extension sign-in (PKCE + state through the web session).
    let signedInReal = false;
    {
      const before = new Set(context.pages());
      await popup.getByTestId("sign-in").click();
      const deadline = Date.now() + 25_000;
      let authPage: Page | null = null;
      while (Date.now() < deadline) {
        if (await popup.getByTestId("signed-in").isVisible()) {
          signedInReal = true;
          break;
        }
        authPage = context.pages().find((x) => !before.has(x) && x !== popup && /oauth\/extension\/authorize/.test(x.url())) ?? authPage;
        if (authPage) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      let authText = "(auth window not visible to automation)";
      if (authPage) {
        await authPage.waitForLoadState("domcontentloaded").catch(() => undefined);
        authText = `${authPage.url().replace(/code_challenge=[^&]+/, "code_challenge=…")} -> ${(await authPage.textContent("body").catch(() => ""))?.slice(0, 200)}`;
        await shot(authPage, "03-auth-window");
        await authPage.close().catch(() => undefined);
      }
      if (!signedInReal) {
        // The popup's own reaction once the auth window is closed.
        await popup.getByTestId("signed-out-note").filter({ hasText: /Sign-in did not complete/ }).waitFor({ timeout: 20_000 }).catch(() => undefined);
        const note = String(await popup.getByTestId("signed-out-note").textContent());
        await shot(popup, "04-popup-sign-in-failed");
        // Direct probe of the same authorize leg WITH the user's web session.
        const probe = await web.request.get(
          `${API}/v1/oauth/extension/authorize?response_type=code&client_id=proovra-extension&redirect_uri=${encodeURIComponent(`https://${EXT_ID}.chromiumapp.org/oauth2`)}&code_challenge=${"A".repeat(43)}&code_challenge_method=S256&state=probe&scope=capture.direct`,
          { headers: { accept: "text/html" }, maxRedirects: 0 },
        );
        // Why the browser ended the flow (non-interactive, so no window opens).
        const flowError = await sw.evaluate(async (api: string) => {
          const u = new URL(`${api}/v1/oauth/extension/authorize`);
          u.search = new URLSearchParams({ response_type: "code", client_id: "proovra-extension", redirect_uri: chrome.identity.getRedirectURL("oauth2"), scope: "capture.direct", code_challenge: "A".repeat(43), code_challenge_method: "S256", state: "diag" }).toString();
          try {
            return `resolved ${await chrome.identity.launchWebAuthFlow({ url: u.toString(), interactive: false })}`;
          } catch (e) {
            return `rejected: ${(e as Error).message}`;
          }
        }, API);
        record("1b.diag-launchWebAuthFlow", "INFO", `redirect ${await sw.evaluate(() => chrome.identity.getRedirectURL("oauth2"))}; launchWebAuthFlow(interactive:false) ${flowError}`);
        record(
          "1b.extension-sign-in-real",
          "FIXTURE",
          `real PKCE sign-in refused by the stack: auth window ${authText}; popup note "${note}"; signed-in probe of authorize -> ${probe.status()} ${(await probe.text()).slice(0, 120)}`,
        );
      } else {
        record("1b.extension-sign-in-real", "PASS", "real PKCE sign-in completed");
      }
    }

    // 1c — FIXTURE token (only when the real flow is refused by the stack).
    let mintedSid = "";
    if (!signedInReal) {
      const r = spawnSync(process.execPath, [resolve(ROOT, "e2e/acceptance/stack.mjs"), "tsx", resolve(ROOT, "e2e/acceptance/free/mint-extension-token.ts").replace(/\\/g, "/"), `--email=${p.email}`], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, ACCEPT_STACK_INSTANCE: "fa", ACCEPT_STACK_PORTS: "8691,3711,55933,56879,59500" },
      });
      const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("MINTED "));
      if (!line) throw new Error(`mint failed: ${r.stderr}`);
      const minted = JSON.parse(line.slice(7)) as { access_token: string; expires_in: number; account: string; sid: string };
      mintedSid = minted.sid;
      await sw.evaluate(async (t: { access_token: string; expires_in: number; account: string }) => {
        await chrome.storage.session.set({ "proovra.session.token": { accessToken: t.access_token, expiresAtMs: Date.now() + t.expires_in * 1000, account: t.account } });
      }, minted);
      record("1c.fixture-token", "FIXTURE", `capture.direct token minted as /token would (same claims, registered session sid=${minted.sid.slice(0, 6)}…) and placed in chrome.storage.session`);
      await popup.reload();
    }

    // 1d — the popup shows the right account / workspace.
    const ws = platformCtx.availableWorkspaces ?? [];
    await step("1d.popup-account-workspace", async () => {
      await popup.getByTestId("signed-in").waitFor({ state: "visible", timeout: 20_000 });
      await expect(popup.getByTestId("account")).toHaveText(`Signed in as ${p.email}`);
      await expect(popup.getByTestId("capture-viewport")).toBeEnabled({ timeout: 20_000 });
      const options = await popup.locator('[data-testid="workspace"] option').evaluateAll((os) => os.map((o) => ({ v: (o as HTMLOptionElement).value, t: o.textContent })));
      const selected = await popup.getByTestId("workspace").inputValue();
      const cases = await popup.locator('[data-testid="case"] option').allTextContents();
      const caseNote = (await popup.getByTestId("case-note").isVisible()) ? await popup.getByTestId("case-note").textContent() : "";
      await shot(popup, "05-popup-signed-in");
      expect(options.map((o) => o.v).sort()).toEqual(ws.map((w) => w.id).sort());
      expect(selected).toBe(platformCtx.activeSpace?.id ?? ws[0]?.id);
      return `account line ok; workspaces ${JSON.stringify(options)} selected=${selected} (= web activeSpace); case options ${JSON.stringify(cases)}; case note "${caseNote}"`;
    });
    {
      const text = await popup.locator("main").innerText();
      const showsLimits = /\b(of 3|3 records|records left|Free plan|allowance|remaining)\b/i.test(text);
      record("1e.popup-free-limits", showsLimits ? "PASS" : "FAIL", showsLimits ? "popup states the Free allowance" : `popup states no plan or allowance before a capture (text: ${JSON.stringify(text.slice(0, 400))})`);
    }

    // 2 — capture #1 → record via the real API, worker outputs, library, meter.
    const cx = { popup, fixture, sw, tabId, origin: fx.origin };
    const ids: string[] = [];
    const c1 = await capture(cx, 1);
    await shot(popup, "06-popup-capture-1");
    await step("2a.capture-1", async () => {
      expect(c1.state, `${c1.text} :: ${JSON.stringify(c1.bg)}`).toBe("SUCCEEDED");
      ids.push(c1.evidenceId);
      expect(c1.followUp).toBe("Open the record in PROOVRA");
      return `SUCCEEDED evidence ${c1.evidenceId}; status "${c1.text}"; follow-up "${c1.followUp}"`;
    });
    if (c1.evidenceId) {
      const row = psql(`select status::text||'|'||coalesce(acquisition_mode::text,'')||'|'||coalesce(team_id::text,'')||'|'||coalesce(capture_method::text,'') from evidence where id='${c1.evidenceId}'`);
      record("2b.db-record", row ? "PASS" : "FAIL", `evidence row status|acquisition|team|method = ${row}`);
      await step("2c.worker-report-package", async () => {
        const deadline = Date.now() + 180_000;
        let last = "";
        while (Date.now() < deadline) {
          const s = await web.request.get(`${API}/v1/evidence/${c1.evidenceId}/artifacts/status`);
          const j = (await s.json().catch(() => ({}))) as { report?: { available?: boolean }; verificationPackage?: { available?: boolean }; outputs?: { report?: { state?: string }; verificationPackage?: { state?: string } } };
          last = `${s.status()} report=${j.report?.available}/${j.outputs?.report?.state} package=${j.verificationPackage?.available}/${j.outputs?.verificationPackage?.state}`;
          if (j.report?.available && j.verificationPackage?.available) break;
          await new Promise((r) => setTimeout(r, 4000));
        }
        expect(last).toMatch(/report=true.*package=true/);
        const pdf = await web.request.get(`${API}/v1/evidence/${c1.evidenceId}/report/latest`);
        return `${last}; report/latest ${pdf.status()}`;
      });
      await step("2d.web-library", async () => {
        await web.bringToFront();
        await web.goto("/evidence");
        const row = web.locator(`[data-evidence-row-title="${c1.evidenceId}"]`).first();
        await web.waitForLoadState("networkidle").catch(() => undefined);
        await shot(web, "07-web-library");
        await expect(row).toBeVisible({ timeout: 30_000 });
        const rowText = (await row.innerText()).replace(/\s+/g, " ").slice(0, 120);
        await web.goto(`/evidence/${c1.evidenceId}`);
        await web.waitForLoadState("networkidle").catch(() => undefined);
        await shot(web, "08-web-record");
        const recText = (await web.locator("main").innerText().catch(() => "")).replace(/\s+/g, " ");
        const acq = /browser extension|Direct Web Capture|web capture/i.exec(recText)?.[0] ?? "(no acquisition wording found)";
        return `library row [data-evidence-row-title=${c1.evidenceId}] "${rowText}"; record page ${new URL(web.url()).pathname} opens, mentions "${acq}"`;
      });
      const m1 = await meter("1");
      const h1 = await homeMeter("1");
      record("2e.meters-after-1", /1 of 3/.test(h1) && /counts\.evidence=1/.test(m1.body) ? "PASS" : "FAIL", `billing/overview: ${m1.body}; home: ${h1}`);
    }

    // 3 — use the rest of the allowance, then the refusal.
    for (const n of [2, 3]) {
      const c = await capture(cx, n);
      await step(`3a.capture-${n}`, async () => {
        expect(c.state, `${c.text} :: ${JSON.stringify(c.bg)}`).toBe("SUCCEEDED");
        ids.push(c.evidenceId);
        return `SUCCEEDED evidence ${c.evidenceId}`;
      });
    }
    const m3 = await meter("3");
    const h3 = await homeMeter("3");
    record("3b.meters-after-3", /3 of 3/.test(h3) && /counts\.evidence=3/.test(m3.body) ? "PASS" : "FAIL", `billing/overview: ${m3.body}; home: ${h3}`);
    const before = dbSnapshot(userId);
    record("3c.db-before-4th", "INFO", JSON.stringify(before));
    const c4 = await capture(cx, 4);
    await shot(popup, "10-popup-refused");
    await new Promise((r) => setTimeout(r, 5000));
    const after = dbSnapshot(userId);
    record("3d.db-after-4th", "INFO", JSON.stringify(after));
    await step("3e.refusal-copy", async () => {
      expect(c4.state).toBe("FAILED");
      expect((c4.bg as { denial?: string } | null)?.denial).toBe("FREE_LIMIT_REACHED");
      expect(c4.text).toMatch(/used every evidence record the Free plan includes/);
      expect(c4.retryVisible, "no Try again on a plan refusal").toBe(false);
      expect(c4.followUp).toBe("View plans in PROOVRA");
      return `FAILED denial=FREE_LIMIT_REACHED; "${c4.text}"; Try again hidden; follow-up "${c4.followUp}"; bg=${JSON.stringify(c4.bg)}`;
    });
    await step("3f.upgrade-link", async () => {
      const opened = context.waitForEvent("page", { timeout: 15_000 });
      await popup.getByTestId("follow-up").click();
      const plans = await opened;
      await plans.waitForLoadState("domcontentloaded");
      await plans.waitForLoadState("networkidle").catch(() => undefined);
      await shot(plans, "11-plans-page-from-popup");
      const url = plans.url();
      expect(url.startsWith(`${WEB}/billing`)).toBe(true);
      const body = await plans.locator("body").innerText();
      expect(body).not.toMatch(/404|could not be found|Something went wrong/i);
      const hints = body.split("\n").filter((l) => /plan|upgrade|credit|Free/i.test(l)).slice(0, 6).join(" / ");
      await plans.close();
      return `opened ${url}; page lines: ${hints}`;
    });
    await step("3g.no-stray-record-or-reservation", async () => {
      expect(after.evidence, "no new evidence row").toBe(before.evidence);
      expect(after.openCaptureSessions, "no open (unfinalised, undiscarded) capture session").toBe("0");
      const pending = await sw.evaluate(async () => (await chrome.storage.local.get(null)) as Record<string, unknown>);
      const pend = Object.entries(pending).filter(([k]) => /pending|release/i.test(k));
      const m4 = await meter("4");
      const h4 = await homeMeter("4-after-refusal");
      expect(m4.body).toMatch(/counts\.evidence=3/);
      return `evidence ${before.evidence}->${after.evidence}; sessions ${before.captureSessions} -> ${after.captureSessions}; open=${after.openCaptureSessions}; entitlement ${before.entitlementUsage} -> ${after.entitlementUsage}; extension pending-release ${JSON.stringify(pend)}; meters after refusal: ${m4.body}; home: ${h4}`;
    });

    // 4 — sign-out clears the token and the server session.
    const tokenBefore = await sw.evaluate(async () => ((await chrome.storage.session.get("proovra.session.token"))["proovra.session.token"] as { accessToken?: string } | undefined)?.accessToken ?? "");
    await popup.getByTestId("sign-out").click();
    await step("4a.sign-out-local", async () => {
      await popup.getByTestId("signed-out").waitFor({ state: "visible", timeout: 20_000 });
      const left = await sw.evaluate(async () => (await chrome.storage.session.get("proovra.session.token"))["proovra.session.token"] ?? null);
      expect(left).toBeNull();
      await shot(popup, "12-popup-signed-out");
      return "popup shows Sign in; chrome.storage.session token removed";
    });
    await step("4b.sign-out-server", async () => {
      const r = await fetch(`${API}/v1/platform/context`, { headers: { authorization: `Bearer ${tokenBefore}` } });
      const sidHash = mintedSid ? psql(`select coalesce(revoked_at_utc::text,'NOT REVOKED') from authenticated_sessions where user_id='${userId}' and ua_preview like '%FIXTURE-minted%' order by issued_at_utc desc limit 1`) : "(real token)";
      expect(r.status, "old token refused after sign-out").toBe(401);
      return `old token -> ${r.status} on /v1/platform/context; session row revoked_at=${sidHash}`;
    });
    await step("4c.capture-after-sign-out", async () => {
      const evBefore = psql(`select count(*) from evidence where owner_user_id='${userId}'`);
      expect(await popup.getByTestId("capture-viewport").isVisible()).toBe(false);
      // The background is asked directly, as a stale popup would.
      const resp = (await popup.evaluate(
        async (a: { tabId: number }) => {
          const tab = await chrome.tabs.get(a.tabId);
          return chrome.runtime.sendMessage({ kind: "PRESERVE", mode: "VIEWPORT", teamId: "x", caseId: null, tabId: a.tabId, windowId: tab.windowId, evidenceType: "PHOTO" });
        },
        { tabId },
      )) as { accepted?: boolean; status?: { state?: string; reason?: string } };
      await popup.reload();
      await popup.getByTestId("signed-out").waitFor({ state: "visible", timeout: 20_000 });
      const note = (await popup.getByTestId("signed-out-note").isVisible()) ? await popup.getByTestId("signed-out-note").textContent() : "";
      await shot(popup, "13-popup-capture-after-sign-out");
      const evAfter = psql(`select count(*) from evidence where owner_user_id='${userId}'`);
      expect(resp?.status?.reason).toBe("SIGNED_OUT");
      expect(evAfter).toBe(evBefore);
      return `capture buttons hidden; a direct PRESERVE -> ${JSON.stringify(resp?.status && { state: resp.status.state, reason: resp.status.reason })}; popup note "${note}"; evidence ${evBefore}->${evAfter}`;
    });
    writeFileSync(resolve(OUT, "ids.json"), JSON.stringify({ userId, ids, email: p.email }, null, 2));
  } finally {
    await context.close().catch(() => undefined);
    fx.server.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* locked profile */
    }
  }
});
