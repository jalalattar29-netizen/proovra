/**
 * PUBLIC VERIFY CONVERGENCE (2026-10-18) — the native verify screen rendered
 * against REAL anonymous responses of the converged API
 * (test/fixtures/public-verify-*.json, captured from GET /public/verify/:id):
 *
 *   verification-only            VERIFICATION_ONLY, no report yet
 *   verification-only-report-v1  VERIFICATION_ONLY, report v1 issued; OTS chain-verified since issue
 *   content-preview              CONTENT_PREVIEW, location not shown
 *   content-preview-location     CONTENT_PREVIEW, recorded location shown
 *
 * The screen renders what the API returned: the server's matrix, qualifiers
 * and projection are the only truth and disclosure authorities.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { VERIFICATION_STATUS_LABELS, findForbiddenCustomerClaims } from "@proovra/shared";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(resolve(HERE, "fixtures", `public-verify-${name}.json`), "utf8"));
const VO = fixture("verification-only");
const VO1 = fixture("verification-only-report-v1");
const CP = fixture("content-preview");
const CPL = fixture("content-preview-location");
const REF = "pvr_7pLuIsF1Z_JiaqHKByYM72RwUcM";
const CP_NAMES = CP.evidenceContent.items.map((i) => i.label);

const h = React.createElement;
let M;
let DL;
let answer = () => ({ status: 200, body: {} });

before(async () => {
  M = await loadModule("app/verify.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/product/public-verify.ts"]);
  DL = await loadModule("src/deep-link.ts");
});
beforeEach(() => {
  // Opened with a reviewer share token: it must never be re-shared.
  globalThis.__EXPO_PARAMS__ = { id: "pvs_reviewerShareToken123" };
  globalThis.__LINKING_OPENED__ = [];
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const res = path.startsWith("/public/verify/") ? answer() : { status: 200, body: {} };
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { "content-type": "application/json" } });
  };
});

async function render(body) {
  answer = () => ({ status: 200, body });
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
  return r;
}
const has = (r, s) => assert.ok(r.hasText(s), `missing: ${s}`);
const lacks = (r, s) => assert.ok(!r.hasText(s), `unexpected: ${s}`);
const textsIn = (r, id) => {
  const [node] = r.byTestId(id);
  assert.ok(node, `no ${id}`);
  const flat = (c) => (c == null || c === false ? [] : typeof c === "string" ? [c] : typeof c === "number" ? [String(c)] : Array.isArray(c) ? c.flatMap(flat) : c.props ? flat(c.props.children) : []);
  return node.findAll((n) => n.type === "Text").map((n) => flat(n.props.children).join(""));
};
const badges = (r, id) => {
  const [node] = r.byTestId(id);
  assert.ok(node, `no ${id}`);
  return [...new Set(node.findAll((n) => typeof n.props?.label === "string" && !n.props?.children).map((n) => n.props.label))];
};
const allText = (r) => r.texts().join("\n");

/* ------------------------------------------------------- VERIFICATION_ONLY */

test("VERIFICATION_ONLY: Item 1–6 only, no names, the reference, the record kind, a withheld identity and aggregated access activity", async () => {
  const r = await render(VO);
  // The inventory: the server's generic labels, kind, size and a truncated SHA-256 with copy.
  assert.equal(r.byTestId("verify-inventory").length, 1);
  for (let i = 1; i <= 6; i += 1) assert.equal(r.byTestId(`verify-item-item-${i}`).length, 1, `Item ${i}`);
  const inventory = textsIn(r, "verify-inventory");
  for (let i = 1; i <= 6; i += 1) assert.ok(inventory.includes(`Item ${i}`), `Item ${i}`);
  assert.ok(inventory.includes("Text · 44 B"), inventory.join("|"));
  const sha1 = VO.evidenceContent.items[0].sha256;
  assert.ok(inventory.includes(`SHA-256 ${sha1.slice(0, 12)}…${sha1.slice(-8)}`), "truncated SHA-256");
  assert.equal(r.byTestId("verify-copy-sha-item-1").length, 1, "copy carries the full value");
  // No file names leave the API, so none render.
  for (const name of CP_NAMES) lacks(r, name);
  assert.ok(!allText(r).includes(".txt"));
  lacks(r, "Kestrel Lane collision — private title");

  // Record facts.
  assert.equal(r.byTestId("verify-record-facts").length, 1);
  has(r, "Verification reference");
  assert.deepEqual(textsIn(r, "verify-reference"), [REF]);
  lacks(r, "Evidence ID");
  assert.deepEqual(textsIn(r, "verify-record-kind"), ["Multipart package · 6 items"]);
  has(r, "Report issued");
  has(r, "No report issued yet");
  has(r, "Stored file last rechecked");
  assert.ok(textsIn(r, "verify-record-facts").some((t) => t.endsWith(" · Verified")), "the stored-file recheck is stated beside its time");
  // The identity is withheld in the server's words — never "Not recorded".
  assert.deepEqual(textsIn(r, "verify-identity-withheld"), ["Withheld by the record’s disclosure policy"]);
  assert.ok(!textsIn(r, "verify-identity").some((t) => /Not recorded|N\/A|Not applicable/.test(t)));

  // The disclosure notice, by the shared vocabulary.
  assert.equal(r.byTestId("verify-disclosure").length, 1);
  assert.ok(r.byLabel("Verification only").length >= 1);
  has(r, "Recorded location: not shown.");

  // Access activity: an aggregate (count + latest), never a list.
  const access = textsIn(r, "verify-access-activity");
  assert.equal(access.length, 1);
  assert.ok(access[0].startsWith("Access activity: 4 events · latest "), access[0]);
  lacks(r, "Verify Viewed");
  // The forensic list is shown.
  has(r, "Verification reference issued");

  // No location: neither card renders without captureContext / locationState.
  assert.equal(r.byTestId("verify-capture-context").length, 0);
  assert.equal(r.byTestId("verify-location-state").length, 0);
  assert.deepEqual(findForbiddenCustomerClaims(allText(r)), []);
  r.unmount();
});

