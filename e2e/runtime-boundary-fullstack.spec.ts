/**
 * RUNTIME TENANT BOUNDARY — FULL STACK (API + worker + MinIO + web).
 *
 * Every other gate for the runtime correction intercepts something. This one
 * does not: a PRO account uploads real bytes, the REAL worker renders and
 * stores a real report PDF and verification ZIP, and the real web bundle is
 * driven in Chromium.
 *
 * PHASES (env RUNTIME_OUTAGE_PHASE):
 *
 *   (unset) — CI-compatible. Real generation; real download bytes; the live
 *             worker reads as available; workspace B learns nothing about A;
 *             the rendered Evidence page carries no platform panel.
 *   outage  — run only after the worker has been STOPPED for longer than the
 *             heartbeat window (WORKER_HEARTBEAT_STALE_SECONDS, default 180s).
 *             Generation reads as impaired, the notice sits beside
 *             the new-version action, and the EXISTING report still downloads.
 *   recovered — run after the worker is started again and has heartbeated.
 *
 * State between phases is written to RUNTIME_E2E_STATE (a JSON file).
 */

import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import {
  SESSION_PASSWORD,
  clearTestRateLimits,
  createGuestSession,
  makeApi,
  type GuestSession,
} from "./helpers/api-client";

const PHASE = process.env.RUNTIME_OUTAGE_PHASE ?? "";
const STATE_FILE = process.env.RUNTIME_E2E_STATE ?? "test-results/runtime-boundary-state.json";
const PANEL = /degraded mode|partial or stale|subsystem\(s\)|Failing subsystems/i;

type State = { a: { email: string; token: string }; b: { email: string; token: string }; evidenceId: string };

test.describe.configure({ mode: "serial" });

async function signIn(page: Page, email: string) {
  await clearTestRateLimits();
  await page.goto("/login");
  // The login page renders its form once per layout; drive the visible one.
  await page.locator('input[placeholder="Email"]:visible').first().fill(email);
  await page.locator('input[placeholder="Password"]:visible').first().fill(SESSION_PASSWORD);
  await page.locator("input.auth-legal-checkbox:visible").first().check();
  await page.locator('[data-auth-email-cta="SIGN_IN"]:visible').first().click();
  await page.waitForURL(/\/home/, { timeout: 30_000 });
}

async function openArtifacts(page: Page, evidenceId: string) {
  await page.goto(`/evidence/${evidenceId}`);
  await page.waitForSelector(".evidence-detail-hero", { timeout: 30_000 });
  await page.getByRole("tab", { name: "Artifacts" }).click();
  await page.waitForSelector('[data-evidence-section="latest-artifacts"]');
  // The shared status store's first read waits for idle (≤ 800ms).
  await page.waitForTimeout(1500);
}

async function status(token: string) {
  const api = await makeApi(token);
  const res = await api.get("/v1/runtime/status");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { status: string; capabilities: Record<string, string>; checkedAt: string };
  await api.dispose();
  return body;
}

async function downloadBytes(token: string, path: string): Promise<Buffer> {
  const api = await makeApi(token);
  const res = await api.get(path);
  expect(res.status(), await res.text()).toBe(200);
  const { url } = (await res.json()) as { url: string };
  await api.dispose();
  const file = await fetch(url);
  expect(file.ok).toBe(true);
  return Buffer.from(await file.arrayBuffer());
}

