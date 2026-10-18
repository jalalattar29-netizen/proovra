/**
 * EVERY IDENTIFIER OF A RECORD OPENS THE SAME, FULL PUBLIC VERIFY PAGE — on the
 * real stack (production API + worker images, production web build).
 *
 * Production (2026-10-17): the canonical `pvr_` link resolved, but to a
 * stripped "Evidence verification" matrix instead of the established Public
 * Verify page, because every canonical identifier answered a separate BASIC
 * projection. One record is now reached three ways — its permanent `pvr_`
 * reference, a report-printed `pvs_` token (the recovered shape), and its
 * record id inside the compatibility grace — and all three must give:
 *
 *   - the same projection (the established RICH page, its tabs and sections);
 *   - the same canonical reference and the same verification statuses;
 *   - the same disclosure — the record's disclosure policy (2026-10-18): a
 *     VERIFICATION_ONLY record shows no preview, title, file name, location,
 *     capture details, internal id or original bytes; a CONTENT_PREVIEW record
 *     shows its title, item names and safe previews, never the originals;
 *   - one status per fact on the page (matrix, signals, original evidence);
 *   - an anonymous, logged-out page that renders on desktop and phone width.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { API_BASE, clearTestRateLimits, createGuestSession, type GuestSession } from "../helpers/api-client";
import { createFinalizedEvidence, personalTeamId, sql, stackExec, waitForPair } from "./_stack";

test.describe.configure({ mode: "serial" });

type Ids = { id: string; ref: string; reportToken: string };
let A: GuestSession;
let teamId = "";
const unpublished: Ids = { id: "", ref: "", reportToken: "" };
const published: Ids = { id: "", ref: "", reportToken: "" };
const PRIVATE_TITLE = `Private-title-${Date.now()}`;
const PRIVATE_FILE = "private-original-name";

type Body = Record<string, unknown> & {
  tier?: string;
  disclosure?: { mode: string; recordedLocation: boolean; withheldStatement: string };
  link?: { kind: string };
  canonicalVerification?: { reference: string; status: string; disclosure?: { mode: string } };
  verificationMatrix?: { rows: Array<{ key: string; status: string; statusLabel?: string; statement: string }> };
  basicVerification?: {
    timestamp: { state: string };
    anchoring?: { state: string };
    package: { issued: boolean; sealed: boolean; sealKeyFingerprint: string | null };
  };
};

async function publicVerify(segment: string): Promise<{ status: number; body: Body; raw: string }> {
  const res = await fetch(`${API_BASE}/public/verify/${encodeURIComponent(segment)}`);
  const raw = await res.text();
  let body: Body = {};
  try {
    body = JSON.parse(raw) as Body;
  } catch {
    /* non-JSON failure */
  }
  return { status: res.status, body, raw };
}

/** A REPORT-purpose share token, as an issued report printed it (the recovered `pvs_` shape). */
function mintReportToken(evidenceId: string): string {
  const out = stackExec("api", [
    "node",
    "--input-type=module",
    "-e",
    `const { prisma } = await import("/app/services/api/dist/db.js");
     const rt = await import("@proovra/shared-runtime");
     rt.registerPrisma(prisma);
     const ev = await prisma.evidence.findUnique({ where: { id: ${JSON.stringify(evidenceId)} }, select: { teamId: true } });
     const token = rt.generateVerificationShareToken();
     await prisma.$transaction((tx) => rt.mintVerificationShareTokenTx(tx, { evidenceId: ${JSON.stringify(evidenceId)}, teamId: ev.teamId, purpose: "REPORT", reportVersion: 1, audience: "Report version 1", token, now: new Date() }));
     console.log("TOKEN=" + token); process.exit(0);`,
  ]);
  const m = out.match(/TOKEN=(pvs_\S+)/);
  if (!m) throw new Error(`mintReportToken: ${out}`);
  return m[1]!;
}

const refOf = (id: string) => sql<{ r: string }>(`SELECT verification_ref AS r FROM evidence WHERE id = $1`, [id])[0]!.r;