test("VERIFICATION_ONLY report v1: OpenTimestamps independently verified now, attestation recorded at issue, VERIFICATION_ADVANCED informational, no danger", async () => {
  const r = await render(VO1);
  // The matrix row is the current state.
  assert.deepEqual(badges(r, "verify-matrix-ots_anchoring"), ["Independently verified ✓"]);
  // The at-issue state is the snapshot's; "advanced" is the server's liveAnchoring.advance.
  has(r, "Bitcoin anchoring (when issued)");
  assert.ok(textsIn(r, "verify-snapshot").includes("Attestation recorded"));
  assert.deepEqual(textsIn(r, "verify-ots-advance"), [M.OTS_ADVANCE_COPY.CHAIN_VERIFIED_SINCE_ISSUE]);
  // The divergence reason is informational, never an alarm.
  assert.equal(r.byTestId("verify-divergence").length, 1);
  has(r, "Verification advanced since issue");
  const [reason] = r.byTestId("verify-divergence-reason-VERIFICATION_ADVANCED");
  assert.ok(reason, "the reason renders");
  const tones = reason.findAll((n) => typeof n.props?.tone === "string" && typeof n.props?.label === "string").map((n) => n.props.tone);
  assert.ok(tones.includes("info") && !tones.includes("risk"), tones.join(","));
  // Nothing FAILED: no issue card, and the divergence is not stated as critical.
  assert.equal(r.byTestId("verify-integrity-issues").length, 0);
  assert.ok(!textsIn(r, "verify-divergence").some((t) => t.includes("integrity-relevant check")));
  // The report facts.
  has(r, "Report issued");
  assert.ok(textsIn(r, "verify-record-facts").some((t) => t.endsWith("· version 1")));
  has(r, "At report time (report version 1)");
  r.unmount();
});

/* --------------------------------------------------------- CONTENT_PREVIEW */

test("CONTENT_PREVIEW: the item names are shown; no location card when the policy does not show it", async () => {
  const r = await render(CP);
  for (const name of CP_NAMES) assert.ok(textsIn(r, "verify-inventory").some((t) => t === name || t.endsWith(` · ${name}`)), name);
  assert.ok(r.byLabel("Content preview").length >= 1);
  has(r, "Recorded location: not shown.");
  assert.equal(r.byTestId("verify-capture-context").length, 0);
  assert.equal(r.byTestId("verify-location-state").length, 0);
  assert.equal(r.byTestId("capture-location-map-consent").length, 0);
  r.unmount();
});

test("CONTENT_PREVIEW with location: the capture context card, with the consent notice before any public tiles", async () => {
  const r = await render(CPL);
  assert.equal(r.byTestId("verify-capture-context").length, 1);
  has(r, "Recorded location: shown.");
  has(r, "Capture Context");
  has(r, "48.137154");
  // Public tiles wait for the explicit choice.
  assert.equal(r.byTestId("capture-location-map-consent").length, 1);
  r.unmount();
});

/* ------------------------------------------------------------ package card */

