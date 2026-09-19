/**
 * PERMANENT GUARD — canonical native domain display (Master Program §24, L1).
 *
 * Every canonical domain value must resolve to a { label, tone } whose tone is
 * one of the 6 ProovraStatusTone values (no invented tones), and unknown values
 * must fail SAFELY (humanized label, neutral tone) rather than leak a raw enum.
 * The TS module is transpiled and imported so we test behavior, not source text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../src/product/domain-display.ts"), "utf8")
  // strip the type-only import (no runtime value) so the data: URL import resolves.
  .replace(/^import type .*$/m, "");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const TONES = new Set(["verified", "pending", "risk", "neutral", "governance", "info"]);

const COVERAGE = [
  ["EVIDENCE_STATUSES", "evidenceStatusDisplay"],
  ["VERIFICATION_STATUSES", "verificationStatusDisplay"],
  ["EVIDENCE_LIFECYCLE_STATES", "evidenceLifecycleDisplay"],
  ["CASE_STATUSES", "caseStatusDisplay"],
];

test("every canonical value maps to a non-empty label and a legal tone", () => {
  for (const [valuesKey, fnKey] of COVERAGE) {
    const values = mod[valuesKey];
    const fn = mod[fnKey];
    assert.ok(Array.isArray(values) && values.length, `${valuesKey} must be a non-empty array`);
    for (const v of values) {
      const { label, tone } = fn(v);
      assert.ok(label && typeof label === "string", `${fnKey}(${v}) must yield a label`);
      assert.ok(TONES.has(tone), `${fnKey}(${v}) tone ${tone} must be a ProovraStatusTone`);
    }
  }
});

test("evidence types map to human labels", () => {
  assert.equal(mod.evidenceTypeLabel("PHOTO"), "Photo");
  assert.equal(mod.evidenceTypeLabel("DOCUMENT"), "Document");
});

test("unknown values fail safely (humanized, neutral) — never a raw enum badge", () => {
  const d = mod.evidenceStatusDisplay("SOME_NEW_BACKEND_STATE");
  assert.equal(d.label, "Some New Backend State");
  assert.equal(d.tone, "neutral");
  assert.equal(mod.evidenceTypeLabel(null), "File");
  assert.equal(mod.caseStatusDisplay(undefined).label, "Unknown");
});

test("integrity honesty — failure is risk, unverified is never 'verified'", () => {
  assert.equal(mod.verificationStatusDisplay("FAILED").tone, "risk");
  assert.equal(mod.evidenceStatusDisplay("FAILED_HASH_MISMATCH").tone, "risk");
  assert.notEqual(mod.verificationStatusDisplay("REVIEW_REQUIRED").tone, "verified");
  assert.notEqual(mod.verificationStatusDisplay("MATERIALS_AVAILABLE").tone, "verified");
});
