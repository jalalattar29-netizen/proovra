/**
 * THE CANONICAL VERIFICATION PAGE, end to end on the real stack (production
 * API + worker images, production web build, Postgres, Redis, MinIO, TSA):
 *
 *   1. A NEW record gets its permanent `pvr_` reference when it is finalized —
 *      before any report exists — and every owner surface (verification-access,
 *      the review workspace, the Evidence hero) states the same link.
 *   2. The report PDF's link and the package's README carry exactly that link;
 *      none of them carries the record id.
 *   3. A logged-out visitor opens it.
 *   4. A PRE-CANONICAL record (a report, no reference — the production fleet's
 *      shape) shows no stand-in link; the operator backfill (dry run, apply,
 *      rerun) issues its reference without touching its artifacts, and its
 *      historical record-id link then opens the CANONICAL page.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { test, expect } from "@playwright/test";

import { API_BASE, clearTestRateLimits, createGuestSession, type GuestSession } from "../helpers/api-client";
import { signIn } from "./_browser";
import { extractPackage } from "./_truth";
import { createFinalizedEvidence, downloadVersion, personalTeamId, sha256Hex, sql, stackExec, waitForPair } from "./_stack";

test.describe.configure({ mode: "serial" });

const WORKER_DIR = resolve(__dirname, "..", "..", "services", "worker");
const REF = /^pvr_[A-Za-z0-9_-]{27}$/;

let A: GuestSession;
let teamId = "";
let fresh = { id: "", ref: "" };
let legacy = { id: "", reportSha: "", packageSha: "" };

type Access = { status: string; reference: string | null; verifyPath: string | null; refusalReason: string | null };

async function access(id: string): Promise<Access> {
  const res = await A.api.get(`/v1/evidence/${id}/verification-access`);
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as Access;
}

async function workspaceCanonical(id: string): Promise<Access> {
  const res = await A.api.get(`/v1/evidence/${id}/review-workspace`);
  expect(res.ok(), await res.text()).toBe(true);
  return ((await res.json()) as { canonicalVerification: Access }).canonicalVerification;
}

function pdfLinks(pdf: Buffer): { links: string[]; text: string[] } {
  const file = join(mkdtempSync(join(tmpdir(), "cv-pdf-")), "report.pdf");
  writeFileSync(file, pdf);
  const run = spawnSync(process.execPath, ["--import", "tsx", resolve(__dirname, "pdf-links.mjs"), file], {
    cwd: WORKER_DIR,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(`pdf-links failed: ${run.stderr}`);
  return JSON.parse(run.stdout) as { links: string[]; text: string[] };
}

type BackfillSummary = { scanned: number; eligible: number; issued: number; alreadyIssued: number; failed: number };

function backfill(apply: boolean): BackfillSummary {
  const out = stackExec("api", [
    "node",
    "dist/scripts/three-decisions-backfill.js",
    "verification-references",
    ...(apply ? ["--apply"] : []),
  ]);
  const line = out.split("\n").find((l) => l.includes("[verification-references] SUMMARY"));
  expect(line, out).toBeTruthy();
  return JSON.parse(line!.slice(line!.indexOf("{"))) as BackfillSummary;
}

async function publicVerify(token: string) {
  const res = await fetch(`${API_BASE}/public/verify/${encodeURIComponent(token)}`);
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

test.beforeAll(async () => {
  await clearTestRateLimits();
  A = await createGuestSession();
  teamId = await personalTeamId(A.api);
});

test("SIGNING: a new record's permanent pvr_ reference is issued at finalization, and every owner surface states the same link", async () => {
  test.setTimeout(300_000);
  const { id } = await createFinalizedEvidence(A.api, teamId, "cv-fresh");
  // Issued by the finalize transaction itself — no report job has run yet.
  const [row] = sql<{ verification_ref: string | null }>(`SELECT verification_ref FROM evidence WHERE id = $1`, [id]);
  expect(row?.verification_ref).toMatch(REF);
  const issued = sql<{ n: string }>(
    `SELECT count(*)::text AS n FROM custody_events WHERE evidence_id = $1 AND event_type = 'VERIFICATION_REFERENCE_ISSUED'`,
    [id],
  );
  expect(issued[0]?.n).toBe("1");
  fresh = { id, ref: row!.verification_ref! };

  const a = await access(id);
  expect(a).toMatchObject({ status: "AVAILABLE", reference: fresh.ref, verifyPath: `/verify/${fresh.ref}`, refusalReason: null });
  expect(await workspaceCanonical(id)).toMatchObject({ status: a.status, reference: a.reference, verifyPath: a.verifyPath });
  // The disclosure policy never decides it (it decides what the page shows).
  sql(`UPDATE evidence SET verification_disclosure_mode = 'VERIFICATION_ONLY', show_recorded_location = false WHERE id = $1`, [id]);
  expect((await access(id)).verifyPath).toBe(`/verify/${fresh.ref}`);
});

test("ARTIFACTS: the report's link and the package carry exactly the canonical link, never the record id", async () => {
  test.setTimeout(400_000);
  await waitForPair(A.api, fresh.id, 1, 300_000);
  // The report job reused the finalization reference; it did not issue another.
  const [row] = sql<{ verification_ref: string }>(`SELECT verification_ref FROM evidence WHERE id = $1`, [fresh.id]);
  expect(row?.verification_ref).toBe(fresh.ref);

  const { links, text } = pdfLinks(await downloadVersion(A.api, fresh.id, "report", 1));
  const all = [...links, ...text];
  expect(links.some((l) => l.endsWith(`/verify/${fresh.ref}`)), JSON.stringify(all)).toBe(true);
  expect(all.filter((l) => l.includes(fresh.id))).toEqual([]);

  const pkg = extractPackage(await downloadVersion(A.api, fresh.id, "package", 1), mkdtempSync(join(tmpdir(), "cv-pkg-")));
  const texts = [...pkg.texts.values()].join("\n");
  expect(texts).toContain(`/verify/${fresh.ref}`);
  expect(texts).not.toContain(`/verify/${fresh.id}`);
});

test("HERO + ANONYMOUS: the Evidence hero opens the canonical page, and a logged-out visitor sees it", async ({ page, browser }) => {
  test.setTimeout(300_000);
  await signIn(page, A.email);
  await page.goto(`/evidence/${fresh.id}`);
  await page.waitForSelector(".evidence-detail-hero", { timeout: 60_000 });
  const link = page.locator('a[data-evidence-action="open-verification-link"]').first();
  await expect(link).toBeVisible();
  expect(await link.getAttribute("href")).toMatch(new RegExp(`/verify/${fresh.ref}$`));
  expect(await link.getAttribute("rel")).toContain("noopener");

  const anon = await browser.newContext();
  try {
    const p = await anon.newPage();
    const res = await p.goto(`/verify/${fresh.ref}`);
    expect(res?.status()).toBe(200);
    await expect(p.locator("[data-verify-canonical-reference]").first()).toHaveText(fresh.ref, { timeout: 60_000 });
  } finally {
    await anon.close();
  }
});

test("PRE-CANONICAL: no stand-in link; the backfill issues the reference without touching artifacts; the record-id link opens the canonical page", async ({ page, browser }) => {
  test.setTimeout(600_000);
  const { id } = await createFinalizedEvidence(A.api, teamId, "cv-pre-canonical");
  await waitForPair(A.api, id, 1, 300_000);
  // The production fleet's shape: a published record with its report and
  // package, inside the record-id grace, from before references existed.
  // (Its custody stays append-only; the backfill never reads it.)
  sql(
    `DO $$ BEGIN
       ALTER TABLE evidence DISABLE TRIGGER evidence_verification_ref_set_once;
       UPDATE evidence SET verification_ref = NULL, verification_disclosure_mode = 'CONTENT_PREVIEW',
         legacy_verify_uuid_until_utc = now() + interval '90 days' WHERE id = '${id}';
       ALTER TABLE evidence ENABLE TRIGGER evidence_verification_ref_set_once;
     END $$;`,
  );
  const artifacts = () =>
    sql<{ kind: string; sha: string }>(
      `SELECT 'report:' || version AS kind, storage_key AS sha FROM reports WHERE evidence_id = $1
       UNION ALL SELECT 'package:' || version, coalesce(package_sha256, '') FROM verification_packages WHERE evidence_id = $1
       ORDER BY 1, 2`,
      [id],
    );
  const before = artifacts();
  legacy = { id, reportSha: sha256Hex(await downloadVersion(A.api, id, "report", 1)), packageSha: sha256Hex(await downloadVersion(A.api, id, "package", 1)) };

  // Before reconciliation: NOT_ISSUED, and the hero offers no historical stand-in.
  expect(await access(id)).toMatchObject({ status: "NOT_ISSUED", reference: null, verifyPath: null });
  await signIn(page, A.email);
  await page.goto(`/evidence/${id}`);
  await page.waitForSelector(".evidence-detail-hero", { timeout: 60_000 });
  const disabled = page.locator('button[data-evidence-action="open-verification-link"]').first();
  await expect(disabled).toBeDisabled();
  // (2026-10-18) A record-id link opens only the canonical page, so before the
  // record holds its reference it is the uniform 404 — the backfill below is
  // what makes the printed link work again (run it with every deploy).
  expect((await publicVerify(id)).status).toBe(404);

  // THE OPERATOR BACKFILL: dry run changes nothing; apply issues; rerun is a no-op.
  const dry = backfill(false);
  expect(dry.failed).toBe(0);
  expect(dry.issued).toBeGreaterThanOrEqual(1);
  expect(sql<{ r: string | null }>(`SELECT verification_ref AS r FROM evidence WHERE id = $1`, [id])[0]?.r).toBeNull();
  const applied = backfill(true);
  expect(applied.failed).toBe(0);
  expect(applied.issued).toBe(dry.issued);
  const again = backfill(false);
  expect(again).toMatchObject({ issued: 0, failed: 0 });

  const ref = sql<{ r: string }>(`SELECT verification_ref AS r FROM evidence WHERE id = $1`, [id])[0]!.r;
  expect(ref).toMatch(REF);
  // No regeneration, no rewrite: the same rows and the same bytes.
  expect(artifacts()).toEqual(before);
  expect(sha256Hex(await downloadVersion(A.api, id, "report", 1))).toBe(legacy.reportSha);
  expect(sha256Hex(await downloadVersion(A.api, id, "package", 1))).toBe(legacy.packageSha);

  // The hero now opens the canonical page.
  await page.reload();
  await page.waitForSelector(".evidence-detail-hero", { timeout: 60_000 });
  expect(await page.locator('a[data-evidence-action="open-verification-link"]').first().getAttribute("href")).toMatch(
    new RegExp(`/verify/${ref}$`),
  );

  // The historical record-id link resolves THROUGH the canonical identity.
  const viaId = await publicVerify(id);
  expect(viaId.status).toBe(200);
  expect(viaId.body.canonicalVerification).toMatchObject({ reference: ref, status: "AVAILABLE" });
  const anon = await browser.newContext();
  try {
    const p = await anon.newPage();
    await p.goto(`/verify/${id}`);
    await expect(p.locator("[data-verify-canonical-reference]").first()).toHaveText(ref, { timeout: 60_000 });
  } finally {
    await anon.close();
  }
});

test("FAILURES ARE UNIFORM: malformed, unknown and out-of-grace links answer identically", async () => {
  const unknown = await publicVerify("pvr_" + "Z".repeat(27));
  const malformed = await publicVerify("not-a-link");
  sql(`UPDATE evidence SET legacy_verify_uuid_until_utc = NULL WHERE id = $1`, [legacy.id]);
  const outOfGrace = await publicVerify(legacy.id);
  for (const r of [malformed, outOfGrace]) {
    expect(r.status).toBe(unknown.status);
    expect(JSON.stringify(r.body)).toBe(JSON.stringify(unknown.body));
  }
  expect(unknown.status).toBe(404);
});
