/**
 * BITCOIN ANCHORING (OpenTimestamps) — the one state authority, on native
 * (2026-10-13).
 *
 *   1. Mobile reads the state the API sent (an OtsAnchoringView) and never
 *      re-derives it: a missing or unknown state reads "Unavailable", even
 *      beside a txid; ANCHORED reads "Anchored" with a green ✓.
 *   2. The words come from the shared `otsAnchoringCopy` for the active locale
 *      (en / de / ar), never from the payload's own strings.
 *   3. The removed chain-verifier vocabulary appears nowhere in apps/mobile.
 *
 * Render-harness proof only; no device.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { otsAnchoringCopy } from "@proovra/shared";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(HERE, "..");
const AT = "2026-09-01T00:00:00.000Z";
const TXID = "ab".repeat(32);
let M;

before(async () => {
  M = await loadModule("src/ui/basic-verification-view.tsx", [
    "test/support/providers.tsx",
    "test/support/expo-stub.mjs",
    "src/product/ots-anchoring.ts",
  ]);
});
beforeEach(async () => {
  await M.AsyncStorage.setItem("proovra-locale-mode", "manual");
  await M.AsyncStorage.setItem("proovra-locale", "en");
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

const anchoring = (otsState, over = {}) => ({
  state: "not_checked",
  otsState,
  status: "server words are never printed",
  label: "server words are never printed",
  sentence: "server words are never printed",
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
function otsBadge(r, state) {
  const [row] = r.byTestId(`basic-verification-ots-${state}`);
  assert.ok(row, `no anchoring row in state ${state}`);
  const badge = row.findAll((n) => typeof n.props?.label === "string" && typeof n.props?.tone === "string")[0];
  return { label: badge.props.label, tone: badge.props.tone, texts: row.findAll((n) => n.type === "Text").map((n) => [].concat(n.props.children).join("")) };
}

/* -------------------------------------------------------------- pure reader */

test("an unknown, missing or legacy state reads Unavailable — never Anchored, even beside a txid", () => {
  for (const value of [undefined, null, {}, { state: "VERIFIED" }, { state: "CHAIN_VERIFIED" }, { status: "ANCHORED", bitcoinTxid: TXID }, { state: "anchored" }]) {
    const card = M.otsCard(value, "en");
    assert.equal(card.state, "UNAVAILABLE", JSON.stringify(value));
    assert.equal(card.status, "Unavailable");
    assert.equal(card.badgeTone, "neutral");
    assert.equal(card.check, false);
    assert.ok(!card.facts.some((f) => f.key === "txid"), "a txid shown for a state that is not ANCHORED");
  }
});

test("ANCHORED reads Anchored with a green ✓; the txid and block height only when the server sent them", () => {
  const card = M.otsCard({ state: "ANCHORED", bitcoinTxid: TXID, bitcoinBlockHeight: 860123, anchoredAtUtc: "2026-09-02T08:00:00.000Z" }, "en");
  assert.equal(card.title, "Bitcoin anchoring");
  assert.equal(card.status, "Anchored");
  assert.equal(card.label, "Bitcoin anchored");
  assert.equal(card.sentence, "OpenTimestamps proof anchored in Bitcoin.");
  assert.equal(card.tone, "success");
  assert.equal(card.badgeTone, "verified");
  assert.equal(M.otsBadgeLabel(card), "Anchored ✓");
  assert.deepEqual(card.facts.find((f) => f.key === "txid"), { key: "txid", label: "Bitcoin transaction", value: TXID, mono: true });
  // The anchoring time is PROOVRA's recording time, never a block time.
  assert.equal(card.facts.find((f) => f.key === "anchoredAt").label, "Anchoring recorded by PROOVRA (UTC)");
  assert.ok(card.boundary.includes("PROOVRA does not claim independent canonical-chain verification"));

  const noTx = M.otsCard({ state: "ANCHORED", bitcoinTxid: null }, "en");
  assert.ok(!noTx.facts.some((f) => f.key === "txid"), "an absent txid was rendered");
});

