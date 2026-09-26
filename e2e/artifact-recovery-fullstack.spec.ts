/**
 * ARTIFACT RECOVERY — FULL STACK (API + worker + MinIO + web), nothing mocked.
 *
 * The historical gap, reproduced for real: a PRO record gets a real report and
 * verification package from the real worker; its package row is then removed,
 * which is exactly the state old records are in (a valid report, no package
 * at its version). From there:
 *
 *   1. the server offers RECOVER on the package only — no report verb, no new
 *      version while the pair is incomplete;
 *   2. the web Artifacts tab shows the package panel with "Recover
 *      verification package" and no "Regenerate" anywhere;
 *   3. clicking it builds ONLY the package: the report stays version 1, the
 *      recovered ZIP embeds the stored report BYTE FOR BYTE, and the record's
 *      timestamp token is untouched;
 *   4. with the pair complete, recovery disappears and "Create new version"
 *      appears behind the overflow menu, confirmed with versions and an
 *      estimate; confirming produces version 2 while version 1 stays;
 *   5. another workspace learns nothing (404 on read and on the action).
 */

import { test, expect, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import {
  SESSION_PASSWORD,
  clearTestRateLimits,
  createGuestSession,
  makeApi,
  type GuestSession,
} from "./helpers/api-client";
import { readZipEntries } from "../services/api/test/point5/_zip-entries";

test.describe.configure({ mode: "serial" });

const API_DIR = resolve(__dirname, "..", "services", "api");
const sha256Hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** One SQL statement against the stack's own disposable database. */
function sql(query: string, params: unknown[] = []): Array<Record<string, unknown>> {
  const script = `
    const { Client } = require("pg");
    (async () => {
      const c = new Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      const r = await c.query(${JSON.stringify(query)}, ${JSON.stringify(params)});
      process.stdout.write(JSON.stringify(r.rows));
      await c.end();
    })().catch((e) => { process.stderr.write(String(e)); process.exit(1); });
  `;
  const run = spawnSync(process.execPath, ["-e", script], { cwd: API_DIR, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`sql failed: ${run.stderr}`);
  return JSON.parse(run.stdout || "[]");
}

async function signIn(page: Page, email: string) {
  await clearTestRateLimits();
  await page.goto("/login");
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
}

async function download(token: string, path: string): Promise<Buffer> {
  const api = await makeApi(token);
  const res = await api.get(path);
  expect(res.status(), await res.text()).toBe(200);
  const { url } = (await res.json()) as { url: string };
  await api.dispose();
  const file = await fetch(url);
  expect(file.ok).toBe(true);
  return Buffer.from(await file.arrayBuffer());
}

type Status = {
  outputs: {
    report: { state: string; action: string; actionUnavailableReason: string | null; version: number | null };
    verificationPackage: { state: string; action: string; actionUnavailableReason: string | null; operation: string | null; version: number | null };
    newVersion: { action: string; reason: string | null; currentVersion: number | null; nextVersion: number | null };
    pollIntervalMs: number | null;
  };
};

async function status(s: GuestSession, evidenceId: string): Promise<Status> {
  const r = await s.api.get(`/v1/evidence/${evidenceId}/artifacts/status`);
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()) as Status;
}

test.describe("artifact recovery — the real stack", () => {
  let A: GuestSession;
  let B: GuestSession;
  let evidenceId = "";
  let reportV1 = Buffer.alloc(0);
  let tsaBefore = "";

  test("a real record gets a real report and package; then its package goes missing", async () => {
    test.setTimeout(300_000);
    await clearTestRateLimits();
    A = await createGuestSession({ plan: "PRO" });
    B = await createGuestSession({ plan: "PRO" });

    const bytes = `artifact recovery e2e ${Date.now()}\n`;
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

    await expect
      .poll(async () => {
        const s = await status(A, evidenceId);
        return `${s.outputs.report.state}/${s.outputs.verificationPackage.state}`;
      }, { timeout: 240_000, intervals: [2000] })
      .toBe("READY/READY");
    reportV1 = await download(A.token, `/v1/evidence/${evidenceId}/report/latest`);
    expect(reportV1.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    // The original package embeds the stored report.
    const zip = await download(A.token, `/v1/evidence/${evidenceId}/verification-package`);
    const embedded = [...readZipEntries(zip).entries()].find(([k]) => k.endsWith("proovra-verification-report-v1.pdf"));
    expect(embedded, "the package carries report v1").toBeTruthy();
    expect(sha256Hex(embedded![1])).toBe(sha256Hex(reportV1));
    tsaBefore = JSON.stringify(
      sql(
        "SELECT tsa_status, tsa_token_base64, tsa_serial_number, tsa_gen_time_utc FROM evidence WHERE id = $1",
        [evidenceId],
      ),
    );

    // THE HISTORICAL GAP: a valid report, no package at its version.
    sql("DELETE FROM verification_packages WHERE evidence_id = $1", [evidenceId]);

    const s = await status(A, evidenceId);
    expect(s.outputs.report).toMatchObject({ state: "READY", action: "NONE", actionUnavailableReason: "NOT_REQUIRED", version: 1 });
    expect(s.outputs.verificationPackage).toMatchObject({ action: "RECOVER", operation: "PACKAGE_RECOVERY" });
    expect(s.outputs.newVersion).toMatchObject({ action: "NONE", reason: "PAIR_INCOMPLETE" });
  });

  test("another workspace learns nothing: 404 on the status and on the action", async () => {
    const read = await B.api.get(`/v1/evidence/${evidenceId}/artifacts/status`);
    expect(read.status()).toBe(404);
    const act = await B.api.post(`/v1/evidence/${evidenceId}/reports/regenerate`, { data: { intent: "RECOVER" } });
    expect(act.status()).toBe(404);
    expect(sql("SELECT count(*)::int AS n FROM report_generation_requests WHERE evidence_id = $1 AND requested_by_user_id = (SELECT id FROM users WHERE email = $2)", [evidenceId, B.email])[0]!.n).toBe(0);
  });

  test("the web offers Recover on the package, and recovery embeds the stored report byte for byte", async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page, A.email);
    await openArtifacts(page, evidenceId);

    const panel = page.locator('[data-evidence-section="package-recovery"]');
    await expect(panel).toContainText("The verification package for report version 1 is missing");
    const recover = panel.locator('[data-evidence-action="generate-outputs"]');
    await expect(recover).toHaveText("Recover verification package");
    await expect(page.getByText(/Regenerate/)).toHaveCount(0);

    await recover.click();
    // The click turns the panel into progress: it says the report is not
    // changed while the package is rebuilt ...
    const inFlight = page.locator('[data-evidence-section="package-recovery-in-flight"]');
    await expect(inFlight.or(page.locator('[data-evidence-section="package-recovery"]'))).toBeVisible();
    await expect(panel).toHaveCount(0, { timeout: 30_000 });
    // ... and the page's own polling (no reload) clears BOTH once the worker
    // has published the package. The missing panel alone would be satisfied
    // by the in-flight state, which is not completion.
    await expect(inFlight).toHaveCount(0, { timeout: 240_000 });
    await expect(panel).toHaveCount(0);

    const s = await status(A, evidenceId);
    expect(s.outputs.verificationPackage).toMatchObject({ state: "READY", version: 1 });
    expect(s.outputs.report.version).toBe(1);
    expect(sql("SELECT count(*)::int AS n FROM reports WHERE evidence_id = $1", [evidenceId])[0]!.n).toBe(1);
    const zip = await download(A.token, `/v1/evidence/${evidenceId}/verification-package`);
    const embedded = [...readZipEntries(zip).entries()].find(([k]) => k.endsWith("proovra-verification-report-v1.pdf"));
    expect(embedded, "the recovered package carries report v1").toBeTruthy();
    expect(sha256Hex(embedded![1])).toBe(sha256Hex(reportV1));
    // No new timestamp was issued for the recovery.
    expect(
      JSON.stringify(
        sql("SELECT tsa_status, tsa_token_base64, tsa_serial_number, tsa_gen_time_utc FROM evidence WHERE id = $1", [evidenceId]),
      ),
    ).toBe(tsaBefore);
    // The request that ran was a PACKAGE request at the stored report version.
    const req = sql(
      "SELECT artifact_type, report_version, intent, state FROM report_generation_requests WHERE evidence_id = $1 ORDER BY created_at_utc DESC LIMIT 1",
      [evidenceId],
    )[0]!;
    expect(req).toMatchObject({ artifact_type: "VERIFICATION_PACKAGE", report_version: 1, intent: "RECOVER", state: "SUCCEEDED" });
  });

  test("with the pair complete, Create new version is behind the overflow, confirmed, and keeps version 1", async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page, A.email);
    await openArtifacts(page, evidenceId);
    await expect(page.locator('[data-evidence-action="generate-outputs"]')).toHaveCount(0);

    await page.getByTestId("evidence-new-version").click();
    await page.locator('[data-evidence-output-row-action="create-new-version"]').click();
    const dialog = page.locator("[data-confirm-action-modal]");
    await expect(dialog).toContainText("Create version 2?");
    await expect(dialog).toContainText("Creates report version 2 and its verification package, alongside version 1.");
    await expect(dialog).toContainText("Earlier versions are kept unchanged");
    await expect(dialog).toContainText("Estimated additional storage");
    await dialog.locator('[data-confirm-action-submit="true"]').click();

    await expect(page.locator('[data-evidence-section="reports-new-version-in-flight"]')).toContainText("Creating version 2", { timeout: 30_000 });
    await expect
      .poll(async () => {
        const s = await status(A, evidenceId);
        return `${s.outputs.report.version}/${s.outputs.verificationPackage.version}/${s.outputs.pollIntervalMs}`;
      }, { timeout: 240_000, intervals: [2000] })
      .toBe("2/2/null");
    await expect(page.locator('[data-evidence-section="reports-new-version-in-flight"]')).toHaveCount(0, { timeout: 30_000 });

    // Version 1 is kept and still downloadable.
    const v1 = await download(A.token, `/v1/evidence/${evidenceId}/reports/1`);
    expect(sha256Hex(v1)).toBe(sha256Hex(reportV1));
  });
});
