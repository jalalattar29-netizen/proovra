/**
 * GUARD — public verification id extraction (Native Convergence §20, N5).
 * Verify is public/read-only and does NOT pass through the tenant resolve gate;
 * a pasted link or id resolves to the id the /public/verify screen loads. Pure fn.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
// Extract just the pure function (the module's other exports import nothing at
// runtime, but keep the test hermetic by slicing the function out).
const full = readFileSync(resolve(HERE, "../src/deep-link.ts"), "utf8");
const fn = full.match(/export function extractVerificationId[\s\S]*?\n}/)[0];
const js = ts.transpileModule(fn, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { extractVerificationId } = await import(`data:text/javascript,${encodeURIComponent(js)}`);

test("web verify URL — path segment after /verify", () => {
  assert.equal(extractVerificationId("https://proovra.com/verify/ev-abc123"), "ev-abc123");
  assert.equal(extractVerificationId("https://www.proovra.com/verify/ev-abc123/"), "ev-abc123");
});

test("query id wins", () => {
  assert.equal(extractVerificationId("https://proovra.com/verify?id=ev-9"), "ev-9");
  assert.equal(extractVerificationId("proovra://verify?id=ev-9"), "ev-9");
});

test("bare id passes through; junk / empty / non-verify URL → null", () => {
  assert.equal(extractVerificationId("ev-plain-123"), "ev-plain-123");
  assert.equal(extractVerificationId("  "), null);
  assert.equal(extractVerificationId("has space"), null);
  assert.equal(extractVerificationId("https://proovra.com/something/else"), null);
});
