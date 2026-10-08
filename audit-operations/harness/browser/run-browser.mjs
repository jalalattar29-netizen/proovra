// AUDIT-ONLY browser matrix for /operations against a PRODUCTION web build that
// talks only to the loopback API (http://localhost:8191). Every scenario writes
// a record to audit-operations/evidence/browser/<id>.json; nothing is asserted
// as PASS that was not observed.
//
//   node audit-operations/harness/browser/run-browser.mjs
import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const OUT = resolve(REPO, "audit-operations", "evidence", "browser");
mkdirSync(OUT, { recursive: true });
const WEB = "http://localhost:3311";
const API = "http://localhost:8191";
const FIX = JSON.parse(readFileSync(resolve(REPO, "audit-operations", ".tmp", "browser-fixture.json"), "utf8"));
const PASSWORD = "opsaudit-local-only-password";
const sha = (rel) => createHash("sha256").update(readFileSync(resolve(REPO, rel))).digest("hex");
const UI = [
  "apps/web/app/(app)/operations/page.tsx",
  "apps/web/app/(app)/operations/_components/IncidentInspector.tsx",
  "apps/web/app/(app)/operations/_components/GroupInspector.tsx",
  "apps/web/app/(app)/operations/_components/IncidentSurface.tsx",
  "apps/web/app/(app)/operations/_components/GroupSurface.tsx",
  "apps/web/app/(app)/operations/_components/States.tsx",
  "apps/web/app/(app)/operations/_components/BulkToolbar.tsx",
  "apps/web/app/(app)/operations/operations.css",
];
const scrub = (s) => String(s).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>").replace(/\d{2} \w{3} \d{4}, \d{2}:\d{2}(:\d{2})? [A-Za-z_/]+/g, "<datetime>");

function record(id, title, findingIds, extra) {
  const rec = { proofId: id, title, proofType: "BROWSER_PROVEN", findingIds, webBuild: "production (next build) via apps/web/scripts/dev-admin-fixture.mjs --mode=production, NEXT_PUBLIC_API_BASE=http://localhost:8191", sourceFingerprints: Object.fromEntries(UI.map((f) => [f, sha(f)])), command: "node audit-operations/harness/browser/run-browser.mjs", ...extra };
  writeFileSync(resolve(OUT, `${id}.json`), JSON.stringify(rec, null, 2) + "\n");
  console.log("[BROWSER]", id, JSON.stringify(extra.observed ?? {}).slice(0, 300));
}

async function login(browser, email) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${WEB}/login`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Reject all" }).click({ timeout: 15000 }).catch(() => {});
  await page.locator("#login-email:visible").first().fill(email);
  await page.locator("input[type=\"password\"]:visible").first().fill(PASSWORD);
  await page.locator("input[type=\"checkbox\"]:visible").first().check();
  await page.getByRole("button", { name: "Sign in with Email" }).locator("visible=true").first().click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
  const state = await ctx.storageState();
  await ctx.close();
  return state;
}

async function openOps(browser, state, opts = {}) {
  const ctx = await browser.newContext({ storageState: state, viewport: opts.viewport ?? { width: 1440, height: 900 }, reducedMotion: opts.reducedMotion ?? "no-preference" });
  if (opts.locale) await ctx.addInitScript((l) => { try { localStorage.setItem("proovra-locale-mode", "manual"); localStorage.setItem("proovra-locale", l); } catch {} }, opts.locale);
  const page = await ctx.newPage();
  const reqs = [];
  page.on("request", (r) => { if (r.url().startsWith(API) && r.method() !== "OPTIONS") reqs.push({ m: r.method(), u: r.url().replace(API, "").replace(/teamId=[^&]+/, "teamId=<ws>").slice(0, 120), t: Date.now() }); });
  // Select the workspace through the product's own switch endpoint: the active
  // workspace is persisted server-side, so a previous scenario's switch would
  // otherwise leak into this one.
  const ws = opts.ws === undefined ? (state === S_OWNER() ? FIX.workspaces.personal : null) : opts.ws;
  if (ws) {
    await page.goto(`${WEB}/home`, { waitUntil: "domcontentloaded" });
    await page.evaluate(async ([api, id]) => { await fetch(`${api}/v1/platform/context/switch-workspace`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: id }) }); }, [API, ws]);
  }
  if (opts.routes) for (const [pattern, handler] of opts.routes) await page.route(pattern, handler);
  await page.goto(`${WEB}${opts.path ?? "/operations"}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(opts.settle ?? 1500);
  return { ctx, page, reqs };
}

