/**
 * THE THREE PRODUCT DECISIONS — FULL STACK (API + worker + MinIO + web).
 * Nothing is mocked: the real worker renders and packages, the real browser
 * reads the real pages. (owner decisions 2026-10-14)
 *
 *   1. A FREE account's THREE records each get their report AND verification
 *      package from the real worker; a fourth record is refused.
 *   2. The Artifacts tab's "Verification access" shows the record's permanent
 *      canonical page; a LOGGED-OUT browser opens it from the reference alone,
 *      sees verification facts, never the internal id, and the page is
 *      noindex; the internal id is not a link.
 *   3. Home counts 3 unlinked records; Delete → Trash and Home counts 2 (the
 *      deleted record never inflates it) → time advances past 90 days with a
 *      legal hold in force → the lifecycle sweep moves it to the Retention
 *      Archive → the owner restores it from "Archived evidence" in the browser
 *      → the running worker verifies the stored bytes and reactivates the SAME
 *      record → Home counts 3 again.
 */
import { test, expect, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { SESSION_PASSWORD, clearTestRateLimits, createGuestSession, type GuestSession } from "./helpers/api-client";

test.describe.configure({ mode: "serial" });

const API_DIR = resolve(__dirname, "..", "services", "api");
const WORKER_DIR = resolve(__dirname, "..", "services", "worker");

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

/** Run the worker's own lifecycle sweep with the clock advanced (time control, nothing else). */
function runTrashGraceSweep(teamId: string, now: Date) {
  const script = `
    import { runTrashGraceReconciliation } from "./dist/governance/trash-grace-reconciler.js";
    const out = await runTrashGraceReconciliation({ teamId: ${JSON.stringify(teamId)}, now: new Date(${JSON.stringify(now.toISOString())}), trigger: "e2e" });
    process.stdout.write(JSON.stringify(out.candidates.map((c) => ({ id: c.evidenceId, disposition: c.disposition, barrier: c.retentionBarrier }))));
    process.exit(0);
  `;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: WORKER_DIR, encoding: "utf8", timeout: 120_000 });
  if (run.status !== 0) throw new Error(`sweep failed: ${run.stderr}\n${run.stdout}`);
  const lines = run.stdout.trim().split("\n");
  return JSON.parse(lines[lines.length - 1]!) as Array<{ id: string; disposition: string; barrier: string | null }>;
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

