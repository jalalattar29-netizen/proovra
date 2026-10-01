#!/usr/bin/env node
/**
 * REMEDIATION-RERUN probe (not product code) — required journey R02:
 * Web screen capture → outputs, in a REAL Chromium against the disposable stack.
 *
 * The browser is signed in the way the product signs a user in (the HttpOnly
 * `proovra_session` cookie carrying the seeded owner's session token), opens the
 * real /capture page, records the current tab through getDisplayMedia (Chromium
 * auto-selects this tab by title, so no OS picker), adds the recording to the
 * session, finalizes, and then reads the SAME record back through the product
 * API: sealed, report and package produced, Public Verify answering for it.
 *
 * Usage: node web-screen-capture-probe.mjs <seed.json> <out.json> [screenshot.png]
 * Env:   UCA_API (default http://localhost:4000), UCA_WEB (default http://localhost:3311)
 */
import { createRequire } from "node:module";
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const require = createRequire("D:/pv-ucc/apps/extension/package.json");
const { chromium } = require("@playwright/test");

const API = process.env.UCA_API ?? "http://localhost:4000";
const WEB = process.env.UCA_WEB ?? "http://localhost:3311";
const [seedPath, outPath, shotPath] = process.argv.slice(2);
if (!seedPath || !outPath) throw new Error("usage: web-screen-capture-probe.mjs <seed.json> <out.json> [screenshot.png]");
// The seed output ends with the JSON line (as journeys.mjs reads it).
const seed = JSON.parse(readFileSync(seedPath, "utf8").trim().split("\n").pop());
const owner = seed.ownerA;

const checks = [];
const requests = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail ?? null });

