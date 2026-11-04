/**
 * PRO-115 / MOBILE-03 — reopening an intake link resumes the contributor's own
 * session instead of opening a new one.
 *
 * GET /v1/external-intake/:token resumes ONLY when the reopen presents its
 * session in `x-proovra-intake-session` (external-intake.routes.ts, UC-WEB-003),
 * answering { link, session, request, resumed: true, parts }. No mobile file
 * sent that header, so every remount, return from the background or second tap
 * on the link opened another session and dropped identity, consent and files.
 * The stub below answers exactly as the route does: a known handle resumes,
 * anything else opens a fresh session.
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
const TOKEN = "tok-resume-1";
let Landing;
let Capture;
let requests;
let sessions;
let nextId;
let expired;

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const link = { workflowTemplateName: "Claim evidence", intakeMode: "EXTERNAL_ANONYMOUS", isAnonymous: true, consentPolicyVersion: "2026-09", consentDisclosureText: "Uploads go to Acme." };
const sessionView = (s) => ({
  id: s.id, status: "OPEN", openedAtUtc: "2026-11-04T09:00:00.000Z", uploadStartedAtUtc: null, uploadCompletedAtUtc: null,
  submittedAtUtc: null, abandonedAtUtc: null, expiresAtUtc: "2026-11-05T09:00:00.000Z", consentAcceptedAtUtc: s.consentAt,
});

before(async () => {
  Landing = await loadModule("app/(stack)/intake/[token].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/intake/intake-resume.ts"]);
  Capture = await loadModule("app/(stack)/intake/capture.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/intake/intake-resume.ts"]);
});

beforeEach(() => {
  requests = [];
  sessions = new Map();
  nextId = 1;
  expired = false;
  Landing.releaseIntakeSession(TOKEN);
  Capture.releaseIntakeSession(TOKEN);
  globalThis.__EXPO_PARAMS__ = { token: TOKEN };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ path, method: init.method ?? "GET", resume: headers.get("x-proovra-intake-session"), auth: headers.get("authorization"), body });
    const base = `/v1/external-intake/${TOKEN}`;
    if (path === base && (init.method ?? "GET") === "GET") {
      if (expired) return json(410, { error: { code: "INTAKE_LINK_EXPIRED", message: "This link has expired." } });
      const handle = headers.get("x-proovra-intake-session");
      const held = handle ? sessions.get(handle) : null;
      if (held) {
        return json(200, { link, session: sessionView(held), request: null, resumed: true, parts: held.parts });
      }
      const s = { id: `s${nextId++}`, consentAt: null, parts: [] };
      sessions.set(s.id, s);
      return json(200, { link, session: sessionView(s), request: null, resumed: false, parts: [] });
    }
    const m = path.match(/sessions\/([^/]+)\/(identity|consent|parts|submit)$/);
    if (m) {
      const s = sessions.get(m[1]);
      if (m[2] === "consent") s.consentAt = "2026-11-04T09:01:00.000Z";
      if (m[2] === "parts") {
        s.parts.push({ id: `p${body.partIndex}`, partIndex: body.partIndex, originalFileName: body.originalFileName, mimeType: body.mimeType, checklistStepId: null, sizeBytes: 10, stored: true });
        return json(201, { part: { id: `p${body.partIndex}`, partIndex: body.partIndex }, upload: { putUrl: `https://storage.example/${body.partIndex}` } });
      }
      if (m[2] === "submit") return json(200, { session: { ...sessionView(s), status: "SUBMITTED" }, submissionId: "ev-1" });
      return json(200, { session: sessionView(s) });
    }
    return json(500, { error: { code: "UNSTUBBED" } });
  };
  globalThis.__UPLOAD_ASYNC__ = async () => ({ status: 200 });
});
const mounted = [];
afterEach(() => {
  while (mounted.length) mounted.pop().unmount();
  delete globalThis.__DOC_PICK__;
});
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const open = async (M = Landing) => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  mounted.push(r);
  await settle();
  return r;
};
const validates = () => requests.filter((q) => q.method === "GET" && q.path === `/v1/external-intake/${TOKEN}`);

test("PRO-115: a reopen presents the open session in the header, and the server resumes it", async () => {
  const first = await open();
  assert.equal(validates()[0].resume, null, "a first open has no session to present");
  await first.press("Continue");
  await settle();
  await first.press("I have read and accept the terms above.");
  await first.press("I understand — continue");
  await settle();
  first.unmount();
  mounted.length = 0;

  const again = await open();
  assert.equal(validates()[1].resume, "s1", "the reopen did not present its own session");
  assert.equal(sessions.size, 1, "the reopen opened a second contributor session");
  // Consent was recorded once: a resumed, consented session goes straight to its files.
  assert.equal(again.byLabel("I have read and accept the terms above.").length, 0, "consent was asked again");
  assert.ok(again.byLabel("Add files").length > 0, "the resumed session did not return to its files");
  assert.ok(validates().every((q) => q.auth === null), "the account session was attached to a public call");
});

test("PRO-115: files the server already holds are listed, and new ones are numbered after them", async () => {
  const s = { id: "s7", consentAt: "2026-11-04T09:01:00.000Z", parts: [{ id: "p0", partIndex: 0, originalFileName: "first.pdf", mimeType: "application/pdf", checklistStepId: null, sizeBytes: 10, stored: true }] };
  sessions.set("s7", s);
  Landing.holdIntakeSession(TOKEN, "s7", []);
  const r = await open();
  assert.equal(validates()[0].resume, "s7");
  assert.ok(r.hasText("Welcome back. 1 file is already part of this submission."));

  // The capture step reads the same held session (its own module graph here, so seeded the same way).
  Capture.holdIntakeSession(TOKEN, "s7", s.parts);
  globalThis.__EXPO_PARAMS__ = { token: TOKEN, sid: "s7" };
  globalThis.__DOC_PICK__ = { canceled: false, assets: [{ uri: "file:///cache/second.jpg", name: "second.jpg", mimeType: "image/jpeg", size: 10 }] };
  const c = await open(Capture);
  assert.ok(c.hasText("first.pdf"), "the held file was not shown");
  await c.press("Choose files");
  await settle();
  await c.press("Send");
  await settle();
  const declared = requests.filter((q) => q.method === "POST" && q.path.endsWith("/parts")).map((q) => q.body.partIndex);
  assert.deepEqual(declared, [1], "a new file reused the held file's part index, or the held file was re-sent");
  assert.ok(requests.some((q) => q.path.endsWith("/sessions/s7/submit")));
  assert.equal(Capture.heldIntakeSession(TOKEN), null, "a submitted session would be resumed again");
});

test("PRO-115 control: a refused link releases the handle, so the next open starts clean", async () => {
  Landing.holdIntakeSession(TOKEN, "s-old", []);
  expired = true;
  await open();
  assert.equal(validates()[0].resume, "s-old");
  assert.equal(Landing.heldIntakeSession(TOKEN), null);
  expired = false;
  await open();
  assert.equal(validates()[1].resume, null);
});

test("PRO-115 control: a handle the server does not know opens a fresh session, never someone else's", async () => {
  Landing.holdIntakeSession(TOKEN, "s-unknown", []);
  await open();
  assert.equal(validates()[0].resume, "s-unknown");
  assert.equal(Landing.heldIntakeSession(TOKEN), "s1", "the fresh session the server opened was not kept");
});
