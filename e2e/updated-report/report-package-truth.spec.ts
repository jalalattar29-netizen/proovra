/**
 * REPORT & VERIFICATION-PACKAGE TRUTH — the real stack, end to end.
 *
 * Fresh artifacts from current code (production API and worker images, real
 * MinIO, the local RFC 3161 TSA, a production web build) are generated through
 * the product path and inspected programmatically:
 *
 *   J1  web upload → v1 (TSA token kept, not validated): capture-time identity
 *       (verified email, personal workspace, organization not established),
 *       upload wording, timestamp truth; FULL + EXTERNAL packages consistent,
 *       sealed, README commands executed; DB rows and PROOVRA's public
 *       package record bind the package and its seal key.
 *   J2  TSA validated + attested OTS proof → v2 through the canonical
 *       NEW_VERSION path (idempotent): "proof present, not chain-verified",
 *       no verified claim or full points; v2 supersedes v1 and says what
 *       changed; v1 bytes unchanged; the README's openssl ts -verify runs.
 *   J3  chain verification recorded → freshness offers it → v3 states
 *       "verified against the Bitcoin chain" with its check time.
 *   J4  Public Verify, the review workspace and the package carry the same
 *       canonical states and the capture-time identity.
 *   J5  account/workspace changes after capture do not rewrite identity; an
 *       organization-verified capture is stated only when established.
 *   J6  key registry: current, rotated, revoked, unknown key, unknown package.
 *   J7  a legacy package (no profile, no id inside) is honestly labelled and
 *       still downloadable.
 *   J8  a VIEWER gets the external disclosure package only; an outsider
 *       nothing; every download is a custody event with its profile.
 *   J9  browser: the Artifacts tab shows identity, profile and both
 *       downloads; the public package record binds a dropped ZIP; an
 *       unreachable registry reads "binding unavailable".
 *
 * All temporary files go to RGA_PROOF_DIR (an OS temp folder by default).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPublicKey, generateKeyPairSync, verify as cryptoVerify } from "node:crypto";

import { test, expect, type APIRequestContext } from "@playwright/test";
import { verifySealedPackageEntries } from "@proovra/shared";

import { clearTestRateLimits, createGuestSession, type GuestSession } from "../helpers/api-client";
import { openArtifacts, signIn } from "./_browser";
import {
  addWorkspaceMember,
  anchorOtsThroughUpgrade,
  createFinalizedEvidence,
  downloadVersion,
  personalTeamId,
  signedRequest,
  sql,
  stackCtl,
  status,
  validateKeptTsaToken,
  waitForPair,
} from "./_stack";
import {
  consistencyFindings,
  extractPackage,
  provisionVerifiedOrganization,
  publishAndShare,
  readmeCommands,
  recordChainVerification,
  sh,
  sha256,
  type ExtractedPackage,
} from "./_truth";

test.describe.configure({ mode: "serial" });

const WORKER_DIR = resolve(__dirname, "..", "..", "services", "worker");
const PROOF_DIR = resolve(process.env.RGA_PROOF_DIR ?? join(tmpdir(), "pv-rga-proof"), "truth");
mkdirSync(PROOF_DIR, { recursive: true });
const API_BASE = process.env.API_BASE ?? "http://127.0.0.1:58081";

function pdfText(bytes: Buffer, name: string): string {
  const file = join(PROOF_DIR, name);
  writeFileSync(file, bytes);
  const run = spawnSync(process.execPath, [resolve(__dirname, "pdf-text.mjs"), file], { cwd: WORKER_DIR, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`pdf-text failed: ${run.stderr}`);
  return run.stdout.replace(/\s+/g, " ");
}

async function downloadExternal(api: APIRequestContext, id: string, version: number): Promise<{ status: number; zip: Buffer | null; body: Record<string, unknown> }> {
  const res = await api.get(`/v1/evidence/${id}/verification-packages/${version}/external-disclosure`);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status() !== 200) return { status: res.status(), zip: null, body };
  const file = await signedRequest("GET", String(body.url));
  expect(file.status).toBe(200);
  return { status: 200, zip: file.body, body };
}

async function publicRecord(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${API_BASE}${path}`);
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function newVersion(api: APIRequestContext, id: string, key: string, reason: string) {
  const st = await status(api, id);
  const res = await api.post(`/v1/evidence/${id}/reports/regenerate`, {
    data: { intent: "NEW_VERSION", reason, clientRequestKey: key, offerRevision: st.outputs.offer?.revision },
  });
  return { status: res.status(), body: (await res.json()) as Record<string, unknown> };
}

function sealOk(pkg: ExtractedPackage) {
  return verifySealedPackageEntries({
    entries: pkg.entries,
    sha256Hex: (b) => sha256(Buffer.from(b)),
    verifyEd25519: (m, s, pem) => cryptoVerify(null, Buffer.from(m), createPublicKey(pem), Buffer.from(s, "base64")),
    decodeUtf8: (b) => Buffer.from(b).toString("utf8"),
    hexToBytes: (h) => Buffer.from(h, "hex"),
  });
}

function signal(pkg: ExtractedPackage, key: string): Record<string, unknown> {
  const signals = (pkg.json("trust-decision.json").signals ?? []) as Array<Record<string, unknown>>;
  const s = signals.find((x) => x.key === key);
  expect(s, key).toBeTruthy();
  return s!;
}

const IDENTITY_OVERCLAIM = /OAuth-backed|Organization account|ORGANIZATION_ACCOUNT|VERIFIED_EMAIL/;

let owner: GuestSession;
let teamId = "";
let evidenceId = "";
const v1: { pdf: Buffer; full: ExtractedPackage | null; ext: ExtractedPackage | null; packageId: string; extPackageId: string } = {
  pdf: Buffer.alloc(0),
  full: null,
  ext: null,
  packageId: "",
  extPackageId: "",
};
let v3Full: ExtractedPackage | null = null;

test("J1 v1 — capture-time identity, upload wording and timestamp truth; both profiles consistent, sealed and bound to PROOVRA", async () => {
  test.setTimeout(600_000);
  await clearTestRateLimits();
  owner = await createGuestSession({ plan: "TEAM" });
  teamId = await personalTeamId(owner.api);
  const ev = await createFinalizedEvidence(owner.api, teamId, "truth");
  evidenceId = ev.id;
  await waitForPair(owner.api, evidenceId, 1);

  v1.pdf = await downloadVersion(owner.api, evidenceId, "report", 1);
  const zip = await downloadVersion(owner.api, evidenceId, "package", 1);
  const ext = await downloadExternal(owner.api, evidenceId, 1);
  expect(ext.status).toBe(200);
  v1.full = extractPackage(zip, join(PROOF_DIR, "v1-full"));
  v1.ext = extractPackage(ext.zip!, join(PROOF_DIR, "v1-external"));

  // --- PDF: identity, acquisition, timestamp -------------------------------
  const text = pdfText(v1.pdf, "v1.pdf");
  expect(text).toContain("Authenticated email account");
  expect(text).toContain("Personal workspace");
  expect(text).toMatch(/Organization Verification\s+Not established/i);
  expect(text).not.toMatch(IDENTITY_OVERCLAIM);
  expect(text).toContain("Files submitted through PROOVRA Web Upload. PROOVRA did not observe creation or editing before submission.");
  expect(text).not.toMatch(/secure capture/i);
  expect(text).toContain("Timestamp token obtained; not validated");
  expect(text).not.toMatch(/could not be obtained/i);
  expect(text).not.toMatch(/completedByUserId|acquisitionMode:/);

  // --- Package identity, consistency and seal (both profiles) --------------
  const full = v1.full!;
  const extPkg = v1.ext!;
  for (const pkg of [full, extPkg]) {
    expect(consistencyFindings(pkg), pkg.dir).toEqual([]);
    expect(sealOk(pkg).ok, JSON.stringify(sealOk(pkg).failures)).toBe(true);
  }
  const manifest = full.json("package-manifest.json");
  v1.packageId = String(manifest.packageId);
  v1.extPackageId = String(extPkg.json("package-manifest.json").packageId);
  expect(v1.packageId).toMatch(/^[0-9a-f-]{36}$/);
  expect(v1.extPackageId).not.toBe(v1.packageId);
  expect(manifest.disclosureProfile).toBe("FULL_FORENSIC");
  expect(manifest.supersedesPackage).toBeNull();
  expect(manifest.evidenceFileSha256).toBe(full.json("package-seal.json").fileSha256);
  expect(full.json("package-seal.json").packageId).toBe(v1.packageId);
  expect(full.json("signers/signer-registry-snapshot.json").packageId).toBe(v1.packageId);
  expect(full.texts.get("signers/signer-registry-snapshot.json")).not.toMatch(/\/run\/signing|arn:aws/);

  // --- The database row is the package -------------------------------------
  const [row] = sql<{ id: string; disclosure_profile: string; package_sha256: string; external_disclosure_artifact: Record<string, unknown> }>(
    "SELECT id, disclosure_profile, package_sha256, external_disclosure_artifact FROM verification_packages WHERE evidence_id = $1 AND version = 1",
    [evidenceId],
  );
  expect(row?.id).toBe(v1.packageId);
  expect(row?.disclosure_profile).toBe("FULL_FORENSIC");
  expect(row?.package_sha256).toBe(sha256(zip));
  expect(row?.external_disclosure_artifact.packageId).toBe(v1.extPackageId);
  expect(row?.external_disclosure_artifact.packageSha256).toBe(sha256(ext.zip!));

  // --- The README's commands, executed against the extracted package -------
  const readme = full.texts.get("README.txt")!;
  expect(readme).toContain(`Package ID: ${v1.packageId}`);
  expect(readme).not.toContain("fileSha256 from package-manifest.json");
  const commands = readmeCommands(readme).filter((c) => !c.startsWith("openssl ts -verify"));
  expect(commands.length).toBeGreaterThanOrEqual(10);
  const outputs = commands.map((c) => sh(full.dir, c));
  const sealSig = full.json("package-seal.sig");
  expect(outputs.join("\n")).toContain(String(sealSig.sealSha256));
  expect(outputs.join("\n")).toContain(String(sealSig.signingKeyFingerprint));
  expect(outputs.filter((o) => /Signature Verified Successfully/.test(o)).length).toBe(2);
  expect(outputs.join("\n")).toContain(String(manifest.evidenceFileSha256));

  // --- External disclosure: commitments kept, identifiers and infra gone ---
  expect([...extPkg.entries.keys()].some((p) => p.startsWith("reports/"))).toBe(false);
  // The original file sits at the FULL package root under a non-reserved name;
  // the external package has no such entry.
  const FIXED_ROOT = new Set(["README.txt", "signature.txt", "public-key.pem", "package-manifest-public-key.pem", "package-manifest.sig", "package-manifest.verify.txt", "package-seal.sig", "timestamp.tsr", "opentimestamps-proof.ots", "map-preview.png"]);
  const originals = (pkg: ExtractedPackage) =>
    [...pkg.entries.keys()].filter((p) => !p.includes("/") && !p.endsWith(".json") && !FIXED_ROOT.has(p));
  expect(originals(full)).toHaveLength(1);
  expect(originals(extPkg)).toEqual([]);
  expect(sealOk(extPkg).passed).toContain("REPORT_COMMITTED_WITHHELD");
  const disclosure = extPkg.json("disclosure-manifest.json");
  expect(disclosure.completeForensicPackage).toBe(false);
  expect(disclosure.sourceFullPackageId).toBe(v1.packageId);
  const withheld = (disclosure.withheldFiles as Array<Record<string, unknown>>).map((w) => w.reason);
  expect(withheld).toEqual(expect.arrayContaining(["ORIGINAL_CONTENT", "CONTAINS_DIRECT_IDENTIFIERS"]));
  expect((disclosure.fields as Array<Record<string, unknown>>).some((f) => /email/i.test(String(f.path)))).toBe(true);
  expect(extPkg.texts.get("original-linkage.json")).not.toMatch(/proovra-rga|evidence\/[0-9a-f-]{36}\/parts/);
  expect(full.texts.get("original-linkage.json")).toMatch(/storageKey/); // FULL keeps the necessary storage facts

  // --- PROOVRA's public record binds both packages and the seal key --------
  for (const [id, sha, profile, sig] of [
    [v1.packageId, sha256(zip), "FULL_FORENSIC", sealSig],
    [v1.extPackageId, sha256(ext.zip!), "EXTERNAL_DISCLOSURE", extPkg.json("package-seal.sig")],
  ] as const) {
    const byId = await publicRecord(`/public/verification-packages/${id}`);
    expect(byId.status).toBe(200);
    expect(byId.body.disclosureProfile).toBe(profile);
    expect(byId.body.packageSha256).toBe(sha);
    expect(byId.body.sealKeyFingerprintSha256).toBe(sig.signingKeyFingerprint);
    expect(byId.body.keyBinding).toBe("BOUND");
    expect(JSON.stringify(byId.body)).not.toMatch(/@example\.test|storageKey|proovra-rga/);
    const bySha = await publicRecord(`/public/verification-packages/by-sha256/${sha}`);
    expect(bySha.body.packageId).toBe(id);
  }
});

test("J2 v2 — TSA validated + attested OTS proof: present, not chain-verified; supersedes v1 and says what changed; v1 unchanged", async () => {
  test.setTimeout(600_000);
  validateKeptTsaToken(evidenceId);
  anchorOtsThroughUpgrade(evidenceId);
  await expect
    .poll(async () => (await status(owner.api, evidenceId)).outputs.freshness.changes.map((c) => c.code).sort().join(","), { timeout: 120_000 })
    .toContain("TSA_VALIDATED_AFTER_REPORT");
  // The attested proof is recorded by the worker's upgrade processor (async).
  await expect
    .poll(async () => (await status(owner.api, evidenceId)).outputs.trust.ots.status, { timeout: 180_000 })
    .toBe("ANCHORED");

  // Repeated clicks with one key are ONE request (no duplicate version or spend).
  const key = `truth-v2-${Date.now()}`;
  const first = await newVersion(owner.api, evidenceId, key, "Timestamp validated and proof attested");
  const second = await newVersion(owner.api, evidenceId, key, "Timestamp validated and proof attested");
  expect([200, 202]).toContain(first.status);
  expect(second.body.requestId ?? second.body.id).toBe(first.body.requestId ?? first.body.id);
  await waitForPair(owner.api, evidenceId, 2);
  expect(sql("SELECT count(*)::int AS n FROM reports WHERE evidence_id = $1", [evidenceId])[0]).toEqual({ n: 2 });

  const pdf2 = await downloadVersion(owner.api, evidenceId, "report", 2);
  const full2 = extractPackage(await downloadVersion(owner.api, evidenceId, "package", 2), join(PROOF_DIR, "v2-full"));
  const ext2 = await downloadExternal(owner.api, evidenceId, 2);
  const text = pdfText(pdf2, "v2.pdf");
  expect(text).toMatch(/Updated report/i);
  expect(text).toMatch(/Bitcoin attestation was added to the OpenTimestamps proof after report v1/);
  expect(text).toMatch(/supersedes report v1/);
  expect(text).toMatch(/trusted timestamp was validated after report v1/i);
  expect(text).toContain("Anchoring proof present; not independently chain-verified");
  expect(text).toContain("Proof present, not chain-verified");
  expect(text).not.toMatch(/Bitcoin anchoring\s+Verified/);
  expect(text).not.toMatch(/OAuth-backed|Organization account/);

  expect(consistencyFindings(full2)).toEqual([]);
  expect(signal(full2, "bitcoin_anchoring").state).toBe("PRESENT_NOT_INDEPENDENTLY_VERIFIED");
  expect(signal(full2, "bitcoin_anchoring").status).not.toBe("passed");
  expect(signal(full2, "trusted_timestamp").state).toBe("PASSED");
  expect(full2.json("package-manifest.json").publicAnchoringVerified).toBe(false);
  const trust = full2.json("trust-decision.json");
  expect(trust.verdict).not.toBe("STRONGLY_VERIFIED");

  // Supersession is explicit and v1 keeps its bytes.
  expect(full2.json("package-manifest.json").supersedesPackage).toEqual({ packageId: v1.packageId, reportVersion: 1 });
  expect(full2.json("package-seal.json").supersedesPackageId).toBe(v1.packageId);
  expect(sha256(await downloadVersion(owner.api, evidenceId, "report", 1))).toBe(sha256(v1.pdf));
  expect(sha256(await downloadVersion(owner.api, evidenceId, "package", 1))).toBe(sha256(v1.full!.zip));

  // The validated token is included, with its validation record, and the
  // README's openssl ts -verify succeeds against the authority's root.
  expect(full2.entries.has("timestamp.tsr")).toBe(true);
  const tv = full2.json("timestamp-validation.json");
  expect(tv.status).toBe("VALIDATED");
  expect(tv.imprintMatchesEvidenceDigest).toBe(true);
  expect((tv.qualifiedStatus as Record<string, unknown>).evaluated).toBe(false);
  expect(tv.checks).toMatchObject({ signature: "PASSED", certificateChain: "PASSED", messageImprint: "PASSED" });
  const ca = spawnSync("docker", ["compose", "-p", "pv-rga", "-f", resolve(__dirname, "stack", "docker-compose.yml"), "exec", "-T", "tsa", "cat", "/tsa/ca.pem"], { encoding: "utf8" });
  writeFileSync(join(full2.dir, "TSA-ROOT.pem"), ca.stdout);
  const tsaCommand = readmeCommands(full2.texts.get("README.txt")!).find((c) => c.startsWith("openssl ts -verify"));
  expect(tsaCommand).toBeTruthy();
  expect(sh(full2.dir, tsaCommand!)).toMatch(/Verification: OK/);
  expect(ext2.status).toBe(200);
  expect(consistencyFindings(extractPackage(ext2.zip!, join(PROOF_DIR, "v2-external")))).toEqual([]);
});

test("J3 v3 — a recorded chain verification is offered as a newer fact and v3 states it, with its check time", async () => {
  test.setTimeout(600_000);
  recordChainVerification(evidenceId);
  const st = await status(owner.api, evidenceId);
  expect(st.outputs.freshness.changes.map((c) => c.code)).toContain("OTS_CHAIN_VERIFIED_AFTER_REPORT");
  const r = await newVersion(owner.api, evidenceId, `truth-v3-${Date.now()}`, "Anchor verified against the Bitcoin chain");
  expect([200, 202]).toContain(r.status);
  await waitForPair(owner.api, evidenceId, 3);
  const text = pdfText(await downloadVersion(owner.api, evidenceId, "report", 3), "v3.pdf");
  expect(text).toContain("Anchored in Bitcoin; verified against the Bitcoin chain");
  expect(text).toMatch(/verified against the Bitcoin chain after report v2/);
  v3Full = extractPackage(await downloadVersion(owner.api, evidenceId, "package", 3), join(PROOF_DIR, "v3-full"));
  expect(consistencyFindings(v3Full)).toEqual([]);
  const anchoring = signal(v3Full, "bitcoin_anchoring");
  expect(anchoring.state).toBe("PASSED");
  expect(anchoring.measuredAtUtc).toBeTruthy();
  expect(v3Full.json("package-manifest.json").publicAnchoringVerified).toBe(true);
});

test("J4 Public Verify, the review workspace and the package carry the same canonical states and identity", async () => {
  test.setTimeout(300_000);
  const token = publishAndShare(evidenceId, teamId, owner.userId);
  const pv = await publicRecord(`/public/verify/${encodeURIComponent(token)}`);
  expect(pv.status).toBe(200);
  const pvSignals = ((pv.body.trustDecision as Record<string, unknown>).signals ?? []) as Array<Record<string, unknown>>;
  const pkgSignals = (v3Full!.json("trust-decision.json").signals ?? []) as Array<Record<string, unknown>>;
  const states = (s: Array<Record<string, unknown>>) => Object.fromEntries(s.map((x) => [String(x.key), String(x.state)]));
  expect(states(pvSignals)).toEqual(states(pkgSignals));
  const overview = JSON.stringify(pv.body);
  expect(overview).toContain("Authenticated email account");
  expect(overview).toContain("Personal workspace");
  expect(overview).not.toMatch(/OAuth-backed|"Organization account"/);
  const rw = await owner.api.get(`/v1/evidence/${evidenceId}/review-workspace`);
  expect(rw.ok()).toBe(true);
  const rwBody = (await rw.json()) as Record<string, unknown>;
  // The authenticated review workspace states the same anchoring state.
  expect(JSON.stringify(rwBody)).toMatch(/"key":"bitcoin_anchoring"[^}]*"state":"PASSED"/);
});

test("J5 identity: a later account/workspace change rewrites nothing; an organization-verified capture is stated when established", async () => {
  test.setTimeout(600_000);
  // Change the CURRENT state after capture: the personal workspace marked verified.
  sql("UPDATE teams SET verification_state = 'VERIFIED' WHERE id = $1", [teamId]);
  try {
    const r = await newVersion(owner.api, evidenceId, `truth-v4-${Date.now()}`, "Identity re-check after account change");
    expect([200, 202]).toContain(r.status);
    await waitForPair(owner.api, evidenceId, 4);
    const text = pdfText(await downloadVersion(owner.api, evidenceId, "report", 4), "v4.pdf");
    expect(text).toContain("Personal workspace");
    expect(text).toMatch(/Organization Verification\s+Not established/i);
    expect(text).not.toMatch(/Verified organization/);
  } finally {
    sql("UPDATE teams SET verification_state = NULL WHERE id = $1", [teamId]);
  }

  const orgOwner = await createGuestSession({ plan: "TEAM" });
  const org = provisionVerifiedOrganization(orgOwner.email);
  const ev = await createFinalizedEvidence(orgOwner.api, org.workspaceId, "truth-org");
  await waitForPair(orgOwner.api, ev.id, 1);
  const text = pdfText(await downloadVersion(orgOwner.api, ev.id, "report", 1), "org-v1.pdf");
  expect(text).toContain("Verified organization");
  expect(text).toContain("Shared workspace");
  expect(text).toMatch(/Organization Verification\s+Established at capture/i);
});

test("J6 key registry: current, rotated, revoked, unknown key and unknown package", async () => {
  test.setTimeout(400_000);
  const sealFp = String(v1.full!.json("package-seal.sig").signingKeyFingerprint);
  const keys = await publicRecord("/public/signing-keys");
  expect(keys.status).toBe(200);
  const listed = (keys.body.keys as Array<Record<string, unknown>>).find((k) => k.fingerprintSha256 === sealFp);
  expect(listed?.status).toBe("ACTIVE");
  expect(JSON.stringify(keys.body)).not.toMatch(/PRIVATE KEY|secret/i);

  // FIXTURE (operator rotation): a newer version of the seal key's id. The
  // registry is insert-only and a revocation can never be cleared, so the
  // live signing key is never revoked here.
  const [cur] = sql<{ key_id: string; version: number }>(
    "SELECT key_id, version FROM signing_keys ORDER BY created_at ASC LIMIT 1",
  );
  const { publicKey } = generateKeyPairSync("ed25519");
  const rotatedPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const rotatedFp = sha256(publicKey.export({ type: "spki", format: "der" }));
  sql("INSERT INTO signing_keys (key_id, version, public_key_pem) VALUES ($1, $2, $3)", [cur!.key_id, 900 + cur!.version, rotatedPem]);
  const rec = await publicRecord(`/public/verification-packages/${v1.packageId}`);
  expect((rec.body.sealKey as Record<string, unknown>).status).toBe("SUPERSEDED");
  expect(rec.body.keyBinding).toBe("BOUND");
  expect(sealOk(v1.full!).ok).toBe(true); // the historical package still verifies after rotation

  // Revoked: a dedicated fixture record whose seal key is the fixture key,
  // which is then revoked — it stays listed, as revoked.
  const ev = await createFinalizedEvidence(owner.api, teamId, "truth-revoked-key");
  await waitForPair(owner.api, ev.id, 1);
  sql("UPDATE verification_packages SET seal_signing_key_sha256 = $2 WHERE evidence_id = $1", [ev.id, rotatedFp]);
  sql("UPDATE signing_keys SET revoked_at = now() WHERE key_id = $1 AND version = $2", [cur!.key_id, 900 + cur!.version]);
  const [row] = sql<{ id: string }>("SELECT id FROM verification_packages WHERE evidence_id = $1", [ev.id]);
  const revoked = await publicRecord(`/public/verification-packages/${row!.id}`);
  expect(revoked.body.keyBinding).toBe("BOUND_KEY_REVOKED");
  expect((revoked.body.sealKey as Record<string, unknown>).status).toBe("REVOKED");
  expect((revoked.body.sealKey as Record<string, unknown>).revokedAtUtc).toBeTruthy();
  const after = await publicRecord("/public/signing-keys");
  expect((after.body.keys as Array<Record<string, unknown>>).some((k) => k.fingerprintSha256 === rotatedFp && k.status === "REVOKED")).toBe(true);

  // Unknown package / malformed id / unknown digest: one bounded 404.
  expect((await publicRecord(`/public/verification-packages/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
  expect((await publicRecord(`/public/verification-packages/not-a-uuid`)).status).toBe(404);
  expect((await publicRecord(`/public/verification-packages/by-sha256/${"0".repeat(64)}`)).status).toBe(404);
});

test("J7 a legacy package is labelled as legacy, its key as unpublished, and stays downloadable", async () => {
  test.setTimeout(400_000);
  const ev = await createFinalizedEvidence(owner.api, teamId, "truth-legacy");
  await waitForPair(owner.api, ev.id, 1);
  // FIXTURE: the row as a package issued before profiles (no profile, no
  // companion) sealed by a key the registry never published.
  sql(
    "UPDATE verification_packages SET disclosure_profile = NULL, external_disclosure_artifact = NULL, seal_signing_key_sha256 = $2 WHERE evidence_id = $1",
    [ev.id, "f".repeat(64)],
  );
  const st = (await status(owner.api, ev.id)) as unknown as { versions: { versions: Array<{ package: Record<string, unknown> | null }> } };
  expect(st.versions.versions[0]!.package!.disclosureProfile).toBe("LEGACY");
  expect(st.versions.versions[0]!.package!.externalDisclosure).toBeNull();
  const ext = await downloadExternal(owner.api, ev.id, 1);
  expect(ext.status).toBe(409);
  expect(ext.body.code).toBe("EXTERNAL_DISCLOSURE_NOT_ISSUED");
  expect((await downloadVersion(owner.api, ev.id, "package", 1)).subarray(0, 2).toString()).toBe("PK");
  const [row] = sql<{ id: string }>("SELECT id FROM verification_packages WHERE evidence_id = $1", [ev.id]);
  const rec = await publicRecord(`/public/verification-packages/${row!.id}`);
  expect(rec.body.disclosureProfile).toBe("LEGACY");
  expect(rec.body.packageIdRecordedInPackage).toBe(false);
  expect(rec.body.keyBinding).toBe("KEY_NOT_PUBLISHED");
});

test("J8 authorization: a VIEWER gets only the external disclosure package; an outsider gets nothing; downloads are custody events", async () => {
  test.setTimeout(300_000);
  const viewer = await createGuestSession({ plan: "TEAM" });
  addWorkspaceMember(teamId, viewer.userId, "VIEWER");
  const fullRes = await viewer.api.get(`/v1/evidence/${evidenceId}/verification-packages/1`);
  expect(fullRes.status()).toBe(403);
  expect(((await fullRes.json()) as Record<string, unknown>).code).toBe("FULL_PACKAGE_REQUIRES_ORIGINAL_ACCESS");
  expect((await downloadExternal(viewer.api, evidenceId, 1)).status).toBe(200);
  const vs = (await status(viewer.api, evidenceId)) as unknown as { packageAccess: Record<string, boolean> };
  expect(vs.packageAccess).toEqual({ fullForensic: false, externalDisclosure: true });

  const outsider = await createGuestSession({ plan: "TEAM" });
  expect([403, 404]).toContain((await outsider.api.get(`/v1/evidence/${evidenceId}/verification-packages/1`)).status());
  expect([403, 404]).toContain((await outsider.api.get(`/v1/evidence/${evidenceId}/verification-packages/1/external-disclosure`)).status());

  const events = sql<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM custody_events WHERE evidence_id = $1 AND event_type = 'VERIFICATION_PACKAGE_DOWNLOADED'",
    [evidenceId],
  );
  expect(events.some((e) => e.payload.disclosureProfile === "EXTERNAL_DISCLOSURE")).toBe(true);
  expect(events.some((e) => e.payload.disclosureProfile === "FULL_FORENSIC")).toBe(true);
});

test("J9 browser — Artifacts shows identity, profile and both downloads; the public record binds a ZIP; an unreachable registry is stated", async ({ page }) => {
  test.setTimeout(600_000);
  await signIn(page, owner.email);
  await openArtifacts(page, evidenceId);
  const profile = page.getByTestId("pair-1-package-profile");
  await expect(profile).toContainText("Full forensic package");
  await expect(profile).toContainText(v1.packageId);
  await expect(page.getByTestId("download-external-package-v1")).toBeEnabled();
  await expect(page.getByTestId("truth-ots")).toHaveText("Anchored, chain-verified");
  await expect(page.getByTestId("truth-ots-measured")).toContainText("Checked against the Bitcoin chain");
  await expect(page.getByTestId("truth-tsa")).toHaveText("Validated");

  await page.goto(`/verify/package/${v1.packageId}`);
  await expect(page.getByTestId("package-record-binding")).toHaveAttribute("data-key-binding", "BOUND");
  const zipPath = join(PROOF_DIR, "v1-package.zip");
  writeFileSync(zipPath, v1.full!.zip);
  await page.getByTestId("package-record-file").setInputFiles(zipPath);
  await expect(page.getByTestId("package-record-file-result")).toHaveAttribute("data-match", "true");
  await page.screenshot({ path: join(PROOF_DIR, "package-record.png"), fullPage: true });

  stackCtl("stop", "api");
  try {
    await page.reload();
    await expect(page.getByTestId("package-record-unavailable")).toBeVisible({ timeout: 60_000 });
  } finally {
    stackCtl("start", "api");
    await expect
      .poll(async () => (await fetch(`${API_BASE}/health`).then((r) => r.status).catch(() => 0)), { timeout: 180_000 })
      .toBe(200);
  }
});
