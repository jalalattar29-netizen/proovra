/**
 * PHASE 2 — DOMAIN CLASSIFICATION CLOSURE (2026-07-21).
 *
 * Invariants:
 *   1. The canonical classifier (`resolveWorkspaceKind`) is the ONLY
 *      workspace-kind decision procedure: persisted kind wins; the
 *      deterministic compatibility rule covers NULL rows; unprovable rows
 *      fail closed (UNKNOWN).
 *   2. Every workspace creator writes the canonical kinds:
 *        personal bootstrap  → SYSTEM container + PERSONAL workspace
 *        self-service /teams → SYSTEM container + OWNED workspace
 *        enterprise provisioning → CUSTOMER org + ORGANIZATION workspace(s)
 *   3. `POST /v1/orgs` (generic self-service organization creation) is
 *      RETIRED — bounded 403, no organization.create in the handler.
 *   4. `/v1/me/orgs` lists CUSTOMER organizations only — SYSTEM containers
 *      never surface as customer Enterprise Organizations.
 *   5. No production file outside the canonical classifier re-derives
 *      workspace kind from `billingPlan === "ENTERPRISE"`.
 *   6. The web self-service "create organization" caller is migrated.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  organizationLifecycleApplies,
  resolveWorkspaceKind,
} from "../src/services/identity/workspace-kind.js";

const API = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(API, "..", "..");
const read = (rel: string) => readFileSync(join(API, rel), "utf8");
const readRepo = (rel: string) => readFileSync(join(REPO, rel), "utf8");

// ---------------------------------------------------------------------------
// 1. Canonical classifier behavior
// ---------------------------------------------------------------------------

describe("Phase 2 — one canonical workspace-kind classifier", () => {
  it("persisted workspaceKind always wins", () => {
    for (const kind of ["PERSONAL", "OWNED", "ORGANIZATION"] as const) {
      expect(
        resolveWorkspaceKind({
          workspaceKind: kind,
          isPersonal: kind !== "PERSONAL", // contradictory legacy flag loses
          billingPlan: "ENTERPRISE",
          teamLoaded: true,
        }),
      ).toBe(kind);
    }
  });

  /**
   * PHASE 12 CORRECTIVE PASS §5.2 (ARCH-002, 2026-08-06) — THIS PIN WAS
   * PINNING THE DEFECT.
   *
   * The old expectations were `ENTERPRISE → ORGANIZATION` and `else → OWNED`
   * for a NULL kind. That rule reads a TENANCY fact off a COMMERCIAL one: an
   * Owned workspace whose account was upgraded to ENTERPRISE silently became
   * an ORGANIZATION workspace to the authorization chain, which then enforced
   * customer-Organization lifecycle against a workspace with no customer
   * Organization — and the same workspace downgraded silently stopped having
   * it enforced. Neither transition was anyone's decision and neither was
   * audited.
   *
   * `teams.workspace_kind` is now NOT NULL (20271125000000), backfilled from
   * structural authority only, and every writer supplies it. The classifier
   * fails closed instead. The personal-space invariant survives because
   * `is_personal` is structural, not commercial — the same authority the
   * backfill uses, and the database now makes the two equivalent by CHECK
   * constraint.
   */
  it("NULL kind → the personal-space invariant only; commercial facts decide nothing", () => {
    expect(
      resolveWorkspaceKind({ workspaceKind: null, isPersonal: true, billingPlan: "FREE", teamLoaded: true }),
    ).toBe("PERSONAL");
    expect(
      resolveWorkspaceKind({ workspaceKind: null, isPersonal: false, billingPlan: "ENTERPRISE", teamLoaded: true }),
    ).toBe("UNKNOWN");
    expect(
      resolveWorkspaceKind({ workspaceKind: null, isPersonal: false, billingPlan: "TEAM", teamLoaded: true }),
    ).toBe("UNKNOWN");
  });

  it("unprovable rows fail closed (UNKNOWN) and org lifecycle applies only to ORGANIZATION", () => {
    expect(
      resolveWorkspaceKind({ workspaceKind: null, isPersonal: null, billingPlan: null, teamLoaded: false }),
    ).toBe("UNKNOWN");
    expect(organizationLifecycleApplies("ORGANIZATION")).toBe(true);
    expect(organizationLifecycleApplies("PERSONAL")).toBe(false);
    expect(organizationLifecycleApplies("OWNED")).toBe(false);
    expect(organizationLifecycleApplies("UNKNOWN")).toBe(false);
  });

  it("platform-context composes the canonical classifier (no inline fallback)", () => {
    const src = read("src/services/platform-context/platform-context.service.ts");
    expect(src).toContain('from "../identity/workspace-kind.js"');
    expect(src).toContain("resolveWorkspaceKind({");
    // The retired inline ternary must be gone.
    expect(src).not.toMatch(
      /billingPlan[^;\n]*===\s*"ENTERPRISE"\s*\?\s*"ORGANIZATION"/,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Creators write canonical kinds
// ---------------------------------------------------------------------------

describe("Phase 2 — creation paths write canonical kinds", () => {
  it("personal bootstrap → SYSTEM container + PERSONAL workspace", () => {
    const src = read("src/services/platform-context/workspace-bootstrap.service.ts");
    expect(src).toMatch(/kind:\s*"SYSTEM"/);
    expect(src).toMatch(/workspaceKind:\s*"PERSONAL"/);
  });

  // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — the self-service
  // workspace CREATION path was removed from `POST /v1/teams`, so there is no
  // longer a `team.create` there to state a kind.
  //
  // The reason is commercial and it is decisive: checkout has ONE subject and
  // it is the person, so a workspace created on that path could never be paid
  // for. It would resolve FREE permanently and the shared-workspace admission
  // rule would refuse every piece of evidence recorded in it. The route
  // refuses instead of minting something unusable.
  //
  // The property this test defends is unchanged and is asserted on the two
  // paths that still create workspaces — the personal bootstrap and Enterprise
  // provisioning, each in its own test here. What is asserted for this file is
  // the ABSENCE, so the removal is pinned rather than silently forgotten.
  it("self-service workspace creation no longer exists — the route refuses", () => {
    const src = read("src/routes/teams.routes.ts");
    expect(src).not.toMatch(/(?:tx|prisma)\.team\.create\(/);
    expect(src).not.toMatch(/organization\.create\(/);
    expect(src).toMatch(/WORKSPACE_CREATION_NOT_SELF_SERVICE/);
  });

  it("enterprise provisioning → CUSTOMER org + ORGANIZATION workspaces", () => {
    const src = read("src/services/enterprise-provisioning.service.ts");
    expect(src).toMatch(/kind:\s*"CUSTOMER"/);
    expect(src).toMatch(/workspaceKind:\s*"ORGANIZATION"/);
  });
});

// ---------------------------------------------------------------------------
// 3 + 4. /v1/orgs resolution
// ---------------------------------------------------------------------------

describe("Phase 2 — /v1/orgs ambiguity resolved", () => {
  const src = read("src/routes/organizations.routes.ts");

  it("POST /v1/orgs is retired with a bounded denial and creates nothing", () => {
    const idx = src.indexOf("org_self_service_creation_retired");
    expect(idx).toBeGreaterThan(-1);
    // The retired handler block contains no organization/membership writes.
    const block = src.slice(idx - 1200, idx + 600);
    expect(block).not.toContain("organization.create");
    expect(block).not.toContain("organizationMembership.create");
  });

  it("/v1/me/orgs lists CUSTOMER organizations only (SYSTEM never surfaces)", () => {
    const idx = src.indexOf('"/v1/me/orgs"');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 1200);
    expect(block).toMatch(/organization:\s*\{\s*kind:\s*"CUSTOMER"\s*\}/);
  });
});

// ---------------------------------------------------------------------------
// 5 + 6. Web consumers migrated
// ---------------------------------------------------------------------------

describe("Phase 2 — web consumers use canonical classification", () => {
  it("organizations page no longer POSTs /v1/orgs (self-service create removed)", () => {
    const src = readRepo("apps/web/app/(app)/organizations/page.tsx");
    expect(src).not.toMatch(/apiFetch\("\/v1\/orgs",\s*\{\s*method:\s*"POST"/);
    expect(src).toContain("enterprise-info");
  });

  it("AiSection derives kind from the canonical contextOptions.activeContext", () => {
    const src = readRepo("apps/web/app/(app)/settings/_sections/AiSection.tsx");
    expect(src).toContain("contextOptions?.activeContext");
    expect(src).toMatch(/canonicalKind/);
  });
});
