/**
 * Phase 3 — responsive breakpoint logic (pure). Transpile-and-import the TS.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../src/theme/breakpoints.ts"), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { resolveBreakpoint, isTabletWidth, navModeFor, CONTENT_MAX_WIDTH, FORM_MAX_WIDTH } = await import(
  `data:text/javascript,${encodeURIComponent(js)}`
);

test("width maps to the content-driven class", () => {
  assert.equal(resolveBreakpoint(375), "compact");
  assert.equal(resolveBreakpoint(599), "compact");
  assert.equal(resolveBreakpoint(600), "medium");
  assert.equal(resolveBreakpoint(768), "medium");
  assert.equal(resolveBreakpoint(839), "medium");
  assert.equal(resolveBreakpoint(840), "expanded");
  assert.equal(resolveBreakpoint(1366), "expanded");
});

test("tablet detection + nav mode follow the breakpoint, not a device name", () => {
  assert.equal(isTabletWidth(390), false);
  assert.equal(isTabletWidth(834), true);
  assert.equal(navModeFor(390), "bottom");
  assert.equal(navModeFor(1024), "rail");
});

test("content clamp is a readable column, not the full tablet width", () => {
  assert.equal(CONTENT_MAX_WIDTH, 720);
});

test("form clamp is a tighter single-column measure than content", () => {
  assert.equal(FORM_MAX_WIDTH, 480);
  assert.ok(FORM_MAX_WIDTH < CONTENT_MAX_WIDTH, "forms read narrower than content");
});
