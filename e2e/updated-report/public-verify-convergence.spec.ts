/**
 * PUBLIC VERIFY CONVERGENCE (2026-10-18) — the production lifecycle on the real
 * stack (production API + worker images, production web build, MinIO, the
 * local RFC 3161 authority, the offline OpenTimestamps upgrade).
 *
 * Journey A mirrors the production record the audit traced: a six-part
 * multipart record whose storage keys embed the original names, with GPS and a
 * device time; its RFC 3161 token obtained at intake but recorded FAILED (no
 * trust anchor), report v1; the kept token validated later by the repair; the
 * proof anchored (attestation recorded); report v2; the canonical reference
 * issued AFTER the reports (the backfill); the package rows of the legacy era.
 * It is opened through its pvr_, a report pvs_ and its record id in grace.
 * Journeys B–E cover the OpenTimestamps chain states, every access state, the
 * reviewer-share profile, and the three seal outcomes. Screenshots from the
 * production web build go to $RGA_PROOF_DIR/public-verify-convergence/.
 *
 * Owner approvals the stack has no human for (step-up) run the product's own
 * services inside the API image and say so (FIXTURE).
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

import { API_BASE, clearTestRateLimits, createGuestSession, type GuestSession } from "../helpers/api-client";
import { personalTeamId, signedRequest, sql, stackExec, validateKeptTsaToken, anchorOtsThroughUpgrade, waitForPair, status } from "./_stack";

test.describe.configure({ mode: "serial" });

const WEB_BASE = process.env.WEB_BASE ?? "http://127.0.0.1:53000";
const PROOF = resolve(process.env.RGA_PROOF_DIR ?? "test-results", "public-verify-convergence");
mkdirSync(PROOF, { recursive: true });

const NAMES = [
  "alpha-witness-statement",
  "bravo-dashcam-still",
  "charlie-insurer-letter",
  "delta-police-ref",
  "echo-garage-invoice",
  "foxtrot-medical-note",
];
const TITLE = `Kestrel-Lane-private-${Date.now()}`;
const DEVICE_TIME = "2026-10-01T09:41:07.123+02:00";
const GPS = { lat: 48.137154, lng: 11.576124, accuracyMeters: 7 };
const TILE_HOST = "https://tile.openstreetmap.org";

let owner: GuestSession;
let teamId = "";
let ownerUserId = "";
const rec = { id: "", ref: "", reportToken: "" };

type Body = Record<string, any>;
async function publicVerify(segment: string, query = ""): Promise<{ status: number; body: Body; raw: string }> {
  const res = await fetch(`${API_BASE}/public/verify/${encodeURIComponent(segment)}${query}`);
  const raw = await res.text();
  let body: Body = {};
  try {
    body = JSON.parse(raw);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body, raw };
}
const row = (body: Body, key: string) => (body.verificationMatrix?.rows ?? []).find((r: Body) => r.key === key);

function nodeInApi(script: string): string {
  return stackExec("api", ["node", "--input-type=module", "-e", script]);
}

/** FIXTURE (owner step-up approval): change the record's disclosure through the one authority. */
function setDisclosure(mode: "VERIFICATION_ONLY" | "CONTENT_PREVIEW", showRecordedLocation: boolean) {
  const out = nodeInApi(
    `const { prisma } = await import("/app/services/api/dist/db.js");
     const rt = await import("@proovra/shared-runtime"); rt.registerPrisma(prisma);
     const svc = await import("/app/services/api/dist/services/public-verify/verification-disclosure.service.js");
     const cur = await svc.readVerificationDisclosure(${JSON.stringify(rec.id)});
     const r = await svc.changeVerificationDisclosure({ evidenceId: ${JSON.stringify(rec.id)}, actorUserId: ${JSON.stringify(ownerUserId)}, mode: ${JSON.stringify(mode)}, showRecordedLocation: ${showRecordedLocation}, expectedVersion: cur.version });
     console.log("RESULT=" + r.outcome); process.exit(0);`,
  );
  expect(out).toMatch(/RESULT=(CHANGED|UNCHANGED)/);
}