let OWNER_STATE = null;
const S_OWNER = () => OWNER_STATE;
const mainText = (page) => page.locator("main").innerText().catch(() => "");
const dialogText = (page) => page.locator('main [role="dialog"]').last().innerText().catch(() => null);
const dialogButtons = (page) => page.locator('main [role="dialog"]').last().locator("button, a").evaluateAll((els) => els.map((e) => ((e.innerText || e.getAttribute("aria-label") || "").trim() + (e.getAttribute("href") ? ` -> ${e.getAttribute("href")}` : "") + (e.disabled ? " [disabled]" : "")))).catch(() => []);
async function switchView(page, label) { await page.getByRole("button", { name: label, exact: true }).click().catch(() => {}); await page.waitForTimeout(1500); }
async function clickTitle(page, text) { const el = page.locator("main").getByText(text, { exact: false }).first(); await el.click(); await page.waitForTimeout(2000); }

// AUDIT-ONLY fixture reset so the run is repeatable: B02 acknowledges a seeded
// condition, so return it to OPEN on the disposable database before each run.
{
  const { execSync } = await import("node:child_process");
  execSync(`docker exec opsaudit-pg psql -U pv -d opsaudit_browser -c "UPDATE operational_incidents SET status='OPEN', acknowledged_at_utc=NULL, acknowledged_by_user_id=NULL WHERE (team_id='${FIX.workspaces.personal}' AND source_id='search.indexing_failure') OR (team_id='${FIX.workspaces.org}' AND source_id='pipeline.report_generation_failed')"`, { stdio: "ignore" });
}
const browser = await chromium.launch();
const results = {};
try {
  const S = { owner: await login(browser, FIX.users.owner), viewer: await login(browser, FIX.users.viewer), free: await login(browser, FIX.users.free) };
  OWNER_STATE = S.owner;

  // B01 — Reem view (personal + internal TEAM grant): summary vs grouped list, group drawer, flat drawers.
  {
    const { ctx, page, reqs } = await openOps(browser, S.owner);
    const grouped = scrub(await mainText(page));
    await clickTitle(page, "Storage add-on still billing");
    const groupDrawer = { text: scrub(await dialogText(page)), controls: await dialogButtons(page) };
    await page.keyboard.press("Escape");
    await clickTitle(page, "Queue retry storm");
    const stormDrawer = { text: scrub(await dialogText(page)), controls: await dialogButtons(page) };
    await page.keyboard.press("Escape");
    await switchView(page, "All conditions");
    const flat = scrub(await mainText(page));
    await clickTitle(page, "Storage add-on still billing");
    const storage = { text: scrub(await dialogText(page)), controls: await dialogButtons(page) };
    await page.keyboard.press("Escape"); await page.waitForTimeout(500);
    await clickTitle(page, "Report generation failed");
    const report = { text: scrub(await dialogText(page)), controls: await dialogButtons(page) };
    await page.screenshot({ path: resolve(OUT, "B01-report-drawer.png") });
    await page.keyboard.press("Escape"); await page.waitForTimeout(500);
    await clickTitle(page, "Queue telemetry sampler delayed");
    const telemetry = { text: scrub(await dialogText(page)), controls: await dialogButtons(page) };
    record("PR-B01-reem-view", "Reem-shaped personal workspace rendered: grouped list, group drawer, condition drawers", ["OPS-001", "OPS-002", "OPS-003", "OPS-012", "OPS-013"], { persona: "personal owner", plan: "FREE + internal TEAM grant", workspaceType: "personal", observed: { groupedView: grouped.slice(0, 2500), groupDrawerStorage: groupDrawer, groupDrawerRetryStorm: stormDrawer, flatView: flat.slice(0, 1500), storageDrawer: storage, reportDrawer: report, telemetryDrawer: telemetry, apiRequests: reqs.length } });
    await ctx.close();
  }

  // B02 — action with drawer open: does the list update?
  {
    const { ctx, page, reqs } = await openOps(browser, S.owner);
    await switchView(page, "All conditions");
    await clickTitle(page, "Search index reconciliation failing");
    const before = await dialogText(page);
    reqs.length = 0;
    await page.locator('main [role="dialog"]').last().getByRole("button", { name: "Acknowledge" }).click();
    await page.waitForTimeout(8000);
    const after = await dialogText(page);
    const refresh = await page.getByRole("button", { name: /Refresh/ }).first().evaluate((b) => ({ text: b.innerText.trim(), disabled: b.disabled })).catch(() => null);
    const apiState = await page.evaluate(async ([api, ws]) => { const r = await fetch(`${api}/v1/ops/incidents?teamId=${ws}`, { credentials: "include" }); const j = await r.json(); return j.incidents.filter((i) => /Search index/.test(i.title)).map((i) => i.status); }, [API, FIX.workspaces.personal]);
    await page.keyboard.press("Escape"); await page.waitForTimeout(1500);
    const refreshAfterClose = await page.getByRole("button", { name: /Refresh/ }).first().evaluate((b) => ({ text: b.innerText.trim(), disabled: b.disabled })).catch(() => null);
    record("PR-B02-drawer-refresh-deadlock", "Acknowledge with the condition drawer open", ["OPS-007"], { persona: "personal owner", observed: { drawerHeadBefore: before?.slice(0, 40), drawerHeadAfter: after?.slice(0, 40), refreshControlAfter: refresh, refreshControlAfterDrawerClosed: refreshAfterClose, serverStatus: apiState, requestsAfterAck: reqs.map((r) => `${r.m} ${r.u}`) } });
    await ctx.close();
  }

  // B03 — workspace switch while the old workspace's list is still in flight (delayed 3s).
  {
    let delayed = 0;
    const { ctx, page, reqs } = await openOps(browser, S.owner);
    await page.route(`${API}/v1/ops/incidents?teamId=${FIX.workspaces.personal}*`, async (route) => { delayed++; await new Promise((r) => setTimeout(r, 3000)); await route.continue(); });
    await switchView(page, "All conditions");
    await clickTitle(page, "Queue retry storm");
    await page.getByRole("button", { name: /Refresh/ }).first().click().catch(() => {});
    // Switch through the product's own switcher.
    const sw = page.locator('button[aria-label*="workspace switcher"]').first();
    const switcherClick = await sw.click({ timeout: 5000 }).then(() => "clicked").catch((e) => "blocked: " + String(e.message).split(String.fromCharCode(10))[0].slice(0, 120));
    if (switcherClick !== "clicked") { await page.keyboard.press("Escape"); await page.waitForTimeout(300); await sw.click(); }
    await page.waitForTimeout(800);
    const switcherItems = await page.locator('[role="menuitem"], [role="option"], [role="menuitemradio"]').allInnerTexts().catch(() => []);
    await page.getByText("Audit Team WS", { exact: false }).last().click().catch(() => {});
    await page.waitForTimeout(6000);
    const header = scrub((await mainText(page)).slice(0, 400));
    const shown = (await mainText(page));
    const drawerAfterSwitch = await dialogText(page);
    record("PR-B03-workspace-switch-inflight", "Workspace switch with a delayed old-workspace list and an open drawer", ["OPS-007"], { persona: "owner of personal + TEAM org workspace", observed: { switcherClickWithDrawerOpen: switcherClick, switcherItems: switcherItems.map(scrub), delayedOldListRequests: delayed, headerAfterSwitch: header, showsOrgConditions: /Governance policy condition/.test(shown), stillShowsPersonalConditions: /Queue retry storm|Storage add-on/.test(shown), drawerStillOpenAfterSwitch: drawerAfterSwitch ? scrub(drawerAfterSwitch.slice(0, 120)) : null, requests: reqs.map((r) => `${r.m} ${r.u}`).slice(-12) } });
    await ctx.close();
  }

  // B04 — TEAM viewer: visible controls vs API authority.
  {
    const { ctx, page } = await openOps(browser, S.viewer);
    await switchView(page, "All conditions");
    const rowMenus = await page.getByRole("button", { name: /^Actions for/ }).count();
    await clickTitle(page, "Governance policy condition");
    const controls = await dialogButtons(page);
    const checkboxes = await page.locator('main input[type="checkbox"]').count();
    record("PR-B04-viewer-controls", "TEAM viewer: rendered controls", ["OPS-020"], { persona: "TEAM viewer", plan: "TEAM", workspaceType: "organization", observed: { drawerControls: controls, bulkCheckboxes: checkboxes, rowActionMenus: rowMenus } });
    await ctx.close();
  }

  // B05 — FREE personal owner: page gate.
  {
    const { ctx, page } = await openOps(browser, S.free);
    const t = scrub(await mainText(page));
    const nav = await page.locator("nav a, aside a").evaluateAll((as) => as.map((a) => a.getAttribute("href"))).catch(() => []);
    record("PR-B05-free-gate", "FREE personal owner opens /operations directly", ["OPS-005"], { persona: "personal owner", plan: "FREE", observed: { pageText: t.slice(0, 600), navHasOperations: nav.includes("/operations") } });
    await ctx.close();
  }

  // B06 — error / loading / partial states through response interception.
  {
    const cases = {};
    for (const [status, body] of [[403, { error: { code: "permission_denied" } }], [404, { error: { code: "not_found" } }], [409, { error: { code: "conflict" } }], [429, { error: { code: "rate_limited" } }], [500, { error: { code: "internal" } }]]) {
      const { ctx, page } = await openOps(browser, S.owner, { routes: [[`${API}/v1/ops/incidents?*`, (r) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })]] });
      const t = await mainText(page);
      cases[`incidents_${status}`] = { allClearShown: /all clear|nothing needs|no operational conditions/i.test(t), text: scrub(t).slice(0, 300) };
      await ctx.close();
    }
    {
      const { ctx, page } = await openOps(browser, S.owner, { routes: [[`${API}/v1/ops/summary?*`, (r) => r.fulfill({ status: 500, contentType: "application/json", body: "{}" })]] });
      cases.summary_500 = { text: scrub(await mainText(page)).slice(0, 300) };
      await ctx.close();
    }
    {
      const { ctx, page } = await openOps(browser, S.owner, { settle: 200, routes: [[`${API}/v1/ops/**`, async (r) => { await new Promise((x) => setTimeout(x, 4000)); await r.continue(); }]] });
      cases.slowNetwork_at200ms = { text: scrub(await mainText(page)).slice(0, 200) };
      await ctx.close();
    }
    {
      const { ctx, page } = await openOps(browser, S.owner, { routes: [[`${API}/v1/ops/incidents/*?*`, (r) => r.fulfill({ status: 500, contentType: "application/json", body: "{}" })]] });
      await switchView(page, "All conditions");
      await clickTitle(page, "Queue retry storm");
      const listStill = /Storage add-on/.test(await mainText(page));
      cases.detail_500 = { drawer: scrub((await dialogText(page)) ?? "").slice(0, 200), listIntact: listStill };
      await ctx.close();
    }
    {
      const { ctx, page } = await openOps(browser, S.owner, { routes: [[`${API}/v1/ops/incident-groups?*`, (r) => r.fulfill({ status: 500, contentType: "application/json", body: "{}" })]] });
      { const t = scrub(await mainText(page)); cases.groups_500 = { saysNoMatch: /match these filters/i.test(t), saysCouldNotLoad: /could not be loaded|unavailable/i.test(t.split("Queue summary")[1] ?? ""), tail: t.slice(-500) }; }
      await ctx.close();
    }
    record("PR-B06-error-states", "Rendered states for failed / slow reads", ["OPS-020"], { persona: "personal owner", observed: cases });
  }

  // B07 — bulk outcome rendering (server response shape replayed verbatim from PR-A8-bulk-vocabulary).
  {
    let posted = null;
    const { ctx, page } = await openOps(browser, S.owner, { path: "/operations" });
    await page.route(`${API}/v1/ops/bulk-actions`, async (route) => {
      const req = route.request(); posted = JSON.parse(req.postData() ?? "{}");
      const items = (posted.targetIds ?? []).map((id) => ({ id: "00000000-0000-4000-8000-0000000000aa", targetType: "OperationalIncident", targetId: id, status: "COMPLETED", errorCode: null }));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { id: "00000000-0000-4000-8000-0000000000bb", status: "COMPLETED", result: { total: items.length, failed: 0, skipped: 0, succeeded: items.length } }, items }) });
    });
    await switchView(page, "All conditions");
    const boxes = page.locator('main input[type="checkbox"]');
    const n = Math.min(2, await boxes.count());
    for (let i = 0; i < n; i++) await boxes.nth(i).check().catch(() => {});
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: /^Acknowledge/ }).first().click().catch(() => {});
    await page.waitForTimeout(3000);
    record("PR-B07-bulk-outcome", "Web rendering of a fully successful bulk run (server vocabulary COMPLETED)", ["OPS-011"], { persona: "personal owner", fixtureNote: "bulk POST fulfilled with the server's own response vocabulary because the route requires SMS/TOTP step-up which is not available locally; this isolates the web's interpretation only", observed: { selected: n, postedBody: posted ? { actionType: posted.actionType, targets: posted.targetIds?.length, idempotencyKey: posted.idempotencyKey ?? null } : null, rendered: scrub(await mainText(page)).match(/[^\n]*(updated|could not be changed|remain selected)[^\n]*/gi) ?? [] } });
    await ctx.close();
  }

  // B08 — pagination and grouped "Load more".
  {
    const s = await (async () => { const { ctx, page } = await openOps(browser, S.viewer); return { ctx, page }; })();
    const { ctx, page } = s;
    const groupedText = await mainText(page);
    const loadMoreInGrouped = await page.getByRole("button", { name: /Load \d+ more/ }).count();
    await switchView(page, "All conditions");
    const rowsBefore = await page.getByRole("button", { name: /^Actions for/ }).count().catch(() => 0);
    const countLabel = (await mainText(page)).match(/\d+\+? conditions?/)?.[0] ?? null;
    await page.getByRole("button", { name: /Load \d+ more/ }).first().click().catch(() => {});
    await page.waitForTimeout(2500);
    const checkboxesAfter = await page.locator('main input[type="checkbox"]').count();
    const titlesAfter = (await mainText(page)).match(/Governance policy condition/g)?.length ?? 0;
    record("PR-B08-pagination", "Pagination with 121 conditions", ["OPS-020"], { persona: "TEAM viewer", observed: { groupedSummary: scrub(groupedText).match(/\d+ groups?[^\n]*/)?.[0] ?? null, loadMoreButtonsInGroupedView: loadMoreInGrouped, countLabelFlat: countLabel, orgTitlesRenderedAfterLoadMore: titlesAfter, rowActionMenusBeforeLoadMore: rowsBefore, checkboxesAfter } });
    await ctx.close();
  }

  // B09 — responsive widths and 200% zoom equivalent.
  {
    const widths = {};
    for (const w of [320, 375, 768, 1024, 1440]) {
      const { ctx, page } = await openOps(browser, S.owner, { viewport: { width: w, height: 900 } });
      widths[w] = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const over = [...document.querySelectorAll("main *")].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > vw + 1; }).length;
        const small = [...document.querySelectorAll("main button, main a, main input, main select")].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.height < 24 || r.width < 24); }).map((e) => (e.innerText || e.getAttribute("aria-label") || e.getAttribute("type") || "").trim().slice(0, 30));
        return { scrollWidth: document.documentElement.scrollWidth, viewport: vw, overflowingElements: over, targetsUnder24px: small.length, smallSample: small.slice(0, 6) };
      });
      if (w === 320) await page.screenshot({ path: resolve(OUT, "B09-320.png"), fullPage: false });
      await ctx.close();
    }
    const { ctx, page } = await openOps(browser, S.owner, { viewport: { width: 1440, height: 900 } });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await page.waitForTimeout(800);
    const zoom = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
    await ctx.close();
    record("PR-B09-responsive", "Responsive widths and 200% root text size", ["OPS-020"], { persona: "personal owner", observed: { widths, rootText200pct: zoom } });
  }

  // B10 — locales.
  {
    const loc = {};
    for (const l of ["en", "de", "ar"]) {
      const { ctx, page } = await openOps(browser, S.owner, { locale: l });
      const t = await mainText(page);
      loc[l] = await page.evaluate(() => ({ lang: document.documentElement.lang, dir: document.documentElement.dir })).then((x) => ({ ...x, headingSample: t.split("\n").slice(0, 3).join(" | ").slice(0, 160), containsEnglishQueueSummary: /Queue summary|Unresolved|Report generation failed/.test(t) }));
      if (l === "ar") await page.screenshot({ path: resolve(OUT, "B10-ar.png") });
      await ctx.close();
    }
    record("PR-B10-locales", "English / German / Arabic (RTL) rendering of /operations", ["OPS-020"], { persona: "personal owner", observed: loc });
  }

  // B11 — keyboard, focus trap/restore, headings, nested interactive, names, reduced motion.
  {
    const { ctx, page } = await openOps(browser, S.owner, { reducedMotion: "reduce" });
    await switchView(page, "All conditions");
    const opener = page.locator("main").getByText("Queue retry storm").first();
    await opener.focus().catch(() => {});
    const openerTag = await page.evaluate(() => { const a = document.activeElement; return a ? `${a.tagName}${a.getAttribute("role") ? "[" + a.getAttribute("role") + "]" : ""}` : null; });
    await page.keyboard.press("Enter"); await page.waitForTimeout(2000);
    const inDialogAfterOpen = await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
    let escaped = -1;
    for (let i = 0; i < 60; i++) { await page.keyboard.press("Tab"); const inside = await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')); if (!inside) { escaped = i + 1; break; } }
    await page.keyboard.press("Escape"); await page.waitForTimeout(800);
    const focusAfterClose = await page.evaluate(() => { const a = document.activeElement; return a ? (a.innerText || a.getAttribute("aria-label") || a.tagName).trim().slice(0, 60) : null; });
    const audit = await page.evaluate(() => {
      const hs = [...document.querySelectorAll("main h1, main h2, main h3, main h4")].map((h) => h.tagName + ":" + h.innerText.trim().slice(0, 30));
      const nested = [...document.querySelectorAll("a button, button a, button button, a a")].length;
      const unnamed = [...document.querySelectorAll("main button, main a[href]")].filter((e) => !(e.innerText || "").trim() && !e.getAttribute("aria-label") && !e.getAttribute("aria-labelledby") && !e.getAttribute("title")).length;
      const live = [...document.querySelectorAll('[aria-live], [role="status"], [role="alert"]')].map((e) => e.getAttribute("role") || "aria-live:" + e.getAttribute("aria-live"));
      const spin = [...document.querySelectorAll("main *")].map((e) => getComputedStyle(e).animationName).filter((n) => n && n !== "none");
      return { headings: hs, nestedInteractive: nested, unnamedControls: unnamed, liveRegions: live, runningAnimationsUnderReducedMotion: spin.length };
    });
    record("PR-B11-accessibility", "Keyboard, focus trap/restore, headings, names, live regions, reduced motion", ["OPS-020"], { persona: "personal owner", observed: { openerFocusable: openerTag, focusMovedIntoDrawer: inDialogAfterOpen, tabPressesUntilFocusLeftDrawer: escaped, focusAfterEscape: focusAfterClose, ...audit } });
    await ctx.close();
  }

  // B12 — back/forward and deep link to a condition.
  {
    const { ctx, page } = await openOps(browser, S.owner);
    await page.getByRole("button", { name: /Critical/ }).first().click().catch(() => {});
    await page.waitForTimeout(1500);
    const urlAfterFilter = page.url().replace(WEB, "");
    await page.goBack(); await page.waitForTimeout(1500);
    const urlAfterBack = page.url().replace(WEB, "");
    await page.goForward(); await page.waitForTimeout(1500);
    const urlAfterForward = page.url().replace(WEB, "");
    await switchView(page, "All conditions");
    await clickTitle(page, "Report generation failed");
    const urlWithDrawer = page.url().replace(WEB, "");
    await page.reload(); await page.waitForTimeout(3000);
    const drawerAfterReload = await dialogText(page);
    record("PR-B12-history-deeplink", "Back/forward over filters; deep link to an open condition", ["OPS-020"], { persona: "personal owner", observed: { urlAfterFilter: scrub(urlAfterFilter), urlAfterBack: scrub(urlAfterBack), urlAfterForward: scrub(urlAfterForward), urlWhileDrawerOpen: scrub(urlWithDrawer), drawerRestoredAfterReload: !!drawerAfterReload } });
    await ctx.close();
  }

  // B13 — repeated drawer open/close: request behaviour and polling cadence.
  {
    const { ctx, page, reqs } = await openOps(browser, S.owner);
    await switchView(page, "All conditions");
    reqs.length = 0;
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) { await clickTitle(page, "Queue retry storm"); await page.keyboard.press("Escape"); await page.waitForTimeout(300); }
    const opens = reqs.filter((r) => /\/v1\/ops\/incidents\/[^?]+\?/.test(r.u)).length;
    const lists = reqs.filter((r) => /\/v1\/ops\/incidents\?/.test(r.u)).length;
    reqs.length = 0;
    await page.waitForTimeout(65_000);
    const idle = reqs.map((r) => r.u.split("?")[0]);
    const perf = await page.evaluate((api) => performance.getEntriesByType("resource").filter((e) => e.name.startsWith(api + "/v1/ops/")).map((e) => ({ u: e.name.replace(api, "").split("?")[0], ms: Math.round(e.duration) })), API);
    const lat = {}; for (const p of perf) (lat[p.u] ??= []).push(p.ms);
    const latency = Object.fromEntries(Object.entries(lat).map(([k, v]) => [k.replace(/[0-9a-f-]{36}/g, ":id"), { n: v.length, medianMs: v.sort((a, b) => a - b)[Math.floor(v.length / 2)] }]));
    record("PR-B13-drawer-churn-polling", "10x drawer open/close; idle 65s request cadence; measured API latency", ["OPS-020"], { persona: "personal owner", observed: { elapsedMs: Date.now() - t0, detailReadsFor10Opens: opens, listReadsDuringChurn: lists, requestsDuringIdle65s: idle, latencyMeasured: latency } });
    await ctx.close();
  }

  // B14 — a reconciled workspace with no conditions: does the page assert all-clear honestly?
  {
    const { ctx, page } = await openOps(browser, S.owner, { ws: FIX.workspaces.empty });
    const t = scrub(await mainText(page));
    record("PR-B14-empty-state", "Reconciled TEAM workspace with zero conditions", ["OPS-020"], { persona: "TEAM owner", plan: "TEAM", workspaceType: "organization", observed: { text: t.slice(0, 900) } });
    await ctx.close();
  }

  // B15 — two tabs acting on the same condition.
  {
    const a = await openOps(browser, S.owner, { ws: FIX.workspaces.org });
    const b = await openOps(browser, S.owner, { ws: FIX.workspaces.org });
    for (const t of [a, b]) { await switchView(t.page, "All conditions"); await clickTitle(t.page, "Report generation failed"); }
    await a.page.locator('main [role="dialog"]').last().getByRole("button", { name: "Acknowledge" }).click();
    await a.page.waitForTimeout(2500);
    await b.page.locator('main [role="dialog"]').last().getByRole("button", { name: "Acknowledge" }).click().catch(() => {});
    await b.page.waitForTimeout(2500);
    const bText = scrub(await mainText(b.page));
    const bModal = await b.page.locator('[role="alertdialog"], [role="dialog"]').allInnerTexts().catch(() => []);
    record("PR-B15-two-tabs", "Second tab acknowledges a condition already acknowledged in the first", ["OPS-007"], { persona: "TEAM owner", observed: { secondTabMessages: (bText.match(/[^\n]*(already|changed|could not|refresh|no longer)[^\n]*/gi) ?? []).slice(0, 5), dialogs: bModal.map(scrub).map((x) => x.slice(0, 160)).slice(0, 3) } });
    await a.ctx.close(); await b.ctx.close();
  }
} catch (e) {
  record("PR-B99-runner-error", "Browser runner aborted", [], { observed: { error: String(e?.stack ?? e).slice(0, 1500) } });
} finally {
  await browser.close();
}
