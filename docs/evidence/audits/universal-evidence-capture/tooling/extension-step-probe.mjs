/**
 * AUDIT-ONLY extension step probe. Not product code.
 *
 * Replicates apps/extension/e2e/direct-web-capture.spec.ts step by step against a
 * running disposable stack, with a timeout on EVERY step (the spec leaves several
 * unbounded), and additionally drives the capture the way the product does: a
 * PRESERVE message sent from the extension's own popup page. Also screenshots the
 * real popup UI.
 *
 * Usage (from apps/extension/e2e so @playwright/test resolves):
 *   node <this> <seed.json> <out.json> <screenshot.png>
 */
import { chromium } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API = "http://localhost:4000";
const FIXTURES = "http://127.0.0.1:4599";
const EXT = "D:/pv-uca/apps/extension/dist";
const REDIRECT_URI = "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.chromiumapp.org/oauth";
const [seedPath, outPath, shotPath] = process.argv.slice(2);
const seed = JSON.parse(readFileSync(seedPath, "utf8").trim().split("\n").pop());
const owner = seed.ownerA;
const steps = [];

async function step(name, ms, fn) {
  const t0 = Date.now();
  let timer;
  try {
    const v = await Promise.race([fn(), new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`TIMEOUT ${ms}ms`)), ms)))]);
    const value = v && typeof v === "object" && typeof v.url === "function" ? v.url() : v === undefined ? null : v;
    steps.push({ name, ok: true, ms: Date.now() - t0, value });
    return v;
  } catch (err) {
    steps.push({ name, ok: false, ms: Date.now() - t0, error: String(err?.message ?? err).slice(0, 400) });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

const b64u = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function oauthToken() {
  const verifier = b64u(randomBytes(32));
  const challenge = b64u(createHash("sha256").update(verifier).digest());
  const authz = await fetch(
    `${API}/v1/oauth/extension/authorize?response_type=code&client_id=proovra-extension&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${challenge}&code_challenge_method=S256&scope=capture.direct&state=uca`,
    { headers: { authorization: `Bearer ${owner.bearer}` }, redirect: "manual" },
  );
  if (authz.status !== 302) throw new Error(`authorize ${authz.status}`);
  const code = new URL(authz.headers.get("location")).searchParams.get("code");
  const tok = await fetch(`${API}/v1/oauth/extension/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: "proovra-extension", redirect_uri: REDIRECT_URI }),
  });
  const j = await tok.json();
  if (!j.access_token) throw new Error(`token ${tok.status}`);
  return j.access_token;
}

const token = await step("oauth token (authorize + PKCE exchange)", 20000, oauthToken);
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "uca-ext-")), {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
try {
  const sw = await step("extension service worker registered", 20000, async () => {
    const s = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
    return s;
  });
  const extId = sw ? new URL(sw.url()).host : null;
  steps.push({ name: "extension id", ok: Boolean(extId), ms: 0, value: extId });
  if (sw && token) {
    await step("token stored in chrome.storage.session (as the spec does)", 10000, () =>
      sw.evaluate(async (t) => {
        await chrome.storage.session.set({ "proovra.session.token": { accessToken: t, expiresAtMs: Date.now() + 3600000, account: "uca" } });
        return true;
      }, token),
    );
  }
  const page = await ctx.newPage();
  await step("navigate to fixture page", 15000, () => page.goto(`${FIXTURES}/static`).then((r) => r?.status() ?? null));
  const tab = sw
    ? await step("tabs.query active tab (from service worker)", 10000, () =>
        sw.evaluate(async () => {
          const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
          return t ? { tabId: t.id, windowId: t.windowId, url: t.url } : null;
        }),
      )
    : null;

  // Real popup UI.
  if (extId) {
    const popup = await ctx.newPage();
    await step("open the real popup page", 15000, () => popup.goto(`chrome-extension://${extId}/popup.html`).then(() => true));
    await popup.waitForTimeout(2500);
    await step("popup UI state (workspace select + capture buttons)", 10000, () =>
      popup.evaluate(() => {
        const sel = document.querySelector("select");
        const buttons = [...document.querySelectorAll("button")].map((b) => ({ text: b.textContent?.trim(), disabled: b.disabled }));
        return {
          workspaceOptions: sel ? [...sel.options].map((o) => o.textContent?.trim()) : null,
          buttons,
          status: document.getElementById("status")?.textContent?.trim() ?? null,
        };
      }),
    );
    await popup.screenshot({ path: shotPath }).catch(() => undefined);
    // Product-shaped capture: PRESERVE sent from the extension's own page (as popup.ts does).
    if (tab?.tabId) {
      await page.bringToFront();
      await page.waitForTimeout(500);
      await step("PRESERVE from the extension page (product path, VIEWPORT)", 90000, () =>
        popup.evaluate(
          async (a) =>
            chrome.runtime.sendMessage({ kind: "PRESERVE", mode: "VIEWPORT", teamId: a.teamId, tabId: a.tabId, windowId: a.windowId, evidenceType: "PHOTO" }),
          { teamId: owner.teamId, tabId: tab.tabId, windowId: tab.windowId },
        ),
      );
      await page.goto(`${FIXTURES}/long`).catch(() => undefined);
      await page.bringToFront();
      await page.waitForTimeout(500);
      await step("PRESERVE from the extension page (product path, FULL_PAGE on the long fixture)", 120000, () =>
        popup.evaluate(
          async (a) =>
            chrome.runtime.sendMessage({ kind: "PRESERVE", mode: "FULL_PAGE", teamId: a.teamId, tabId: a.tabId, windowId: a.windowId, evidenceType: "PHOTO" }),
          { teamId: owner.teamId, tabId: tab.tabId, windowId: tab.windowId },
        ),
      );
    }
  }
  // The spec's own path: the service worker messaging itself.
  if (sw && tab?.tabId) {
    await page.goto(`${FIXTURES}/static`).catch(() => undefined);
    await page.bringToFront();
    await step("PRESERVE sent by the service worker to itself (spec path)", 30000, () =>
      sw.evaluate(
        async (a) => chrome.runtime.sendMessage({ kind: "PRESERVE", mode: "VIEWPORT", teamId: a.teamId, tabId: a.tabId, windowId: a.windowId, evidenceType: "PHOTO" }),
        { teamId: owner.teamId, tabId: tab.tabId, windowId: tab.windowId },
      ),
    );
  }
} finally {
  await ctx.close().catch(() => undefined);
}
writeFileSync(outPath, JSON.stringify({ browser: "playwright chromium (bundled)", steps }, null, 2));
for (const s of steps) console.log(`${s.ok ? "OK  " : "FAIL"} ${s.name} (${s.ms}ms) ${s.ok ? JSON.stringify(s.value)?.slice(0, 300) ?? "" : s.error}`);
