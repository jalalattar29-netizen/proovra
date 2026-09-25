/**
 * T-15 — advisory media-intelligence signals on the evidence Technical tab
 * (GET …/media-intelligence, POST …/run, POST /v1/media-intelligence/signals/:id/action).
 * Native never showed a record's observations, so none could be acknowledged or
 * dismissed, and the analyzer could not be run.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};
let signals;
let latestRun;

const MI = "/v1/evidence/ev-1/media-intelligence?teamId=t-1";
const CATALOG = [
  { signalType: "EXIF_MISSING", displayLabel: "EXIF missing", implemented: true },
  { signalType: "MIME_EXTENSION_MISMATCH", displayLabel: "File type differs from extension", implemented: true },
  { signalType: "OCR_AVAILABLE", displayLabel: "OCR available", implemented: false },
];

before(async () => {
  M = await loadModule("app/(stack)/evidence/[id].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  signals = [
    { id: "s-info", signalType: "EXIF_MISSING", severity: "INFO", confidence: "HIGH", safeSummary: "No EXIF block was present.", status: "PENDING", createdAtUtc: "2026-09-20T10:00:00.000Z" },
    { id: "s-att", signalType: "EXIF_TIMESTAMP_MISMATCH", severity: "ATTENTION", confidence: "MEDIUM", safeSummary: "Capture time differs from upload time.", status: "PENDING", createdAtUtc: "2026-09-19T10:00:00.000Z" },
    { id: "s-done", signalType: "CLIENT_SERVER_TIME_GAP", severity: "INFO", confidence: "LOW", safeSummary: "Clock gap observed.", status: "DISMISSED", createdAtUtc: "2026-09-18T10:00:00.000Z" },
  ];
  // The record was analysed before: the run row is already COMPLETED.
  latestRun = { runId: "run-1", status: "COMPLETED", attemptCount: 1, startedAtUtc: "2026-09-18T09:59:00.000Z", completedAtUtc: "2026-09-18T10:00:00.000Z", lastError: null };
  globalThis.__EXPO_PARAMS__ = { id: "ev-1" };
  routes = {
    ...authenticatedRoutes(),
    "/v1/evidence/ev-1/review-workspace": () => ({ relationships: { items: [] }, reviewWorkflow: { teamId: "t-1", status: "IN_REVIEW", assignedTo: null } }),
    "/v1/evidence/ev-1": () => ({ evidence: { id: "ev-1", status: "SIGNED", type: "PHOTO" } }),
    [MI]: () => ({ evidenceId: "ev-1", signals, catalog: CATALOG, latestRun }),
    "/v1/evidence/ev-1/media-intelligence/run": () => ({ evidenceId: "ev-1", mode: "async", queued: true, runId: "run-1" }),
    "/v1/media-intelligence/signals/s-att/action": (body) => {
      signals = signals.map((s) => (s.id === "s-att" ? { ...s, status: body.action } : s));
      return { ok: true };
    },
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    if (!path.startsWith("/v1/me/presence")) requests.push({ path, method, body });
    const key = routes[path] ? path : Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key](body) : undefined;
    const status = res === undefined ? 500 : res.__status ?? 200;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const openTechnical = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  await r.press("Technical");
  await settle();
  return r;
};

test("observations are listed ATTENTION-first in advisory words, with the not-yet-computed categories", async () => {
  const r = await openTechnical();
  assert.ok(requests.some((q) => q.path === MI), "signals were never read for the record's workspace");
  assert.ok(r.hasText("Media intelligence"));
  const t = r.texts();
  assert.ok(t.indexOf("Capture time differs from upload time.") < t.indexOf("No EXIF block was present."), "not ATTENTION-first");
  assert.ok(r.hasText("Needs attention") && r.hasText("Medium confidence") && r.hasText("Awaiting review"));
  assert.ok(!r.hasText("Clock gap observed."), "a resolved observation was shown among the open ones");
  await r.press("Resolved observations (1)");
  assert.ok(r.hasText("Clock gap observed.") && r.hasText("Dismissed"));
  await r.press("Categories not yet computed for this evidence (1)");
  assert.ok(r.hasText("File type differs from extension"));
  assert.ok(!r.hasText("OCR available"), "an unimplemented category was offered");
});

test("acknowledge posts the workspace + action and shows the PERSISTED status", async () => {
  const r = await openTechnical();
  await r.press("Acknowledge: Capture time differs from upload time.");
  await settle();
  const post = requests.find((q) => q.path === "/v1/media-intelligence/signals/s-att/action");
  assert.deepEqual(post.body, { teamId: "t-1", action: "ACKNOWLEDGED" });
  await r.press("Resolved observations (2)");
  assert.ok(r.hasText("Acknowledged"));
});

test("a refused acknowledge says nothing changed", async () => {
  routes["/v1/media-intelligence/signals/s-att/action"] = () => ({ __status: 409 });
  const r = await openTechnical();
  await r.press("Dismiss: Capture time differs from upload time.");
  await settle();
  assert.ok(r.hasText("The observation could not be dismissed. Nothing was changed."));
});

test("a re-run is not reported complete from the PREVIOUS run's row", async () => {
  const r = await openTechnical();
  await r.press("Run analyzer");
  await settle();
  const run = requests.find((q) => q.path === "/v1/evidence/ev-1/media-intelligence/run");
  assert.deepEqual(run.body, { teamId: "t-1", async: true });
  // The server returned the SAME run row, still COMPLETED from last time.
  assert.ok(!r.hasText("Analysis complete"), "the previous run's result was announced as this run's");
  assert.ok(r.hasText("Analysis queued."));
});

test("a run the queue refused says so rather than spinning", async () => {
  routes["/v1/evidence/ev-1/media-intelligence/run"] = () => ({ evidenceId: "ev-1", mode: "async", queued: false, runId: "run-1" });
  const r = await openTechnical();
  await r.press("Run analyzer");
  await settle();
  assert.ok(r.hasText("The analysis was recorded but could not be queued for processing. It stays pending until the queue is available."));
  assert.ok(r.byLabel("Retry analysis").length === 1);
});

test("no workspace on the review workflow → no panel", async () => {
  routes["/v1/evidence/ev-1/review-workspace"] = () => ({ relationships: { items: [] }, reviewWorkflow: null });
  const r = await openTechnical();
  assert.ok(!r.hasText("Media intelligence"));
  assert.ok(!requests.some((q) => q.path.includes("/media-intelligence")));
});

/* --------------------------------------- the run's own terminal state, end to end */
test("a re-run completes only when ITS row changes, and reports new vs total honestly", async () => {
  const P = await loadModule("src/ui/media-intelligence-panel.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
  let polls = 0;
  routes[MI] = () => {
    polls += 1;
    // Poll 1+ after acceptance: PROCESSING, then COMPLETED with a new stamp and one new observation.
    if (polls === 3) latestRun = { ...latestRun, status: "PROCESSING", completedAtUtc: null, startedAtUtc: "2026-09-24T10:00:00.000Z" };
    if (polls === 4) {
      latestRun = { ...latestRun, status: "COMPLETED", completedAtUtc: "2026-09-24T10:00:05.000Z" };
      signals = [...signals, { id: "s-new", signalType: "MIME_EXTENSION_MISMATCH", severity: "REVIEW_RECOMMENDED", confidence: "HIGH", safeSummary: "Extension differs.", status: "PENDING", createdAtUtc: "2026-09-24T10:00:04.000Z" }];
    }
    return { evidenceId: "ev-1", signals, catalog: CATALOG, latestRun };
  };
  const r = await renderComponent(h(P.TestProviders, null, h(P.MediaIntelligencePanel, { evidenceId: "ev-1", teamId: "t-1", pollMs: 5 })));
  await settle();
  await r.press("Run analyzer");
  for (let i = 0; i < 12 && !r.hasText("Analysis complete"); i += 1) {
    await act(async () => { await new Promise((x) => setTimeout(x, 10)); });
  }
  assert.ok(r.hasText("Analysis complete"), "the run never completed");
  assert.ok(r.hasText("1 new observation was recorded."));
  assert.ok(r.hasText("4 observations are now recorded in total."));
  r.unmount();
});
