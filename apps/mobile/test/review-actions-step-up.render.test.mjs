/**
 * Stage B — T-165: the mobile review-actions panel posts the Evidence-page
 * decision door, which is step-up gated (workspace checkbox, session risk) and
 * age gated. On e4e908e88 the panel had no step-up handling: a 401
 * STEP_UP_REQUIRED was shown as a failure the phone could never satisfy, and a
 * 401 reauth_required read as a generic error.
 *
 * Now the shared challenge sheet opens in place, a verified code retries ONCE
 * with the challenge header, and the note sheet keeps its text through a
 * refusal; reauth_required says "sign in again" and records nothing.
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let M;
let requests = [];
let decisionAnswers = [];

const EVIDENCE = "ev-1";
const TEAM = "team-1";
const CHALLENGE = "c0000000-0000-4000-8000-000000000001";
const WORKFLOW = { teamId: TEAM, status: "IN_REVIEW", assignedToUserId: "user-1", notIncluded: [] };

before(async () => {
  M = await loadModule("src/ui/review-actions-panel.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});

beforeEach(() => {
  requests = [];
  decisionAnswers = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const headers = {};
    new Headers(init.headers || {}).forEach((v, k) => {
      headers[k] = v;
    });
    requests.push({ path, method: init.method ?? "GET", headers, body: init.body ? JSON.parse(init.body) : null });
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (path === `/v1/review-operations/evidence/${EVIDENCE}/decision`) {
      const next = decisionAnswers.shift() ?? { status: 200, body: { workflow: {} } };
      return json(next.status, next.body);
    }
    if (path === "/v1/identity-security/step-up/start") return json(200, { challenge: { id: CHALLENGE, status: "PENDING" }, method: "TOTP" });
    if (path === "/v1/identity-security/step-up/check") return json(200, { status: "approved" });
    return json(200, {});
  };
});
const mounted = [];
afterEach(() => {
  while (mounted.length) mounted.pop().unmount();
});
const settle = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};

async function rejectWithNote(r, note) {
  await r.press("Reject as insufficient");
  await settle();
  const input = r.root.findAll((n) => n.type === "TextInput" && typeof n.props.onChangeText === "function")[0];
  await act(async () => { input.props.onChangeText(note); });
  await r.press("Submit: Reject as insufficient");
  await settle();
}

const decisionCalls = () => requests.filter((q) => q.path === `/v1/review-operations/evidence/${EVIDENCE}/decision`);

async function render() {
  const r = await renderComponent(h(M.TestProviders, null, h(M.ReviewActionsPanel, { evidenceId: EVIDENCE, workflow: WORKFLOW, onChanged: () => {} })));
  mounted.push(r);
  await settle();
  return r;
}

test("a STEP_UP_REQUIRED decision opens the challenge sheet with its reason and retries once with the challenge header", async () => {
  decisionAnswers = [
    {
      status: 401,
      body: {
        error: {
          code: "STEP_UP_REQUIRED",
          message: "Step-up verification required.",
          details: { purpose: "REVIEWER_OPS_REJECT", resourceKind: "evidence_review_decision", resourceId: EVIDENCE, teamId: TEAM, reason: "policy_flag:requireStepUpForReject" },
        },
      },
    },
  ];
  const r = await render();
  await rejectWithNote(r, "Not enough detail");
  assert.ok(r.byTestId("challenge-step-up").length > 0, "the challenge sheet did not open");
  assert.ok(r.hasText("Your workspace asks for a second factor to reject"), "the reason was not shown");
  await r.type("Verification code", "123456");
  await r.press("Confirm + retry");
  await settle();
  const sent = decisionCalls();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].headers["x-proovra-step-up-challenge-id"], CHALLENGE);
  assert.deepEqual(sent[1].body.decision, "REJECT_INSUFFICIENT");
  assert.equal(sent[1].body.note, "Not enough detail");
});

test("reauth_required says sign in again, records nothing and keeps the note", async () => {
  decisionAnswers = [
    {
      status: 401,
      body: {
        error: {
          code: "reauth_required",
          message: "Sign in again to perform this action.",
          details: { reason: "session_age_window", windowHours: 8 },
        },
      },
    },
  ];
  const r = await render();
  await rejectWithNote(r, "Keep me");
  assert.equal(decisionCalls().length, 1);
  assert.ok(r.texts().some((t) => /sign in again/i.test(t) && /8 hours/.test(t)), "no re-sign-in sentence");
  assert.ok(!r.texts().some((t) => /expired/i.test(t)), "said the session expired");
  const input = r.root.findAll((n) => n.type === "TextInput" && typeof n.props.onChangeText === "function")[0];
  assert.equal(input.props.value, "Keep me");
});

test("no factor: the enrolment state offers Open Security settings and Not now", async () => {
  decisionAnswers = [
    {
      status: 401,
      body: { error: { code: "STEP_UP_REQUIRED", message: "x", details: { purpose: "REVIEWER_OPS_REJECT", reason: "elevated_session_risk" } } },
    },
  ];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/v1/identity-security/step-up/start")) {
      return new Response(JSON.stringify({ error: { code: "STEP_UP_ENROLLMENT_REQUIRED", message: "x" } }), { status: 403, headers: { "content-type": "application/json" } });
    }
    return realFetch(url, init);
  };
  const r = await render();
  await rejectWithNote(r, "x");
  assert.ok(r.byLabel("Open Security settings").length > 0);
  assert.ok(r.byLabel("Not now").length > 0);
  assert.ok(r.hasText("unusual sign-in activity"));
});
