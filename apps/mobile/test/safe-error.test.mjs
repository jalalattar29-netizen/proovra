/**
 * Phase 3 — canonical safe-error layer (pure). Covers every backend envelope
 * variant + the classification/redaction contract. Transpile-and-import.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../src/errors/safe-error.ts"), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { toSafeUserError, isAuthError, isLegalGate } = await import(
  `data:text/javascript,${encodeURIComponent(js)}`
);

test("401 → auth (session ended), no raw backend string leaked", () => {
  const e = toSafeUserError({ status: 401, error: { code: "UNAUTHENTICATED", message: "jwt expired at ...", requestId: "req_1" } });
  assert.equal(e.kind, "auth");
  assert.equal(e.requestId, "req_1");
  assert.ok(!/jwt expired/.test(e.message), "must not surface the raw server string");
  assert.ok(isAuthError({ statusCode: 401 }));
});

test("428 / LEGAL_REACCEPT_REQUIRED → legal with missingPolicies", () => {
  const e = toSafeUserError({
    status: 428,
    code: "LEGAL_REACCEPT_REQUIRED",
    details: { missingPolicies: ["terms", "privacy"] },
  });
  assert.equal(e.kind, "legal");
  assert.deepEqual(e.missingPolicies, ["terms", "privacy"]);
  assert.ok(isLegalGate({ error: { code: "LEGAL_REACCEPT_REQUIRED" } }));
});

test("Fastify-flat envelope {error,message,statusCode} is understood", () => {
  const e = toSafeUserError({ error: "Forbidden", message: "no access to team", statusCode: 403 });
  assert.equal(e.kind, "forbidden");
  // 403 message is safe/useful → surfaced
  assert.equal(e.status, 403);
});

test("400 INVALID_INPUT surfaces the backend message (it is user-facing)", () => {
  const e = toSafeUserError({ status: 400, error: { code: "INVALID_INPUT", message: "email is required" } });
  assert.equal(e.kind, "input");
  assert.equal(e.message, "email is required");
});

test("transport failure (TypeError) → network, not invalid credentials", () => {
  const e = toSafeUserError(new TypeError("Network request failed"));
  assert.equal(e.kind, "network");
});

test("5xx → server, generic safe copy only", () => {
  const e = toSafeUserError({ status: 500, error: { message: "stacktrace: at db.query", requestId: "r9" } });
  assert.equal(e.kind, "server");
  assert.ok(!/stacktrace/.test(e.message));
  assert.equal(e.requestId, "r9");
});

test("bare unknown object with no status/code ≈ network (offline), never a crash", () => {
  const e = toSafeUserError({});
  assert.equal(e.kind, "network");
  assert.equal(typeof e.message, "string");
});
