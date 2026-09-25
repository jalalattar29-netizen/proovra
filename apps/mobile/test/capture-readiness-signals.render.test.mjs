/**
 * T-14 — CaptureReadinessSignals (:109 No blockers, :122 Blockers, :131
 * Warnings): both issue groups with label + detail, the rail's 4-item cap with
 * "+N more", and the all-clear row said in words.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React } from "./support/render.mjs";

const h = React.createElement;
let M;
before(async () => {
  M = await loadModule("src/ui/capture-session-status.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/product/capture-plan.ts"]);
});
const issue = (i, severity) => ({ code: `c${i}`, severity, label: `Issue ${i}`, detail: `Detail ${i}`, itemId: `it${i}` });
const render = (readiness) => renderComponent(h(M.TestProviders, null, h(M.CaptureReadinessSignals, { readiness })));

test("blockers and warnings are listed with their detail, capped at four with the remainder counted", async () => {
  const r = await render({ blockers: [issue(1, "blocker")], warnings: [1, 2, 3, 4, 5, 6].map((i) => issue(i + 10, "warning")) });
  assert.ok(r.hasText("Blockers 1"));
  assert.ok(r.hasText("Issue 1") && r.hasText("Detail 1"));
  assert.ok(r.hasText("Warnings 6"));
  assert.ok(r.hasText("Issue 14") && !r.hasText("Issue 15"), "the cap was not applied");
  assert.ok(r.hasText("+2 more warnings"));
  assert.equal(r.byTestId("capture-signals-clear").length, 0);
});

test("with nothing to report, one all-clear row in words", async () => {
  const r = await render({ blockers: [], warnings: [] });
  assert.ok(r.hasText("✓ No blockers") && r.hasText("✓ No warnings"));
  assert.equal(r.byTestId("capture-signals-blockers").length, 0);
});
