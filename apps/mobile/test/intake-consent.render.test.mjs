/**
 * DEFECT — native public intake could never pass consent. POST …/consent parses
 * { consent: WorkflowIntakeConsentSnapshotSchema } (acceptedAtUtc, policyVersion,
 * disclosureTextHash = SHA-256 hex of the disclosure SHOWN, termsAcknowledged,
 * identityDisclosed, ipHash, userAgent); native sent { consent: { accepted } }.
 * T-14 alongside: the web's disclosure text and the two acknowledgements.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let M;
let posts = [];
let link;
before(async () => {
  M = await loadModule("app/(stack)/intake/[token].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(() => {
  posts = [];
  link = { workflowTemplateName: "Claim evidence", intakeMode: "EXTERNAL_IDENTIFIED", isAnonymous: false, consentPolicyVersion: "2026-09", consentDisclosureText: "Uploads go to Acme Legal for the claim review." };
  globalThis.__EXPO_PARAMS__ = { token: "tok-1" };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (init.method === "POST") posts.push({ path, body: JSON.parse(init.body) });
    const body = path === "/v1/external-intake/tok-1" ? { link, session: { id: "s1", status: "OPEN" } } : { session: { id: "s1" } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
});
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const toConsent = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  await r.type("Your name", "Sam");
  await r.press("Continue");
  await settle();
  return r;
};
const continueNode = (r) => r.byLabel("I understand — continue").find((n) => n.props.onPress);

test("consent is recorded in the server's snapshot shape, hashing the disclosure shown", async () => {
  const r = await toConsent();
  assert.ok(r.hasText("Uploads go to Acme Legal for the claim review."), "the link's own disclosure was not shown");
  const btn = continueNode(r);
  assert.equal(btn.props.disabled ?? btn.props.accessibilityState?.disabled, true, "consent possible without acknowledging the terms");
  await r.press("I have read and accept the terms above.");
  await r.press("My submission may be associated with my email address.");
  await act(async () => { await continueNode(r).props.onPress(); });
  await settle();
  const c = posts.find((p) => p.path === "/v1/external-intake/tok-1/sessions/s1/consent").body.consent;
  assert.deepEqual(Object.keys(c).sort(), ["acceptedAtUtc", "disclosureTextHash", "identityDisclosed", "ipHash", "policyVersion", "termsAcknowledged", "userAgent"]);
  assert.equal(c.policyVersion, "2026-09");
  assert.equal(c.disclosureTextHash, createHash("sha256").update("Uploads go to Acme Legal for the claim review.").digest("hex"));
  assert.match(c.disclosureTextHash, /^[a-f0-9]{64}$/);
  assert.equal(c.termsAcknowledged, true);
  assert.equal(c.identityDisclosed, true);
  assert.equal(c.ipHash, null);
  assert.ok(!Number.isNaN(Date.parse(c.acceptedAtUtc)));
});

test("an anonymous link offers no identity acknowledgement and records it false; the default disclosure is used when none is set", async () => {
  link = { ...link, isAnonymous: true, intakeMode: "EXTERNAL_ANONYMOUS", consentDisclosureText: null, consentPolicyVersion: null };
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  await r.press("Continue");
  await settle();
  assert.equal(r.byLabel("My submission may be associated with my email address.").length, 0);
  await r.press("I have read and accept the terms above.");
  await act(async () => { await continueNode(r).props.onPress(); });
  await settle();
  const c = posts.find((p) => p.path.endsWith("/consent")).body.consent;
  assert.equal(c.policyVersion, "default");
  assert.equal(c.identityDisclosed, false);
  assert.equal(
    c.disclosureTextHash,
    createHash("sha256").update("Files you upload through this secure link will be added to the workspace that issued the link. By accepting you confirm the upload is yours to share, and you agree to the workspace's evidence handling terms.").digest("hex"),
  );
});

test("the part upload URL is read from upload.putUrl", async () => {
  const P = await loadModule("src/product/external-intake.ts", []);
  const u = P.parseIntakePartUpload({ part: { id: "p1" }, upload: { bucket: "b", key: "k", putUrl: "https://s3.example/put?sig=1", expiresInSeconds: 600 } });
  assert.equal(u.uploadUrl, "https://s3.example/put?sig=1");
  assert.equal(u.partId, "p1");
  assert.equal(P.parseIntakePartUpload({ uploadUrl: "https://fiction" }).uploadUrl, null, "a key the server never sends was still read");
});

test("Add files hands the capture step the LINK's location policy — the server's submit gate — not the template's label", async () => {
  link = { ...link, locationPolicy: "REQUIRED", workflowTemplateLocationRequirement: "NONE" };
  const r = await toConsent();
  await r.press("I have read and accept the terms above.");
  await r.press("My submission may be associated with my email address.");
  await act(async () => { await continueNode(r).props.onPress(); });
  await settle();
  await r.press("Add files");
  assert.match(M.calls.push.at(-1), /^\/intake\/capture\?token=tok-1&sid=s1&loc=REQUIRED$/);
});

test("Add files hands the capture step the link's checklist (ids, purpose labels, required) and plan mode", async () => {
  // ExternalIntakeLinkPublicView.steps (workflow-intake-session.service.ts:154-161) + workflowTemplatePlanMode.
  link = {
    ...link,
    workflowTemplatePlanMode: "CHECKLIST_REQUIRED",
    steps: [
      { id: "step-overview", title: "Overview of the damage", description: "", purposeLabel: "Overview photo", required: true, acceptedKinds: ["PHOTO"] },
      { id: "step-receipt", title: "Repair receipt", description: "", purposeLabel: "Receipt", required: false, acceptedKinds: [] },
    ],
  };
  const r = await toConsent();
  await r.press("I have read and accept the terms above.");
  await act(async () => { await continueNode(r).props.onPress(); });
  await settle();
  await r.press("Add files");
  const href = M.calls.push.at(-1);
  const q = new URLSearchParams(href.split("?")[1]);
  assert.equal(href.split("?")[0], "/intake/capture");
  assert.equal(q.get("token"), "tok-1");
  assert.equal(q.get("sid"), "s1");
  assert.equal(q.get("plan"), "CHECKLIST_REQUIRED");
  assert.deepEqual(JSON.parse(q.get("steps")), [
    { id: "step-overview", purposeLabel: "Overview photo", required: true },
    { id: "step-receipt", purposeLabel: "Receipt", required: false },
  ]);
});