async function api(method, path, body, extraHeaders = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${owner.bearer}`,
      "x-proovra-workspace-id": owner.teamId,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  requests.push({ method, path, status: res.status });
  return { status: res.status, json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The product's step-up (TOTP) path, as journeys.mjs drives it, for the share link.
function base32Decode(str) {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of str.replace(/=+$/, "").toUpperCase()) {
    const v = a.indexOf(ch);
    if (v >= 0) bits += v.toString(2).padStart(5, "0");
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function totp(secretB32) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const h = createHmac("sha1", base32Decode(secretB32)).update(b).digest();
  const o = h[h.length - 1] & 15;
  return ((h.readUInt32BE(o) & 0x7fffffff) % 1000000).toString().padStart(6, "0");
}
async function mintShareLink(evidenceId) {
  let r = await api("POST", `/v1/evidence/${evidenceId}/verify-links`, { audience: "r02", expiresInDays: 7 });
  if (r.status === 401) {
    const st = await api("POST", "/v1/identity/mfa/enroll/start", { label: "uca-r02" });
    await api("POST", "/v1/identity/mfa/enroll/verify", { factorId: st.json?.factorId, code: totp(st.json?.secretBase32 ?? "") });
    await sleep(31_000 - (Date.now() % 30_000) + 1_000); // a fresh TOTP window, not the enrolment code
    const start = await api("POST", "/v1/identity-security/step-up/start", { teamId: owner.teamId, purpose: "PUBLIC_VERIFY_PUBLISH", resourceKind: "evidence", resourceId: evidenceId });
    const challengeId = start.json?.challenge?.id;
    await api("POST", "/v1/identity-security/step-up/check", { teamId: owner.teamId, challengeId, code: totp(st.json?.secretBase32 ?? "") });
    r = await api("POST", `/v1/evidence/${evidenceId}/verify-links`, { audience: "r02", expiresInDays: 7 }, { "x-proovra-step-up-challenge-id": challengeId });
  }
  return r.json?.token ?? null;
}

const PAGE_TITLE_MARK = "UCA-R02";
const browser = await chromium.launch({
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--auto-select-tab-capture-source-by-title=${PAGE_TITLE_MARK}`,
    "--enable-features=GetDisplayMediaSet",
  ],
});
let evidenceId = null;
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies([
    { name: "proovra_session", value: owner.bearer, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
  });
  // Name every failed response, so a console "Failed to load resource" is attributable.
  const failedResponses = [];
  page.on("response", async (r) => {
    if (r.status() >= 500) {
      let body = "";
      try {
        body = (await r.text()).slice(0, 300);
      } catch {
        /* streamed / opaque */
      }
      failedResponses.push({ status: r.status(), method: r.request().method(), url: r.url().replace(/[?#].*$/, ""), body });
    }
  });

  // The user picks the workspace the capture belongs to (the web app opens in the
  // owner's Personal workspace, whose FREE plan does not include report/package).
  const sw = await api("POST", "/v1/platform/context/switch-workspace", { workspaceId: owner.teamId });
  check("the owner switches to the organization workspace before capturing", sw.status === 200, sw.status);
  const before = await api("GET", `/v1/evidence?scope=all`);
  const beforeIds = new Set((before.json?.items ?? before.json?.evidence ?? []).map((e) => e.id));

  await page.goto(`${WEB}/capture`, { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => {
    document.title = t;
  }, PAGE_TITLE_MARK);

  const screenAction = page.getByRole("button", { name: /^Screen\b/ });
  await screenAction.waitFor({ state: "visible", timeout: 60_000 });
  check("the Capture page offers a Screen action where getDisplayMedia exists", true);
  await screenAction.click();

  await page.getByRole("button", { name: /Choose what to record/ }).click();
  const stop = page.getByRole("button", { name: /^Stop$/ });
  await stop.waitFor({ state: "visible", timeout: 20_000 });
  check("getDisplayMedia granted and MediaRecorder recording", true);
  await page.evaluate((t) => {
    document.title = t;
  }, PAGE_TITLE_MARK);
  await sleep(3_000);
  await stop.click();

  const add = page.getByRole("button", { name: /Add recording to session/ });
  await add.waitFor({ state: "visible", timeout: 20_000 });
  await add.click();
  check("the stopped recording is added to the capture session", true);

  const finalize = page.locator(".capture-primary-finalize-action");
  await finalize.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(() => {
    const b = document.querySelector(".capture-primary-finalize-action");
    return b && !b.hasAttribute("disabled");
  }, null, { timeout: 120_000 });
  await finalize.click();

  // The record the browser created: newest one that did not exist before.
  for (let i = 0; i < 90 && !evidenceId; i += 1) {
    const list = await api("GET", `/v1/evidence?scope=all`);
    const items = list.json?.items ?? list.json?.evidence ?? [];
    const fresh = items.find((e) => !beforeIds.has(e.id));
    if (fresh) evidenceId = fresh.id;
    else await sleep(2_000);
  }
  check("finalize created a record", evidenceId, evidenceId);

  if (evidenceId) {
    let detail = null;
    for (let i = 0; i < 90; i += 1) {
      detail = await api("GET", `/v1/evidence/${evidenceId}`);
      const st = detail.json?.evidence?.status ?? detail.json?.status;
      if (st === "SIGNED" || st === "REPORTED") break;
      await sleep(2_000);
    }
    const ev = detail?.json?.evidence ?? detail?.json ?? {};
    check("the record is sealed (SIGNED/REPORTED)", ["SIGNED", "REPORTED"].includes(ev.status), ev.status);
    check("the record is a VIDEO", ev.type === "VIDEO", ev.type);

    let status = null;
    for (let i = 0; i < 120; i += 1) {
      status = await api("GET", `/v1/evidence/${evidenceId}/artifacts/status`);
      // Same readiness rule as journeys.mjs pollOutputs.
      if (status.json?.report?.available === true && status.json?.verificationPackage?.available === true) break;
      await sleep(2_000);
    }
    requests.splice(0, requests.length, ...requests.filter((r) => !r.path.endsWith("/artifacts/status")));
    const rep = await api("GET", `/v1/evidence/${evidenceId}/report/latest`);
    check("a report was produced for the recording", rep.status === 200, rep.status);
    check("the report is sealed with the web acquisition mode", rep.json?.snapshots?.acquisitionMode === "PROOVRA_WEB_UPLOAD", rep.json?.snapshots?.acquisitionMode);
    check("the record is in the organization workspace", (ev.teamId ?? detail?.json?.teamId) === owner.teamId, ev.teamId ?? detail?.json?.teamId);
    const pkg = await api("GET", `/v1/evidence/${evidenceId}/verification-package`);
    check("a verification package was produced for the recording", pkg.status === 200, pkg.status);
    const token = await mintShareLink(evidenceId);
    check("a share link is minted (step-up)", Boolean(token), token ? "minted" : "none");
    const res = await fetch(`${API}/public/verify/${token}`);
    requests.push({ method: "GET", path: "/public/verify/<share-token>", status: res.status });
    check("Public Verify answers for the record through its share link", res.status === 200, res.status);
  }
  check("no page console errors", consoleErrors.length === 0, consoleErrors.slice(0, 5).join(" | "));
  check("no server error answered the page", failedResponses.length === 0, failedResponses.slice(0, 5));
  if (shotPath) await page.screenshot({ path: shotPath, fullPage: false });
} catch (err) {
  check("probe ran to completion", false, String(err?.message ?? err).slice(0, 500));
} finally {
  await browser.close();
}

const verdict = checks.every((c) => c.ok) ? "PASS" : "FAIL";
writeFileSync(
  outPath,
  JSON.stringify({ journeys: [{ id: "R02-web-screen-capture-real-chromium", title: "Web screen capture (real Chromium, getDisplayMedia) → seal → report → package → Public Verify", verdict, evidenceId, checks, requests }] }, null, 2) + "\n",
);
console.log(`R02 ${verdict} ${checks.filter((c) => c.ok).length}/${checks.length}`);
process.exit(verdict === "PASS" ? 0 : 1);
