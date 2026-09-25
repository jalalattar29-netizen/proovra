/**
 * T-14 — public intake (IntakeChecklist.tsx:246 "Accepts:",
 * IntakeCompletionProgress.tsx:64 Completion). The validate response's
 * `request` carries each deliverable's counts / kinds / hints and a server
 * completion summary; native showed bare titles only.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let M;
let payload;
before(async () => {
  M = await loadModule("app/(stack)/intake/[token].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(() => {
  globalThis.__EXPO_PARAMS__ = { token: "tok-1" };
  payload = {
    link: { workflowTemplateName: "Claim evidence", intakeMode: "EXTERNAL_IDENTIFIED" },
    session: { id: "s1", status: "OPEN" },
    // evidence-request.service.ts public projection.
    request: {
      title: "Water damage claim",
      completion: { requiredTotal: 2, requiredFulfilled: 1, optionalTotal: 1, optionalFulfilled: 0, completionPercent: 33, reviewReady: false, needsMoreInfo: false },
      deliverables: [
        { id: "d1", title: "Damage photos", description: "All four walls.", required: true, acceptedKinds: ["PHOTO", "VIDEO"], minCount: 4, maxCount: 8, locationRequirement: "required", captureAfterRequest: true, status: "PARTIALLY_FULFILLED", fulfilledCount: 1 },
        { id: "d2", title: "Invoice", description: "", required: false, acceptedKinds: [], minCount: 1, maxCount: null, locationRequirement: "none", captureAfterRequest: false, status: "PENDING", fulfilledCount: 0 },
      ],
    },
  };
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const body = path === "/v1/external-intake/tok-1" ? payload : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
});
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
  return r;
};

test("each requested item says how many, which kinds, and the location / fresh-capture rules", async () => {
  const r = await render();
  assert.ok(r.hasText("Damage photos (required)"));
  assert.ok(r.hasText("1 of 4 required (up to 8) · Accepts: Photo, Video · Location capture required · Capture fresh — do not reuse old files"));
  assert.ok(r.hasText("0 of 1 required · Accepts: Photo, Video, Audio, Document"));
});

test("the completion summary is the server's", async () => {
  const r = await render();
  assert.equal(r.byTestId("intake-completion").length, 1);
  assert.ok(r.byLabel("33%").length === 1 && r.byLabel("Required items remaining").length === 1);
  assert.ok(r.hasText("Required: 1 / 2 · Optional: 0 / 1"));
  payload.request.completion = { ...payload.request.completion, reviewReady: true, completionPercent: 100 };
  r.unmount();
  const r2 = await render();
  assert.equal(r2.byLabel("Review-ready").length, 1);
});

/* ---- (e) the landing's failed states, from intakeErrorToReply (external-intake.routes.ts:463-500) ---- */

const refuse = (status, code, message) => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { code, message } }), { status, headers: { "content-type": "application/json" } });
};

test("a revoked, expired or exhausted link (410 LINK_NO_LONGER_AVAILABLE) says so, with the web's copy and next step", async () => {
  refuse(410, "LINK_NO_LONGER_AVAILABLE", "This upload link is no longer available. It may have expired or been revoked. Please contact the sender for a new link.");
  const r = await render();
  assert.ok(r.hasText("This link is not open"));
  assert.ok(r.hasText("This upload link is no longer available. It may have expired or been revoked. Please contact the sender for a new link."), r.texts().join(" | "));
  assert.ok(r.hasText("If you still need to submit evidence, contact the workspace that sent you this link — they can issue a new one."));
  assert.ok(!r.hasText("This link could not be opened. Try again, or ask for a new one."), "a withdrawn link was told to try again");
});

test("a used one-time link (410 LINK_ALREADY_SUBMITTED) is the web's Already submitted outcome, not a fault", async () => {
  refuse(410, "LINK_ALREADY_SUBMITTED", "This upload link has already been used.");
  const r = await render();
  assert.ok(r.hasText("Already submitted"));
  assert.ok(r.hasText("This link has already been used. Your earlier submission was received and the workspace can review it."));
  assert.ok(r.hasText("If you need to send more files, contact the sender for a new upload link."));
});

test("an unknown token (404 INVALID_OR_EXPIRED_LINK) is an invalid link, not an expired one", async () => {
  refuse(404, "INVALID_OR_EXPIRED_LINK", "This upload link is invalid or has expired. Please contact the sender for a new link.");
  const r = await render();
  assert.ok(r.hasText("This link is not valid. Check the message you received, or ask for a new link."), r.texts().join(" | "));
});