async function setUp(target: Ids, label: string, publish: boolean) {
  const { id } = await createFinalizedEvidence(A.api, teamId, label, undefined, {
    gps: { lat: 52.520008, lng: 13.404954, accuracyMeters: 12 },
  });
  await waitForPair(A.api, id, 1, 300_000);
  sql(
    `UPDATE evidence SET title = $2, original_file_name = $3, display_file_name = $3,
       verification_disclosure_mode = $4, show_recorded_location = false,
       legacy_verify_uuid_until_utc = now() + interval '90 days' WHERE id = $1`,
    [id, `${PRIVATE_TITLE}-${label}`, `${PRIVATE_FILE}-${label}.txt`, publish ? "CONTENT_PREVIEW" : "VERIFICATION_ONLY"],
  );
  target.id = id;
  target.ref = refOf(id);
  target.reportToken = mintReportToken(id);
}

const identifiersOf = (r: Ids) => [
  { kind: "pvr_ reference", segment: r.ref },
  { kind: "report pvs_ token", segment: r.reportToken },
  { kind: "record id (grace)", segment: r.id },
];

test.beforeAll(async () => {
  test.setTimeout(900_000);
  await clearTestRateLimits();
  A = await createGuestSession();
  teamId = await personalTeamId(A.api);
});

test("FIXTURES: a pre-canonical record reconciled by the backfill, and a new record issued its pvr_ at signing", async () => {
  test.setTimeout(900_000);
  // The Production shape: a record with its report and no reference, then the backfill.
  await setUp(unpublished, "pv-ident-unpublished", false);
  const legacyRef = unpublished.ref;
  sql(
    `DO $$ BEGIN
       ALTER TABLE evidence DISABLE TRIGGER evidence_verification_ref_set_once;
       UPDATE evidence SET verification_ref = NULL WHERE id = '${unpublished.id}';
       ALTER TABLE evidence ENABLE TRIGGER evidence_verification_ref_set_once;
     END $$;`,
  );
  expect(legacyRef).toMatch(/^pvr_/);
  stackExec("api", ["node", "dist/scripts/three-decisions-backfill.js", "verification-references", "--apply"]);
  unpublished.ref = refOf(unpublished.id);
  expect(unpublished.ref).toMatch(/^pvr_[A-Za-z0-9_-]{27}$/);

  // A new record: its reference was issued when it was finalized.
  await setUp(published, "pv-ident-published", true);
  expect(published.ref).toMatch(/^pvr_[A-Za-z0-9_-]{27}$/);
  writeFileSync(join(mkdtempSync(join(tmpdir(), "pv-ident-")), "ids.json"), JSON.stringify({ unpublished, published }));
});

for (const which of ["unpublished", "published"] as const) {
  test(`API (${which}): all three identifiers give the SAME full projection, reference, statuses and disclosure`, async () => {
    const r = which === "unpublished" ? unpublished : published;
    const answers = [];
    for (const { kind, segment } of identifiersOf(r)) {
      const a = await publicVerify(segment);
      expect(a.status, `${kind}: ${a.raw.slice(0, 300)}`).toBe(200);
      answers.push({ kind, ...a });
    }
    const shape = (b: Body) => ({
      tier: b.tier,
      disclosure: b.disclosure,
      reference: b.canonicalVerification?.reference,
      sections: Object.keys(b).filter((k) => !["link"].includes(k)).sort(),
      matrix: b.verificationMatrix?.rows.map((row) => [row.key, row.status, row.statusLabel ?? null]),
    });
    for (const a of answers) {
      // The established page, never the stripped replacement.
      expect(a.body.tier, a.kind).toBe("RICH");
      expect(a.body.canonicalVerification, a.kind).toMatchObject({ reference: r.ref, status: "AVAILABLE" });
      expect(a.body.disclosure?.mode, a.kind).toBe(which === "unpublished" ? "VERIFICATION_ONLY" : "CONTENT_PREVIEW");
      expect(shape(a.body), a.kind).toEqual(shape(answers[0]!.body));
    }
    expect(answers.map((a) => a.body.link?.kind)).toEqual(["CANONICAL", "CANONICAL", "LEGACY_RECORD_ID"]);
  });
}

