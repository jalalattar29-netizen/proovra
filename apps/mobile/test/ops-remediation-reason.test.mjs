/**
 * ET-REC-04 — mobile Operations collects the reason an action requires.
 *
 * The parser dropped `requiresReason` and the remediate call sent no reason,
 * so "Retry after exhausted failure" always answered 400
 * remediation_reason_required. The parser keeps the flag, the POST body
 * carries the reason, and the screen asks for it before sending.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadModule } from "./support/render.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const C = await loadModule("src/product/ops-console.ts");

const detailWith = (action) => ({
  incident: {
    id: "i1",
    status: "OPEN",
    severity: "HIGH",
    category: "REPORTING",
    title: "Report failed",
    fingerprint: "REPORT:x:TERMINAL",
    firstSeenAtUtc: "2026-09-29T00:00:00.000Z",
    lastSeenAtUtc: "2026-09-29T00:00:00.000Z",
    occurrenceCount: 1,
    timeline: [],
  },
  remediation: { disposition: "DIRECT_REMEDIATION", actions: [action], deepLink: null, guidance: null, unsafeReason: null },
});

test("the parser keeps requiresReason", () => {
  const d = C.parseIncidentDetail(
    detailWith({ actionId: "report.supersede_failed_generation", label: "Retry after exhausted failure", description: "d", confirm: true, async: true, requiresReason: true }),
  );
  assert.ok(d, "detail parses");
  assert.equal(d.remediation.actions[0].requiresReason, true);
});

test("the body carries the reason exactly when one was given", () => {
  assert.deepEqual(JSON.parse(C.buildRemediateBody({ teamId: "t", actionId: "a", reason: "  customer asked  " })), {
    teamId: "t",
    actionId: "a",
    reason: "customer asked",
  });
  assert.deepEqual(JSON.parse(C.buildRemediateBody({ teamId: "t", actionId: "a", reason: "   " })), { teamId: "t", actionId: "a" });
  assert.equal(JSON.parse(C.buildRemediateBody({ teamId: "t", actionId: "a", reason: "x".repeat(900) })).reason.length, 500);
});

test("an action that requires a reason is not ready without one", () => {
  const a = { actionId: "a", label: "l", description: "", confirm: false, async: true, requiresReason: true };
  assert.equal(C.remediationReasonReady(a, ""), false);
  assert.equal(C.remediationReasonReady(a, "because"), true);
  assert.equal(C.remediationReasonReady({ ...a, requiresReason: false }, ""), true);
});

test("the screen asks for the reason and sends it through the one body builder", () => {
  const screen = readFileSync(resolve(HERE, "../app/(stack)/operations/index.tsx"), "utf8");
  assert.match(screen, /buildRemediateBody\(\{ teamId, actionId: a\.actionId, reason: a\.requiresReason \? reasonText : null \}\)/);
  assert.match(screen, /if \(!remediationReasonReady\(a, reasonFor === a\.actionId \? reasonText : ""\)\)/);
  assert.match(screen, /testID="ops-remediation-reason"/);
  assert.doesNotMatch(screen, /body: JSON\.stringify\(\{ teamId, actionId: a\.actionId \}\)/);
});
