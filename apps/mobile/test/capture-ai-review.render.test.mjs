/**
 * T-15 — Capture AI review (POST /v1/ai/capture/analyze-session). Native had
 * no advisory QA of a staged session. Component-level: staging items on the
 * capture screen needs the camera/picker, which this harness does not drive;
 * the mount in app/(stack)/capture.tsx is type-checked.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let M;
let requests = [];
let answer;

const PLAN = {
  id: "general-evidence-record",
  version: 3,
  name: "General evidence record",
  description: "",
  locationRequirement: "required",
  steps: [
    { id: "primary", title: "Primary evidence", description: "The main item", purposeLabel: "Primary", required: true, acceptedKinds: ["PHOTO"] },
    { id: "context", title: "Context shot", description: "", purposeLabel: "Context", required: true, acceptedKinds: ["PHOTO"] },
    { id: "extra", title: "Anything else", description: "x", purposeLabel: "Extra", required: false, acceptedKinds: [] },
  ],
};
const ITEMS = [
  { id: "i1", fileName: "roof.jpg", mimeType: "image/jpeg", sizeBytes: 2048, checklistStepId: "primary", role: "Primary", sourceLabel: null, locationIncluded: false },
];

before(async () => {
  M = await loadModule("src/ui/capture-ai-review.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(() => {
  requests = [];
  answer = () => ({
    status: 200,
    body: { data: { status: "ok", summary: "s", warnings: ["Two items share a timestamp."], suggestions: ["Add a wide context shot."], flags: [{ severity: "danger", title: "Required context missing", detail: "No context shot." }], legalDisclaimer: "Advisory only (server)." } },
  });
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (!path.startsWith("/v1/ai/")) return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    requests.push({ path, body: init.body ? JSON.parse(init.body) : null });
    const out = answer();
    return new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json" } });
  };
});
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const mount = async (props = {}) => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.CaptureAiReview, { plan: PLAN, useLocation: false, items: ITEMS, ...props })));
  await settle();
  await r.press("AI Review");
  return r;
};

test("the pre-check states coverage and the location gate before any AI runs", async () => {
  const r = await mount();
  assert.equal(requests.length, 0, "AI ran without being asked");
  assert.ok(r.hasText("Coverage gap detected"));
  assert.ok(r.hasText("1 required capture step still need mapped material before final review."));
  assert.ok(r.hasText("1/2") && r.hasText("50% required coverage"));
  assert.ok(r.hasText("Run AI QA review (2)"), "the coverage gap and the required-location gate are two signals");
});

test("running sends METADATA ONLY and shows the server's answer, which replaces local guidance", async () => {
  const r = await mount();
  await r.press("Run AI QA review");
  await settle();
  const body = requests[0].body;
  assert.equal(body.planMode, "FLEXIBLE");
  assert.equal(body.collectionPlan.description, "General evidence record", "an empty description would fail the route");
  assert.equal(body.collectionPlan.steps[1].description, "Context shot");
  assert.deepEqual(body.items[0], { id: "i1", fileName: "roof.jpg", mimeType: "image/jpeg", sizeBytes: 2048, checklistStepId: "primary", role: "Primary", clientSignals: { locationIncluded: false } });
  assert.ok(!JSON.stringify(body).includes("file://"), "a file location left the device");
  assert.ok(r.hasText("• Required context missing"), "the AI's missing-requirement flag did not lead coverage");
  assert.ok(r.hasText("• Two items share a timestamp."));
  assert.ok(r.hasText("• Add a wide context shot."));
  assert.ok(r.hasText("Advisory only (server)."));
  assert.ok(r.texts().some((t) => t.startsWith("AI advisory is not saved.")));
});

test("an unavailable AI says so and capture continues", async () => {
  answer = () => ({ status: 503, body: { code: "AI_DISABLED" } });
  const r = await mount();
  await r.press("Run AI QA review");
  await settle();
  assert.ok(r.hasText("AI assistant unavailable. Continue capture and finish normally."));
});

test("no plan → no run is offered", async () => {
  const r = await mount({ plan: null });
  assert.ok(r.hasText("Plan context required"));
  assert.ok(r.byLabel("Run AI QA review")[0].props.accessibilityState.disabled);
});
