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

/*
 * THE SHARED DICTIONARY, INLINED — because a data URL cannot resolve a bare
 * specifier.
 *
 * This module imports `@proovra/shared` — the ROOT, because Metro does not
 * transpile-and-import idiom these pure tests use loads the result as a data
 * URL, from which "@proovra/..." is not resolvable at all. Inlining the REAL
 * built module as a nested data URL keeps one authority: the codes asserted
 * below are the ones the product ships, not a fixture written to match.
 */
const dictionarySrc = readFileSync(
  resolve(HERE, "../../../packages/shared/dist/user-facing-errors.js"),
  "utf8",
);
const dictionaryUrl = `data:text/javascript,${encodeURIComponent(dictionarySrc)}`;

const src = readFileSync(resolve(HERE, "../src/errors/safe-error.ts"), "utf8").replace(
  '"@proovra/shared"',
  JSON.stringify(dictionaryUrl),
);
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

test("400 INVALID_INPUT answers with the product's sentence, and the FIELDS", () => {
  // CHANGED DELIBERATELY. This used to render the server's own summary, and
  // that summary is not written for a person: `server.ts` composes it as
  // "Invalid input: <root> — Too big: expected number to be <=100". The
  // product's sentence is the summary now, and `fields[]` — which the same
  // handler bounds to five entries of path + message — is what a form renders
  // beside the input that is actually wrong.
  const e = toSafeUserError({
    status: 400,
    error: {
      code: "INVALID_INPUT",
      message: "Invalid input: email — Required",
      fields: [{ path: "email", code: "invalid_type", message: "Required" }],
    },
  });
  assert.equal(e.kind, "input");
  assert.equal(e.explained, true, "INVALID_INPUT is in the shared dictionary");
  assert.ok(!/<root>|expected number/.test(e.message), "no zod shape reaches a person");
  assert.deepEqual(e.fields, [{ path: "email", message: "Required" }]);
});

test("a code the dictionary knows is answered by the PRODUCT, not by its status", () => {
  // THE DEFECT THIS CLOSES. Native classified by status alone, so every 409
  // — evidence locked, already finalized, a session already reserved — read
  // "Something went wrong. Please try again." about something retrying can
  // never fix, and every 403 read as a permission problem even when it was a
  // plan limit.
  const locked = toSafeUserError({ status: 409, error: { code: "EVIDENCE_LOCKED" } });
  assert.equal(locked.explained, true);
  assert.ok(!/Please try again/i.test(locked.message), locked.message);

  const plan = toSafeUserError({ status: 403, error: { code: "STORAGE_LIMIT_REACHED" } });
  assert.equal(plan.explained, true);
  assert.notEqual(plan.message, "You don't have access to this.");
});

test("an UNMAPPED code still gets safe copy, never a raw server string", () => {
  const e = toSafeUserError({
    status: 409,
    error: { code: "SOME_NEW_CODE_NOBODY_MAPPED", message: "constraint violation on evidence_pkey" },
  });
  assert.equal(e.explained, false);
  assert.ok(!/constraint violation/.test(e.message));
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

test("an unmapped refusal (409/422) is the web 4xx bucket, not 'Please try again'", () => {
  for (const status of [409, 422]) {
    const s = toSafeUserError({ status, error: { code: "SOMETHING_UNMAPPED", message: "internal detail" } });
    assert.equal(s.title, "We couldn’t complete that action");
    assert.equal(s.message, "Please review your input and try again.");
  }
  // 5xx keeps its own bucket.
  assert.equal(toSafeUserError({ status: 503 }).message, "We hit a problem on our side. Please try again.");
});

test("a bare 429 is the rate-limit answer (web fromStatus(429)), never the 4xx review sentence", () => {
  const e = toSafeUserError({ status: 429 });
  assert.equal(e.message, "Please wait a moment and try again.");
});
