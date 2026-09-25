/**
 * T-14 — Comparison mode (web ComparisonPanel + StructuredSnapshot), ungated on
 * the web Review tab. Native had no comparison at all. The payload here is the
 * route's own reply (evidence.routes.ts:7915): the read happens only on open;
 * the package card marks fields that differ from the report's recorded trust
 * decision; all-null mismatch flags are never shown.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn, platformContextEnvelope } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let P;
let routes = {};
let reads = [];
const COMPARISON = () => ({
  evidenceId: "ev-1",
  original: { mimeType: "image/jpeg", sizeBytes: "2048", originalFileName: "site.jpg", displayFileName: null, fileSha256: "abcdef0123456789", fingerprintHash: null },
  previewRepresentation: { mimeType: "image/jpeg", primaryKind: "image", previewable: true },
  reportArtifact: { version: 2, generatedAtUtc: "2026-09-20T10:00:00.000Z", verificationPackageVersion: 1, trustDecisionSnapshot: { verdict: "CONSISTENT", score: 82 } },
  verificationPackage: { version: 1, generatedAtUtc: "2026-09-19T10:00:00.000Z", packageType: "ZIP", manifestDigest: null, trustDecisionSnapshot: { verdict: "CONSISTENT", score: 70 } },
  contentItems: [],
  mismatchFlags: { originalVsRecordedHash: null, originalVsVerificationPackageManifest: null, previewVsOriginal: null },
});

before(async () => {
  M = await loadModule("app/(stack)/evidence/[id].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
  P = await loadModule("src/product/evidence-comparison.ts");
});
beforeEach(async () => {
  reads = [];
  globalThis.__EXPO_PARAMS__ = { id: "ev-1" };
  routes = {
    ...authenticatedRoutes({ "/v1/platform/context": () => platformContextEnvelope({}) }),
    "/v1/evidence/ev-1/comparison": () => COMPARISON(),
    "/v1/evidence/ev-1/review-workspace": () => ({ relationships: { items: [] } }),
    "/v1/evidence/ev-1": () => ({ evidence: { id: "ev-1", status: "SIGNED", type: "PHOTO" } }),
  };
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    reads.push(path);
    const key = routes[path] ? path : Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key]() : undefined;
    return new Response(JSON.stringify(res ?? {}), { status: res === undefined ? 500 : 200, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};

test("Comparison mode reads on open and shows each artifact with its summary, never the all-null mismatch flags", async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  await r.press("Review");
  await settle();
  assert.equal(r.byTestId("evidence-comparison").length, 1, "no Comparison mode on the Review tab");
  assert.ok(!reads.includes("/v1/evidence/ev-1/comparison"), "read before it was opened");
  await r.press("Comparison mode");
  await settle();
  assert.ok(reads.includes("/v1/evidence/ev-1/comparison"));
  assert.ok(r.texts().some((t) => t.startsWith("Comparison uses recorded metadata and export references only.")));
  for (const title of ["Original record", "Reviewer preview", "Report artifact", "Verification package"]) assert.ok(r.hasText(title), title);
  assert.ok(r.hasText("image/jpeg · 2048 B · SHA-256 abcdef01…"));
  assert.ok(!r.hasText("Mismatch flags"), "scaffolding flags were shown");
});

test("the package's technical details mark the trust-decision fields that differ from the report", async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  await r.press("Review");
  await settle();
  await r.press("Comparison mode");
  await settle();
  await r.press("Technical details: Verification package");
  assert.ok(r.hasText("Marked fields differ from the report artifact. Unmarked fields match, or have no equivalent to compare."));
  assert.ok(r.hasText("Trust decision snapshot"));
  assert.ok(r.hasText("Changed"), "the differing score was not marked");
  await r.press("View raw snapshot");
  assert.ok(r.texts().some((t) => t.includes("\"packageType\": \"ZIP\"")));
});

test("a failed read says the comparison is unavailable", async () => {
  routes["/v1/evidence/ev-1/comparison"] = () => undefined;
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  await r.press("Review");
  await settle();
  await r.press("Comparison mode");
  await settle();
  assert.ok(!r.hasText("Original record"));
});

test("the snapshot model compares only keys the counterpart carries", () => {
  const nodes = P.body({ a: 1, b: 2 }, { a: 1 }, false);
  assert.deepEqual(nodes.map((n) => [n.key, n.change]), [["a", "unchanged"], ["b", null]]);
  const removed = P.body({ a: 1 }, { a: 1, z: 3 }, false);
  assert.deepEqual(removed.map((n) => [n.key, n.change]), [["a", "unchanged"], ["z", "removed"]]);
  assert.equal(P.humaniseKey("fileSha256"), "File SHA 256");
  assert.equal(P.projectComparison({ mismatchFlags: { x: true } }).at(-1).title, "Mismatch flags");
});


test("View raw snapshot has the web's Copy JSON", async () => {
  globalThis.__CLIPBOARD__ = undefined;
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  await r.press("Review");
  await settle();
  await r.press("Comparison mode");
  await settle();
  await r.press("Technical details: Verification package");
  await r.press("View raw snapshot");
  await r.press("Copy JSON: Verification package");
  await settle();
  assert.equal(JSON.parse(globalThis.__CLIPBOARD__).packageType, "ZIP");
});
