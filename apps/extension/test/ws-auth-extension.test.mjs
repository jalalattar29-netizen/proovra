/**
 * WS-AUTH (RG-10) — extension client refusals, notices and snapshot coverage.
 *
 *   PRO-X1-02  401 REAUTHENTICATION_REQUIRED is the organization's sign-in
 *              policy, not an ended sign-in: token kept, specific copy, no Retry.
 *   PRO-X1-06  a 428 terms gate on the case list is its own state.
 *   PRO-X1-07  the "update required" verdict is tied to the build that earned it.
 *   PRO-X1-08  the canonical nested authorization refusal is read and named.
 *   PRO-PWXZ-01 commercial lifecycle / withheld contract are not "try again".
 *   PRO-X1-10  signed URLs in CSS, active data: URLs and server-rendered field
 *              values are not kept in the snapshot.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError, denialOf } from "./dist/api-client.js";
import { runPreserveFlow } from "./dist/preserve-flow.js";
import { denialToMessage } from "./dist/denial-copy.js";
import { followUpLink, retryOffered, VIEW_PLANS_LABEL } from "./dist/popup-links.js";
import { classifyCasesResponse } from "./dist/popup-context.js";
import { headersSayCurrent, parseStoredClientUpdate, storedClientUpdate } from "./dist/client-contract.js";
import { isActiveUrlValue, redactCssUrls, shouldClearFieldValue } from "./dist/sanitizer.js";
import { statusLine, SESSION_ENDED, CAPTURE_FAILED } from "./dist/status-copy.js";

const failed = (over) => ({
  attemptId: "a",
  tabId: 1,
  mode: "VIEWPORT",
  teamId: "t",
  caseId: null,
  state: "FAILED",
  step: null,
  detail: null,
  outcome: "NOTHING_SAVED",
  reason: "DENIED",
  denial: null,
  evidenceId: null,
  cancelRequested: false,
  startedAtMs: 0,
  updatedAtMs: 0,
  ...over,
});

const HEX = "a".repeat(64);
const REQ = { mode: "VIEWPORT", teamId: "t1", caseId: null, tabId: 1, windowId: 1, evidenceType: "PHOTO" };
function harness(openError) {
  let cleared = false;
  const deps = {
    api: {
      openWebSession: async () => {
        throw openError;
      },
      discardSession: async () => ({ result: { discarded: true } }),
    },
    getToken: async () => "tok",
    clearToken: async () => {
      cleared = true;
    },
    prepare: async () => undefined,
    capture: async () => ({
      artifacts: [{ role: "viewport_screenshot", blob: new Blob(["png"], { type: "image/png" }), mediaType: "image/png", sha256: HEX }],
      pageInfo: { url: "https://example.com/", title: "Example", viewportW: 1280, viewportH: 800, devicePixelRatio: 1 },
      pageMutatedDuringCapture: false,
      limitations: [],
      domSnapshotMissing: true,
      notes: [],
    }),
    sha256Hex: async () => HEX,
    progress: () => undefined,
    browser: { name: "Chrome", versionBucket: "153", os: "Windows" },
    extensionVersion: "test",
    attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    tabUrl: "https://example.com/",
    sleep: async () => undefined,
  };
  return { deps, wasCleared: () => cleared };
}

test("PRO-X1-02: a 401 REAUTHENTICATION_REQUIRED keeps the token and is a named, non-retryable refusal", async () => {
  const h = harness(new ApiError(401, "REAUTHENTICATION_REQUIRED", "POST /v1/capture/direct-sessions -> 401"));
  const r = await runPreserveFlow(h.deps, REQ, new AbortController().signal);
  assert.equal(r.status, "FAILED");
  assert.equal(r.reason, "DENIED");
  assert.equal(h.wasCleared(), false, "a still-valid token was wiped");
  const s = failed({ denial: "REAUTHENTICATION_REQUIRED" });
  assert.match(denialToMessage("REAUTHENTICATION_REQUIRED"), /requires its own sign-in method/);
  assert.notEqual(statusLine(s).text, SESSION_ENDED);
  assert.equal(retryOffered(s, true), false);
  // Control: a genuinely dead token (401 without the denial) still ends the sign-in.
  const dead = harness(new ApiError(401, null, "POST -> 401"));
  const d = await runPreserveFlow(dead.deps, REQ, new AbortController().signal);
  assert.equal(d.reason, "SIGNED_OUT");
  assert.equal(dead.wasCleared(), true);
});

test("PRO-X1-08: the canonical nested refusal is lifted and named; only the 503 stays retryable", () => {
  assert.equal(denialOf({ error: { code: "not_found" } }), "not_found");
  assert.equal(denialOf({ error: { code: "permission_denied", reason: "member_access_expired" } }), "permission_denied");
  assert.equal(denialOf({ error: { code: "something_else" } }), null);
  for (const code of ["not_found", "permission_denied"]) {
    const s = failed({ denial: code });
    assert.notEqual(statusLine(s).text, CAPTURE_FAILED);
    assert.equal(retryOffered(s, true), false);
  }
  assert.equal(retryOffered(failed({ denial: "authorization_unavailable" }), true), true);
});

test("PRO-PWXZ-01: a restricted commercial lifecycle links to billing, a withheld contract is not retried", () => {
  const lifecycle = failed({ denial: "COMMERCIAL_LIFECYCLE_RESTRICTED" });
  assert.notEqual(statusLine(lifecycle).text, CAPTURE_FAILED);
  assert.equal(retryOffered(lifecycle, true), false);
  assert.equal(followUpLink(lifecycle, "https://www.example.test")?.label, VIEW_PLANS_LABEL);
  const contract = failed({ denial: "ENTERPRISE_CONTRACT_REQUIRED" });
  assert.notEqual(statusLine(contract).text, CAPTURE_FAILED);
  assert.equal(retryOffered(contract, true), false);
});

test("PRO-X1-06: a 428 terms refusal on the case list is the terms state, not 'cases could not be loaded'", () => {
  assert.deepEqual(
    classifyCasesResponse(428, { error: { code: "LEGAL_REACCEPT_REQUIRED" } }, "t"),
    { kind: "terms_required" },
  );
  assert.equal(classifyCasesResponse(500, null, "t").kind, "error");
});

test("PRO-X1-07: a stored verdict from another build (or a bare string) is ignored; a current answer is recognised", () => {
  assert.equal(parseStoredClientUpdate("UPDATE_REQUIRED", "1.2.0"), null);
  const stored = storedClientUpdate("UPDATE_REQUIRED", "1.2.0");
  assert.equal(parseStoredClientUpdate(stored, "1.2.0"), "UPDATE_REQUIRED");
  assert.equal(parseStoredClientUpdate(stored, "1.3.0"), null);
  const headers = (h) => ({ get: (k) => h[k] ?? null });
  assert.equal(headersSayCurrent(headers({ "x-proovra-contract": String(stored.own) })), true);
  assert.equal(headersSayCurrent(headers({})), false);
});

test("PRO-X1-10: CSS signed URLs and active data: URLs are redacted; server-rendered field values are cleared", () => {
  const css = redactCssUrls("background:url('https://bucket.example/x.png?X-Amz-Signature=abc&ok=1')");
  assert.equal(css.redacted, 1);
  assert.ok(!css.value.includes("abc"));
  assert.ok(css.value.includes("ok=1"));
  assert.equal(redactCssUrls("color:red").redacted, 0);
  assert.equal(isActiveUrlValue("data:text/html;base64,PHNjcmlwdD4="), true);
  assert.equal(isActiveUrlValue(" data:image/svg+xml,<svg onload=x>"), true);
  assert.equal(isActiveUrlValue("data:image/png;base64,AAAA"), false);
  assert.equal(shouldClearFieldValue({ tag: "input", type: "text", name: "iban", value: "DE89 3704" }), true);
  assert.equal(shouldClearFieldValue({ tag: "input", type: "email", name: "email", value: "a@b.c" }), true);
  assert.equal(shouldClearFieldValue({ tag: "input", type: "submit", value: "Send" }), false);
  assert.equal(shouldClearFieldValue({ tag: "input", type: "text", name: "q", value: "" }), false);
  assert.equal(shouldClearFieldValue({ tag: "textarea", name: "notes", value: "private" }), true);
});