test("PENDING reads the pending sentence, neutral; FAILED is danger with its bounded failure in words", () => {
  const pending = M.otsCard({ state: "PENDING" }, "en");
  assert.equal(pending.status, "Pending");
  assert.equal(pending.sentence, "OpenTimestamps proof is awaiting Bitcoin anchoring.");
  assert.equal(pending.badgeTone, "neutral");
  const failed = M.otsCard({ state: "FAILED", failureCode: "PROOF_HASH_MISMATCH" }, "en");
  assert.equal(failed.status, "Failed");
  assert.equal(failed.badgeTone, "risk");
  assert.equal(failed.failureLabel, "The OpenTimestamps proof does not commit to this record's evidence digest.");
});

test("de and ar words come from the shared otsAnchoringCopy; any other locale reads English", () => {
  for (const locale of ["de", "ar"]) {
    const copy = otsAnchoringCopy(locale);
    for (const state of ["NOT_REQUESTED", "PENDING", "ANCHORED", "FAILED", "UNAVAILABLE"]) {
      const card = M.otsCard({ state }, locale);
      assert.equal(card.title, copy.title);
      assert.equal(card.status, copy.words[state]);
      assert.equal(card.label, copy.labels[state]);
      assert.equal(card.sentence, copy.sentences[state]);
    }
  }
  assert.equal(M.otsCard({ state: "ANCHORED" }, "fr").status, "Anchored");
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

/* -------------------------------------------------------------- rendered */

test("rendered: an anchoring block without otsState (an older API) is Unavailable", async () => {
  const r = await view(data({ state: "verified", basis: null, anchoredAtUtc: AT, bitcoinTxid: TXID }));
  const b = otsBadge(r, "UNAVAILABLE");
  assert.equal(b.label, "Unavailable");
  assert.equal(b.tone, "neutral");
  assert.ok(!r.hasText(TXID), "a txid shown for an unknown state");
  assert.ok(!r.hasText("Anchored"));
});

test("rendered: ANCHORED shows 'Bitcoin anchoring — Anchored ✓' in green with the txid", async () => {
  const r = await view(data(anchoring("ANCHORED")));
  const b = otsBadge(r, "ANCHORED");
  assert.equal(b.label, "Anchored ✓");
  assert.equal(b.tone, "verified");
  assert.ok(r.hasText("Bitcoin anchoring"));
  assert.ok(r.hasText("OpenTimestamps proof anchored in Bitcoin."));
  assert.ok(r.hasText(`Bitcoin transaction: ${TXID}`));
  assert.ok(r.hasText("Anchoring recorded by PROOVRA (UTC): 2026-09-02 08:00:00 UTC"));
  assert.ok(!r.hasText("server words are never printed"));
});

for (const locale of ["de", "ar"]) {
  test(`rendered in ${locale}: the anchoring row prints otsAnchoringCopy("${locale}")`, async () => {
    const copy = otsAnchoringCopy(locale);
    const r = await view(data(anchoring("PENDING")), locale);
    const b = otsBadge(r, "PENDING");
    assert.equal(b.label, copy.words.PENDING);
    assert.ok(b.texts.includes(copy.title));
    assert.ok(b.texts.includes(copy.sentences.PENDING));
    assert.ok(!r.hasText("OpenTimestamps proof is awaiting Bitcoin anchoring."), "the English sentence leaked");
    const a = await view(data(anchoring("ANCHORED")), locale);
    assert.equal(otsBadge(a, "ANCHORED").label, `${copy.words.ANCHORED} ✓`);
    assert.ok(a.hasText(`${copy.facts.txid}: ${TXID}`));
  });
}

test("rendered in ar: the anchoring row mirrors (label from the right)", async () => {
  const r = await view(data(anchoring("ANCHORED")), "ar");
  const [row] = r.byTestId("basic-verification-ots-ANCHORED");
  const head = row.findAll((n) => n.type === "View" && n.props?.style?.flexDirection)[0];
  assert.equal(head.props.style.flexDirection, "row-reverse");
});

/* -------------------------------------------------------------- vocabulary */

test("the removed chain-verifier vocabulary appears nowhere in apps/mobile", () => {
  const banned = [
    "Attestation recorded",
    "Bitcoin anchoring verified",
    "chain-verified",
    "proof still being prepared",
    "Independent public anchoring is not finalized yet",
    "anchorClaim",
    "CHAIN_VERIFIED",
    "OTS_TRUTH_",
    "resolveOtsAnchorClaim",
    "otsClaimBadge",
    "parseOtsAnchorClaim",
    "resolveOtsProofStatus",
    "OTS_PROOF_STATUS_LABELS",
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
