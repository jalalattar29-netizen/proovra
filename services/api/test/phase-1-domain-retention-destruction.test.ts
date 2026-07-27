/**
 * PHASE 1 AUTHORIZATION CLOSURE (2026-07-21) — CRITICAL domain:
 * retention / destruction / legal-hold (governance-lifecycle.routes.ts +
 * destructive-action-gate.service.ts).
 *
 * Behavioral proof (via the reusable negative-conformance harness) that the
 * canonical primitive these routes now compose denies across the full
 * negative matrix for each governance permission the domain uses. Plus
 * source-contract assertions that the domain actually routes through the
 * primitive (no residual status-blind gate) and that the secondary
 * destructive gate is status-aware.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { assertNegativeAuthorizationConformance } from "./helpers/authorization-conformance.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const routesSrc = readFileSync(
  join(SRC, "routes", "governance-lifecycle.routes.ts"),
  "utf8",
);
const gateSrc = readFileSync(
  join(SRC, "services", "governance", "destructive-action-gate.service.ts"),
  "utf8",
);
const govSrc = readFileSync(join(SRC, "routes", "governance.routes.ts"), "utf8");
const govOpsSrc = readFileSync(
  join(SRC, "routes", "governance-operations.routes.ts"),
  "utf8",
);

// Every distinct permission the governance-lifecycle routes authorize with.
describe("retention/destruction — governance.policy.read is authorization-closed", () => {
  assertNegativeAuthorizationConformance("governance.policy.read");
});
describe("retention/destruction — governance.policy.manage is authorization-closed", () => {
  assertNegativeAuthorizationConformance("governance.policy.manage");
});
describe("retention/destruction — evidence.delete is authorization-closed", () => {
  assertNegativeAuthorizationConformance("evidence.delete");
});

describe("retention/destruction — source composes the canonical primitive", () => {
  it("routes through authorizeOrFail with anti-enumeration", () => {
    expect(routesSrc).toContain("authorizeOrFail");
    expect(routesSrc).toMatch(/antiEnumeration:\s*true/);
  });

  it("no longer uses the status-blind requirePermission/denyByPermission pair", () => {
    // Only doc-comment mentions may remain; no live call.
    expect(routesSrc).not.toMatch(/const perm = requirePermission\(/);
    expect(routesSrc).not.toMatch(/return denyByPermission\(/);
  });

  it("no longer reads teamMember directly for authorization", () => {
    expect(routesSrc).not.toMatch(/teamMember\.findUnique/);
  });

  it("preserves the fall-through contract (reply already sent on deny)", () => {
    expect(routesSrc).toContain("if (!ok) return");
  });
});

describe("legal-hold (governance.routes) — source composes the canonical primitive", () => {
  it("routes through authorizeOrFail with anti-enumeration", () => {
    expect(govSrc).toContain("authorizeOrFail");
    expect(govSrc).toMatch(/antiEnumeration:\s*true/);
  });
  it("legal-hold place/release is manage-gated; no status-blind pair", () => {
    expect(govSrc).toContain('"governance.legal_hold.manage"');
    expect(govSrc).not.toMatch(/const perm = requirePermission\(/);
    expect(govSrc).not.toMatch(/teamMember\.findUnique/);
  });
});

describe("governance-operations — source composes the canonical primitive", () => {
  it("routes through authorizeOrFail with anti-enumeration", () => {
    expect(govOpsSrc).toContain("authorizeOrFail");
    expect(govOpsSrc).toMatch(/antiEnumeration:\s*true/);
    expect(govOpsSrc).not.toMatch(/const perm = requirePermission\(/);
    expect(govOpsSrc).not.toMatch(/teamMember\.findUnique/);
  });
});

describe("destructive-action-gate — status-aware role (fail-closed)", () => {
  it("contributes a role only for an ACTIVE membership", () => {
    expect(gateSrc).toContain("teamMemberStatusGrantsAccess");
    expect(gateSrc).toMatch(/role:\s*activeRole/);
  });

  it("does not pass a raw membership.role into the sensitive-action decision", () => {
    expect(gateSrc).not.toMatch(/role:\s*membership\?\.role/);
  });
});
