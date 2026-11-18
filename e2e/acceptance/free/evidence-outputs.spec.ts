/**
 * FREE PLAN — EVIDENCE, ALLOWANCE, UPLOADS, OUTPUTS, VERIFY, INTAKE LINKS, CLIENT SKEW.
 *
 * Runs only against the isolated acceptance stack (e2e/acceptance/stack.mjs),
 * in real Chrome, with persisted state (ACCEPT_STATE_NAME=free-evidence) so a
 * repaired step can be rerun alone: ACCEPT_RESUME=1 ... -g "E05".
 *
 * Isolation substitutions, stated wherever a proof would include them:
 *   OTS and TSA are DISABLED on this stack; the signer is a local PEM key.
 *   Email goes to the recording transport (.p7tmp/recorded-emails.jsonl).
 *
 * Labelled fixture shortcuts (no proof of the product path they replace):
 *   FIXTURE-OP     The operator account is seeded (platform staff, not a customer step).
 *   FIXTURE-GRANT  The paid (TEAM) workspace comes from the operator CLI
 *                  `ops:internal-plan-grant` (no payment provider exists here),
 *                  and the downgrade is the same CLI's `revoke`.
 *   FIXTURE-EXPIRY An intake link's expires_at_utc is set in the past with SQL.
 *   API-NATIVE     The native client's duplicate-content / clientAttemptId path
 *                  is exercised at API level (no device here).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { expect, test, type Page, type Request } from "@playwright/test";

import { PLAN_CAPABILITIES } from "../../../packages/shared-billing/src/plan-catalog";
import { assertIsolatedStack } from "../../helpers/stack-isolation";
import {
  API_BASE,
  keepProfile,
  linkFromMail,
  loadState,
  mailbox,
  newProfile,
  registerAccount,
  samplePng,
  saveState,
  shot,
  WEB_BASE,
} from "../lib/journey";
import {
  api,
  fev,
  ledger,
  pdfText,
  personalProjection,
  personalTeamOf,
  save,
  sha256Hex,
  sql,
  stackTsx,
  userIdOf,
  zipContents,
} from "./lib";

const s = loadState();
test.describe.configure({ mode: "serial" });

const LAT = 59.913868;
const LNG = 10.752245;
const STORAGE_HOST = /localhost:59500|127\.0\.0\.1:59500/;

function log(label: string, v: unknown): void {
  console.log(`[fev] ${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
}

function fileFor(seed: string) {
  return { name: `fev-${seed}-${s.runId}.png`, mimeType: "image/png", buffer: samplePng(`fev-${seed}-${s.runId}`) };
}

async function stage(page: Page, seed: string): Promise<void> {
  await page.locator('input[type="file"][aria-label="Upload evidence files"]').setInputFiles(fileFor(seed));
  await expect(page.getByText("1 material added").first()).toBeVisible();
}

async function reviewAndSign(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Review & Sign", exact: true }).last().click();
  await page.locator("[data-capture-review-confirm]").click();
}

/** Wait for the worker: report and package downloadable on the record page. */
async function waitReported(page: Page, evidenceId: string): Promise<void> {
  await expect(async () => {
    await page.goto(`/evidence/${evidenceId}`);
    await expect(page.locator('[data-evidence-action="download-report"]')).toBeEnabled({ timeout: 4000 });
    await expect(page.getByText("Reported").first()).toBeVisible({ timeout: 4000 });
  }).toPass({ timeout: 180_000, intervals: [3000] });
}

/**
 * The page's own download control. The report opens in a new tab (F-P1-04,
 * artifact-window.ts) whose presigned URL Chrome downloads; the package
 * downloads in place. Either way the bytes are what the person receives.
 */
async function downloadVia(page: Page, selector: string): Promise<Buffer> {
  const ctx = page.context();
  let popupUrl = "";
  const got = new Promise<Buffer>((done) => {
    const onDl = (d: import("@playwright/test").Download) => void d.path().then((p) => done(readFileSync(p)));
    page.once("download", onDl);
    ctx.once("page", (p) => {
      p.once("download", onDl);
      void p.waitForLoadState("domcontentloaded").then(() => (popupUrl = p.url())).catch(() => undefined);
    });
  });
  await page.locator(selector).click();
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), 30_000));
  const bytes = await Promise.race([got, timeout]);
  if (bytes) return bytes;
  // A tab that rendered the file instead of downloading it: read the same URL.
  expect(popupUrl, `${selector} produced neither a download nor a tab`).toMatch(/^http/);
  return Buffer.from(await (await ctx.request.get(popupUrl)).body());
}

/** Download the PDF and the package through the page's own buttons; inspect both. */
async function checkOutputs(page: Page, evidenceId: string, tag: string): Promise<{ pdf: string; zip: string; zipSha: string; pdfTextValue: string; zipEntries: string[]; texts: Record<string, string> }> {
  const pdfBytes = await downloadVia(page, '[data-evidence-action="download-report"]');
  expect(pdfBytes.subarray(0, 4).toString()).toBe("%PDF");
  const pdf = save(`${tag}-report.pdf`, pdfBytes);
  const zipBytes = await downloadVia(page, '[data-evidence-action="download-package"]');
  expect(zipBytes.subarray(0, 2).toString()).toBe("PK");
  const zip = save(`${tag}-package.zip`, zipBytes);
  const text = pdfText(pdf);
  const ref = sql(`select coalesce(verification_ref, '') from evidence where id = '${evidenceId}'`)[0]![0]!;
  const flat = text.text.replace(/\s+/g, "");
  const hasId = flat.includes(evidenceId) || (ref !== "" && flat.includes(ref));
  log(`${tag} pdf`, { pages: text.pages, hasEvidenceId: flat.includes(evidenceId), hasRef: ref !== "" && flat.includes(ref), ref });
  expect(hasId, `the report names the record (${evidenceId} / ${ref})`).toBe(true);
  const z = zipContents(zip);
  log(`${tag} zip entries`, z.entries);
  for (const required of ["package-manifest.json", "package-manifest.sig", "package-seal.json", "package-seal.sig", "reports/proovra-verification-report-v1.pdf", "disclosure-manifest.json"]) {
    expect(z.entries, `package holds ${required}`).toContain(required);
  }
  expect(z.texts["package-manifest.json"] ?? "").toContain(evidenceId);
  return { pdf, zip, zipSha: sha256Hex(zipBytes), pdfTextValue: text.text, zipEntries: z.entries, texts: z.texts };
}

/** UI meters (shell, Home, Billing) against the server's own projection and Postgres. */
async function checkMeters(page: Page, label: string): Promise<{ held: number; cap: number; usedBytes: string; usedLabel: string }> {
  await page.goto("/home");
  await settle(page);
  const proj = await personalProjection(page);
  const adm = proj.evidenceAdmission;
  const st = proj.usage.storage;
  const held = adm.recordsHeld as number;
  const cap = adm.effectiveLifetimeCap as number;
  log(`meters ${label} server`, { held, cap, next: adm.next, credits: adm.creditsAvailable, storage: { state: st.state, used: st.usedBytes, limit: st.limitBytes, usedLabel: st.usedLabel, limitLabel: st.limitLabel } });
  await expect(page.locator("[data-sidebar-records]").first()).toHaveAttribute("data-sidebar-records", `${held} of ${cap} records`);
  await expect(page.locator("[data-sidebar-storage-detail]").first()).toHaveText(`${st.usedLabel} of ${st.limitLabel}`);
  await page.goto("/billing");
  await settle(page);
  const count = page.locator("[data-billing-evidence-count]").first();
  if (await count.isVisible().catch(() => false)) log(`meters ${label} billing evidence`, await page.locator("[data-billing-evidence-detail]").first().innerText());
  const used = page.locator("[data-billing-storage-used]").first();
  if (await used.isVisible().catch(() => false)) {
    await expect(used).toHaveText(st.usedLabel);
  }
  await shot(page, `fev-meters-${label}`);
  const dbCount = Number(sql(`select count(*) from evidence where owner_user_id = '${s.facts.freeUserId}' and status <> 'CREATED'`)[0]![0]);
  log(`meters ${label} db non-draft evidence`, dbCount);
  return { held, cap, usedBytes: String(st.usedBytes), usedLabel: String(st.usedLabel) };
}

test.beforeAll(async () => {
  await assertIsolatedStack();
});
test.afterEach(() => saveState(s));