/** FIXTURE (owner approval): a reviewer share through the product's share service. */
function share(opts: { projection?: "STANDARD" | "BASIC"; maxUses?: number | null; allowOriginalDownload?: boolean; expiresInDays?: number | null } = {}): string {
  const out = nodeInApi(
    `const { prisma } = await import("/app/services/api/dist/db.js");
     const rt = await import("@proovra/shared-runtime"); rt.registerPrisma(prisma);
     const s = await import("/app/services/api/dist/services/governance/verification-share.service.js");
     const record = await s.loadRecordForShare(${JSON.stringify(rec.id)});
     const r = await s.createVerificationLink({ record, actorUserId: ${JSON.stringify(ownerUserId)}, audience: "Insurer reviewer", expiresInDays: ${JSON.stringify(opts.expiresInDays ?? 7)}, projection: ${JSON.stringify(opts.projection ?? "STANDARD")}, maxUses: ${JSON.stringify(opts.maxUses ?? null)}, allowOriginalDownload: ${opts.allowOriginalDownload === true} });
     console.log("TOKEN=" + r.token); process.exit(0);`,
  );
  const m = out.match(/TOKEN=(pvs_\S+)/);
  if (!m) throw new Error(`share: ${out}`);
  return m[1]!;
}

function mintReportToken(evidenceId: string): string {
  const out = nodeInApi(
    `const { prisma } = await import("/app/services/api/dist/db.js");
     const rt = await import("@proovra/shared-runtime"); rt.registerPrisma(prisma);
     const ev = await prisma.evidence.findUnique({ where: { id: ${JSON.stringify(evidenceId)} }, select: { teamId: true } });
     const token = rt.generateVerificationShareToken();
     await prisma.$transaction((tx) => rt.mintVerificationShareTokenTx(tx, { evidenceId: ${JSON.stringify(evidenceId)}, teamId: ev.teamId, purpose: "REPORT", reportVersion: 1, audience: "Report version 1", token, now: new Date() }));
     console.log("TOKEN=" + token); process.exit(0);`,
  );
  return out.match(/TOKEN=(pvs_\S+)/)![1]!;
}

