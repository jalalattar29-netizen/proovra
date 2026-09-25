/**
 * T-14 — CaptureSessionPanel on native capture (:196-206 Mapped / Blockers /
 * Warnings, :229 Session ID + metadata, :252 Integrity preparation), and the
 * web's Finish gate: `finishDisabled = busy || !sessionReadiness.canFinalize`.
 * Driven through the real capture screen with a staged document.
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let routes = {};
const TEMPLATE = (locationRequirement) => ({
  templates: [
    {
      templateId: "site", templateName: "Site survey", description: "Walk the site.", locationRequirement,
      steps: [
        { id: "overview", title: "Overview photo", required: true, acceptedKinds: ["PHOTO"] },
        { id: "report", title: "Written report", required: false, acceptedKinds: ["DOCUMENT"] },
      ],
    },
  ],
});

before(async () => {
  M = await loadModule("app/(stack)/capture.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  routes = {
    ...authenticatedRoutes(),
    "/v1/capture/intake-templates": () => TEMPLATE("required"),
    "/v1/capture/sessions": () => ({ session: { id: "draft-1", status: "DRAFT" }, item: { id: "it-1" } }),
    "/v1/evidence?scope=active": () => ({ items: [] }),
    "/v1/users/me": () => ({ user: { id: "u1" } }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key](path, init) : undefined;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status: res === undefined ? 500 : 200, headers: { "content-type": "application/json" } });
  };
  globalThis.__DOC_PICK__ = { canceled: false, assets: [{ uri: "file:///cache/claim.pdf", name: "claim.pdf", mimeType: "application/pdf", size: 2048 }] };
  await signIn(M);
});
afterEach(() => {
  delete globalThis.__DOC_PICK__;
});
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const stageDocument = async (before) => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  if (before) await before(r);
  // Web CaptureDropzone "Files" opens the picker directly.
  await r.press("Files");
  await settle();
  return r;
};
const finish = (r) => r.byLabel("Finish & Sign (1)").find((n) => n.props.onPress || n.props.accessibilityState);

test("a staged session shows status, metrics, metadata and integrity preparation", async () => {
  const r = await stageDocument();
  assert.equal(r.byTestId("capture-session-status").length, 1, "the session panel is missing");
  assert.ok(r.hasText("Ready with warnings"), "an unmapped item did not warn");
  assert.ok(r.byLabel("Mapped").length >= 1 || r.hasText("Mapped"));
  assert.ok(r.hasText("Blockers") && r.hasText("Warnings"));
  assert.ok(r.texts().some((t) => /^CAP-\d{4}-\d{2}-\d{2}$/.test(t)), "no session id");
  assert.ok(r.hasText("General") && r.hasText("Flexible") && r.hasText("2.0 KB"));
  assert.ok(r.hasText("Integrity preparation") && r.hasText("Queued") && r.hasText("Ready after sign") && r.hasText("After finalization"));
  assert.ok(r.hasText("Not included"));
});

test("a plan that REQUIRES location blocks Finish while location is off", async () => {
  const plain = await stageDocument();
  const before = finish(plain);
  assert.ok(before, "Finish control not found");
  assert.notEqual(before.props.disabled ?? before.props.accessibilityState?.disabled, true, "Finish was blocked with no blocker");
  plain.unmount?.();
  // Like the web (CaptureRequirements disabled={busy || hasSessionItems}), the plan is chosen BEFORE staging.
  const r = await stageDocument(async (x) => {
    await x.press("No plan selected");
    await x.press("Site survey");
    await settle();
  });
  assert.ok(r.hasText("Blocked"));
  assert.ok(r.texts().some((t) => t.startsWith("Location metadata is required by the selected plan.")));
  const after = finish(r);
  assert.equal(after.props.disabled ?? after.props.accessibilityState?.disabled, true, "Finish stayed enabled past a blocker");
});

/* ---- T-14 (capture/page.tsx:1022 unmapped, :1051 Bulk actions) ---- */

test("the session says how many items are unmapped and offers the web's bulk actions", async () => {
  const r = await stageDocument();
  assert.ok(r.hasText("1 unmapped"));
  assert.equal(r.byTestId("capture-bulk-actions").length, 1);
  const clear = r.byLabel("Clear all mappings").find((n) => n.props.onPress);
  assert.equal(clear.props.disabled ?? clear.props.accessibilityState?.disabled, true, "nothing is mapped, yet Clear was enabled");
  await r.press("Remove pending items");
  await settle();
  assert.equal(r.byTestId("capture-session-status").length, 0, "the pending item was not removed");
});

test("Session activity logs the staged material, collapsed until opened (CaptureActivityDisclosure)", async () => {
  const r = await stageDocument();
  assert.equal(r.byTestId("capture-activity").length, 1, "no Session activity disclosure");
  assert.ok(r.hasText("Session activity · 1 event"), "the staged material was not logged");
  assert.ok(!r.hasText("Materials staged"), "the log should start collapsed");
  await r.press("Session activity, 1 event. View activity");
  assert.ok(r.hasText("Materials staged") && r.hasText("1 item added to this session."));
  assert.ok(r.hasText("Hide activity"));
});