test("E00 the published Free allowance: Pricing and the plan catalogue agree", async ({ browser }) => {
  const free = PLAN_CAPABILITIES.FREE;
  log("catalogue FREE", { maxEvidenceRecords: free.maxEvidenceRecords, includedStorageBytes: String(free.includedStorageBytes), intakeIncluded: free.intakeIncluded, reports: free.reportsIncluded, package: free.verificationPackageIncluded });
  expect(free.maxEvidenceRecords).toBe(3);
  expect(free.includedStorageBytes).toBe(250n * 1024n * 1024n);
  expect(free.intakeIncluded).toBe(false);
  const { context, page } = await newProfile(browser);
  await page.goto("/pricing");
  await settle(page);
  await expect(page.locator("main")).toContainText("3 complete evidence records total");
  await expect(page.locator("main")).toContainText("250 MB");
  await shot(page, "fev-e00-pricing");
  await context.close();
});

test("E01 a new Free user registers; meters start at zero", async ({ browser }) => {
  const free = fev(s, "free", "Free Evidence User");
  const { context, page } = await newProfile(browser);
  await registerAccount(page, free);
  s.facts.freeUserId = userIdOf(free.email);
  s.facts.freeTeamId = personalTeamOf(s.facts.freeUserId);
  const m = await checkMeters(page, "e01-start");
  expect(m.held).toBe(0);
  expect(m.cap).toBe(3);
  s.facts.ledgerStart = JSON.stringify(ledger(s.facts.freeUserId, s.facts.freeTeamId));
  log("ledger start", s.facts.ledgerStart);
  await keepProfile(context, free, s, "free");
  await context.close();
});

test("E02 record 1, captured with location, through the web capture page; worker outputs download", async ({ browser }) => {
  const free = s.people.free!;
  const { context, page } = await newProfile(browser, free);
  await context.grantPermissions(["geolocation"], { origin: WEB_BASE });
  await context.setGeolocation({ latitude: LAT, longitude: LNG, accuracy: 12 });
  if (!s.facts.r1) {
  await page.goto("/capture");
  await settle(page);
  if (!(await page.locator("[data-capture-location-toggle]").isVisible().catch(() => false))) {
    await page.getByRole("button", { name: /Change setup/ }).click();
  }
  await page.locator("[data-capture-location-toggle]").check();
  await expect(page.locator("small[data-capture-location-check]")).not.toHaveAttribute("data-capture-location-check", /off|checking/, { timeout: 30_000 });
  log("location check", await page.locator("small[data-capture-location-check]").getAttribute("data-capture-location-check"));
  await stage(page, "r1");
  const creates: string[] = [];
  page.on("response", (r) => {
    if (r.request().method() === "POST" && r.url() === `${API_BASE}/v1/evidence`) void r.text().then((t) => creates.push(`${r.status()} ${t.slice(0, 200)}`));
  });
  await reviewAndSign(page);
  await page.waitForURL(/\/evidence\/[0-9a-f-]{36}/, { timeout: 90_000 });
  const id = page.url().match(/evidence\/([0-9a-f-]{36})/)![1]!;
  s.facts.r1 = id;
  saveState(s);
  log("r1 create answers", creates);
  }
  const id = s.facts.r1;
  await waitReported(page, id);
  await shot(page, "fev-e02-r1-reported");
  const out = await checkOutputs(page, id, "r1");
  s.facts.r1Zip = out.zip;
  s.facts.r1Pdf = out.pdf;
  s.facts.r1ZipSha = out.zipSha;
  const [lat, lng] = sql(`select lat, lng from evidence where id = '${id}'`)[0]!;
  log("r1 stored coordinates", { lat, lng });
  s.facts.r1Lat = lat!;
  s.facts.r1Lng = lng!;
  const m = await checkMeters(page, "e02-after-r1");
  expect(m.held).toBe(1);
  await keepProfile(context, free, s, "free");
  await context.close();
});

type Trail = { creates: Array<{ status: number; body: string }>; puts: number; putAborts: number; completes: number; completeAborts: number };

/** Route the storage PUT and the Finish call so a test can fail them on purpose. */
async function instrument(page: Page, ctl: { failPut: boolean; failCompleteOnce: boolean }): Promise<Trail> {
  const t: Trail = { creates: [], puts: 0, putAborts: 0, completes: 0, completeAborts: 0 };
  page.on("response", (r) => {
    if (r.request().method() === "POST" && r.url() === `${API_BASE}/v1/evidence`) {
      void r.text().then((b) => t.creates.push({ status: r.status(), body: b.slice(0, 400) })).catch(() => undefined);
    }
  });
  await page.route((u) => STORAGE_HOST.test(u.host), async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    t.puts += 1;
    if (ctl.failPut) {
      t.putAborts += 1;
      return route.abort("connectionreset");
    }
    return route.continue();
  });
  await page.route(/\/v1\/evidence\/[0-9a-f-]{36}\/complete$/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    t.completes += 1;
    if (ctl.failCompleteOnce) {
      ctl.failCompleteOnce = false;
      t.completeAborts += 1;
      return route.abort("connectionreset");
    }
    return route.continue();
  });
  return t;
}

async function finishSettledOnCapture(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Review & Sign", exact: true }).last()).toBeEnabled({ timeout: 120_000 });
  expect(page.url()).toContain("/capture");
}

function diffLedger(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const d: Record<string, number> = {};
  for (const k of Object.keys(after)) if (after[k] !== before[k]) d[k] = after[k]! - before[k]!;
  return d;
}

test("E03 record 2: a failed storage PUT, then a failed Finish, retried into the same record", async ({ browser }) => {
  const free = s.people.free!;
  const before = ledger(s.facts.freeUserId!, s.facts.freeTeamId!);
  const { context, page } = await newProfile(browser, free);
  const ctl = { failPut: true, failCompleteOnce: false };
  const t = await instrument(page, ctl);
  await page.goto("/capture");
  await settle(page);
  await stage(page, "r2");
  await reviewAndSign(page);
  await expect.poll(() => t.putAborts, { timeout: 60_000 }).toBeGreaterThan(0);
  await finishSettledOnCapture(page);
  await shot(page, "fev-e03-put-failed");
  log("e03 after failed PUT", { trail: t, alert: await page.locator('[role="alert"], [role="status"]').allInnerTexts().catch(() => []) });
  const reserved = JSON.parse(t.creates[0]!.body).id as string;
  expect(sql(`select status from evidence where id = '${reserved}'`)[0]![0]).not.toBe("SIGNED");

  ctl.failPut = false;
  ctl.failCompleteOnce = true;
  await reviewAndSign(page);
  await expect.poll(() => t.completeAborts, { timeout: 60_000 }).toBe(1);
  await finishSettledOnCapture(page);
  await shot(page, "fev-e03-complete-failed");
  log("e03 after failed Finish", { trail: t, alert: await page.locator('[role="alert"], [role="status"]').allInnerTexts().catch(() => []) });

  await reviewAndSign(page);
  await page.waitForURL(/\/evidence\/[0-9a-f-]{36}/, { timeout: 90_000 });
  const id = page.url().match(/evidence\/([0-9a-f-]{36})/)![1]!;
  log("e03 trail", t);
  expect(id, "the retry finished the record reserved by the first attempt").toBe(reserved);
  expect(t.creates.length, "one record was ever requested").toBe(1);
  s.facts.r2 = id;
  await waitReported(page, id);
  await checkOutputs(page, id, "r2");
  const after = ledger(s.facts.freeUserId!, s.facts.freeTeamId!);
  log("e03 ledger diff", diffLedger(before, after));
  expect(after.evidence_rows! - before.evidence_rows!).toBe(1);
  expect(after.evidence_parts! - before.evidence_parts!).toBe(1);
  const m = await checkMeters(page, "e03-after-r2");
  expect(m.held).toBe(2);
  await keepProfile(context, free, s, "free");
  await context.close();
});

