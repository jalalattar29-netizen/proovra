/**
 * PHASE 1 — Persona-visibility core-safety guard.
 *
 * The persona-visibility overlay is wired into the sidebar
 * (`AppSidebarV2.tsx` → `resolveNavigationGroups({ persona })`). That
 * resolver drops any item whose pillar is NOT in
 * `visiblePillarsForPersona(persona)`.
 *
 * CONSTITUTIONAL INVARIANT (Final Product Architecture Constitution,
 * Part 2 / Part 11): the CORE self-serve product must be visible to EVERY
 * persona. Persona is presentation-only and must NEVER hide a core
 * surface. This test pins that every core route's pillar is present in the
 * visible-pillar set of all seven personas — so wiring the overlay can
 * never make Home / Capture / Evidence / Cases / Reports / Search /
 * Settings / Billing disappear from the sidebar for anyone.
 *
 * If this test fails, the persona overlay (or a route→pillar mapping)
 * changed in a way that would hide a core product surface for some
 * persona. Fix the overlay / UNIVERSAL_PILLARS, not this test.
 *
 * Runs under Node's built-in `node:test`, matching the sibling web tests.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  pillarForRoute,
  visiblePillarsForPersona,
} from "../lib/navigation/pillarRegistry";
import { WORKSPACE_PERSONA_PROFILES } from "../lib/platform-context/types";

// The CORE self-serve surfaces (route ids) that must be visible to every
// persona regardless of use-case. These mirror the CORE tier in
// lib/surface/tiers.ts.
const CORE_ROUTE_IDS: ReadonlyArray<string> = [
  "workspace.home",
  "workspace.capture",
  "workspace.evidence",
  "workspace.cases",
  "workspace.reports",
  "workspace.search",
  "account.settings",
  "account.billing",
  "account.inbox",
  "workspace.notifications",
  "account.persona",
];

test("Phase 1 — every core route's pillar is visible to all 7 personas", () => {
  for (const persona of WORKSPACE_PERSONA_PROFILES) {
    const visible = visiblePillarsForPersona(persona);
    for (const routeId of CORE_ROUTE_IDS) {
      const pillar = pillarForRoute(routeId);
      assert.ok(
        visible.has(pillar),
        `Core-surface regression: route "${routeId}" (pillar "${pillar}") is NOT ` +
          `visible to persona "${persona}". Wiring the persona overlay would hide ` +
          `a core product surface. Add its pillar to UNIVERSAL_PILLARS or the ` +
          `persona overlay in lib/navigation/pillarRegistry.ts.`,
      );
    }
  }
});

test("Phase 1 — CAPTURE, CASES, ADMIN are universal (structural invariant)", () => {
  // These back the core self-serve surfaces; if any persona overlay ever
  // omits one, this pins that they remain visible via UNIVERSAL_PILLARS.
  for (const persona of WORKSPACE_PERSONA_PROFILES) {
    const visible = visiblePillarsForPersona(persona);
    for (const pillar of ["HOME", "TRUST", "CAPTURE", "CASES", "ADMIN"] as const) {
      assert.ok(
        visible.has(pillar),
        `Universal pillar "${pillar}" missing for persona "${persona}".`,
      );
    }
  }
});