test("PRIVACY: a record its owner has not published discloses no content, title, file name, location, capture detail, internal id or original bytes", async () => {
  for (const { kind, segment } of identifiersOf(unpublished)) {
    const { raw, body } = await publicVerify(segment);
    for (const forbidden of [unpublished.id, PRIVATE_TITLE, PRIVATE_FILE, "52.52", "13.40", "X-Amz-Signature", "data:image", A.userId]) {
      expect(raw, `${kind} leaks ${forbidden}`).not.toContain(forbidden);
    }
    expect(body.evidenceId ?? null, kind).toBeNull();
    expect(body.captureContext ?? null, kind).toBeNull();
    expect(body.locationState ?? null, kind).toBeNull();
    expect((body.contentAccessPolicy as { allowContentView?: boolean; allowDownload?: boolean }).allowContentView, kind).toBe(false);
    expect((body.contentAccessPolicy as { allowDownload?: boolean }).allowDownload, kind).toBe(false);
  }
  // A published record keeps the owner-consented page: its title is shown, the
  // original bytes are still never handed out by default (preview, not download).
  const pub = await publicVerify(published.ref);
  expect(pub.raw).toContain(`${PRIVATE_TITLE}-pv-ident-published`);
  expect(pub.raw).not.toContain("X-Amz-Signature");
});

test("TRUTH: one status per fact — matrix, signals and original-evidence checks agree; publication is never claimed for a canonical page", async () => {
  for (const r of [unpublished, published]) {
    const { body } = await publicVerify(r.ref);
    const rows = Object.fromEntries((body.verificationMatrix?.rows ?? []).map((row) => [row.key, row]));
    const basic = body.basicVerification!;
    // RFC 3161: the matrix and the original-evidence check say the same thing.
    const tsaStates: Record<string, string[]> = {
      VERIFIED: ["verified"],
      NOT_CHECKED: ["not_checked"],
      FAILED: ["failed"],
      // "Not obtained": the matrix says Unavailable, Basic Verify says the
      // request failed and none was obtained — never a positive state.
      UNAVAILABLE: ["not_issued", "pending", "failed"],
      NOT_APPLICABLE: ["not_issued", "pending"],
    };
    expect(tsaStates[rows.tsa_token!.status], `matrix ${rows.tsa_token!.status} vs original evidence ${basic.timestamp.state}`).toContain(basic.timestamp.state);
    // The signals listed on the page are the same live decision the matrix states.
    const signals = ((body.trustDecision as { signals?: Array<{ key: string; state: string }> }).signals ?? []);
    const signalState = Object.fromEntries(signals.map((s) => [s.key, s.state]));
    if (rows.tsa_token!.status === "VERIFIED") expect(signalState.trusted_timestamp).toBe("PASSED");
    if (signalState.trusted_timestamp === "PASSED") expect(rows.tsa_token!.status).toBe("VERIFIED");
    expect(body.trustDecisionSource).toBe("LIVE_VERIFICATION");
    // A sealed package bound to a published key is VERIFIED, never "Not checked".
    if (basic.package.issued && basic.package.sealed && basic.package.sealKeyFingerprint) {
      expect(rows.package_signature!.status).toBe("VERIFIED");
      expect(rows.package_completeness!.status).toBe("VERIFIED");
    }
    if (!basic.package.issued) expect(rows.package_signature!.status).toBe("NOT_APPLICABLE");
    // OpenTimestamps: "Attestation recorded" is never "Independently verified".
    expect(rows.ots_anchoring!.status === "VERIFIED").toBe(/Independently verified/.test(rows.ots_anchoring!.statusLabel ?? ""));
    // A canonical page has no publication step.
    expect(rows.public_verify_publication).toMatchObject({ status: "NOT_APPLICABLE" });
    expect(rows.public_verify_publication!.statement).toMatch(/Disclosure: (Verification only|Content preview)/);
  }
});