test("E04 record 3: a refresh mid-upload, then resume the draft and finish the same reserved record", async ({ browser }) => {
  const free = s.people.free!;
  const before = ledger(s.facts.freeUserId!, s.facts.freeTeamId!);
  const { context, page } = await newProfile(browser, free);
  const ctl = { failPut: true, failCompleteOnce: false };
  const t = await instrument(page, ctl);
  await page.goto("/capture");
  await settle(page);
  await stage(page, "r3");
  await reviewAndSign(page);
  await expect.poll(() => t.putAborts, { timeout: 60_000 }).toBeGreaterThan(0);
  const reserved = JSON.parse(t.creates[0]!.body).id as string;
  // The person refreshes while the upload is failing.
  ctl.failPut = false;
  await page.reload();
  await settle(page);
  await shot(page, "fev-e04-after-refresh");
  const mid = ledger(s.facts.freeUserId!, s.facts.freeTeamId!);
  log("e04 mid-flow ledger diff", diffLedger(before, mid));
  await expect(page.getByRole("region", { name: "Unfinished capture sessions" })).toBeVisible();
  await page.getByRole("button", { name: /^Drafts \(/ }).click();
  await page.getByRole("dialog", { name: "Unfinished capture drafts" }).getByRole("button", { name: "Resume" }).first().click();
  await expect(page.locator("[data-capture-reattach]")).toBeVisible();
  await shot(page, "fev-e04-resume-reattach");
  await stage(page, "r3");
  await reviewAndSign(page);
  await page.waitForURL(/\/evidence\/[0-9a-f-]{36}/, { timeout: 90_000 });
  const id = page.url().match(/evidence\/([0-9a-f-]{36})/)![1]!;
  log("e04 creates", t.creates);
  expect(id, "the resumed draft finished the record reserved before the refresh").toBe(reserved);
  expect(JSON.parse(t.creates[t.creates.length - 1]!.body).resumed ?? null).toBe(true);
  s.facts.r3 = id;
  await waitReported(page, id);
  await checkOutputs(page, id, "r3");
  const after = ledger(s.facts.freeUserId!, s.facts.freeTeamId!);
  log("e04 ledger diff", diffLedger(before, after));
  expect(after.evidence_rows! - before.evidence_rows!).toBe(1);
  const m = await checkMeters(page, "e04-after-r3");
  expect(m.held).toBe(3);
  await keepProfile(context, free, s, "free");
  await context.close();
});

const MUST_NOT_MOVE = [
  "evidence_rows",
  "evidence_parts",
  "upload_sessions",
  "evidence_upload_sessions",
  "credit_ledger_rows",
  "credit_ledger_sum",
  "entitlement_usage_consumed",
  "checkout_attempts",
  "entitlement_credits",
  "verification_packages",
  "reports",
];

test("E05 the fourth record is refused before upload, with copy and a working upgrade path, and leaves nothing", async ({ browser }) => {
  const free = s.people.free!;
  const before = ledger(s.facts.freeUserId!, s.facts.freeTeamId!);
  log("e05 ledger before", before);
  const { context, page } = await newProfile(browser, free);
  const ctl = { failPut: false, failCompleteOnce: false };
  const t = await instrument(page, ctl);
  await page.goto("/capture");
  await settle(page);
  const notice = page.locator('[data-capture-allowance-notice="capture_records_exhausted"]');
  await expect(notice).toBeVisible();
  s.facts.e05Notice = await notice.innerText();
  log("e05 capture notice", s.facts.e05Notice);
  await stage(page, "r4");
  await shot(page, "fev-e05-notice");
  await reviewAndSign(page);
  await expect.poll(() => t.creates.length, { timeout: 30_000 }).toBe(1);
  log("e05 create answer", t.creates[0]);
  expect(t.creates[0]!.status).toBe(409);
  expect(JSON.parse(t.creates[0]!.body).code).toBe("FREE_LIMIT_REACHED");
  await page.waitForTimeout(1500);
  const alerts = (await page.locator('[role="alert"], [role="status"]').allInnerTexts()).filter((x) => x.trim());
  s.facts.e05Alerts = JSON.stringify(alerts);
  log("e05 alerts", alerts);
  await shot(page, "fev-e05-refused");
  expect(alerts.join(" ")).toMatch(/record limit|Free record limit|records your plan includes/i);
  expect(t.puts, "no byte left the browser").toBe(0);
  expect(page.url()).toContain("/capture");
  await expect(page.getByText("1 material added").first()).toBeVisible();

  // The upgrade destination the notice and the refusal name.
  const plans = page.locator('[data-capture-allowance] a[href="/billing"]').first();
  await expect(plans).toBeVisible();
  const [tab] = await Promise.all([context.waitForEvent("page"), plans.click()]);
  await tab.waitForLoadState("domcontentloaded");
  await settle(tab);
  expect(new URL(tab.url()).pathname).toBe("/billing");
  await expect(tab.locator("[data-billing-evidence-detail]")).toContainText("Your included records are used up");
  const action = tab.locator("[data-billing-evidence-action], [data-billing-evidence-detail] button").first();
  s.facts.e05BillingAction = (await action.innerText().catch(() => "")).trim();
  log("e05 billing action", s.facts.e05BillingAction);
  await shot(tab, "fev-e05-billing");
  await tab.close();

  // The same create, straight at the API: the canonical refusal, nothing written.
  const direct = await api(page, "POST", "/v1/evidence", { type: "PHOTO", mimeType: "image/png", originalFileName: "fev-direct.png" });
  log("e05 direct create", { status: direct.status, body: direct.text });
  expect(direct.status).toBe(409);
  expect(direct.json.code).toBe("FREE_LIMIT_REACHED");

  const after = ledger(s.facts.freeUserId!, s.facts.freeTeamId!);
  const diff = diffLedger(before, after);
  s.facts.e05LedgerDiff = JSON.stringify(diff);
  log("e05 ledger diff", diff);
  for (const k of MUST_NOT_MOVE) expect(after[k], k).toBe(before[k]);
  const m = await checkMeters(page, "e05-after-refusal");
  expect(m.held).toBe(3);
  await keepProfile(context, free, s, "free");
  await context.close();
});

/** A native-style sign-in: no x-web-client header, so the API answers with a bearer token. */
async function nativeToken(request: import("@playwright/test").APIRequestContext, email: string, password: string): Promise<string> {
  const r = await request.post(`${API_BASE}/v1/auth/email/login`, { data: { email, password } });
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()).token as string;
}