test.describe("three product decisions — the real stack", () => {
  let A: GuestSession;
  let evidenceId = "";
  let reference = "";
  let teamId = "";

  /** One finalized record of the FREE account (upload + complete), by its id. */
  async function finalizeFreeRecord(label: string): Promise<string> {
    const bytes = `three decisions e2e ${label} ${Date.now()}\n`;
    const sha = createHash("sha256").update(bytes).digest("base64");
    const md5 = createHash("md5").update(bytes).digest("base64");
    const created = await A.api.post("/v1/evidence", {
      data: { type: "DOCUMENT", mimeType: "text/plain", originalFileName: "free.txt", checksumSha256Base64: sha, contentMd5Base64: md5 },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const id = ((await created.json()) as { id: string }).id;
    const partRes = await A.api.post(`/v1/evidence/${id}/parts`, {
      data: { partIndex: 0, mimeType: "text/plain", originalFileName: "free.txt", checksumSha256Base64: sha, contentMd5Base64: md5 },
    });
    expect(partRes.ok(), await partRes.text()).toBe(true);
    const part = (await partRes.json()) as { upload: { putUrl: string } };
    const put = await fetch(part.upload.putUrl, {
      method: "PUT",
      body: bytes,
      headers: { "Content-Type": "text/plain", "x-amz-checksum-sha256": sha, "Content-MD5": md5 },
    });
    expect(put.ok, `PUT ${put.status}`).toBe(true);
    const done = await A.api.post(`/v1/evidence/${id}/complete`, { data: {} });
    expect(done.ok(), await done.text()).toBe(true);
    return id;
  }

  test("FREE records 1–3 each get their report AND package from the real worker; the fourth is refused", async () => {
    test.setTimeout(420_000);
    await clearTestRateLimits();
    A = await createGuestSession({ plan: "FREE" });
    const records = [await finalizeFreeRecord("one"), await finalizeFreeRecord("two"), await finalizeFreeRecord("three")];
    evidenceId = records[0]!;

    // No regenerate call: finalization of a FREE-included record enqueues it.
    for (const id of records) {
      await expect
        .poll(async () => {
          const r = await A.api.get(`/v1/evidence/${id}/artifacts/status`);
          const s = (await r.json()) as { outputs: { report: { state: string }; verificationPackage: { state: string } } };
          return `${s.outputs.report.state}/${s.outputs.verificationPackage.state}`;
        }, { timeout: 240_000, intervals: [2000] })
        .toBe("READY/READY");
    }
    for (const id of records) {
      expect(sql("SELECT output_earned_basis FROM evidence WHERE id = $1", [id])[0]!.output_earned_basis).toBe("FREE_ALLOWANCE");
    }
    // The fourth record is refused at admission: three is the lifetime allowance.
    const fourth = await A.api.post("/v1/evidence", { data: { type: "DOCUMENT", mimeType: "text/plain" } });
    expect(fourth.status()).toBe(409);
    expect(((await fourth.json()) as { code?: string }).code).toBe("FREE_LIMIT_REACHED");

    const row = sql("SELECT output_earned_basis, verification_ref, team_id FROM evidence WHERE id = $1", [evidenceId])[0]!;
    expect(row.output_earned_basis).toBe("FREE_ALLOWANCE");
    expect(String(row.verification_ref)).toMatch(/^pvr_[A-Za-z0-9_-]{27}$/);
    reference = String(row.verification_ref);
    teamId = String(row.team_id);
  });

  test("the Artifacts tab shows the canonical page; a logged-out browser opens it from the reference alone", async ({ page, browser }) => {
    test.setTimeout(180_000);
    await signIn(page, A.email);
    await page.goto(`/evidence/${evidenceId}`);
    await page.waitForSelector(".evidence-detail-hero", { timeout: 30_000 });
    await page.getByRole("tab", { name: "Artifacts" }).click();
    const panel = page.locator('[data-evidence-section="verification-access"]');
    await expect(panel.locator('[data-verification-access-status="AVAILABLE"]')).toBeVisible({ timeout: 30_000 });
    await expect(panel.locator("[data-verification-access-reference]")).toHaveText(reference);
    await expect(panel.locator('[data-verification-access-action="open"]')).toHaveAttribute("href", new RegExp(`/verify/${reference}$`));
    await expect(panel).toContainText("It does not publish the original evidence files.");
    await expect(page.getByText("This record is private. It has no public verification page until you create a link")).toHaveCount(0);

    const anonymous = await browser.newContext();
    const reviewer = await anonymous.newPage();
    const response = await reviewer.goto(`/verify/${reference}`);
    expect(response?.status()).toBe(200);
    await expect(reviewer.locator("[data-verify-canonical-reference]")).toHaveText(reference, { timeout: 30_000 });
    // Never indexed: the verify layout's robots metadata (the production
    // X-Robots-Tag header is pinned by verify-capability-noindex.test.ts).
    await expect(reviewer.locator('meta[name="robots"]').first()).toHaveAttribute("content", /noindex/);
    await expect(reviewer.locator('[data-verify-tier="basic"]')).toBeVisible();
    expect(await reviewer.content()).not.toContain(evidenceId);
    // The internal id is not a link to the page.
    await reviewer.goto(`/verify/${evidenceId}`);
    await expect(reviewer.locator('[data-verify-canonical-state="LEGACY_LINK_RETIRED"]')).toBeVisible({ timeout: 30_000 });
    await anonymous.close();
  });

  /** Home's "unlinked records" chip — the canonical ACTIVE population in no active matter. */
  async function homeUnlinked(page: Page): Promise<string | null> {
    await page.goto("/home");
    const chip = page.locator("[data-case-unlinked]");
    await chip.first().waitFor({ timeout: 30_000 });
    return chip.first().getAttribute("data-case-unlinked");
  }

  test("Home 3 → Trash → Home 2 → (day 91, legal hold) → Retention Archive → restore in the browser → the SAME record → Home 3", async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page, A.email);
    expect(await homeUnlinked(page)).toBe("3");
    const trashed = await A.api.delete(`/v1/evidence/${evidenceId}`);
    expect(trashed.ok(), await trashed.text()).toBe(true);
    // The deleted record no longer counts on Home.
    expect(await homeUnlinked(page)).toBe("2");
    sql(
      `INSERT INTO evidence_legal_holds (team_id, evidence_id, title, reason, status, placed_by_user_id, updated_at)
       SELECT team_id, id, 'E2E hold', 'e2e', 'ACTIVE', owner_user_id::uuid, now() FROM evidence WHERE id = $1`,
      [evidenceId],
    );
    const day91 = new Date(Date.now() + 91 * 24 * 60 * 60 * 1000);
    const swept = runTrashGraceSweep(teamId, day91);
    expect(swept.find((c) => c.id === evidenceId)).toMatchObject({ disposition: "RETENTION_ARCHIVED", barrier: "LEGAL_HOLD" });
    expect(sql("SELECT lifecycle_state FROM evidence WHERE id = $1", [evidenceId])[0]!.lifecycle_state).toBe("RETENTION_ARCHIVED");

    await page.goto("/evidence/archive");
    const item = page.locator(`[data-archive-item="${evidenceId}"]`);
    await expect(item).toBeVisible({ timeout: 30_000 });
    await expect(item).toContainText("Archived — retained");
    await expect(item).toContainText("Legal hold");
    await item.locator('[data-archive-action="restore"]').click();
    await page.getByRole("button", { name: "Request restore" }).click();
    // The running worker's restore sweep verifies the stored bytes and the
    // issued report/package, then reactivates the record; the page polls.
    await expect
      .poll(() => sql("SELECT lifecycle_state FROM evidence WHERE id = $1", [evidenceId])[0]!.lifecycle_state, {
        timeout: 180_000,
        intervals: [2000],
      })
      .toBe("ACTIVE");
    await expect(page.locator(`[data-archive-item="${evidenceId}"]`)).toHaveCount(0, { timeout: 30_000 });
    const events = sql("SELECT event_type FROM custody_events WHERE evidence_id = $1 ORDER BY sequence", [evidenceId]).map((r) => r.event_type);
    expect(events).toEqual(expect.arrayContaining(["RETENTION_ARCHIVED", "ARCHIVE_RESTORE_REQUESTED", "ARCHIVE_RESTORE_VERIFIED", "ARCHIVE_RESTORE_COMPLETED"]));
    // Same identity, same verification page.
    expect(sql("SELECT verification_ref FROM evidence WHERE id = $1", [evidenceId])[0]!.verification_ref).toBe(reference);
    await page.goto(`/evidence/${evidenceId}`);
    await page.waitForSelector(".evidence-detail-hero", { timeout: 30_000 });
    expect(await homeUnlinked(page)).toBe("3");
  });
});
