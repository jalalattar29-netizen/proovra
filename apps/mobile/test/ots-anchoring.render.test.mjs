/**
 * BITCOIN ANCHORING (OpenTimestamps) — the one state authority, on native.
 *
 *   1. Mobile reads the state AND the derived verification the API sent (an
 *      OtsAnchoringView) and never re-derives them: a missing or unknown state
 *      reads "Unavailable", even beside a txid.
 *   2. ANCHORED is only "Bitcoin attestation recorded" / "Not independently
 *      checked against Bitcoin" — neutral, no check mark, never "Verified".
 *      CHAIN_VERIFIED alone is green with a ✓ and reads "Independently
 *      verified against the Bitcoin main chain". FAILED / CHAIN_FAILED are
 *      danger; PENDING is not.
 *   3. The words come from the shared `otsAnchoringCopy` for the active locale
 *      (en / de / ar), never from the payload's own strings.
 *   4. The removed pre-chain-verifier vocabulary appears nowhere in apps/mobile.
 *
 * Render-harness proof only; no device.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildVerificationMatrix, otsAnchoringCopy } from "@proovra/shared";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(HERE, "..");
const AT = "2026-09-01T00:00:00.000Z";
const TXID = "ab".repeat(32);
const HASH = "00".repeat(8) + "cd".repeat(24);
const CHECKED = "2026-09-03T12:00:00.000Z";
let M;
let ER;
let PV;

before(async () => {
  M = await loadModule("src/ui/basic-verification-view.tsx", [
    "test/support/providers.tsx",
    "test/support/expo-stub.mjs",
    "src/product/ots-anchoring.ts",
  ]);
  ER = await loadModule("src/product/evidence-record.ts");
  PV = await loadModule("src/product/public-verify.ts");
});
beforeEach(async () => {
  await M.AsyncStorage.setItem("proovra-locale-mode", "manual");
  await M.AsyncStorage.setItem("proovra-locale", "en");
});

/** A bounded chain fact as the API sends it. */
const chain = (status, over = {}) => ({
  status,
  failureCode: null,
  blockHeight: 860123,
  blockHash: HASH,
  blockTimeUtc: "2026-09-02T07:55:00.000Z",
  confirmations: status === "INSUFFICIENT_CONFIRMATIONS" ? 2 : 12,
  minConfirmations: 6,
  checkedAtUtc: CHECKED,
  verifiedAtUtc: status === "VERIFIED" ? CHECKED : null,
  verifier: "bitcoin-core/27.0",
  ...over,
});

/** An `otsAnchoring` / `preservationMatrix.ots` view, as the API sends it. */
const ANCHORED = (verification, chainFact = null, over = {}) => ({
  state: "ANCHORED",
  verification,
  title: "server words are never printed",
  status: "server words are never printed",
  label: "server words are never printed",
  sentence: "server words are never printed",
  secondaryStatus: null,
  tone: "success",
  failureCode: null,
  failureLabel: null,
  committedDigestHex: "ef".repeat(32),
  proofSha256: "9f".repeat(32),
  attestationType: "BITCOIN_BLOCK_HEADER",
  bitcoinBlockHeight: 860123,
  bitcoinTxid: TXID,
  submittedAtUtc: AT,
  anchoredAtUtc: "2026-09-02T08:00:00.000Z",
  validator: "proovra-ots-proof/1",
  chain: chainFact,
  ...over,
});

function data(anchoring) {
  return {
    schema: "PROOVRA_BASIC_VERIFICATION",
    version: 1,
    checkedAtUtc: AT,
    original: {
      state: "verified",
      basis: "SIGNATURE_AND_FINGERPRINT_AND_CUSTODY_CHAIN",
      checks: {},
      fileSha256: "a".repeat(64),
      fingerprintHash: "b".repeat(64),
      serverReceivedAtUtc: AT,
      deviceDeclaredCaptureAtUtc: null,
      capturedAtUtcDeclared: AT,
      finalizedAtUtc: AT,
    },
    timestamp: { state: "not_issued", basis: null, tokenTimeUtc: null },
    anchoring,
    report: { issued: false, latestVersion: null, issuedAtUtc: null, digestRecorded: false, sha256: null },
    package: { issued: false, certifiesReportVersion: null, assembledAtUtc: null, sealed: false, packageSha256: null, sealKeyFingerprint: null, latestReportLacksPackage: false },
  };
}