test("E06 [API-NATIVE] clientAttemptId replay and duplicate-content bytes through the native capture path", async ({ browser, request }) => {
  const native = fev(s, "native", "Native Path User");
  if (!s.facts.nativeUserId) {
    const { context, page } = await newProfile(browser);
    await registerAccount(page, native);
    await keepProfile(context, native, s, "native");
    await context.close();
    s.facts.nativeUserId = userIdOf(native.email);
    s.facts.nativeTeamId = personalTeamOf(s.facts.nativeUserId);
  }
  const uid = s.facts.nativeUserId!;
  const before = ledger(uid, s.facts.nativeTeamId!);
  const token = await nativeToken(request, native.email, native.password);
  s.facts.nativeToken = token;
  const H = { authorization: `Bearer ${token}` };
  const post = async (path: string, data: unknown) => {
    const r = await request.post(`${API_BASE}${path}`, { headers: H, data });
    const text = await r.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* none */
    }
    return { status: r.status(), json, text: text.slice(0, 600) };
  };
  const bytes = samplePng(`fev-native-dup-${s.runId}`);
  const { createHash } = await import("node:crypto");
  const shaHex = createHash("sha256").update(bytes).digest("hex");
  const shaB64 = createHash("sha256").update(bytes).digest("base64");
  const md5B64 = createHash("md5").update(bytes).digest("base64");
  const facts: Record<string, unknown> = {};

  async function oneCapture(tag: string): Promise<string> {
    const attempt = randomUUID();
    const open1 = await post("/v1/capture/direct-sessions", { mode: "PROOVRA_MOBILE_APP", clientAttemptId: attempt });
    const open2 = await post("/v1/capture/direct-sessions", { mode: "PROOVRA_MOBILE_APP", clientAttemptId: attempt });
    facts[`${tag}.open`] = [open1.status, open2.status, open1.json?.session?.captureSessionId === open2.json?.session?.captureSessionId];
    expect(open1.status, open1.text).toBe(201);
    expect(open2.status, open2.text).toBe(200);
    const sid = open1.json.session.captureSessionId as string;
    expect(open2.json.session.captureSessionId).toBe(sid);
    const reserve1 = await post(`/v1/capture/direct-sessions/${sid}/evidence`, { type: "PHOTO", mimeType: "image/png", deviceTimeIso: new Date().toISOString(), originalFileName: `fev-native-${tag}.png` });
    expect(reserve1.status, reserve1.text).toBe(201);
    const eid = reserve1.json.evidence.evidenceId as string;
    // The reserve answer was "lost": the app replays the open with the same attempt id.
    const open3 = await post("/v1/capture/direct-sessions", { mode: "PROOVRA_MOBILE_APP", clientAttemptId: attempt });
    facts[`${tag}.open3`] = { status: open3.status, sameSession: open3.json?.session?.captureSessionId === sid, reservedEvidenceId: open3.json?.session?.reservedEvidenceId };
    expect(open3.json?.session?.reservedEvidenceId).toBe(eid);
    const reserve2 = await post(`/v1/capture/direct-sessions/${sid}/evidence`, { type: "PHOTO", mimeType: "image/png", deviceTimeIso: new Date().toISOString(), originalFileName: `fev-native-${tag}.png` });
    facts[`${tag}.reserve2`] = { status: reserve2.status, body: reserve2.text.slice(0, 240), sameEvidence: reserve2.json?.evidence?.evidenceId === eid };
    const declared = await post(`/v1/capture/direct-sessions/${sid}/parts/0/declaration`, { sha256: shaHex, clientReportedSource: "FILE_PICKER", signed: null });
    expect(declared.status, declared.text).toBeLessThan(300);
    const partBody = { partIndex: 0, mimeType: "image/png", originalFileName: `fev-native-${tag}.png`, checksumSha256Base64: shaB64, contentMd5Base64: md5B64, sizeBytes: bytes.length };
    const part1 = await post(`/v1/evidence/${eid}/parts`, partBody);
    expect(part1.status, part1.text).toBeLessThan(300);
    const part2 = await post(`/v1/evidence/${eid}/parts`, partBody);
    facts[`${tag}.partReplay`] = { first: part1.status, replay: part2.status, body: part2.text.slice(0, 160) };
    const putUrl = (part2.json?.upload?.putUrl ?? part1.json.upload.putUrl) as string;
    for (let i = 0; i < 2; i += 1) {
      // The same bytes sent twice (a retried PUT after a lost answer).
      const put = await request.put(putUrl, { headers: { "content-type": "image/png", "x-amz-checksum-sha256": shaB64, "Content-MD5": md5B64 }, data: bytes });
      facts[`${tag}.put${i}`] = put.status();
      expect(put.status()).toBeLessThan(300);
    }
    const done1 = await post(`/v1/capture/direct-sessions/${sid}/complete`, {});
    expect(done1.status, done1.text).toBe(200);
    expect(done1.json.result.evidenceId).toBe(eid);
    const done2 = await post(`/v1/capture/direct-sessions/${sid}/complete`, {});
    facts[`${tag}.completeReplay`] = { status: done2.status, body: done2.text.slice(0, 240) };
    return eid;
  }

  const e1 = s.facts.n1 ?? (s.facts.n1 = await oneCapture("n1"));
  saveState(s);
  const e2 = s.facts.n2 ?? (s.facts.n2 = await oneCapture("n2"));
  saveState(s);
  log("e06 facts", facts);
  if (Object.keys(facts).length) s.facts.e06Facts = JSON.stringify(facts);
  expect(e2).not.toBe(e1);
  const after = ledger(uid, s.facts.nativeTeamId!);
  log("e06 ledger diff", diffLedger(before, after));
  const rows = sql(`select id, status, file_sha256 from evidence where owner_user_id = '${uid}' order by created_at`);
  log("e06 native evidence rows", rows);
  expect(rows.length, "two records: one per attempt, none per replay").toBe(2);
  const parts = sql(`select e.id, count(p.id) from evidence e left join evidence_parts p on p.evidence_id = e.id where e.owner_user_id = '${uid}' group by e.id`);
  log("e06 parts per record", parts);
  for (const p of parts) expect(Number(p[1])).toBe(1);
  // The allowance moved once per record.
  const proj = await request.get(`${API_BASE}/v1/billing/accounts`, { headers: H });
  const personal = ((await proj.json()).accounts as Array<{ type: string; id: string }>).find((a) => a.type === "PERSONAL")!;
  const acc = await (await request.get(`${API_BASE}/v1/billing/accounts/PERSONAL/${personal.id}`, { headers: H })).json();
  log("e06 allowance", acc.evidenceAdmission);
  expect(acc.evidenceAdmission.recordsHeld).toBe(2);
  // The second record's package names the duplicate digest (worker output).
  await expect
    .poll(async () => sql(`select count(*) from verification_packages where evidence_id = '${e2}' and state = 'PUBLISHED'`)[0]![0], { timeout: 180_000, intervals: [3000] })
    .not.toBe("0");
  const pkg = await (await request.get(`${API_BASE}/v1/evidence/${e2}/verification-package`, { headers: H })).json();
  const zipBytes = Buffer.from(await (await request.get(pkg.url)).body());
  const zip = zipContents(save("n2-package.zip", zipBytes));
  s.facts.e06DuplicateDigests = (zip.texts["duplicate-digests.json"] ?? "").slice(0, 800);
  log("e06 n2 duplicate-digests.json", s.facts.e06DuplicateDigests);
});

