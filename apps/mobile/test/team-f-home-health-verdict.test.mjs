/**
 * Team remediation stage F — T-135 (audit PRD-04 / O-07): the Home health
 * verdict never says "Healthy" beside a CRITICAL attention item (web parity).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, "../src/product/home-operations.ts"), "utf8");
const js = ts.transpileModule(SRC.replace(/^import type .*$/m, ""), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const H = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const allOk = [{ tone: "ok" }, { tone: "neutral" }];

test("a critical attention item makes healthy metrics 'action_required'", () => {
  assert.equal(H.workspaceHealthOverall(allOk), "healthy");
  assert.equal(H.workspaceHealthOverall(allOk, { priorities: [{ severity: "critical" }] }), "action_required");
});

test("a warning attention item makes healthy metrics 'needs_attention'; info changes nothing", () => {
  assert.equal(H.workspaceHealthOverall(allOk, { priorities: [{ severity: "warning" }] }), "needs_attention");
  assert.equal(H.workspaceHealthOverall(allOk, { priorities: [{ severity: "info" }] }), "healthy");
});