async function expectFullPage(page: Page, ref: string, verificationOnly: boolean) {
  await expect(page.locator("[data-verify-canonical-reference]").first()).toHaveText(ref, { timeout: 90_000 });
  // Never the stripped replacement.
  await expect(page.locator('[data-verify-tier="basic"]')).toHaveCount(0);
  await expect(page.getByText("What was checked, signal by signal")).toBeVisible();
  // An accessible tablist (2026-10-18): the forensic chain and access activity are separate tabs.
  for (const tab of ["Record", "Integrity", "Package Integrity", "Forensic Chain", "Access Activity"]) {
    await expect(page.getByRole("tab", { name: tab, exact: true }).first(), tab).toBeVisible();
  }
  // One identifier on the page: the verification reference — never an "Evidence ID" or a token pill.
  await expect(page.getByText(/Evidence ID/i)).toHaveCount(0);
  await expect(page.getByText(/Token:\s*pv[rs]_/)).toHaveCount(0);
  await expect(page.locator("[data-verify-disclosure-notice]")).toHaveCount(verificationOnly ? 1 : 0);
  // No sentence on the page contradicts a status the page states elsewhere.
  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/Publication posture/);
  expect(text).not.toMatch(/sourced from the fixed snapshot/);
  expect(text).not.toMatch(/Published: this is the record's PROOVRA Public Verify page/);
  if (/TRUSTED TIMESTAMP \(RFC 3161\)\s*Not checked/i.test(text)) {
    expect(text, "a token that was obtained is never called unusable").not.toMatch(/did not return a usable token/);
  }
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over, "horizontal overflow").toBeLessThanOrEqual(0);
}

test("BROWSER: logged out, every identifier renders the full Public Verify page on desktop and phone width", async ({ browser }) => {
  test.setTimeout(600_000);
  await clearTestRateLimits();
  for (const viewport of [{ width: 1366, height: 900 }, { width: 390, height: 844 }]) {
    const ctx = await browser.newContext({ viewport });
    try {
      for (const [r, verificationOnly] of [[unpublished, true], [published, false]] as const) {
        for (const { kind, segment } of identifiersOf(r)) {
          const page = await ctx.newPage();
          const res = await page.goto(`/verify/${segment}`);
          expect(res?.status(), kind).toBe(200);
          await expectFullPage(page, r.ref, verificationOnly);
          if (verificationOnly) {
            const text = await page.locator("body").innerText();
            for (const forbidden of [PRIVATE_TITLE, PRIVATE_FILE, unpublished.id]) expect(text, `${kind} shows ${forbidden}`).not.toContain(forbidden);
          }
          await page.screenshot({ path: test.info().outputPath(`${r === unpublished ? "unpublished" : "published"}-${kind.replace(/\W+/g, "-")}-${viewport.width}.png`), fullPage: false });
          await page.close();
        }
      }
    } finally {
      await ctx.close();
    }
  }
});

test("FAILURES STAY UNIFORM: malformed and unknown identifiers; withdrawn, suspended and trashed records", async () => {
  await clearTestRateLimits();
  const unknown = await publicVerify(`pvr_${"Z".repeat(27)}`);
  expect(unknown.status).toBe(404);
  for (const seg of ["not-a-link", `pvs_${"Q".repeat(43)}`, "00000000-0000-4000-8000-000000000000"]) {
    const r = await publicVerify(seg);
    expect(r.status, seg).toBe(404);
    expect(r.raw, seg).toBe(unknown.raw);
  }
  // A suspended verification page answers 503 for every identifier; a withdrawn one 410.
  sql(`UPDATE evidence SET verification_access_state = 'SUSPENDED' WHERE id = $1`, [published.id]);
  for (const { kind, segment } of identifiersOf(published)) expect((await publicVerify(segment)).status, kind).toBe(503);
  await clearTestRateLimits();
  sql(`UPDATE evidence SET verification_access_state = 'WITHDRAWN' WHERE id = $1`, [published.id]);
  for (const { kind, segment } of identifiersOf(published)) expect((await publicVerify(segment)).status, kind).toBe(410);
  sql(`UPDATE evidence SET verification_access_state = 'AVAILABLE' WHERE id = $1`, [published.id]);
  await clearTestRateLimits();
  // A trashed record is no active record behind any identifier: every one
  // answers the same canonical RETAINED state — no tier, no record details.
  sql(`UPDATE evidence SET lifecycle_state = 'TRASHED', deleted_at = now() WHERE id = $1`, [unpublished.id]);
  const retained = [];
  for (const { kind, segment } of identifiersOf(unpublished)) {
    const r = await publicVerify(segment);
    expect(r.body.code, kind).toBe("VERIFICATION_RECORD_RETAINED");
    expect(r.body.tier, kind).toBeUndefined();
    for (const forbidden of [PRIVATE_TITLE, PRIVATE_FILE, unpublished.id]) expect(r.raw, `${kind} leaks ${forbidden}`).not.toContain(forbidden);
    retained.push(r.status);
  }
  expect(new Set(retained).size).toBe(1);
});
