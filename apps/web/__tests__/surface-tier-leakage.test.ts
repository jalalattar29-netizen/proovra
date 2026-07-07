/**
 * PHASE 1 — Surface-tier leakage guard.
 *
 * Constitutional rule being defended (PROOVRA Final Product Architecture
 * Constitution, Part 3 / Part 11):
 *
 *   FREE and PRO (self-serve) users must NEVER see Enterprise, Governance,
 *   Operations, Organization Administration, Identity, SSO/SCIM, Legal
 *   Hold, Retention, Audit, or internal platform surfaces — in the
 *   sidebar, Command Palette, All Tools, OR via direct URL.
 *
 * The single source of truth for that visibility is `lib/surface/tiers.ts`.
 * A surface leaks when its path falls through to the CORE default (see the
 * `Conservative defaults — an unmapped path is treated as CORE` note in
 * that file). This test pins that every "must never see" surface resolves
 * to ENTERPRISE or INTERNAL, and that the core self-serve surfaces stay
 * CORE.
 *
 * Runs under Node's built-in `node:test` (no third-party test runner),
 * matching the sibling web tests.
 *
 * NOTE ON PERSONA: this test deliberately does NOT reference persona.
 * Persona is presentation-only and must never be a visibility gate — the
 * enterprise-leakage guarantee lives entirely in the plan/tier model
 * enforced here.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { getSurfaceTier } from "../lib/surface/tiers";

// Surfaces that a self-serve (FREE/PRO) user must never reach. Each entry
// is a representative path for the surface; `getSurfaceTier` is prefix +
// path-segment aware, so `/governance` also covers `/governance/retention`.
const MUST_NOT_BE_CORE: ReadonlyArray<{ path: string; label: string }> = [
  { path: "/audit-transparency", label: "Audit / compliance transparency" },
  { path: "/governance", label: "Governance" },
  { path: "/governance/retention", label: "Retention" },
  { path: "/governance-platform", label: "Governance platform (org admin)" },
  { path: "/evidence-lifecycle", label: "Evidence lifecycle" },
  { path: "/evidence-lifecycle/legal-holds", label: "Legal hold" },
  { path: "/evidence-lifecycle/retention", label: "Retention (lifecycle)" },
  { path: "/organizations", label: "Organization administration" },
  { path: "/admin", label: "Admin surface" },
  { path: "/admin/identity", label: "Enterprise identity / SSO / SCIM" },
  { path: "/security-center", label: "Security center (workspace identity)" },
  { path: "/identity-security", label: "Identity security ops" },
  { path: "/executive", label: "Executive dashboard" },
  { path: "/review", label: "Review surfaces" },
  { path: "/reviewer-ops", label: "Reviewer ops" },
  { path: "/investigation", label: "Investigation power tools" },
  { path: "/ops", label: "Internal platform ops" },
  { path: "/operations", label: "Internal platform operations" },
  { path: "/platform", label: "Platform internal" },
  { path: "/tools", label: "All Tools (internal catalog)" },
];

// Surfaces that the simple self-serve product MUST keep for every plan.
const MUST_STAY_CORE: ReadonlyArray<string> = [
  "/home",
  "/capture",
  "/evidence",
  "/evidence/abc123",
  "/cases",
  "/reports",
  "/search",
  "/settings",
  "/settings/security",
  "/billing",
];

test("Phase 1 — enterprise/governance/ops/identity/audit surfaces are never CORE", () => {
  for (const { path, label } of MUST_NOT_BE_CORE) {
    const tier = getSurfaceTier(path);
    assert.ok(
      tier === "ENTERPRISE" || tier === "INTERNAL",
      `Leakage: ${label} (${path}) resolved to tier "${tier}"; expected ENTERPRISE or INTERNAL. ` +
        `A self-serve FREE/PRO user could reach it. Add an explicit rule to lib/surface/tiers.ts.`,
    );
  }
});

test("Phase 1 — audit-transparency is explicitly ENTERPRISE (regression pin)", () => {
  assert.equal(
    getSurfaceTier("/audit-transparency"),
    "ENTERPRISE",
    "audit-transparency must be ENTERPRISE — it was previously CORE-by-default and leaked to self-serve users.",
  );
});

test("Phase 1 — core self-serve surfaces remain CORE", () => {
  for (const path of MUST_STAY_CORE) {
    assert.equal(
      getSurfaceTier(path),
      "CORE",
      `Regression: core surface ${path} is no longer CORE — this would hide it from FREE/PRO users.`,
    );
  }
});
