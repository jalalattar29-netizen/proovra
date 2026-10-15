/**
 * T-15 — the provenance chain (GET /v1/provenance/:evidenceId) at the top of
 * the evidence Integrity tab. Native never read it: how a record reached
 * PROOVRA, which preservation steps were applied, derived copies and what the
 * record does NOT establish were unreachable on a phone.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};
const CHAIN = (over = {}) => ({
  chain: {
    schemaVersion: "V2", generatedAtUtc: "2026-09-24T10:00:00Z", evidenceId: "ev-1",
    acquisition: { label: "Captured in the PROOVRA app", recordedBy: "BACKFILL_INTAKE_SESSION_LINK" },
    capture: { deviceSignatureNote: "Signed by the capturing device", attestationVerdict: "PASSED", attestationProvider: "APP_ATTEST", signedAtUtc: "2026-09-20T10:00:00Z" },
    server: { countersigned: true, countersignedAtUtc: "2026-09-20T10:01:00Z" },
    time: { rfc3161: { applied: true, appliedAtUtc: "2026-09-20T10:02:00Z" }, ots: { applied: false, anchorTxId: null, appliedAtUtc: null, bitcoinBlockHeight: null, status: "NOT_REQUESTED", statusLabel: "Not requested" } },
    derivations: [{ derivedEvidenceId: "abcdef1234567890", transformLabel: "redacted copy", derivedAtUtc: "2026-09-21T10:00:00Z" }],
    limitations: ["PROVENANCE_DOES_NOT_PROVE_CONTENT_TRUTH", "SOME_NEW_CODE"],
    ...over,
  },
});

before(async () => {
  M = await loadModule("app/(stack)/evidence/[id].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  globalThis.__EXPO_PARAMS__ = { id: "ev-1" };
  routes = {
    ...authenticatedRoutes(),
    "/v1/provenance/ev-1": () => ({ body: CHAIN() }),
    "/v1/evidence/ev-1/review-workspace": () => ({ body: { relationships: { items: [] } } }),
    "/v1/evidence/ev-1": () => ({ body: { evidence: { id: "ev-1", status: "SIGNED", type: "PHOTO" } } }),
  };
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push(path);
    const key = routes[path] ? path : Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const out = key ? routes[key]() : { status: 500, body: {} };
    return new Response(JSON.stringify(out.body ?? out), { status: out.status ?? 200, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const openIntegrity = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  await r.press("Integrity");
  await settle();
  return r;
};

test("the Integrity tab shows how the record reached PROOVRA, its preservation steps and its limits", async () => {
  const r = await openIntegrity();
  assert.ok(requests.includes("/v1/provenance/ev-1"), "provenance was never read");
  assert.ok(r.hasText("How this record reached PROOVRA"));
  assert.ok(r.hasText("Captured in the PROOVRA app"));
  assert.ok(r.hasText("Recorded later from this record's secure intake session."));
  assert.ok(r.hasText("Passed (App attest)"));
  assert.ok(r.hasText("Bitcoin anchoring"));
  assert.ok(r.hasText("Not requested"));
  assert.ok(r.hasText("abcdef12… · redacted copy"));
  assert.ok(r.hasText("It does not establish whether what the file shows is true."));
  assert.ok(r.hasText("Some new code"), "an unknown limitation code was dropped instead of shown");
});

test("a projection for ANOTHER record is never shown", async () => {
  routes["/v1/provenance/ev-1"] = () => ({ body: CHAIN({ evidenceId: "ev-other" }) });
  const r = await openIntegrity();
  assert.ok(r.hasText("A provenance record is not available for this evidence in the workspace you are in."));
  assert.ok(!r.hasText("Captured in the PROOVRA app"));
});

test("403 names the organisation-workspace rule; a 500 is an error with Try again", async () => {
  routes["/v1/provenance/ev-1"] = () => ({ status: 403, body: {} });
  let r = await openIntegrity();
  assert.ok(r.hasText("Provenance records are kept for organisation workspaces."));
  r.unmount();
  routes["/v1/provenance/ev-1"] = () => ({ status: 500, body: {} });
  r = await openIntegrity();
  assert.equal(r.byTestId("provenance-error").length, 1);
});

test("UC-TRUST-002: a PENDING OTS proof is never 'Anchored'; an unvalidated token is 'Recorded, not validated'", async () => {
  routes["/v1/provenance/ev-1"] = () => ({
    body: CHAIN({
      time: {
        rfc3161: { applied: false, appliedAtUtc: "2026-09-20T10:02:00Z", status: "RECORDED_NOT_VALIDATED" },
        // ProvenanceChain time.ots.status is THE canonical OtsState (2026-10-13).
        ots: { applied: false, anchorTxId: null, appliedAtUtc: null, bitcoinBlockHeight: null, status: "PENDING", statusLabel: "Pending" },
      },
    }),
  });
  const r = await openIntegrity();
  assert.ok(!r.hasText("Anchored"), "a pending proof was shown as anchored");
  assert.ok(r.hasText("OpenTimestamps proof pending"));
  assert.ok(r.hasText("Recorded, not validated"));
});

test("an ANCHORED provenance proof without a chain verification is an attestation recorded, never verified", async () => {
  routes["/v1/provenance/ev-1"] = () => ({
    body: CHAIN({
      time: {
        rfc3161: { applied: true, appliedAtUtc: "2026-09-20T10:02:00Z" },
        ots: { applied: true, anchorTxId: null, appliedAtUtc: "2026-09-21T10:00:00Z", bitcoinBlockHeight: 860123, status: "ANCHORED", verification: "ATTESTATION_RECORDED", statusLabel: "server words" },
      },
    }),
  });
  const r = await openIntegrity();
  assert.ok(r.hasText("Bitcoin attestation recorded — Not independently checked against Bitcoin"));
  assert.ok(!r.hasText("Independently verified against the Bitcoin main chain ✓"));
  assert.ok(!r.texts().some((t) => t.includes("✓") && t.includes("Bitcoin")), "a check mark beside an unchecked attestation");
  assert.ok(r.hasText("860123"));
});

test("only a CHAIN_VERIFIED provenance proof reads independently verified, with its check mark", async () => {
  routes["/v1/provenance/ev-1"] = () => ({
    body: CHAIN({
      time: {
        rfc3161: { applied: true, appliedAtUtc: "2026-09-20T10:02:00Z" },
        ots: { applied: true, anchorTxId: null, appliedAtUtc: "2026-09-21T10:00:00Z", bitcoinBlockHeight: 860123, status: "ANCHORED", verification: "CHAIN_VERIFIED", statusLabel: "server words" },
      },
    }),
  });
  const r = await openIntegrity();
  assert.ok(r.hasText("Independently verified against the Bitcoin main chain ✓"));
  assert.ok(!r.hasText("Not independently checked against Bitcoin"));
});

test("AUD-017: a continuous capture shows delivered of recorded segments, client-reported, with the boundary note", async () => {
  routes["/v1/provenance/ev-1"] = () => ({
    body: CHAIN({
      captureManifestFacts: {
        schema: "PROOVRA_CAPTURE_MANIFEST_FACTS_V1",
        kind: "SCREEN_CONTINUOUS",
        reportedBy: "CAPTURE_CLIENT",
        manifestSchemaVersion: "PROOVRA_SCREEN_CAPTURE_CONTINUOUS_MANIFEST_V2",
        manifestSha256: "e".repeat(64),
        manifestPartIndex: 2,
        clientCaptureWindow: { startedAtUtc: "2026-10-01T10:00:00.000Z", endedAtUtc: "2026-10-01T10:00:12.000Z" },
        completeness: "COMPLETE_SESSION",
        reportedComplete: true,
        limitations: [],
        client: { kind: "MOBILE_APP", appVersion: "1.0.0", platform: "android", osVersion: "14", model: "Pixel 7", browserName: null, browserVersion: null },
        web: null,
        // Facts recorded before AUD-017 (no declaredRecordedThroughMax).
        screen: { endReason: "USER_STOPPED", artifactCount: 2, recordedSegmentCount: 2, totalDurationMs: 12000 },
      },
    }),
  });
  const r = await openIntegrity();
  assert.equal(r.byTestId("provenance-capture-completeness").length, 1);
  assert.ok(r.hasText("Completeness (client-reported)"));
  assert.ok(r.hasText("Reported complete by the capture client"));
  assert.ok(r.hasText("Segments delivered 2 of 2 recorded (client-reported)"));
  assert.ok(r.hasText("PROOVRA cannot verify segments the client never declared."), "the boundary note is missing");
});

test("AUD-017: no capture-manifest facts, no completeness rows", async () => {
  const r = await openIntegrity();
  assert.equal(r.byTestId("provenance-capture-completeness").length, 0);
});