test("the package card equals the matrix's package_signature row, on every fixture", () => {
  for (const f of [VO, VO1, CP, CPL]) {
    const row = f.verificationMatrix.rows.find((x) => x.key === "package_signature");
    const pkg = M.parseVerifyPackage(f);
    assert.equal(pkg.badge, VERIFICATION_STATUS_LABELS[row.status]);
    assert.equal(pkg.decisionLabel, row.statement);
    assert.equal(pkg.sealCheck, row.status);
    assert.notEqual(pkg.tone, "success");
  }
  // A reply without sealCheck reads the matrix row — never a file-presence inference.
  const legacy = {
    verificationPackageIntegrity: { available: true, version: 3, manifestPresent: true, signedManifestPresent: true, checksumIndexPresent: true, auditExportIncluded: true },
    verificationMatrix: {
      ...VO.verificationMatrix,
      rows: VO.verificationMatrix.rows.map((x) =>
        x.key === "package_signature" ? { ...x, status: "NOT_CHECKED", statement: "Sealed — seal not checked against a published PROOVRA key." } : x,
      ),
    },
  };
  const pkg = M.parseVerifyPackage(legacy);
  assert.equal(pkg.decisionLabel, "Sealed — seal not checked against a published PROOVRA key.");
  assert.equal(pkg.tone, "warning");
  assert.notEqual(pkg.decisionLabel, "Package Integrity Complete");
  // With neither, the seal is unavailable — never complete.
  const bare = M.parseVerifyPackage({ verificationPackageIntegrity: { available: true, version: 3, manifestPresent: true, signedManifestPresent: true, checksumIndexPresent: true, auditExportIncluded: true } });
  assert.equal(bare.sealCheck, "UNAVAILABLE");
  assert.equal(bare.tone, "neutral");
});

test("a retained-token timestamp prints the server's statusLabel and its validation time", async () => {
  const at = "2026-10-17T09:00:00.000Z";
  const body = {
    ...VO1,
    verificationMatrix: {
      ...VO1.verificationMatrix,
      rows: VO1.verificationMatrix.rows.map((x) =>
        x.key === "tsa_token"
          ? {
              ...x,
              status: "VERIFIED",
              statusLabel: "Verified — validated from the timestamp token retained at intake",
              statement: "RFC 3161 timestamp validated from the token retained at intake.",
              measuredAtUtc: at,
              qualifiers: ["VALIDATED_FROM_RETAINED_TOKEN"],
            }
          : x,
      ),
    },
  };
  const r = await render(body);
  assert.deepEqual(badges(r, "verify-matrix-tsa_token"), ["Verified — validated from the timestamp token retained at intake"]);
  const rowTexts = textsIn(r, "verify-matrix-tsa_token");
  assert.ok(rowTexts.includes("Validated from the token retained at intake"), rowTexts.join("|"));
  assert.ok(rowTexts.some((t) => t.startsWith("Validated ") && t !== "Validated from the token retained at intake"), "the validation time");
  r.unmount();
});

/* ------------------------------------------------------------------ share */

test("share and copy use the canonical /verify/<pvr_> link — never the pvs_ token the page was opened with", async () => {
  const prev = process.env.EXPO_PUBLIC_WEB_BASE;
  process.env.EXPO_PUBLIC_WEB_BASE = "https://www.proovra.example";
  try {
    const r = await render(VO);
    assert.deepEqual(textsIn(r, "verify-share-url"), [`https://www.proovra.example/verify/${REF}`]);
    assert.ok(!allText(r).includes("pvs_reviewerShareToken123"), "the pvs_ token is never printed or shared");
    r.unmount();
  } finally {
    if (prev === undefined) delete process.env.EXPO_PUBLIC_WEB_BASE;
    else process.env.EXPO_PUBLIC_WEB_BASE = prev;
  }
  assert.equal(M.canonicalVerifyShareUrl("https://x.example/", { recordFacts: { verificationReference: "pvs_abc" } }), null);
  assert.equal(M.canonicalVerifyShareUrl("https://x.example/", { recordFacts: { verificationReference: "5b0a3c1e-0000-4000-8000-000000000001" } }), null);
  assert.equal(M.canonicalVerifyShareUrl("https://x.example/", VO), `https://x.example/verify/${REF}`);
});

/* -------------------------------------------------------------- deep link */

test("a /verify/package/<id> link is the web package page — never the verification id 'package'", async () => {
  assert.equal(DL.extractVerificationId("https://www.proovra.com/verify/package/pkg_42"), null);
  assert.equal(DL.extractVerificationPackageId("https://www.proovra.com/verify/package/pkg_42"), "pkg_42");
  assert.equal(DL.extractVerificationPackageId(`https://www.proovra.com/verify/${REF}`), null);
  assert.equal(DL.extractVerificationId(`https://www.proovra.com/verify/${REF}`), REF);

  // Pasted on the landing: the web package page opens; nothing is fetched as a record.
  const prev = process.env.EXPO_PUBLIC_WEB_BASE;
  process.env.EXPO_PUBLIC_WEB_BASE = "https://www.proovra.example";
  globalThis.__EXPO_PARAMS__ = {};
  let asked = null;
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/public/verify/")) asked = String(url);
    return prevFetch(url, init);
  };
  try {
    const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
    await r.type("Verification token or public verification ID", "https://www.proovra.com/verify/package/pkg_42");
    await r.press("Open verification");
    for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
    assert.equal(asked, null);
    assert.deepEqual(globalThis.__LINKING_OPENED__, ["https://www.proovra.example/verify/package/pkg_42"]);
    r.unmount();
  } finally {
    if (prev === undefined) delete process.env.EXPO_PUBLIC_WEB_BASE;
    else process.env.EXPO_PUBLIC_WEB_BASE = prev;
  }
});