test("E07 public Verify by reference, check a package by file (only the SHA-256 leaves), limited-use reloads", async ({ browser }) => {
  const r1 = s.facts.r1!;
  const ref = sql(`select verification_ref from evidence where id = '${r1}'`)[0]![0]!;
  s.facts.r1Ref = ref;
  // The owner's own entry point to the verification page.
  const owner = await newProfile(browser, s.people.free!);
  await owner.page.goto(`/evidence/${r1}`);
  await settle(owner.page);
  const vlink = owner.page.locator('[data-evidence-action="open-verification-link"]').first();
  log("e07 owner verification-link control", { visible: await vlink.isVisible().catch(() => false), href: await vlink.getAttribute("href").catch(() => null) });

  // 1. Anonymous: the hero form, then the canonical page, reloaded.
  const anon = await newProfile(browser);
  const verifyGets: string[] = [];
  anon.page.on("response", (r) => {
    if (r.url().startsWith(`${API_BASE}/public/verify/`)) verifyGets.push(`${r.status()}`);
  });
  await anon.page.goto("/verify");
  await settle(anon.page);
  await anon.page.getByTestId("verification-token-input").fill(ref);
  await anon.page.getByTestId("verification-submit").click();
  await anon.page.waitForURL(new RegExp(`/verify/${ref}`), { timeout: 30_000 });
  await settle(anon.page);
  const card = anon.page.getByTestId("verify-matrix-summary-card");
  await expect(card).toBeVisible();
  const tone = await card.getAttribute("data-summary-tone");
  const summary = (await anon.page.getByTestId("verify-matrix-summary").innerText().catch(() => "")).slice(0, 300);
  log("e07 canonical page", { tone, summary, rows: await anon.page.locator('[data-testid^="verify-matrix-row-"]').evaluateAll((els) => els.map((e) => `${e.getAttribute("data-testid")}=${e.getAttribute("data-status")}`)) });
  await shot(anon.page, "fev-e07-verify-ref");
  for (let i = 0; i < 4; i += 1) {
    await anon.page.reload();
    await settle(anon.page);
    await expect(anon.page.getByTestId("verify-matrix-summary-card")).toHaveAttribute("data-summary-tone", tone ?? "");
    await expect(anon.page.getByTestId("verify-link-notice")).toHaveCount(0);
  }
  log("e07 /public/verify answers over 5 loads", verifyGets);
  s.facts.e07RefLoads = JSON.stringify(verifyGets);
  expect(verifyGets.every((x) => x === "200")).toBe(true);
  // The record's identifier alone (UUID) is not a capability after tokens (legacy grace only).
  const byUuid = await anon.page.request.get(`${API_BASE}/public/verify/${r1}`);
  s.facts.e07ByUuid = String(byUuid.status());
  log("e07 /public/verify/<uuid>", { status: byUuid.status(), body: (await byUuid.text()).slice(0, 160) });

  // 2. Check a package by file: hashed in the browser, only the digest is sent.
  const sent: Array<{ method: string; url: string; bodyBytes: number }> = [];
  anon.page.on("request", (r) => sent.push({ method: r.method(), url: r.url(), bodyBytes: r.postDataBuffer()?.length ?? 0 }));
  await anon.page.goto("/verify");
  await settle(anon.page);
  sent.length = 0;
  const zipBytes = readFileSync(s.facts.r1Zip!);
  await anon.page.getByTestId("verify-package-file").setInputFiles(s.facts.r1Zip!);
  const result = anon.page.getByTestId("verify-package-by-file-result");
  await expect(result).toHaveAttribute("data-outcome", "registered", { timeout: 30_000 });
  await shot(anon.page, "fev-e07-package-by-file");
  const apiCalls = sent.filter((r) => r.url.startsWith(API_BASE));
  const withBody = sent.filter((r) => r.bodyBytes > 0);
  log("e07 package-by-file requests", { api: apiCalls, anyWithBody: withBody, zipBytes: zipBytes.length, zipSha: s.facts.r1ZipSha });
  s.facts.e07ByFileRequests = JSON.stringify(apiCalls);
  expect(apiCalls.length).toBe(1);
  expect(apiCalls[0]!.method).toBe("GET");
  expect(apiCalls[0]!.url).toBe(`${API_BASE}/public/verification-packages/by-sha256/${s.facts.r1ZipSha}`);
  expect(withBody, "no request carried a body").toEqual([]);
  await anon.page.getByTestId("verify-package-record-link").click();
  await anon.page.waitForURL(/\/verify\/package\//);
  await settle(anon.page);
  await expect(anon.page.getByTestId("package-record-sha256")).toContainText(s.facts.r1ZipSha!);
  await shot(anon.page, "fev-e07-package-record");
  // A file that is not a ZIP is refused locally, with no request at all.
  await anon.page.goto("/verify");
  await settle(anon.page);
  sent.length = 0;
  await anon.page.getByTestId("verify-package-file").setInputFiles(fileFor("not-a-zip"));
  await expect(anon.page.getByTestId("verify-package-by-file-result")).toHaveAttribute("data-outcome", "invalid");
  expect(sent.filter((r) => r.url.startsWith(API_BASE))).toEqual([]);

  // 3. A limited-use link (owner-issued, two uses).
  const made = await api(owner.page, "POST", `/v1/evidence/${r1}/verify-links`, { audience: "fev acceptance reviewer", expiresInDays: 7, projection: "BASIC", maxUses: 2, allowOriginalDownload: false });
  log("e07 limited link create", { status: made.status, body: made.text.slice(0, 300) });
  s.facts.e07LimitedCreate = `${made.status} ${made.text.slice(0, 200)}`;
  if (made.status === 201) {
    const token = made.json.token as string;
    const linkId = made.json.link?.id as string;
    const uses = () => sql(`select use_count from verification_share_tokens where id = '${linkId}'`)[0]![0];
    const a = await newProfile(browser);
    await a.page.goto(`/verify/${token}`);
    await settle(a.page);
    await expect(a.page.getByTestId("verify-link-notice")).toHaveCount(0);
    const afterA = uses();
    for (let i = 0; i < 3; i += 1) {
      await a.page.reload();
      await settle(a.page);
      await expect(a.page.getByTestId("verify-link-notice")).toHaveCount(0);
    }
    const afterReloads = uses();
    const b = await newProfile(browser);
    await b.page.goto(`/verify/${token}`);
    await settle(b.page);
    await expect(b.page.getByTestId("verify-link-notice")).toHaveCount(0);
    const afterB = uses();
    const c = await newProfile(browser);
    await c.page.goto(`/verify/${token}`);
    await settle(c.page);
    const cNotice = await c.page.getByTestId("verify-link-notice").getAttribute("data-notice").catch(() => null);
    await shot(c.page, "fev-e07-limited-exhausted");
    await b.page.reload();
    await settle(b.page);
    const bAfter = await b.page.getByTestId("verify-link-notice").getAttribute("data-notice", { timeout: 3000 }).catch(() => null);
    await a.page.reload();
    await settle(a.page);
    const aAfter = await a.page.getByTestId("verify-link-notice").getAttribute("data-notice", { timeout: 3000 }).catch(() => null);
    const raw = await c.page.request.get(`${API_BASE}/public/verify/${token}`);
    const facts = { afterA, afterReloads, afterB, cNotice, bReloadAfterExhausted: bAfter, aReloadAfterExhausted: aAfter, rawNoSession: `${raw.status()} ${(await raw.text()).slice(0, 160)}`, final: uses() };
    log("e07 limited-use", facts);
    s.facts.e07Limited = JSON.stringify(facts);
    expect(afterA).toBe("1");
    expect(afterReloads, "a reload in the same tab spends no use").toBe("1");
    expect(afterB).toBe("2");
    expect(cNotice).toBe("LINK_ENDED");
    expect(bAfter, "the session that spent the last use may reload").toBeNull();
    expect(raw.status()).toBe(410);
    for (const x of [a, b, c]) await x.context.close();
  }
  await anon.context.close();
  await owner.context.close();
});

function coordinateHits(texts: Record<string, string>, lat: string, lng: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const latRe = new RegExp(lat.replace(".", "\\.") + "\\d*");
  const lngRe = new RegExp(lng.replace(".", "\\.") + "\\d*");
  const coarseLat = lat.slice(0, lat.indexOf(".") + 3);
  for (const [name, text] of Object.entries(texts)) {
    const hits: string[] = [];
    if (latRe.test(text)) hits.push(`lat:${text.match(latRe)![0]}`);
    if (lngRe.test(text)) hits.push(`lng:${text.match(lngRe)![0]}`);
    const coarse = text.match(new RegExp(`"[^"]*"\\s*:\\s*${coarseLat.replace(".", "\\.")}\\b(?!\\d)`));
    if (coarse) hits.push(`coarse:${coarse[0]}`);
    if (text.includes("[withheld]")) hits.push("withheld");
    if (hits.length) out[name] = hits;
  }
  return out;
}

/** The external-disclosure package of a version, fetched by its own route, inspected. */
async function externalPackage(page: Page, evidenceId: string, version: number, tag: string) {
  const r = await api(page, "GET", `/v1/evidence/${evidenceId}/verification-packages/${version}/external-disclosure`);
  log(`${tag} external-disclosure route`, { status: r.status, body: r.text.slice(0, 300) });
  if (r.status !== 200) return { status: r.status, body: r.text, zip: null as null | { entries: string[]; texts: Record<string, string> } };
  const bytes = Buffer.from(await (await page.context().request.get(r.json.url)).body());
  return { status: 200, body: r.text, zip: zipContents(save(`${tag}-external.zip`, bytes)) };
}

test("E08 exact location: the owner's report shows the coordinates, the external-disclosure package does not disclose them exactly", async ({ browser }) => {
  const r1 = s.facts.r1!;
  const lat = s.facts.r1Lat!;
  const lng = s.facts.r1Lng!;
  const pdf = pdfText(s.facts.r1Pdf!).text;
  const pdfHasLat = pdf.includes(lat);
  const pdfHasLng = pdf.includes(lng);
  const around = pdf.slice(Math.max(0, pdf.indexOf(lat) - 120), pdf.indexOf(lat) + 80);
  log("e08 owner report", { lat, lng, pdfHasLat, pdfHasLng, around });
  s.facts.e08OwnerReport = JSON.stringify({ lat, lng, pdfHasLat, pdfHasLng, around });
  expect(pdfHasLat && pdfHasLng, "the owner's report prints the recorded coordinates").toBe(true);

  const full = zipContents(s.facts.r1Zip!);
  const fullHits = coordinateHits(full.texts, lat, lng);
  log("e08 full package coordinate hits", fullHits);

  const { context, page } = await newProfile(browser, s.people.free!);
  await page.goto(`/evidence/${r1}`);
  await settle(page);
  const ext = await externalPackage(page, r1, 1, "r1-v1");
  expect(ext.status).toBe(200);
  const extHits = coordinateHits(ext.zip!.texts, lat, lng);
  const disclosure = JSON.parse(ext.zip!.texts["disclosure-manifest.json"] ?? "{}");
  log("e08 external v1", { entries: ext.zip!.entries.length, hasCaptureContext: ext.zip!.entries.includes("capture-context.json"), hasMap: ext.zip!.entries.includes("map-preview.png"), hits: extHits, disclosure: JSON.stringify(disclosure).slice(0, 900) });
  s.facts.e08ExternalV1 = JSON.stringify({ hits: extHits, captureContext: ext.zip!.entries.includes("capture-context.json"), map: ext.zip!.entries.includes("map-preview.png") });
  for (const [name, hits] of Object.entries(extHits)) {
    expect(hits.filter((h) => h.startsWith("lat:") || h.startsWith("lng:")), `${name} carries no exact coordinate`).toEqual([]);
  }

  // Can a Free owner disclose the location and issue a package that coarsens it?
  const access = await api(page, "GET", `/v1/evidence/${r1}/verification-access`);
  log("e08 verification-access", { status: access.status, body: access.text.slice(0, 400) });
  const version = access.json?.disclosure?.version ?? access.json?.disclosurePolicy?.version ?? 0;
  const put = await api(page, "PUT", `/v1/evidence/${r1}/verification-disclosure`, { mode: "CONTENT_PREVIEW", showRecordedLocation: true, expectedVersion: version });
  log("e08 disclosure put", { status: put.status, body: put.text.slice(0, 300) });
  const regen = await api(page, "POST", `/v1/evidence/${r1}/reports/regenerate`, { intent: "NEW_VERSION", reason: "Location disclosure changed for the recipient", clientRequestKey: `fev-e08-${s.runId}` });
  log("e08 regenerate on Free", { status: regen.status, body: regen.text.slice(0, 400) });
  s.facts.e08FreeDisclosure = JSON.stringify({ put: put.status, putBody: put.text.slice(0, 200), regen: regen.status, regenBody: regen.text.slice(0, 300) });
  await context.close();
});

const OPERATOR_ID = "0adf0000-0000-4000-8000-000000000001";

function intakeLinks(teamId: string): string[][] {
  return sql(`select id, status, coalesce(recipient_email, ''), used_count, to_char(expires_at_utc, 'YYYY-MM-DD"T"HH24:MI:SS'), coalesce(to_char(revoked_at_utc, 'HH24:MI:SS'), '') from workflow_intake_links where team_id = '${teamId}' order by created_at`);
}

async function teamIdFromPage(page: Page): Promise<string> {
  return personalTeamOf(userIdOf(s.people.intake!.email));
}

test("E09 Free cannot create intake links: the catalogue, the UI and the API refuse cleanly", async ({ browser }) => {
  const intake = fev(s, "intake", "Intake Owner");
  const { context, page } = await newProfile(browser);
  if (!s.facts.intakeUserId) {
    await registerAccount(page, intake);
    s.facts.intakeUserId = userIdOf(intake.email);
    s.facts.intakeTeamId = personalTeamOf(s.facts.intakeUserId);
    await keepProfile(context, intake, s, "intake");
  }
  await context.close();
  const p = await newProfile(browser, intake);
  const page2 = p.page;
  await page2.goto("/home");
  await settle(page2);
  const navHasIntake = await page2.locator('a[href="/intake-links"]').count();
  await page2.goto("/intake-links");
  await settle(page2);
  await shot(page2, "fev-e09-free-intake-links");
  const manageOnly = page2.locator('[data-intake-links-manage-only="true"]');
  const facts = {
    navLinks: navHasIntake,
    manageOnlyVisible: await manageOnly.isVisible().catch(() => false),
    manageOnlyText: (await manageOnly.innerText().catch(() => "")).slice(0, 300),
    newCta: await page2.locator('[data-intake-links-new-cta="true"]').count(),
    emptyCreate: await page2.locator('[data-intake-links-empty-create="true"]').count(),
    pageText: (await page2.locator("main").innerText().catch(() => "")).slice(0, 400),
  };
  await page2.goto("/intake-links?new=1");
  await settle(page2);
  const wizardOnFree = await page2.getByTestId("intake-link-create-wizard").count();
  const refused = await api(page2, "POST", "/v1/workflow/intake-links", {
    teamId: s.facts.intakeTeamId,
    workflowTemplateSlug: "general-evidence-record",
    intakeMode: "EXTERNAL_ONE_TIME",
    deliveryMethod: "MANUAL",
    expiresAtUtc: new Date(Date.now() + 48 * 3600_000).toISOString(),
    idempotencyKey: `fev-free-${s.runId}`,
  });
  log("e09 free intake", { ...facts, wizardOnFree, api: `${refused.status} ${refused.text.slice(0, 300)}` });
  s.facts.e09 = JSON.stringify({ ...facts, wizardOnFree, api: `${refused.status} ${refused.text.slice(0, 300)}` });
  expect(refused.status).toBe(409);
  expect(refused.text).toContain("INTAKE_NOT_INCLUDED");
  expect(facts.newCta).toBe(0);
  expect(wizardOnFree).toBe(0);
  expect(intakeLinks(s.facts.intakeTeamId!).length).toBe(0);
  await p.context.close();
});

test("E10 [FIXTURE-GRANT] paid workspace: create with the wizard, a lost answer retried (B3B-F-102 replay), a changed body refused", async ({ browser }) => {
  const intake = s.people.intake!;
  const recipient = fev(s, "recipient", "Intake Recipient");
  if (!s.facts.grantApplied) {
    const out = stackTsx(["src/scripts/internal-plan-grant.ts", "apply", `--email=${intake.email}`, `--actor-user-id=${OPERATOR_ID}`, "--reason=fev-acceptance-paid-workspace", `--idempotency-key=fev-grant-${s.runId}`, "--confirm"]);
    log("e10 grant apply", out.slice(-600));
    s.facts.grantApplied = "1";
    saveState(s);
  }
  log("e10 team plan", sql(`select billing_plan, billing_status from teams where id = '${s.facts.intakeTeamId}'`));
  const { context, page } = await newProfile(browser, intake);
  const creates: Array<{ status: number; body: string; reqBody: string }> = [];
  page.on("response", (r) => {
    if (r.request().method() === "POST" && r.url() === `${API_BASE}/v1/workflow/intake-links`) {
      void r.text().then((b) => creates.push({ status: r.status(), body: b.slice(0, 1500), reqBody: r.request().postData() ?? "" })).catch(() => undefined);
    }
  });
  let loseNextAnswer = true;
  let lostRequestBody = "";
  let lostAnswer = "";
  await page.route(`${API_BASE}/v1/workflow/intake-links`, async (route) => {
    if (route.request().method() !== "POST" || !loseNextAnswer) return route.continue();
    loseNextAnswer = false;
    lostRequestBody = route.request().postData() ?? "";
    const resp = await route.fetch();
    lostAnswer = `${resp.status()} ${(await resp.text()).slice(0, 400)}`;
    // The server created the link; the browser never hears back.
    await route.abort("connectionreset");
  });
  await page.goto("/intake-links");
  await settle(page);
  await expect(page.locator('[data-intake-links-new-cta="true"]')).toBeVisible();
  await page.locator('[data-intake-links-new-cta="true"]').click();
  const wizard = page.getByTestId("intake-link-create-wizard");
  await expect(wizard).toHaveAttribute("data-intake-link-wizard-step", "request");
  await page.locator("[data-intake-link-wizard-next]").click();
  await expect(wizard).toHaveAttribute("data-intake-link-wizard-step", "delivery");
  // Email and SMS state "Not configured on this deployment" on this stack: the copy-link channel.
  const emailCard = page.locator('[data-intake-link-delivery-method="EMAIL"]');
  s.facts.e10EmailChannel = (await emailCard.innerText()).replace(/\s+/g, " ");
  await page.locator('[data-intake-link-delivery-method="MANUAL"]').click();
  await page.locator("#ilk-f-recipient-label").fill("fev lost answer");
  await page.locator("[data-intake-link-wizard-next]").click();
  await expect(wizard).toHaveAttribute("data-intake-link-wizard-step", "rules");
  await page.locator("[data-intake-link-wizard-next]").click();
  await expect(wizard).toHaveAttribute("data-intake-link-wizard-step", "review");
  await shot(page, "fev-e10-wizard-review");
  const mailBefore = mailbox(recipient.email).length;
  await page.locator("[data-intake-link-submit]").click();
  await expect.poll(() => lostAnswer, { timeout: 30_000 }).not.toBe("");
  await page.waitForTimeout(1500);
  const afterLost = { links: intakeLinks(s.facts.intakeTeamId!), alert: await page.locator("[data-intake-link-create-error]").innerText().catch(() => "") };
  await shot(page, "fev-e10-lost-answer");
  // The person presses the button again.
  await page.locator("[data-intake-link-submit]").click();
  await expect.poll(() => creates.length, { timeout: 30_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(1500);
  await shot(page, "fev-e10-replayed");
  const replayUi = await page.locator("[data-intake-link-create-error], [data-testid=intake-link-created]").first().innerText().catch(() => "");
  await page.waitForTimeout(3000);
  const linksAfterRetry = intakeLinks(s.facts.intakeTeamId!);
  const mailAfterRetry = mailbox(recipient.email).length;
  // The same request, straight at the API, and once with a changed body under the same key.
  const sameBody = JSON.parse(lostRequestBody);
  const replay = await api(page, "POST", "/v1/workflow/intake-links", sameBody);
  const changed = await api(page, "POST", "/v1/workflow/intake-links", { ...sameBody, recipientLabel: "Changed after the fact" });
  const facts = {
    lostAnswer,
    afterLost,
    uiRetry: creates.map((c) => `${c.status} ${c.body.slice(0, 260)}`),
    replayUi: replayUi.slice(0, 400),
    linksAfterRetry,
    mail: { before: mailBefore, afterRetry: mailAfterRetry },
    apiReplay: `${replay.status} ${replay.text.slice(0, 300)}`,
    apiChanged: `${changed.status} ${changed.text.slice(0, 300)}`,
    linksFinal: intakeLinks(s.facts.intakeTeamId!).length,
    mailFinal: mailbox(recipient.email).length,
  };
  log("e10 idempotency", facts);
  s.facts.e10 = JSON.stringify(facts);
  expect(linksAfterRetry.length, "one link after a lost answer and a retry").toBe(1);
  expect(creates[0]!.status).toBe(200);
  expect(JSON.parse(creates[0]!.body).replayed).toBe(true);
  expect(replay.status).toBe(200);
  expect(replay.json.replayed).toBe(true);
  expect(changed.status).toBe(409);
  expect(changed.text).toContain("IDEMPOTENCY_KEY_REUSED");
  expect(facts.linksFinal).toBe(1);
  expect(facts.mailFinal, "nothing is mailed on the copy-link channel").toBe(mailBefore);
  s.facts.linkA = linksAfterRetry[0]![0]!;
  await keepProfile(context, intake, s, "intake");
  await context.close();
});

/** Create a MANUAL link through the wizard; the raw token is read from the create answer. */
async function createManualLink(page: Page, label: string): Promise<{ id: string; token: string }> {
  let answer: any = null;
  const onResp = (r: import("@playwright/test").Response) => {
    if (r.request().method() === "POST" && r.url() === `${API_BASE}/v1/workflow/intake-links`) void r.json().then((j) => (answer = j)).catch(() => undefined);
  };
  page.on("response", onResp);
  await page.goto("/intake-links");
  await settle(page);
  await page.locator('[data-intake-links-new-cta="true"]').click();
  const wizard = page.getByTestId("intake-link-create-wizard");
  await page.locator("#ilk-f-recipient-label").fill(label).catch(() => undefined);
  await page.locator("[data-intake-link-wizard-next]").click();
  await expect(wizard).toHaveAttribute("data-intake-link-wizard-step", "delivery");
  await page.locator('[data-intake-link-delivery-method="MANUAL"]').click();
  await page.locator("[data-intake-link-wizard-next]").click();
  await page.locator("[data-intake-link-wizard-next]").click();
  await expect(wizard).toHaveAttribute("data-intake-link-wizard-step", "review");
  await page.locator("[data-intake-link-submit]").click();
  await expect(page.getByTestId("intake-link-created")).toBeVisible();
  await expect.poll(() => answer?.rawToken ?? null, { timeout: 15_000 }).not.toBeNull();
  page.off("response", onResp);
  await page.keyboard.press("Escape");
  return { id: answer.link.id as string, token: answer.rawToken as string };
}

async function openAsRecipient(browser: import("@playwright/test").Browser, url: string): Promise<{ phase: string | null; errorClass: string | null; page: Page; close: () => Promise<void> }> {
  const r = await newProfile(browser);
  await r.page.goto(url);
  await settle(r.page);
  await expect(r.page.locator("main[data-intake-phase]")).not.toHaveAttribute("data-intake-phase", "loading", { timeout: 30_000 });
  return {
    phase: await r.page.locator("main[data-intake-phase]").getAttribute("data-intake-phase"),
    errorClass: await r.page.locator("[data-intake-error-class]").getAttribute("data-intake-error-class").catch(() => null),
    page: r.page,
    close: () => r.context.close(),
  };
}

test("E11 recipient submits through the emailed link; a revoked link and an expired link are refused", async ({ browser, request }) => {
  const intake = s.people.intake!;
  const recipient = s.people.recipient!;
  const facts: Record<string, unknown> = {};
  // A. A copy-link link works once (the email channel is not configured on this stack).
  const { context, page } = await newProfile(browser, intake);
  const created = await createManualLink(page, "fev submit once");
  s.facts.linkSubmit = created.id;
  const link = `${WEB_BASE}/intake/${created.token}`;
  const a = await openAsRecipient(browser, link);
  facts.aPhase = a.phase;
  if (a.phase === "consent") {
    for (const ack of await a.page.locator("[data-intake-ack]").all()) await ack.check();
    await a.page.locator("[data-intake-consent-continue]").click();
  }
  await expect(a.page.locator("main[data-intake-phase]")).toHaveAttribute("data-intake-phase", "upload", { timeout: 30_000 });
  await a.page.locator('input[type="file"]').first().setInputFiles(fileFor("intake-a"));
  await expect(a.page.locator("[data-intake-part-filename]").first()).toBeAttached({ timeout: 30_000 });
  await a.page.waitForTimeout(1500);
  facts.fileCardLayout = await a.page.locator("[data-intake-part-filename]").first().evaluate((el) => {
    const box = (e: Element | null) => (e ? (({ width, height }) => ({ width: Math.round(width), height: Math.round(height) }))(e.getBoundingClientRect()) : null);
    const card = el.closest("li, article, .ipk-file") ?? el.parentElement;
    return { name: box(el), card: box(card), cardClass: card?.className ?? "", viewport: window.innerWidth };
  });
  await a.page.screenshot({ path: `${process.cwd()}/.p7tmp/acceptance-shots/fev-e11-recipient-file-card.png`, fullPage: true });
  const skip = a.page.locator("[data-intake-location-skip]");
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await shot(a.page, "fev-e11-recipient-ready");
  await a.page.locator(".ipk-submit").first().click();
  await expect(a.page.locator("main[data-intake-phase]")).toHaveAttribute("data-intake-phase", "submitted", { timeout: 90_000 });
  await shot(a.page, "fev-e11-recipient-submitted");
  await a.page.reload();
  await settle(a.page);
  facts.aAfterReload = await a.page.locator("main[data-intake-phase]").getAttribute("data-intake-phase");
  await a.close();
  const tokenA = new URL(link).pathname.split("/").pop()!;
  const again = await request.get(`${API_BASE}/v1/external-intake/${tokenA}`);
  facts.aApiAfterSubmit = `${again.status()} ${(await again.text()).slice(0, 200)}`;

  // B. A link revoked by the owner in the list.
  const b = await createManualLink(page, "fev revoke me");
  s.facts.linkB = b.id;
  await page.goto("/intake-links");
  await settle(page);
  const row = page.locator(`[data-intake-links-row-id="${b.id}"]`).first();
  await row.locator("[data-intake-links-row-menu-trigger]").click();
  await page.locator('[data-intake-links-row-action="revoke"]').click();
  await page.locator('[data-confirm-action-modal="intake-link-revoke"] [data-confirm-action-submit="true"]').click();
  await expect.poll(() => sql(`select status from workflow_intake_links where id = '${b.id}'`)[0]![0], { timeout: 20_000 }).toBe("REVOKED");
  await shot(page, "fev-e11-revoked");
  const rb = await openAsRecipient(browser, `${WEB_BASE}/intake/${b.token}`);
  facts.revoked = { phase: rb.phase, errorClass: rb.errorClass, text: (await rb.page.locator("main").innerText()).slice(0, 200) };
  await shot(rb.page, "fev-e11-revoked-recipient");
  await rb.close();
  const rbApi = await request.get(`${API_BASE}/v1/external-intake/${b.token}`);
  facts.revokedApi = `${rbApi.status()} ${(await rbApi.text()).slice(0, 200)}`;

  // C. A link past its expiry [FIXTURE-EXPIRY: expires_at_utc set in the past with SQL].
  const c = await createManualLink(page, "fev expire me");
  s.facts.linkC = c.id;
  sql(`update workflow_intake_links set expires_at_utc = now() - interval '1 minute' where id = '${c.id}'`);
  const rc = await openAsRecipient(browser, `${WEB_BASE}/intake/${c.token}`);
  facts.expired = { phase: rc.phase, errorClass: rc.errorClass };
  await shot(rc.page, "fev-e11-expired-recipient");
  await rc.close();
  const rcApi = await request.get(`${API_BASE}/v1/external-intake/${c.token}`);
  facts.expiredApi = `${rcApi.status()} ${(await rcApi.text()).slice(0, 200)}`;

  // D. One link stays active, for management after the downgrade.
  const d = await createManualLink(page, "fev keep active");
  s.facts.linkD = d.id;
  s.facts.linkDToken = d.token;
  facts.links = intakeLinks(s.facts.intakeTeamId!);
  log("e11 intake", facts);
  s.facts.e11 = JSON.stringify(facts);
  expect.soft(facts.aAfterReload, "a submitted one-time link reopens on its read-only submitted page").toMatch(/submitted|already_submitted/);
  expect(rb.phase).toBe("link_unavailable");
  expect(rbApi.status()).toBe(410);
  expect(rc.phase).toBe("link_unavailable");
  expect(rcApi.status()).toBe(410);
  await keepProfile(context, intake, s, "intake");
  await context.close();
});

test("E12 [FIXTURE-GRANT revoke] after the downgrade: manage-only lists and revokes existing links, cannot create (B3B-F-104)", async ({ browser }) => {
  const intake = s.people.intake!;
  if (!s.facts.grantRevoked) {
    const out = stackTsx(["src/scripts/internal-plan-grant.ts", "revoke", `--email=${intake.email}`, `--actor-user-id=${OPERATOR_ID}`, "--reason=fev-acceptance-downgrade", "--confirm"]);
    log("e12 grant revoke", out.slice(-600));
    s.facts.grantRevoked = "1";
    saveState(s);
  }
  log("e12 team plan", sql(`select billing_plan, billing_status from teams where id = '${s.facts.intakeTeamId}'`));
  const { context, page } = await newProfile(browser, intake);
  await page.goto("/intake-links");
  await settle(page);
  const manageOnly = page.locator('[data-intake-links-manage-only="true"]');
  await expect(manageOnly).toBeVisible();
  await shot(page, "fev-e12-manage-only");
  const rows = await page.locator("tr[data-intake-links-row-id]").evaluateAll((els) => els.map((e) => `${e.getAttribute("data-intake-links-row-id")}:${e.getAttribute("data-intake-links-row-lifecycle")}`));
  const newCta = await page.locator('[data-intake-links-new-cta="true"]').count();
  // Revoke the one still-active link from the manage-only screen.
  const row = page.locator(`[data-intake-links-row-id="${s.facts.linkD}"]`).first();
  await row.locator("[data-intake-links-row-menu-trigger]").click();
  await page.locator('[data-intake-links-row-action="revoke"]').click();
  await page.locator('[data-confirm-action-modal="intake-link-revoke"] [data-confirm-action-submit="true"]').click();
  await expect.poll(() => sql(`select status from workflow_intake_links where id = '${s.facts.linkD}'`)[0]![0], { timeout: 20_000 }).toBe("REVOKED");
  await page.goto("/intake-links?new=1");
  await settle(page);
  const wizard = await page.getByTestId("intake-link-create-wizard").count();
  const refused = await api(page, "POST", "/v1/workflow/intake-links", {
    teamId: s.facts.intakeTeamId,
    workflowTemplateSlug: "general-evidence-record",
    intakeMode: "EXTERNAL_ONE_TIME",
    deliveryMethod: "MANUAL",
    expiresAtUtc: new Date(Date.now() + 48 * 3600_000).toISOString(),
    idempotencyKey: `fev-after-downgrade-${s.runId}`,
  });
  const facts = { manageOnly: (await manageOnly.innerText().catch(() => "")).slice(0, 300), rows, newCta, wizard, api: `${refused.status} ${refused.text.slice(0, 200)}`, links: intakeLinks(s.facts.intakeTeamId!) };
  log("e12 manage-only", facts);
  s.facts.e12 = JSON.stringify(facts);
  expect(rows.length).toBeGreaterThanOrEqual(4);
  expect(newCta).toBe(0);
  expect(wizard).toBe(0);
  expect(refused.status).toBe(409);
  expect(refused.text).toContain("INTAKE_NOT_INCLUDED");
  await keepProfile(context, intake, s, "intake");
  await context.close();
});

test("E13 older clients: no contract header, an old contract value, a bearer token; issued outputs still download and verify", async ({ request }) => {
  const free = s.people.free!;
  const token = await nativeToken(request, free.email, free.password);
  const before = ledger(s.facts.freeUserId!, s.facts.freeTeamId!);
  const facts: Record<string, unknown> = {};
  const variants: Array<[string, Record<string, string>]> = [
    ["no-header", { authorization: `Bearer ${token}` }],
    ["old-contract-header", { authorization: `Bearer ${token}`, "x-proovra-client-contract": "0", "x-proovra-contract": "0" }],
  ];
  const pdfSha = sha256Hex(readFileSync(s.facts.r1Pdf!));
  for (const [name, H] of variants) {
    const rep = await request.get(`${API_BASE}/v1/evidence/${s.facts.r1}/report/latest`, { headers: H });
    const repJson = await rep.json();
    const pdf = Buffer.from(await (await request.get(repJson.url)).body());
    const pkg = await request.get(`${API_BASE}/v1/evidence/${s.facts.r1}/verification-package`, { headers: H });
    const pkgJson = await pkg.json();
    const zip = Buffer.from(await (await request.get(pkgJson.url)).body());
    const h = rep.headers();
    facts[name] = {
      report: rep.status(),
      pdfIsPdf: pdf.subarray(0, 4).toString() === "%PDF",
      pdfSameBytes: sha256Hex(pdf) === pdfSha,
      package: pkg.status(),
      zipSameBytes: sha256Hex(zip) === s.facts.r1ZipSha,
      contract: h["x-proovra-contract"],
      minClientContract: h["x-proovra-min-client-contract"],
      routeEpoch: h["x-proovra-route-epoch"],
    };
    expect(rep.status()).toBe(200);
    expect(sha256Hex(pdf)).toBe(pdfSha);
    expect(pkg.status()).toBe(200);
    expect(sha256Hex(zip)).toBe(s.facts.r1ZipSha);
  }
  // Every record issued earlier still verifies, anonymously and with no header.
  for (const id of [s.facts.r1, s.facts.r2, s.facts.r3]) {
    const ref = sql(`select verification_ref from evidence where id = '${id}'`)[0]![0]!;
    const v = await request.get(`${API_BASE}/public/verify/${ref}`);
    facts[`verify-${id!.slice(0, 8)}`] = v.status();
    expect(v.status()).toBe(200);
  }
  const byHash = await request.get(`${API_BASE}/public/verification-packages/by-sha256/${s.facts.r1ZipSha}`);
  facts.packageByHash = byHash.status();
  expect(byHash.status()).toBe(200);
  // What an older native build receives for the new refusals.
  const H = { authorization: `Bearer ${token}` };
  const legacyCreate = await request.post(`${API_BASE}/v1/evidence`, { headers: H, data: { type: "PHOTO", mimeType: "image/png" } });
  facts.legacyCreateRefusal = `${legacyCreate.status()} ${(await legacyCreate.text()).slice(0, 300)}`;
  const open = await request.post(`${API_BASE}/v1/capture/direct-sessions`, { headers: H, data: { mode: "PROOVRA_MOBILE_APP", clientAttemptId: randomUUID() } });
  const openJson = await open.json().catch(() => null);
  facts.directOpen = `${open.status()}`;
  if (openJson?.session?.captureSessionId) {
    const sid = openJson.session.captureSessionId;
    const reserve = await request.post(`${API_BASE}/v1/capture/direct-sessions/${sid}/evidence`, { headers: H, data: { type: "PHOTO", mimeType: "image/png", deviceTimeIso: new Date().toISOString() } });
    facts.directReserveRefusal = `${reserve.status()} ${(await reserve.text()).slice(0, 400)}`;
    const discard = await request.post(`${API_BASE}/v1/capture/direct-sessions/${sid}/discard`, { headers: H, data: {} });
    facts.directDiscard = `${discard.status()} ${(await discard.text()).slice(0, 160)}`;
  }
  const after = ledger(s.facts.freeUserId!, s.facts.freeTeamId!);
  facts.ledgerDiff = diffLedger(before, after);
  log("e13 client skew", facts);
  s.facts.e13 = JSON.stringify(facts);
  expect(legacyCreate.status()).toBe(409);
  for (const k of MUST_NOT_MOVE) expect(after[k], k).toBe(before[k]);
});

test("E14 [FIXTURE-GRANT] repro: a lost create answer shows the browser's raw network error in the wizard", async ({ browser }) => {
  const intake = s.people.intake!;
  stackTsx(["src/scripts/internal-plan-grant.ts", "apply", `--email=${intake.email}`, `--actor-user-id=${OPERATOR_ID}`, "--reason=fev-acceptance-repro", `--idempotency-key=fev-grant-repro-${Date.now()}`, "--confirm"]);
  const seen: string[] = [];
  try {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const { context, page } = await newProfile(browser, intake);
      let lost = false;
      let createdId = "";
      await page.route(`${API_BASE}/v1/workflow/intake-links`, async (route) => {
        if (route.request().method() !== "POST" || lost) return route.continue();
        lost = true;
        const resp = await route.fetch();
        createdId = ((await resp.json()) as { link?: { id?: string } }).link?.id ?? "";
        await route.abort("connectionreset");
      });
      await page.goto("/intake-links");
      await settle(page);
      await page.locator('[data-intake-links-new-cta="true"]').click();
      await page.locator("[data-intake-link-wizard-next]").click();
      await page.locator('[data-intake-link-delivery-method="MANUAL"]').click();
      await page.locator("[data-intake-link-wizard-next]").click();
      await page.locator("[data-intake-link-wizard-next]").click();
      await page.locator("[data-intake-link-submit]").click();
      const err = page.locator("[data-intake-link-create-error]");
      await expect(err).toBeVisible();
      seen.push((await err.innerText()).trim());
      await shot(page, `fev-e14-lost-answer-${attempt}`);
      if (createdId) await api(page, "POST", `/v1/workflow/intake-links/${createdId}/revoke`, { reason: "fev acceptance repro cleanup" });
      await context.close();
    }
  } finally {
    stackTsx(["src/scripts/internal-plan-grant.ts", "revoke", `--email=${intake.email}`, `--actor-user-id=${OPERATOR_ID}`, "--reason=fev-acceptance-repro-end", "--confirm"]);
  }
  log("e14 wizard error after a lost answer", seen);
  s.facts.e14 = JSON.stringify(seen);
  expect.soft(seen.join(" | "), "a network failure is said in product words, not the browser's").not.toContain("Failed to fetch");
});

// <next-step>
