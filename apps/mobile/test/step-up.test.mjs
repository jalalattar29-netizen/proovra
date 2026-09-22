/**
 * STEP-UP — a challenge is not a refusal.
 *
 * The API answers a step-up-guarded action with
 * 401 { error: { code, methods, message } } and expects the SAME request to be
 * retried with `stepUp` in the body. Getting this wrong in either direction is
 * a security-surface failure: read as a permission error, it tells a user they
 * may not manage their own account; read as an expired session, it signs them
 * out of what they were doing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, "../src/product/step-up.ts"), "utf8");
const js = ts.transpileModule(SRC, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const S = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const challenge = (methods, code = "STEP_UP_REQUIRED", message) => ({
  statusCode: 401,
  body: { error: { code, methods, ...(message ? { message } : {}) } },
});

test("a step-up challenge is recognised where the server actually puts it", () => {
  const c = S.extractStepUp(challenge(["password", "mfa"]));
  assert.deepEqual(c.methods, ["password", "mfa"]);
  assert.equal(c.message, "");
});

test("an ordinary error is not a challenge", () => {
  assert.equal(S.extractStepUp({ statusCode: 403, body: { error: { code: "owner_required" } } }), null);
  assert.equal(S.extractStepUp({ statusCode: 401 }), null);
  assert.equal(S.extractStepUp(null), null);
});

test("a rejected retry carries the server's own reason", () => {
  // "That code is wrong" and "that password is wrong" are different problems.
  const c = S.extractStepUp(challenge(["mfa"], "STEP_UP_INVALID", "That code did not match."));
  assert.equal(c.message, "That code did not match.");
});

test("methods the server did not send are not invented", () => {
  // An account with no password cannot be asked for one.
  assert.deepEqual(S.extractStepUp(challenge(["mfa"])).methods, ["mfa"]);
  assert.deepEqual(S.extractStepUp(challenge(["nonsense"])).methods, ["reauth"]);
  assert.deepEqual(S.extractStepUp(challenge(undefined)).methods, ["reauth"]);
});

test("a rate limit is told apart from a refusal", () => {
  assert.equal(S.isStepUpRateLimited({ statusCode: 429, body: { error: { code: "rate_limited" } } }), true);
  assert.equal(S.isStepUpRateLimited(challenge(["password"])), false);
});

test("the cheaper proof is asked for first, when the account has one", () => {
  assert.equal(S.stepUpMethodFor({ methods: ["password", "mfa"], message: "" }), "password");
  assert.equal(S.stepUpMethodFor({ methods: ["mfa"], message: "" }), "mfa");
  assert.equal(S.stepUpMethodFor({ methods: ["reauth"], message: "" }), "reauth");
});

test("reauth-only shows no field, because there is nothing to type", () => {
  assert.equal(S.stepUpFieldFor("reauth"), null);
  assert.equal(S.stepUpFieldFor("password").secure, true);
  assert.equal(S.stepUpFieldFor("mfa").keypad, true);
  assert.equal(S.stepUpFieldFor("mfa").secure, false);
});

test("the reauth note says what to do, not just that it failed", () => {
  assert.match(S.REAUTH_ONLY_NOTE, /Security/);
});

test("the proof is shaped exactly as the route schema accepts it", () => {
  assert.deepEqual(S.buildStepUpProof("password", " hunter2 "), {
    method: "password",
    currentPassword: "hunter2",
  });
  assert.deepEqual(S.buildStepUpProof("mfa", "123456"), { method: "mfa", code: "123456" });
  assert.equal(S.buildStepUpProof("password", "   "), null);
  assert.equal(S.buildStepUpProof("reauth", "x"), null);
});

test("the retry carries the original body, not just the proof", () => {
  // Re-sending only the proof would be a different request, and the route
  // would reject it for missing the fields it was called with.
  assert.deepEqual(S.withStepUp({ targetUserId: "u1" }, { method: "mfa", code: "1" }), {
    targetUserId: "u1",
    stepUp: { method: "mfa", code: "1" },
  });
  assert.deepEqual(S.withStepUp({ targetUserId: "u1" }, null), { targetUserId: "u1" });
});
