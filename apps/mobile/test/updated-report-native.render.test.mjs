/**
 * UPDATED REPORT (native) — parity with the web contract, through the REAL
 * Evidence screen:
 *
 *   * "Generate updated report" is a DIRECT action; opening it re-reads the
 *     status and holds the SIGNED offer revision;
 *   * Confirm is disabled until the shared reason validator passes;
 *   * Confirm sends the revision; a STALE answer is handled in place (change
 *     sentences, reason kept, re-read offer, new confirmation with a new key);
 *   * a typed error never shows raw server text;
 *   * the durable request renders its persisted step; the history shows each
 *     immutable report beside the package that certifies it.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn, TEST_TEAM_ID } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let B;
let routes = {};
let posts = [];
let postAnswers = [];
const ELIG = `/v1/governance/export-eligibility?teamId=${TEST_TEAM_ID}&evidenceId=ev-1`;
const READY = (v) => ({ state: "READY", action: "NONE", actionUnavailableReason: "NOT_REQUIRED", version: v, latestAvailableVersion: v });

const statusBody = ({ current = 1, offer = "ofr1.first", active = null } = {}) => ({
  outputs: {
    report: READY(current),
    verificationPackage: READY(current),
    newVersion: { action: "CREATE_NEW_VERSION", reason: null, currentVersion: current, nextVersion: current + 1, estimate: null },
    offer: { revision: offer, operation: "NEW_VERSION", targetVersion: current + 1, reasonRequired: true, creditEffect: { kind: "NONE" }, storageEffect: { estimatedBytes: null, fitsStorage: true, storageBytesUsed: null, storageBytesLimit: null } },
    freshness: {
      reportVersion: current,
      reportGeneratedAtUtc: "2026-10-06T09:00:00.000Z",
      hasNewerFacts: true,
      changes: [{ code: "TSA_VALIDATED_AFTER_REPORT", atUtc: "2026-10-06T09:30:00.000Z" }],
    },
    activeRequest: active,
    pollIntervalMs: null,
  },
  versions: {
    versions: Array.from({ length: current }, (_, i) => current - i).map((v) => ({
      reportVersion: v,
      generatedAtUtc: "2026-10-06T09:00:00.000Z",
      sizeBytes: "2000000",
      sha256: "a".repeat(64),
      immutableRecorded: false,
      issueKind: v === 1 ? "FIRST_ISSUE" : "UPDATED_REPORT",
      issueReason: v === 1 ? null : "Document the validated timestamp",
      latest: v === current,
      digestMismatch: false,
      package: { version: v, generatedAtUtc: "2026-10-06T09:00:05.000Z", sizeBytes: "2400000", sha256: "b".repeat(64), embeddedReportSha256: "a".repeat(64), sealed: true, immutableRecorded: false, pairing: "REPORT_VERSION" },
    })),
    unpairedPackages: [],
  },
});

before(async () => {
  M = await loadModule("app/(stack)/evidence/[id].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
  B = await loadModule("src/ui/runtime-status-banner.tsx");
});
beforeEach(async () => {
  B.resetServiceStatusForTests();
  globalThis.__EXPO_PARAMS__ = { id: "ev-1" };
  posts = [];
  postAnswers = [];
  routes = {
    ...authenticatedRoutes(),
    "/v1/evidence/ev-1/artifacts/status": () => statusBody(),
    "/v1/evidence/ev-1/review-workspace": () => ({ relationships: { items: [] } }),
    "/v1/evidence/ev-1": () => ({ evidence: { id: "ev-1", status: "REPORTED", type: "PHOTO", displayTitle: "Roof photo" } }),
    [ELIG]: () => ({ outcome: "ALLOWED", reason: "ok", lifecycleState: "ACTIVE" }),
    "/v1/runtime/status": () => ({ status: "HEALTHY" }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (init.method === "POST") {
      posts.push({ path, body: init.body ? JSON.parse(init.body) : null });
      const [status, body] = postAnswers.shift() ?? [202, { outcome: "ENQUEUED", operation: "NEW_VERSION", requestId: "req-1", message: "Report v2 was requested." }];
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }
    const key = routes[path] ? path : Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key]() : undefined;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), {
      status: res ? 200 : 500,
      headers: { "content-type": "application/json" },
    });
  };
  await signIn(M);
});

const settle = async () => {
  for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const open = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  await r.press("Artifacts");
  await settle();
  return r;
};
const generateLabel = (r) => r.byLabel("Generate updated report: Roof photo").length ? "Generate updated report: Roof photo" : "Generate updated report: this record";

test("a direct action; the server's freshness is shown; Confirm is gated on the shared reason validator and sends the SIGNED offer", async () => {
  const r = await open();
  assert.ok(r.hasText("New verification facts are available"));
  assert.ok(r.hasText("The trusted timestamp was validated after report v1 was generated."));
  await r.press(generateLabel(r));
  await settle();
  assert.ok(r.hasText("Generate report v2"));
  assert.ok(r.hasText("A matching verification package v2 will certify report v2."));
  assert.ok(r.hasText("No evidence credit is used. The original evidence and its recorded timestamps are not modified."));
  // Whitespace only: Confirm stays disabled (a disabled press is a no-op).
  await r.type("Reason for the updated report, required", "    ");
  await settle();
  assert.ok(r.hasText("Say why an updated report is being issued."));
  await r.press("Generate report v2");
  await settle();
  assert.equal(posts.length, 0);
  await r.type("Reason for the updated report, required", "  Document   the validated timestamp ");
  await settle();
  assert.ok(r.hasText("32/120"));
  await r.press("Generate report v2");
  await settle();
  assert.equal(posts.length, 1);
  assert.deepEqual(
    { intent: posts[0].body.intent, reason: posts[0].body.reason, offerRevision: posts[0].body.offerRevision },
    { intent: "NEW_VERSION", reason: "Document the validated timestamp", offerRevision: "ofr1.first" },
  );
  assert.match(posts[0].body.clientRequestKey, /^nv-/);
  r.unmount();
});

test("a STALE answer is handled in place: change sentences, reason kept, re-read offer, a NEW confirmation with a NEW key", async () => {
  postAnswers.push([409, { code: "OUTPUT_OFFER_STALE", changes: ["LATEST_REPORT_CHANGED"], changeMessages: ["A newer report version was completed."], message: "x" }]);
  const r = await open();
  await r.press(generateLabel(r));
  await settle();
  await r.type("Reason for the updated report, required", "Owner's reason");
  await settle();
  // Meanwhile a colleague issued v2: the re-read offer is v3.
  routes["/v1/evidence/ev-1/artifacts/status"] = () => statusBody({ current: 2, offer: "ofr1.second" });
  await r.press("Generate report v2");
  await settle();
  assert.ok(r.hasText("This record changed while this was open"));
  assert.ok(r.hasText("• A newer report version was completed."));
  assert.ok(r.hasText("Your reason has been kept."));
  assert.ok(r.hasText("Generate report v3"));
  const input = r.byLabel("Reason for the updated report, required").find((n) => n.props.onChangeText);
  assert.equal(input.props.value, "Owner's reason");
  await r.press("Confirm report v3");
  await settle();
  assert.equal(posts.length, 2);
  assert.equal(posts[1].body.offerRevision, "ofr1.second");
  assert.notEqual(posts[1].body.clientRequestKey, posts[0].body.clientRequestKey);
  r.unmount();
});

test("a typed refusal is said in the shared words, never raw server text; the reason stays", async () => {
  postAnswers.push([403, { code: "GENERATION_NOT_PERMITTED", message: "internal detail at line 42" }]);
  const r = await open();
  await r.press(generateLabel(r));
  await settle();
  await r.type("Reason for the updated report, required", "Member reason");
  await settle();
  await r.press("Generate report v2");
  await settle();
  assert.ok(r.hasText("You don't have permission to do that."));
  assert.ok(!r.hasText("internal detail at line 42"));
  const input = r.byLabel("Reason for the updated report, required").find((n) => n.props.onChangeText);
  assert.equal(input.props.value, "Member reason");
  r.unmount();
});

test("the durable request renders its PERSISTED step; history pairs each report with its own package", async () => {
  routes["/v1/evidence/ev-1/artifacts/status"] = () =>
    statusBody({
      current: 2,
      active: { requestId: "req-9", intent: "NEW_VERSION", artifactType: "REPORT", state: "PROCESSING", stage: "REPORT_RESERVED", progressStage: "VERIFYING_REPORT", targetVersion: 3, terminalReasonCode: null, attemptCount: 1, createdAtUtc: "x", updatedAtUtc: "x", completedAtUtc: null, recent: true },
    });
  const r = await open();
  assert.ok(r.hasText("Generating report v3"));
  assert.ok(r.hasText("Verifying report…"));
  assert.ok(r.byLabel("Verifying report: current").length === 1);
  assert.ok(r.byLabel("Building verification package: pending").length === 1);
  assert.equal(r.byTestId("artifact-pair-2").length, 1);
  assert.ok(r.hasText("Version 2 · Latest · Immutable"));
  assert.ok(r.hasText("Version 1 · Previous · Immutable"));
  assert.ok(r.texts().some((t) => t.startsWith("Verification package v2 · certifies report v2")));
  assert.ok(r.texts().some((t) => t.startsWith("Verification package v1 · certifies report v1")));
  assert.ok(r.byLabel("Download report v1").length + r.byLabel("Download verification package v1").length >= 2);
  r.unmount();
});

test("a failed durable request names the typed error and the support reference", async () => {
  routes["/v1/evidence/ev-1/artifacts/status"] = () =>
    statusBody({
      current: 1,
      active: { requestId: "req-fail-1", intent: "NEW_VERSION", artifactType: "REPORT", state: "FAILED_TERMINAL", stage: "REPORT_RESERVED", progressStage: "RENDERING_REPORT", targetVersion: 2, terminalReasonCode: "RENDER_TIMEOUT", attemptCount: 3, createdAtUtc: "x", updatedAtUtc: "x", completedAtUtc: "x", recent: true },
    });
  const r = await open();
  assert.ok(r.hasText("Generating report v2 stopped"));
  assert.ok(r.hasText("The report could not be rendered"));
  assert.ok(r.hasText("Support reference: req-fail-1"));
  r.unmount();
});