/** The BASIC verification `anchoring` block (shared basic-verification.ts). */
const anchoring = (otsState, otsVerification = otsState === "ANCHORED" ? "ATTESTATION_RECORDED" : otsState, over = {}) => ({
  state: otsVerification === "CHAIN_VERIFIED" ? "verified" : "not_checked",
  otsState,
  otsVerification,
  status: "server words are never printed",
  label: "server words are never printed",
  sentence: "server words are never printed",
  secondaryStatus: null,
  chain: null,
  failureCode: null,
  proofSha256: "9f".repeat(32),
  attestationType: otsState === "ANCHORED" ? "BITCOIN_BLOCK_HEADER" : null,
  bitcoinBlockHeight: otsState === "ANCHORED" ? 860123 : null,
  bitcoinTxid: otsState === "ANCHORED" ? TXID : null,
  submittedAtUtc: AT,
  anchoredAtUtc: otsState === "ANCHORED" ? "2026-09-02T08:00:00.000Z" : null,
  validator: "proovra-ots-proof/1",
  ...over,
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
async function view(d, locale = "en") {
  await M.AsyncStorage.setItem("proovra-locale-mode", "manual");
  await M.AsyncStorage.setItem("proovra-locale", locale);
  const r = await renderComponent(h(M.TestProviders, null, h(M.BasicVerificationView, { data: d })));
  for (let i = 0; i < 4; i += 1) await settle();
  return r;
}
/** The badge on the anchoring row: its words and its tone. */
function otsBadge(r, key) {
  const [row] = r.byTestId(`basic-verification-ots-${key}`);
  assert.ok(row, `no anchoring row for ${key}`);
  const badge = row.findAll((n) => typeof n.props?.label === "string" && typeof n.props?.tone === "string")[0];
  return { label: badge.props.label, tone: badge.props.tone, texts: row.findAll((n) => n.type === "Text").map((n) => [].concat(n.props.children).join("")) };
}

/* -------------------------------------------------------------- pure reader */

test("an unknown, missing or legacy state reads Unavailable — never anchored or verified, even beside a txid", () => {
  for (const value of [undefined, null, {}, { state: "VERIFIED" }, { state: "CHAIN_VERIFIED" }, { status: "ANCHORED", bitcoinTxid: TXID }, { state: "anchored" }]) {
    const card = M.otsCard(value, "en");
    assert.equal(card.state, "UNAVAILABLE", JSON.stringify(value));
    assert.equal(card.verification, "UNAVAILABLE");
    assert.equal(card.status, "Unavailable");
    assert.equal(card.badgeTone, "neutral");
    assert.equal(card.check, false);
    assert.ok(!card.facts.some((f) => f.key === "txid"), "a txid shown for a state that is not ANCHORED");
  }
});

test("ANCHORED without a chain verification: 'Bitcoin attestation recorded' + 'Not independently checked against Bitcoin', neutral, no ✓, never Verified", () => {
  for (const value of [ANCHORED("ATTESTATION_RECORDED"), ANCHORED(undefined), { state: "ANCHORED", bitcoinBlockHeight: 860123 }]) {
    const card = M.otsCard(value, "en");
    assert.equal(card.state, "ANCHORED");
    assert.equal(card.verification, "ATTESTATION_RECORDED");
    assert.equal(card.title, "Bitcoin anchoring");
    assert.equal(card.status, "Attestation recorded");
    assert.equal(card.label, "Bitcoin attestation recorded");
    assert.equal(card.secondaryStatus, "Not independently checked against Bitcoin");
    assert.equal(card.sentence, "The proof names Bitcoin block 860123; PROOVRA has not checked it against the Bitcoin main chain.");
    assert.equal(card.tone, "neutral");
    assert.equal(card.badgeTone, "neutral");
    assert.equal(card.check, false);
    assert.equal(M.otsBadgeLabel(card), "Attestation recorded");
    assert.equal(M.otsStatusLine(card), "Bitcoin attestation recorded — Not independently checked against Bitcoin");
    for (const t of [M.otsBadgeLabel(card), M.otsStatusLine(card), card.label, card.status, card.sentence]) {
      assert.ok(!t.includes("✓"), `a check mark: ${t}`);
      assert.ok(!/\bverified\b/i.test(t), `"verified" for an unchecked attestation: ${t}`);
    }
    assert.ok(card.boundary.includes("It is not independently checked against the Bitcoin main chain"));
  }
  // The anchoring time is PROOVRA's recording time, never a block time; the txid only when sent.
  const card = M.otsCard(ANCHORED("ATTESTATION_RECORDED"), "en");
  assert.deepEqual(card.facts.find((f) => f.key === "txid"), { key: "txid", label: "Bitcoin transaction", value: TXID, mono: true });
  assert.equal(card.facts.find((f) => f.key === "anchoredAt").label, "Attestation recorded by PROOVRA (UTC)");
  assert.ok(!M.otsCard(ANCHORED("ATTESTATION_RECORDED", null, { bitcoinTxid: null }), "en").facts.some((f) => f.key === "txid"));
});

test("a CHAIN_VERIFIED claim without a VERIFIED chain fact behind it reads as an unchecked attestation", () => {
  for (const c of [null, chain("UNAVAILABLE"), chain("INSUFFICIENT_CONFIRMATIONS"), chain("FAILED")]) {
    const card = M.otsCard(ANCHORED("CHAIN_VERIFIED", c), "en");
    assert.notEqual(card.verification, "CHAIN_VERIFIED", JSON.stringify(c));
    assert.equal(card.check, false);
    assert.notEqual(card.badgeTone, "verified");
  }
});

test("CHAIN_VERIFIED is the only green ✓: 'Independently verified against the Bitcoin main chain' with its facts", () => {
  const card = M.otsCard(ANCHORED("CHAIN_VERIFIED", chain("VERIFIED")), "en", (iso) => iso.replace("T", " ").replace(".000Z", " UTC"));
  assert.equal(card.verification, "CHAIN_VERIFIED");
  assert.equal(card.status, "Independently verified");
  assert.equal(card.label, "Independently verified against the Bitcoin main chain");
  assert.equal(card.sentence, "Merkle root matches Bitcoin block 860123; 12 confirmations at 2026-09-03 12:00:00 UTC.");
  assert.equal(card.secondaryStatus, null);
  assert.equal(card.tone, "success");
  assert.equal(card.badgeTone, "verified");
  assert.equal(card.check, true);
  assert.equal(M.otsBadgeLabel(card), "Independently verified ✓");
  assert.equal(M.otsStatusLine(card), "Independently verified against the Bitcoin main chain ✓");
  assert.equal(card.facts.find((f) => f.key === "confirmations").value, "12");
  assert.equal(card.facts.find((f) => f.key === "blockHash").value, HASH);
  assert.ok(card.boundary.includes("merkle root"));
});

test("every other verification key is never green and never carries a ✓", () => {
  const cases = [
    [{ state: "PENDING" }, "PENDING", "neutral", "OpenTimestamps proof pending", "Submitted to OpenTimestamps calendars; no Bitcoin attestation yet."],
    [ANCHORED("CHAIN_CONFIRMATIONS_PENDING", chain("INSUFFICIENT_CONFIRMATIONS")), "CHAIN_CONFIRMATIONS_PENDING", "neutral", "Bitcoin verification pending", "The proof matches Bitcoin block 860123; 2 of 6 confirmations recorded."],
    [ANCHORED("CHAIN_UNAVAILABLE", chain("UNAVAILABLE", { failureCode: "BTC_RPC_TIMEOUT" })), "CHAIN_UNAVAILABLE", "neutral", "Bitcoin verification temporarily unavailable", "The Bitcoin attestation remains recorded but could not be independently checked."],
    [ANCHORED("CHAIN_FAILED", chain("FAILED", { failureCode: "MERKLE_ROOT_MISMATCH" })), "CHAIN_FAILED", "risk", "Bitcoin verification failed", "The OpenTimestamps proof does not match the referenced block in the active Bitcoin main chain."],
    [{ state: "FAILED", failureCode: "PROOF_HASH_MISMATCH" }, "FAILED", "risk", "Bitcoin anchoring failed", "Bitcoin anchoring did not complete for this record."],
    [{ state: "NOT_REQUESTED" }, "NOT_REQUESTED", "neutral", "Not requested", "No OpenTimestamps anchoring was requested for this record."],
  ];
  for (const [value, key, badgeTone, label, sentence] of cases) {
    const card = M.otsCard(value, "en");
    assert.equal(card.verification, key);
    assert.equal(card.badgeTone, badgeTone, key);
    assert.equal(card.tone, badgeTone === "risk" ? "danger" : "neutral", key);
    assert.equal(card.label, label);
    assert.equal(card.sentence, sentence);
    assert.equal(card.check, false);
    assert.ok(!M.otsBadgeLabel(card).includes("✓") && !M.otsStatusLine(card).includes("✓"));
    assert.equal(card.secondaryStatus, null);
  }
  const failed = M.otsCard({ state: "FAILED", failureCode: "PROOF_HASH_MISMATCH" }, "en");
  assert.equal(failed.failureLabel, "The OpenTimestamps proof does not commit to this record's evidence digest.");
});

test("a verification key a trust signal, matrix row or decision bucket carries reads the same words", () => {
  assert.equal(M.otsCardForVerification("ATTESTATION_RECORDED", "en").label, "Bitcoin attestation recorded");
  assert.equal(M.otsCardForVerification("ATTESTATION_RECORDED", "en").check, false);
  assert.equal(M.otsCardForVerification("CHAIN_VERIFIED", "en").check, true);
  assert.equal(M.otsCardForVerification("CHAIN_FAILED", "en").badgeTone, "risk");
  assert.equal(M.otsCardForVerification("nonsense", "en").verification, "UNAVAILABLE");
  // A stored PASSED without a CHAIN_VERIFIED marker is re-read by the shared reader before this; PASSED with one is verified.
  assert.equal(M.otsVerificationFromTrustSignal("PRESENT_NOT_INDEPENDENTLY_VERIFIED"), "ATTESTATION_RECORDED");
  assert.equal(M.otsVerificationFromTrustSignal("PASSED", "CHAIN_VERIFIED"), "CHAIN_VERIFIED");
  assert.equal(M.otsVerificationFromTrustSignal("FAILED", "CHAIN_FAILED"), "CHAIN_FAILED");
  assert.equal(M.otsVerificationFromAnchoringBucket("recorded"), "ATTESTATION_RECORDED");
  assert.equal(M.otsVerificationFromAnchoringBucket("verified"), "CHAIN_VERIFIED");
  assert.equal(M.otsVerificationFromAnchoringBucket("finalized"), "UNAVAILABLE");
  // A projection without chain facts: believed only when coherent with the state.
  assert.equal(M.otsVerificationOf("ANCHORED", null), "ATTESTATION_RECORDED");
  assert.equal(M.otsVerificationOf("ANCHORED", "CHAIN_VERIFIED"), "CHAIN_VERIFIED");
  assert.equal(M.otsVerificationOf("PENDING", "CHAIN_VERIFIED"), "PENDING");
});

test("de and ar words come from the shared otsAnchoringCopy; any other locale reads English", () => {
  for (const locale of ["de", "ar"]) {
    const copy = otsAnchoringCopy(locale);
    for (const state of ["NOT_REQUESTED", "PENDING", "ANCHORED", "FAILED", "UNAVAILABLE"]) {
      const card = M.otsCard({ state }, locale);
      const key = state === "ANCHORED" ? "ATTESTATION_RECORDED" : state;
      assert.equal(card.title, copy.title);
      assert.equal(card.status, copy.verificationWords[key]);
      assert.equal(card.label, copy.verificationLabels[key]);
      assert.equal(card.sentence, copy.verificationSentencesPlain[key]);
    }
    const recorded = M.otsCard(ANCHORED("ATTESTATION_RECORDED"), locale);
    assert.equal(recorded.label, copy.verificationLabels.ATTESTATION_RECORDED);
    assert.equal(recorded.secondaryStatus, copy.notCheckedStatus);
    assert.notEqual(recorded.secondaryStatus, "Not independently checked against Bitcoin", "the English qualifier leaked");
    const verified = M.otsCard(ANCHORED("CHAIN_VERIFIED", chain("VERIFIED")), locale);
    assert.equal(verified.label, copy.verificationLabels.CHAIN_VERIFIED);
    assert.equal(M.otsBadgeLabel(verified), `${copy.verificationWords.CHAIN_VERIFIED} ✓`);
    const chainFailed = M.otsCard(ANCHORED("CHAIN_FAILED", chain("FAILED")), locale);
    assert.equal(chainFailed.label, copy.verificationLabels.CHAIN_FAILED);
    assert.equal(chainFailed.badgeTone, "risk");
  }
  assert.equal(M.otsCard({ state: "ANCHORED" }, "fr").label, "Bitcoin attestation recorded");
  // The failure label is the locale's, keyed by the bounded code — never the payload's English.
  for (const locale of ["de", "ar"]) {
    const copy = otsAnchoringCopy(locale);
    const failed = M.otsCard({ state: "FAILED", failureCode: "PROOF_HASH_MISMATCH", failureLabel: "payload words" }, locale);
    assert.equal(failed.failureLabel, copy.failureLabels.PROOF_HASH_MISMATCH);
    assert.notEqual(failed.failureLabel, otsAnchoringCopy("en").failureLabels.PROOF_HASH_MISMATCH);
    const unknown = M.otsCard({ state: "FAILED", failureCode: "SOME_FUTURE_CODE" }, locale);
    assert.equal(unknown.failureLabel, copy.failureLabels.OTS_PROCESSING_FAILED);
  }
  assert.equal(M.otsCard({ state: "PENDING", failureCode: "PROOF_HASH_MISMATCH" }, "de").failureLabel, null);
  assert.equal(M.otsTitle("de"), "Bitcoin-Verankerung");
});

/* -------------------------------------------------------- record surfaces */

test("the preservation matrix never states 'Verified' for an unchecked attestation; CHAIN_VERIFIED alone is verified", () => {
  const rw = (ots) => ({ evidence: { id: "ev-1" }, preservationMatrix: { verificationStatus: "RECORDED_INTEGRITY_VERIFIED", ots } });
  const row = (ots) => ER.buildPreservationMatrix(rw(ots), (iso) => iso, "en").find((r) => r.label === "Bitcoin anchoring");
  const recorded = row(ANCHORED("ATTESTATION_RECORDED"));
  assert.equal(recorded.state, "recorded");
  assert.equal(recorded.value, "Bitcoin attestation recorded — Not independently checked against Bitcoin");
  assert.equal(ER.INTEGRITY_STATE_PRESENTATION[recorded.state].label, "Recorded");
  const verified = row(ANCHORED("CHAIN_VERIFIED", chain("VERIFIED")));
  assert.equal(verified.state, "verified");
  assert.equal(verified.value, "Independently verified against the Bitcoin main chain ✓");
  assert.equal(row(ANCHORED("CHAIN_FAILED", chain("FAILED"))).state, "failed");
  assert.equal(row({ state: "FAILED", failureCode: "MALFORMED_PROOF" }).state, "failed");
  assert.equal(row({ state: "PENDING" }).state, "pending");
  assert.equal(row(ANCHORED("CHAIN_CONFIRMATIONS_PENDING", chain("INSUFFICIENT_CONFIRMATIONS"))).state, "pending");
  for (const k of ["NOT_REQUESTED", "PENDING", "ATTESTATION_RECORDED", "CHAIN_CONFIRMATIONS_PENDING", "CHAIN_UNAVAILABLE", "CHAIN_FAILED", "FAILED", "UNAVAILABLE"]) {
    assert.notEqual(ER.OTS_INTEGRITY_STATE[k], "verified", k);
  }
  assert.equal(ER.OTS_INTEGRITY_STATE.CHAIN_VERIFIED, "verified");
});

test("Public Verify: an unchecked attestation is neutral, CHAIN_VERIFIED success, CHAIN_FAILED danger with a review note", () => {
  const recorded = PV.verifyOtsTone(ANCHORED("ATTESTATION_RECORDED"), "en");
  assert.equal(recorded.tone, "neutral");
  assert.equal(recorded.label, "Bitcoin attestation recorded — Not independently checked against Bitcoin");
  const verified = PV.verifyOtsTone(ANCHORED("CHAIN_VERIFIED", chain("VERIFIED")), "en");
  assert.equal(verified.tone, "success");
  assert.equal(verified.label, "Independently verified against the Bitcoin main chain ✓");
  assert.equal(PV.verifyOtsTone(ANCHORED("CHAIN_FAILED", chain("FAILED")), "en").tone, "danger");
  assert.equal(PV.verifyOtsTone({ state: "FAILED" }, "en").tone, "danger");
  assert.equal(PV.verifyOtsTone({ state: "PENDING" }, "en").tone, "neutral");

  const signals = (ots) => PV.parseVerifyIntegritySignals({ integrityProof: {}, storageAndTimestamping: { ots } });
  assert.equal(signals(ANCHORED("ATTESTATION_RECORDED")).otsVerification, "ATTESTATION_RECORDED");
  const failed = signals(ANCHORED("CHAIN_FAILED", chain("FAILED")));
  assert.equal(failed.otsChainFailed, true);
  const notes = PV.buildVerifyMismatchExplanations(failed);
  assert.ok(notes.some((n) => n.title === "Bitcoin verification failed" && n.severity === "danger"));

  // A matrix row carrying CHAIN_VERIFIED is verified; one carrying ATTESTATION_RECORDED is not.
  const matrixRow = (state, otsVerification) => {
    const verificationMatrix = buildVerificationMatrix({
      signals: [{ key: "bitcoin_anchoring", state, summary: "server words", otsVerification }],
      identity: null,
      acquisitionMode: null,
      packageSeal: { kind: "NONE" },
      publication: { kind: "THIS_PAGE" },
    });
    return PV.parseVerifyMatrix({ verificationMatrix }, "en").rows.find((r) => r.key === "ots_anchoring");
  };
  const rec = matrixRow("PRESENT_NOT_INDEPENDENTLY_VERIFIED", "ATTESTATION_RECORDED");
  assert.equal(rec.statusLabel, "Attestation recorded");
  assert.equal(rec.tone, "neutral");
  assert.ok(rec.statement.startsWith("Not independently checked against Bitcoin."));
  const ver = matrixRow("PASSED", "CHAIN_VERIFIED");
  assert.equal(ver.statusLabel, "Independently verified ✓");
  assert.equal(ver.tone, "success");
});

/* -------------------------------------------------------------- rendered */

test("rendered: an anchoring block without otsState (an older API) is Unavailable", async () => {
  const r = await view(data({ state: "verified", basis: null, anchoredAtUtc: AT, bitcoinTxid: TXID }));
  const b = otsBadge(r, "UNAVAILABLE");
  assert.equal(b.label, "Unavailable");
  assert.equal(b.tone, "neutral");
  assert.ok(!r.hasText(TXID), "a txid shown for an unknown state");
  assert.ok(!r.hasText("Anchored"));
  assert.ok(!r.hasText("Independently verified"));
});

test("rendered: ANCHORED without chain verification shows 'Bitcoin attestation recorded' + 'Not independently checked against Bitcoin', neutral, no ✓", async () => {
  const r = await view(data(anchoring("ANCHORED")));
  const b = otsBadge(r, "ATTESTATION_RECORDED");
  assert.equal(b.label, "Attestation recorded");
  assert.equal(b.tone, "neutral");
  assert.ok(b.texts.includes("Bitcoin attestation recorded"));
  assert.ok(b.texts.includes("Not independently checked against Bitcoin"));
  assert.ok(r.hasText("The proof names Bitcoin block 860123; PROOVRA has not checked it against the Bitcoin main chain."));
  assert.ok(r.hasText(`Bitcoin transaction: ${TXID}`));
  assert.ok(r.hasText("Attestation recorded by PROOVRA (UTC): 2026-09-02 08:00:00 UTC"));
  assert.ok(!b.texts.some((t) => t.includes("✓")), "a check mark beside an unchecked attestation");
  assert.ok(!b.texts.some((t) => /\bverified\b/i.test(t)), "'verified' beside an unchecked attestation");
  assert.ok(!r.hasText("server words are never printed"));
});

test("rendered: CHAIN_VERIFIED shows the green 'Independently verified against the Bitcoin main chain ✓'", async () => {
  const r = await view(data(anchoring("ANCHORED", "CHAIN_VERIFIED", { chain: chain("VERIFIED") })));
  const b = otsBadge(r, "CHAIN_VERIFIED");
  assert.equal(b.label, "Independently verified ✓");
  assert.equal(b.tone, "verified");
  assert.ok(b.texts.includes("Independently verified against the Bitcoin main chain ✓"));
  assert.ok(r.hasText("Merkle root matches Bitcoin block 860123; 12 confirmations at 2026-09-03 12:00:00 UTC."));
  assert.ok(!r.hasText("Not independently checked against Bitcoin"));
});

test("rendered: CHAIN_FAILED and FAILED are danger; PENDING is not", async () => {
  const cf = await view(data(anchoring("ANCHORED", "CHAIN_FAILED", { chain: chain("FAILED") })));
  const b = otsBadge(cf, "CHAIN_FAILED");
  assert.equal(b.label, "Verification failed");
  assert.equal(b.tone, "risk");
  assert.ok(cf.hasText("The OpenTimestamps proof does not match the referenced block in the active Bitcoin main chain."));
  const f = await view(data(anchoring("FAILED", "FAILED", { failureCode: "PROOF_HASH_MISMATCH" })));
  assert.equal(otsBadge(f, "FAILED").tone, "risk");
  const p = await view(data(anchoring("PENDING")));
  const pb = otsBadge(p, "PENDING");
  assert.equal(pb.tone, "neutral");
  assert.equal(pb.label, "Pending");
  assert.ok(pb.texts.includes("OpenTimestamps proof pending"));
});

for (const locale of ["de", "ar"]) {
  test(`rendered in ${locale}: the anchoring row prints otsAnchoringCopy("${locale}")`, async () => {
    const copy = otsAnchoringCopy(locale);
    const r = await view(data(anchoring("PENDING")), locale);
    const b = otsBadge(r, "PENDING");
    assert.equal(b.label, copy.verificationWords.PENDING);
    assert.ok(b.texts.includes(copy.title));
    assert.ok(b.texts.includes(copy.verificationSentences.PENDING));
    assert.ok(!r.hasText("Submitted to OpenTimestamps calendars; no Bitcoin attestation yet."), "the English sentence leaked");
    const a = await view(data(anchoring("ANCHORED")), locale);
    const ab = otsBadge(a, "ATTESTATION_RECORDED");
    assert.equal(ab.label, copy.verificationWords.ATTESTATION_RECORDED);
    assert.ok(ab.texts.includes(copy.verificationLabels.ATTESTATION_RECORDED));
    assert.ok(ab.texts.includes(copy.notCheckedStatus));
    assert.ok(!ab.texts.some((t) => t.includes("✓")));
    assert.ok(a.hasText(`${copy.facts.txid}: ${TXID}`));
    const v = await view(data(anchoring("ANCHORED", "CHAIN_VERIFIED", { chain: chain("VERIFIED") })), locale);
    const vb = otsBadge(v, "CHAIN_VERIFIED");
    assert.equal(vb.label, `${copy.verificationWords.CHAIN_VERIFIED} ✓`);
    assert.equal(vb.tone, "verified");
    assert.ok(vb.texts.includes(`${copy.verificationLabels.CHAIN_VERIFIED} ✓`));
  });
}

test("rendered in ar: the anchoring row mirrors (label from the right)", async () => {
  const r = await view(data(anchoring("ANCHORED")), "ar");
  const [row] = r.byTestId("basic-verification-ots-ATTESTATION_RECORDED");
  const head = row.findAll((n) => n.type === "View" && n.props?.style?.flexDirection)[0];
  assert.equal(head.props.style.flexDirection, "row-reverse");
});

/* -------------------------------------------------------------- vocabulary */

test("the removed pre-chain-verifier vocabulary appears nowhere in apps/mobile", () => {
  const banned = [
    "Bitcoin anchoring verified",
    "proof still being prepared",
    "Independent public anchoring is not finalized yet",
    "anchorClaim",
    "OTS_TRUTH_",
    "resolveOtsAnchorClaim",
    "otsClaimBadge",
    "parseOtsAnchorClaim",
    "resolveOtsProofStatus",
    "OTS_PROOF_STATUS_LABELS",
    "otsStateFromTrustSignal",
    "otsStateFromAnchoringBucket",
  ];
  const self = fileURLToPath(import.meta.url);
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".") || name === "dist" || name === "android" || name === "ios") continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs|js|json)$/.test(name) && p !== self) {
        const text = readFileSync(p, "utf8");
        for (const b of banned) if (text.includes(b)) hits.push(`${p.slice(MOBILE.length + 1)}: ${b}`);
      }
    }
  };
  for (const d of ["app", "src", "test"]) walk(join(MOBILE, d));
  assert.deepEqual(hits, []);
});
