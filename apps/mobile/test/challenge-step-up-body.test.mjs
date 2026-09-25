/**
 * Latent contract defect (sweep 2): POST /v1/identity-security/challenges/start
 * declares resourceKind / resourceId `.optional()`, not `.nullable()`. A
 * step-up raised without a resource produced `null`s, which that schema
 * refuses with a 400. Absent means omitted.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./support/render.mjs";

let P;
before(async () => {
  P = await loadModule("src/product/challenge-step-up.ts", []);
});

test("an absent resource is omitted, never sent as null", () => {
  const body = P.buildStartBody("team-1", { purpose: "SENSITIVE_ACTION", resourceKind: null, resourceId: null });
  assert.deepEqual(body, { teamId: "team-1", purpose: "SENSITIVE_ACTION" });
  assert.deepEqual(P.buildStartBody("team-1", { purpose: "X", resourceKind: "EVIDENCE", resourceId: "e1" }, "EMAIL"), {
    teamId: "team-1", purpose: "X", resourceKind: "EVIDENCE", resourceId: "e1", channel: "EMAIL",
  });
});
