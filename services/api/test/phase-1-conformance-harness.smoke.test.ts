/**
 * PHASE 1 — smoke test for the reusable negative-conformance harness.
 *
 * Proves the harness registers and passes its negative matrix against a
 * privileged permission (governance.retention.manage) and a baseline read
 * permission (evidence.read, where the role floor legitimately grants
 * access so the capability-blind case is correctly skipped).
 */

import { describe } from "vitest";

import { assertNegativeAuthorizationConformance } from "./helpers/authorization-conformance.js";

describe("harness — privileged permission (governance.retention.manage)", () => {
  assertNegativeAuthorizationConformance("governance.retention.manage");
});

describe("harness — baseline read permission (evidence.read)", () => {
  assertNegativeAuthorizationConformance("evidence.read");
});