/** A multipart record: six named parts uploaded through presigned URLs, then completed. */
async function createMultipart(api: APIRequestContext): Promise<string> {
  const created = await api.post("/v1/evidence", {
    data: { teamId, type: "DOCUMENT", mimeType: "text/plain", deviceTimeIso: DEVICE_TIME, gps: GPS },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const id = ((await created.json()) as { id: string }).id;
  for (const [i, name] of NAMES.entries()) {
    const bytes = Buffer.from(`${name} ${Date.now()} ${i}\n`);
    const sha = createHash("sha256").update(bytes).digest("base64");
    const md5 = createHash("md5").update(bytes).digest("base64");
    const part = await api.post(`/v1/evidence/${id}/parts`, {
      data: { partIndex: i, mimeType: "text/plain", originalFileName: `${name}.txt`, checksumSha256Base64: sha, contentMd5Base64: md5 },
    });
    expect(part.ok(), await part.text()).toBe(true);
    const put = await signedRequest("PUT", ((await part.json()) as { upload: { putUrl: string } }).upload.putUrl, bytes, {
      "Content-Type": "text/plain",
      "x-amz-checksum-sha256": sha,
      "Content-MD5": md5,
    });
    expect(put.status).toBe(200);
  }
  const done = await api.post(`/v1/evidence/${id}/complete`, { data: {} });
  expect(done.ok(), await done.text()).toBe(true);
  return id;
}

async function newVersion(api: APIRequestContext, id: string, reason: string) {
  const st = await status(api, id);
  const res = await api.post(`/v1/evidence/${id}/reports/regenerate`, {
    data: { intent: "NEW_VERSION", reason, clientRequestKey: `pvc-${Date.now()}`, offerRevision: st.outputs.offer?.revision },
  });
  expect([200, 202]).toContain(res.status());
}

async function openPage(page: Page, segment: string, width: number, shot: string) {
  await page.setViewportSize({ width, height: width < 500 ? 812 : 1100 });
  await page.goto(`${WEB_BASE}/verify/${encodeURIComponent(segment)}`, { waitUntil: "networkidle" });
  await expect(page.getByText("Verification reference").first()).toBeVisible({ timeout: 60_000 });
  // No horizontal page scroll.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${shot}: horizontal overflow`).toBeLessThanOrEqual(1);
  await page.screenshot({ path: join(PROOF, `${shot}.png`), fullPage: true });
  return (await page.textContent("body")) ?? "";
}

const assertNoLeaks = (text: string, label: string) => {
  for (const n of NAMES) expect(text, `${label}: ${n}`).not.toContain(n);
  expect(text, label).not.toContain(TITLE);
  expect(text, label).not.toMatch(/\*\*\*@|@example\.test|@test\.proovra/);
  expect(text, label).not.toContain(String(GPS.lat));
  expect(text, label).not.toContain("09:41:07");
  expect(text, label).not.toMatch(/X-Amz-Signature|evidence\/[0-9a-f-]{36}\/parts\//);
  expect(text, label).not.toContain(rec.id);
};

test.beforeAll(async () => {
  test.setTimeout(900_000);
  await clearTestRateLimits();
  owner = await createGuestSession();
  teamId = await personalTeamId(owner.api);
  ownerUserId = sql<{ owner_user_id: string }>(`SELECT owner_user_id FROM teams WHERE id = $1`, [teamId])[0]!.owner_user_id;
});

// Each journey reads the public route many times: start every test with a
// fresh per-client budget, as the other journey specs do.
test.beforeEach(async () => {
  await clearTestRateLimits();
});

test("A0 LIFECYCLE: multipart record → TSA kept-but-FAILED → v1 → repair → attestation → v2 → reference backfilled", async () => {
  test.setTimeout(1_200_000);
  rec.id = await createMultipart(owner.api);
  await waitForPair(owner.api, rec.id, 1, 300_000);
  sql(`UPDATE evidence SET title = $2 WHERE id = $1`, [rec.id, TITLE]);
  // Intake recorded the kept token as FAILED (no trust anchor in the stack).
  const [tsa] = sql<{ tsa_status: string; has_token: boolean }>(`SELECT tsa_status, (tsa_token_base64 IS NOT NULL) AS has_token FROM evidence WHERE id = $1`, [rec.id]);
  expect(tsa).toMatchObject({ tsa_status: "FAILED", has_token: true });
  // The kept token is validated later by the repair; the proof is attested.
  validateKeptTsaToken(rec.id);
  anchorOtsThroughUpgrade(rec.id);
  await expect.poll(async () => (await status(owner.api, rec.id)).outputs.trust.ots.state, { timeout: 180_000 }).toBe("ANCHORED");
  await newVersion(owner.api, rec.id, "Timestamp validated and proof attested");
  await waitForPair(owner.api, rec.id, 2, 300_000);
  // The reference issued AFTER both reports (the production backfill shape).
  sql(
    `DO $$ BEGIN
       ALTER TABLE evidence DISABLE TRIGGER evidence_verification_ref_set_once;
       UPDATE evidence SET verification_ref = NULL WHERE id = '${rec.id}';
       ALTER TABLE evidence ENABLE TRIGGER evidence_verification_ref_set_once;
     END $$;`,
  );
  stackExec("api", ["node", "dist/scripts/three-decisions-backfill.js", "verification-references", "--apply"]);
  rec.ref = sql<{ r: string }>(`SELECT verification_ref AS r FROM evidence WHERE id = $1`, [rec.id])[0]!.r;
  expect(rec.ref).toMatch(/^pvr_[A-Za-z0-9_-]{27}$/);
  rec.reportToken = mintReportToken(rec.id);
  sql(`UPDATE evidence SET legacy_verify_uuid_until_utc = now() + interval '90 days' WHERE id = $1`, [rec.id]);
});

test("A1 VERIFICATION_ONLY (the default) — pvr_, report pvs_ and grace id: the same truth, nothing withheld leaks", async () => {
  const answers = [await publicVerify(rec.ref), await publicVerify(rec.reportToken), await publicVerify(rec.id)];
  for (const a of answers) {
    expect(a.status, a.raw.slice(0, 300)).toBe(200);
    assertNoLeaks(a.raw, "api");
    expect(a.body.disclosure.mode).toBe("VERIFICATION_ONLY");
    expect(a.body.recordFacts.verificationReference).toBe(rec.ref);
    expect(a.body.recordFacts.recordKindLabel).toBe("Multipart package · 6 items");
    expect(a.body.recordFacts.identity).toMatchObject({ disclosure: "WITHHELD", statement: "Withheld by the record’s disclosure policy" });
    expect(a.body.evidenceContent.items.map((i: Body) => i.label)).toEqual(["Item 1", "Item 2", "Item 3", "Item 4", "Item 5", "Item 6"]);
    expect(a.body.custodyLifecycle.accessEvents).toEqual([]);
    expect(a.body.captureContext ?? null).toBeNull();
    // OTS: attestation recorded, not checked; TSA validated from the kept token.
    expect(row(a.body, "ots_anchoring")).toMatchObject({ status: "NOT_CHECKED", statusLabel: "Attestation recorded" });
    expect(row(a.body, "tsa_token")).toMatchObject({ status: "VERIFIED", statusLabel: "Verified — validated from the timestamp token retained at intake" });
    // The package card states the matrix's own seal check.
    expect(a.body.verificationPackageIntegrity.sealCheck).toBe(row(a.body, "package_signature").status);
    // No false alarm: the reference issued after the reports is administrative.
    const reasons = a.body.trustDecisionConsistency.reasons.map((r: Body) => r.code);
    expect(reasons).not.toContain("FORENSIC_CUSTODY_CHANGED");
    expect(a.body.trustDecisionConsistency.reasons.some((r: Body) => r.tone === "danger")).toBe(false);
    // Anchoring was recorded before v2 was issued: not "advanced".
    expect(a.body.liveAnchoring.advance).toBe("NONE");
    expect(a.body.verificationSnapshot.otsVerificationAtGeneration).toBe("ATTESTATION_RECORDED");
  }
  // Same statuses through every identifier.
  const statuses = answers.map((a) => a.body.verificationMatrix.rows.map((r: Body) => `${r.key}:${r.status}`).join("|"));
  expect(new Set(statuses).size).toBe(1);
});

test("A2 VERIFICATION_ONLY in the browser — desktop, 375 px and print", async ({ page }) => {
  for (const [width, shot] of [
    [1366, "verification-only-desktop"],
    [375, "verification-only-mobile"],
  ] as const) {
    const text = await openPage(page, rec.ref, width, shot);
    assertNoLeaks(text, shot);
    expect(text).toContain("Multipart package · 6 items");
    expect(text).toContain("Withheld by the record’s disclosure policy");
    expect(text).toContain("Item 6");
    expect(text).not.toMatch(/Evidence ID/i);
    expect(text).toContain("Attestation recorded");
    expect(text).toContain("validated from the timestamp token retained at intake");
  }
  await page.screenshot({ path: join(PROOF, "tsa-repaired.png"), fullPage: true });
  await page.screenshot({ path: join(PROOF, "ots-attestation-recorded.png"), fullPage: true });
  await page.setViewportSize({ width: 1366, height: 1100 });
  await page.emulateMedia({ media: "print" });
  await page.screenshot({ path: join(PROOF, "print-view.png"), fullPage: true });
  await page.pdf({ path: join(PROOF, "print-view.pdf") }).catch(() => null);
  await page.emulateMedia({ media: "screen" });
});

test("A3 CONTENT_PREVIEW — title, names and previews appear; location stays hidden until its own decision", async ({ page }) => {
  setDisclosure("CONTENT_PREVIEW", false);
  const api = await publicVerify(rec.ref);
  expect(api.body.disclosure.mode).toBe("CONTENT_PREVIEW");
  for (const n of NAMES) expect(api.raw).toContain(n);
  expect(api.raw).toContain(TITLE);
  expect(api.raw).not.toContain(String(GPS.lat));
  expect(api.body.captureContext ?? null).toBeNull();
  expect(api.raw).not.toMatch(/X-Amz-Signature|\*\*\*@/);
  for (const [width, shot] of [
    [1366, "content-preview-desktop"],
    [375, "content-preview-mobile"],
  ] as const) {
    const text = await openPage(page, rec.ref, width, shot);
    expect(text).toContain(NAMES[0]);
    expect(text).not.toContain(String(GPS.lat));
  }
  await page.screenshot({ path: join(PROOF, "location-hidden.png"), fullPage: true });
});

test("A4 location shown only after its own decision: Recorded Location, consent before any public tile, never 'verified'", async ({ page }) => {
  setDisclosure("CONTENT_PREVIEW", true);
  let tileRequests = 0;
  await page.route(`${TILE_HOST}/**`, (route) => {
    tileRequests += 1;
    return route.fulfill({ status: 200, contentType: "image/png", body: Buffer.alloc(0) });
  });
  const text = await openPage(page, rec.ref, 1366, "location-shown-before-consent");
  expect(text).toMatch(/Recorded location/i);
  expect(text).not.toMatch(/verified location|location verified/i);
  expect(tileRequests).toBe(0);
  const consent = page.locator('[data-capture-location-map="consent"]');
  await expect(consent).toBeVisible({ timeout: 90_000 });
  await consent.locator('[data-map-action="load-interactive-map"]').click();
  await expect.poll(() => tileRequests, { timeout: 30_000 }).toBeGreaterThan(0);
  await expect(page.locator("[data-capture-location-coordinates]").first()).toContainText(String(GPS.lat));
  await page.screenshot({ path: join(PROOF, "location-shown.png"), fullPage: true });
  // Back to the default for the remaining journeys.
  setDisclosure("VERIFICATION_ONLY", false);
});

test("B OpenTimestamps: chain verified → VERIFIED; verifier unavailable → still Attestation recorded; digest mismatch → FAILED", async ({ page }) => {
  const [p] = sql<{ proof: string; fp: string }>(`SELECT ots_proof_base64 AS proof, fingerprint_hash AS fp FROM evidence WHERE id = $1`, [rec.id]);
  const proofSha = createHash("sha256").update(Buffer.from(p!.proof, "base64")).digest("hex");
  const height = Number((await publicVerify(rec.ref)).body.storageAndTimestamping.ots.bitcoinBlockHeight ?? 860000);
  const chain = (statusWord: string) =>
    sql(
      `UPDATE evidence SET ots_chain_verification_status = $2::varchar, ots_chain_checked_at_utc = now(), ots_chain_verified_at_utc = CASE WHEN $2::varchar = 'VERIFIED' THEN now() ELSE NULL END,
         ots_chain_block_height = $3, ots_chain_block_hash = $4, ots_chain_block_time_utc = now() - interval '1 day', ots_chain_confirmations = 12,
         ots_chain_verifier = $5, ots_chain_failure_code = NULL WHERE id = $1`,
      [rec.id, statusWord, height, "00000000000000000001" + "ab".repeat(22), `proovra-ots-chain/1;core=310100;min=6;proof=${proofSha.slice(0, 16)}`],
    );
  chain("VERIFIED");
  let b = (await publicVerify(rec.ref)).body;
  expect(row(b, "ots_anchoring")).toMatchObject({ status: "VERIFIED", statusLabel: "Independently verified" });
  await openPage(page, rec.ref, 1366, "ots-independently-verified");
  chain("UNAVAILABLE");
  b = (await publicVerify(rec.ref)).body;
  expect(row(b, "ots_anchoring")).toMatchObject({ status: "NOT_CHECKED", statusLabel: "Attestation recorded" });
  expect(row(b, "ots_anchoring").qualifiers).toContain("VERIFIER_UNAVAILABLE");
  // A proof that commits to another digest.
  sql(`UPDATE evidence SET ots_hash = $2 WHERE id = $1`, [rec.id, "0".repeat(64)]);
  b = (await publicVerify(rec.ref)).body;
  expect(row(b, "ots_anchoring").status).toBe("FAILED");
  sql(`UPDATE evidence SET ots_hash = $2, ots_chain_verification_status = NULL, ots_chain_checked_at_utc = NULL, ots_chain_verified_at_utc = NULL WHERE id = $1`, [rec.id, p!.fp]);
});

test("C access states: suspend, withdraw and trash answer 503/410/RETAINED for every identifier, writing nothing first", async () => {
  const views = () => Number(sql<{ n: number }>(`SELECT count(*)::int AS n FROM verification_views WHERE evidence_id = $1`, [rec.id])[0]!.n);
  const custody = () => Number(sql<{ n: number }>(`SELECT count(*)::int AS n FROM custody_events WHERE evidence_id = $1`, [rec.id])[0]!.n);
  const reviewer = share();
  const cases: Array<[string, string, number[]]> = [
    ["SUSPENDED", `UPDATE evidence SET verification_access_state = 'SUSPENDED' WHERE id = $1`, [503]],
    ["WITHDRAWN", `UPDATE evidence SET verification_access_state = 'WITHDRAWN' WHERE id = $1`, [410]],
    ["TRASHED", `UPDATE evidence SET verification_access_state = 'AVAILABLE', lifecycle_state = 'TRASHED', deleted_at = now() WHERE id = $1`, [200, 410]],
  ];
  for (const [label, update, codes] of cases) {
    sql(update, [rec.id]);
    await new Promise((r) => setTimeout(r, 300));
    const before = { v: views(), c: custody() };
    for (const seg of [rec.ref, rec.reportToken, rec.id, reviewer]) {
      const a = await publicVerify(seg);
      expect(codes, `${label} ${seg.slice(0, 4)}`).toContain(a.status);
      assertNoLeaks(a.raw, `${label}`);
      expect(a.body.verificationMatrix ?? null).toBeNull();
    }
    await new Promise((r) => setTimeout(r, 500));
    expect({ v: views(), c: custody() }, label).toEqual(before);
  }
  sql(`UPDATE evidence SET lifecycle_state = 'ACTIVE', deleted_at = NULL WHERE id = $1`, [rec.id]);
  expect((await publicVerify(rec.ref)).status).toBe(200);
});

test("D reviewer shares: profile, explicit download grant, use limit, revocation and expiry", async ({ page }) => {
  const std = share();
  const a = await publicVerify(std);
  expect(a.body.disclosure).toMatchObject({ mode: "CONTENT_PREVIEW", source: "REVIEWER_SHARE", originalDownload: false });
  expect(a.raw).not.toMatch(/X-Amz-Signature/);
  const granted = share({ allowOriginalDownload: true });
  const g = await publicVerify(granted);
  expect(g.body.disclosure.originalDownload).toBe(true);
  expect(g.body.evidenceContent.items.some((i: Body) => typeof i.viewUrl === "string")).toBe(true);
  const basic = share({ projection: "BASIC" });
  expect((await publicVerify(basic)).body.disclosure.mode).toBe("VERIFICATION_ONLY");
  const once = share({ maxUses: 1 });
  expect((await publicVerify(once)).status).toBe(200);
  expect((await publicVerify(once)).status).toBe(410);
  sql(`UPDATE verification_share_tokens SET revoked_at_utc = now(), revocation_reason = 'OWNER_REVOKED' WHERE token_hash = $1`, [createHash("sha256").update(std).digest("hex")]);
  expect((await publicVerify(std)).status).toBe(410);
  sql(`UPDATE verification_share_tokens SET expires_at_utc = now() - interval '1 minute' WHERE token_hash = $1`, [createHash("sha256").update(basic).digest("hex")]);
  expect((await publicVerify(basic)).status).toBe(410);
  // The pvr_ page is unaffected by any share.
  assertNoLeaks((await publicVerify(rec.ref)).raw, "pvr after shares");
  await openPage(page, granted, 1366, "reviewer-share-with-download");
});

test("E seals: a published-key seal is VERIFIED; a legacy seal not bound to a published key says so; a forged seal is FAILED — card = matrix", async ({ page }) => {
  const pkg = sql<{ id: string; seal_signing_key_id: string | null; seal_signing_key_version: number | null; seal_sha256: string; seal_signing_key_sha256: string }>(
    `SELECT id, seal_signing_key_id, seal_signing_key_version, seal_sha256, seal_signing_key_sha256 FROM verification_packages
      WHERE evidence_id = $1 AND (disclosure_profile IS NULL OR disclosure_profile = 'FULL_FORENSIC') ORDER BY version DESC LIMIT 1`,
    [rec.id],
  )[0]!;
  let b = (await publicVerify(rec.ref)).body;
  expect(row(b, "package_signature").status).toBe("VERIFIED");
  expect(b.verificationPackageIntegrity.sealCheck).toBe("VERIFIED");
  // FIXTURE: the legacy-era shape — the row recorded no key id (immutability trigger lifted for the fixture only).
  const fixture = (set: string) =>
    sql(
      `DO $$ BEGIN
         ALTER TABLE verification_packages DISABLE TRIGGER USER;
         UPDATE verification_packages SET ${set} WHERE id = '${pkg.id}';
         ALTER TABLE verification_packages ENABLE TRIGGER USER;
       END $$;`,
    );
  fixture(`seal_signing_key_id = NULL, seal_signing_key_version = NULL`);
  // A legacy seal whose key PROOVRA publishes: verified read-only from the stored package.
  b = (await publicVerify(rec.ref)).body;
  expect(row(b, "package_signature").status).toBe("VERIFIED");
  expect(b.verificationPackageIntegrity.sealCheck).toBe("VERIFIED");
  // Not bound to any published key.
  fixture(`seal_signing_key_sha256 = '${"9".repeat(64)}'`);
  b = (await publicVerify(rec.ref)).body;
  expect(row(b, "package_signature").status).toBe("NOT_CHECKED");
  expect(row(b, "package_signature").statement).toBe("Sealed — seal not checked against a published PROOVRA key.");
  expect(b.verificationPackageIntegrity.sealStatement).toBe(row(b, "package_signature").statement);
  const text = await openPage(page, rec.ref, 1366, "legacy-seal");
  expect(text).toContain("Sealed — seal not checked against a published PROOVRA key.");
  // A stored seal that is not the seal the row recorded.
  fixture(`seal_signing_key_sha256 = '${pkg.seal_signing_key_sha256}', seal_sha256 = '${"a".repeat(64)}'`);
  b = (await publicVerify(rec.ref)).body;
  expect(row(b, "package_signature").status).toBe("FAILED");
  expect(b.verificationPackageIntegrity.sealCheck).toBe("FAILED");
  fixture(
    `seal_signing_key_id = ${pkg.seal_signing_key_id ? `'${pkg.seal_signing_key_id}'` : "NULL"}, seal_signing_key_version = ${pkg.seal_signing_key_version ?? "NULL"}, seal_signing_key_sha256 = '${pkg.seal_signing_key_sha256}', seal_sha256 = '${pkg.seal_sha256}'`,
  );
});

test("F destroyed: every identifier answers 410 (PURGED), discloses nothing and writes nothing", async () => {
  const reviewer = share();
  sql(`UPDATE evidence SET lifecycle_state = 'DESTROYED', destroyed_at_utc = now(), deleted_at = now() WHERE id = $1`, [rec.id]);
  const custodyCount = () => Number(sql<{ n: number }>(`SELECT count(*)::int AS n FROM custody_events WHERE evidence_id = $1`, [rec.id])[0]!.n);
  const custodyBefore = custodyCount();
  for (const seg of [rec.ref, rec.reportToken, rec.id, reviewer]) {
    const a = await publicVerify(seg);
    expect([404, 410], seg.slice(0, 4)).toContain(a.status);
    assertNoLeaks(a.raw, "destroyed");
  }
  expect((await publicVerify(rec.ref)).status).toBe(410);
  await new Promise((r) => setTimeout(r, 500));
  expect(custodyCount()).toBe(custodyBefore);
});