test.describe("runtime boundary — real generation, isolation and rendering", () => {
  test.skip(PHASE !== "", "phase run");

  let A: GuestSession;
  let B: GuestSession;
  let evidenceId = "";

  test("the real worker renders and stores a real report PDF and verification ZIP", async () => {
    test.setTimeout(240_000);
    await clearTestRateLimits();
    A = await createGuestSession({ plan: "PRO" });
    B = await createGuestSession({ plan: "PRO" });

    // The web capture path: create the record, register the file as an
    // evidence PART (the package is built from parts), PUT it, complete.
    const bytes = `runtime boundary e2e ${Date.now()}\n`;
    const sha = createHash("sha256").update(bytes).digest("base64");
    const md5 = createHash("md5").update(bytes).digest("base64");
    const created = await A.api.post("/v1/evidence", {
      data: { type: "PHOTO", mimeType: "text/plain", originalFileName: "note.txt", checksumSha256Base64: sha, contentMd5Base64: md5 },
    });
    expect(created.ok(), await created.text()).toBe(true);
    evidenceId = ((await created.json()) as { id: string }).id;
    const partRes = await A.api.post(`/v1/evidence/${evidenceId}/parts`, {
      data: { partIndex: 0, mimeType: "text/plain", originalFileName: "note.txt", checksumSha256Base64: sha, contentMd5Base64: md5 },
    });
    expect(partRes.ok(), await partRes.text()).toBe(true);
    const part = (await partRes.json()) as { upload: { putUrl: string } };
    const put = await fetch(part.upload.putUrl, {
      method: "PUT",
      body: bytes,
      headers: { "Content-Type": "text/plain", "x-amz-checksum-sha256": sha, "Content-MD5": md5 },
    });
    expect(put.ok, `PUT ${put.status}`).toBe(true);
    const done = await A.api.post(`/v1/evidence/${evidenceId}/complete`, { data: {} });
    expect(done.ok(), await done.text()).toBe(true);
    expect(((await done.json()) as { fileSha256: string }).fileSha256.toLowerCase()).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );

    // The worker picks the job up, renders with Chromium and stores to MinIO.
    await expect
      .poll(
        async () => {
          const r = await A.api.get(`/v1/evidence/${evidenceId}/report/latest`);
          return r.status();
        },
        { timeout: 180_000, intervals: [2000] },
      )
      .toBe(200);
    const pdf = await downloadBytes(A.token, `/v1/evidence/${evidenceId}/report/latest`);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const zip = await downloadBytes(A.token, `/v1/evidence/${evidenceId}/verification-package`);
    expect(zip.subarray(0, 2).toString("latin1")).toBe("PK");

    const state: State = {
      a: { email: A.email, token: A.token },
      b: { email: B.email, token: B.token },
      evidenceId,
    };
    writeFileSync(STATE_FILE, JSON.stringify(state));
  });

  test("a live worker reads as available; B's view is identical and discloses nothing about A", async () => {
    const a = await status(A.token);
    expect(a.capabilities.artifactGeneration).toBe("HEALTHY");
    expect(a.capabilities.downloads).toBe("HEALTHY");
    const b = await status(B.token);
    expect({ ...b, checkedAt: null }).toEqual({ ...a, checkedAt: null });
    expect(JSON.stringify(b)).not.toContain(evidenceId);
    // B cannot read A's record.
    const cross = await B.api.get(`/v1/evidence/${evidenceId}`);
    expect([403, 404]).toContain(cross.status());
  });

  test("rendered: A's healthy record carries no panel, no notice, no status control", async ({ page }) => {
    await signIn(page, A.email);
    await openArtifacts(page, evidenceId);
    expect(await page.locator("body").innerText()).not.toMatch(PANEL);
    await expect(page.locator("[data-service-notice]")).toHaveCount(0);
    await expect(page.locator("[data-service-status-indicator]")).toHaveCount(0);
    await expect(page.locator('[data-evidence-artifact-download="report"]')).toBeEnabled();
  });

  test("rendered: B opening A's record sees no record content", async ({ page }) => {
    await signIn(page, B.email);
    await page.goto(`/evidence/${evidenceId}`);
    await page.waitForTimeout(3000);
    await expect(page.locator(".evidence-detail-hero")).toHaveCount(0);
    expect(await page.locator("body").innerText()).not.toContain("runtime boundary e2e");
  });
});

test.describe("runtime boundary — generation outage (worker stopped past the heartbeat window)", () => {
  test.skip(PHASE !== "outage", "outage phase only");
  const state = (): State => JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  test.beforeAll(() => {
    if (!existsSync(STATE_FILE)) throw new Error(`run the default phase first (${STATE_FILE})`);
  });

  test("status: generation impaired for every tenant; downloads unaffected", async () => {
    const s = state();
    const a = await status(s.a.token);
    expect(["DEGRADED", "UNAVAILABLE"]).toContain(a.capabilities.artifactGeneration);
    expect(a.capabilities.downloads).toBe("HEALTHY");
    const b = await status(s.b.token);
    expect(b.capabilities.artifactGeneration).toBe(a.capabilities.artifactGeneration);
  });

  test("rendered: the notice sits beside the new-version action, the existing report still downloads, no panel", async ({ page }) => {
    const s = state();
    await signIn(page, s.a.email);
    await openArtifacts(page, s.evidenceId);
    const notice = page.locator('[data-service-notice="artifactGeneration"]');
    await expect(notice).toHaveCount(1, { timeout: 10_000 });
    expect(await notice.evaluate((n) => Boolean(n.closest('[data-evidence-section="reports-ready-actions"]')))).toBe(true);
    await expect(notice).not.toContainText(/stale|corrupt|incomplete|partial/i);
    expect(await page.locator("body").innerText()).not.toMatch(PANEL);
    await expect(page.locator('[data-evidence-artifact-download="report"]')).toBeEnabled();
    await expect(page.locator('[data-service-status-indicator="ISSUE"]')).toHaveCount(1);
    // The existing artifact is really retrievable during the outage.
    const pdf = await downloadBytes(s.a.token, `/v1/evidence/${s.evidenceId}/report/latest`);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});

test.describe("runtime boundary — recovery (worker restarted and heartbeating)", () => {
  test.skip(PHASE !== "recovered", "recovery phase only");
  const state = (): State => JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;

  test("status and page recover without intervention", async ({ page }) => {
    const s = state();
    await expect
      .poll(async () => (await status(s.a.token)).capabilities.artifactGeneration, { timeout: 120_000, intervals: [5000] })
      .toBe("HEALTHY");
    await signIn(page, s.a.email);
    await openArtifacts(page, s.evidenceId);
    await expect(page.locator("[data-service-notice]")).toHaveCount(0);
    await expect(page.locator("[data-service-status-indicator]")).toHaveCount(0);
  });
});
