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

  it("NULL kind → deterministic compatibility rule (isPersonal → PERSONAL; ENTERPRISE → ORGANIZATION; else OWNED)", () => {
    expect(
      resolveWorkspaceKind({ workspaceKind: null, isPersonal: true, billingPlan: "FREE", teamLoaded: true }),
    ).toBe("PERSONAL");
    expect(
      resolveWorkspaceKind({ workspaceKind: null, isPersonal: false, billingPlan: "ENTERPRISE", teamLoaded: true }),
    ).toBe("ORGANIZATION");
    expect(
      resolveWorkspaceKind({ workspaceKind: null, isPersonal: false, billingPlan: "TEAM", teamLoaded: true }),
    ).toBe("OWNED");
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

  it("self-service workspace creation → SYSTEM container + OWNED workspace", () => {
    const src = read("src/routes/teams.routes.ts");
    expect(src).toMatch(/kind:\s*"SYSTEM"/);
    expect(src).toMatch(/workspaceKind:\s*"OWNED"/);
    // Self-service must NEVER MINT a CUSTOMER organization.
    //
    // STALE_SOURCE_PIN (POINT 7): this was a bare `not.toMatch(/kind:
    // "CUSTOMER"/)` over the whole file, which is a proxy for "no CUSTOMER org
    // is created here" that cannot tell a CREATE from a WHERE. The owned-
    // workspace cap now excludes provisioned Organization workspaces with
    // `NOT: { organization: { kind: "CUSTOMER" } }` — a read filter — and the
    // proxy read that as a violation. The pin now asserts the property it
    // meant: every `organization.create` in this file writes SYSTEM.
    const creates = [...src.matchAll(/organization\.create\(\{[\s\S]{0,600}?\n\s*\}\)/g)].map(
      (m) => m[0],
    );
    expect(creates.length).toBeGreaterThan(0);
    for (const block of creates) {
      expect(block).toMatch(/kind:\s*"SYSTEM"/);
      expect(block).not.toMatch(/kind:\s*"CUSTOMER"/);
    }
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
