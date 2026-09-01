/**
 * ADM-013 PHASE 1 — the observability capability split, proven exhaustively.
 *
 * ===========================================================================
 * WHAT THE ONE KEY GOT WRONG
 * ===========================================================================
 * `OBSERVABILITY_VIEW` had to answer two questions at once:
 *
 *   "may this actor read the PROCESS-GLOBAL runtime registry?"
 *   "may this actor see whether their own workspace is healthy?"
 *
 * Those have different audiences and different blast radii. Because one word
 * spelled both, every tenant surface that wanted the second had to test for
 * the first — and the first is platform-staff-only. The observable result was
 * eleven workspace surfaces offering a "diagnostics" link that only platform
 * staff ever saw, and workspace operators looking at a degraded banner with
 * nowhere to go.
 *
 * ===========================================================================
 * WHY THIS TEST ENUMERATES THE WHOLE PRODUCT
 * ===========================================================================
 * A capability leak is not a bug in one branch; it is a branch somebody did
 * not think of. `PLATFORM_TELEMETRY_VIEW` is asserted false across the FULL
 * cross-product of (kind x role x plan x operational-condition inputs) with
 * `isPlatformAdmin: false` — several hundred contexts including the most
 * privileged tenant that exists, an ENTERPRISE organization OWNER. If any
 * future grant reaches it from a tenant path, this fails.
 *
 * The mirror claim is asserted too: `WORKSPACE_HEALTH_VIEW` must track
 * `OPERATIONS_VIEW` exactly. A workspace that can see its conditions queue can
 * see its health rollup; one that cannot, cannot. Splitting a key is only an
 * improvement if the new key is actually reachable by the population it was
 * created for — otherwise it is the old dead end with a new name.
 */

import { describe, expect, it } from "vitest";

import {
  resolveCapabilities,
  type CapabilityResolverInput,
} from "../src/services/platform-context/capability-registry.js";
import {
  CAPABILITY_KEYS,
  WORKSPACE_PLANS,
  WORKSPACE_ROLES,
  WORKSPACE_SCOPES,
} from "../src/services/platform-context/types.js";

const KINDS = ["PERSONAL", "OWNED", "ORGANIZATION", "UNKNOWN"] as const;

/**
 * Every tenant context the product can produce, with `isPlatformAdmin: false`.
 *
 * `scope: null` (no workspace at all) is included because the resolver has a
 * separate early-return branch for it, and an early return is exactly the kind
 * of path a grant gets added to without the main branch being consulted.
 */
function tenantContexts(): CapabilityResolverInput[] {
  const out: CapabilityResolverInput[] = [];
  for (const scope of [null, ...WORKSPACE_SCOPES]) {
    for (const role of [null, ...WORKSPACE_ROLES]) {
      for (const plan of [null, ...WORKSPACE_PLANS]) {
        for (const workspaceKind of [null, ...KINDS]) {
          for (const produces of [true, false, null]) {
            for (const memberCount of [1, 12]) {
              out.push({
                scope,
                role,
                plan,
                isPlatformAdmin: false,
                workspaceKind,
                packageProducesOperationalConditions: produces,
                memberCount,
              } as CapabilityResolverInput);
            }
          }
        }
      }
    }
  }
  return out;
}

function describeContext(c: CapabilityResolverInput): string {
  return `scope=${c.scope} role=${c.role} plan=${c.plan} kind=${c.workspaceKind} produces=${c.packageProducesOperationalConditions} members=${c.memberCount}`;
}

describe("ADM-013 Phase 1 — the two keys exist and are distinct", () => {
  it("both successor keys are in the canonical vocabulary", () => {
    expect(CAPABILITY_KEYS).toContain("PLATFORM_TELEMETRY_VIEW");
    expect(CAPABILITY_KEYS).toContain("WORKSPACE_HEALTH_VIEW");
  });

  it("they are two keys, not an alias of one", () => {
    expect("PLATFORM_TELEMETRY_VIEW").not.toBe("WORKSPACE_HEALTH_VIEW");
    const platformOnly = resolveCapabilities({
      scope: "PERSONAL",
      role: "OWNER",
      plan: "FREE",
      isPlatformAdmin: true,
    });
    const tenantOnly = resolveCapabilities({
      scope: "TEAM",
      role: "OWNER",
      plan: "TEAM",
      isPlatformAdmin: false,
      memberCount: 5,
    });
    // The point of the split, in one assertion: a platform admin on a FREE
    // personal space holds the global key and a shared-workspace OWNER does
    // not, while the shared-workspace OWNER holds the tenant key.
    expect(platformOnly.PLATFORM_TELEMETRY_VIEW).toBe(true);
    expect(tenantOnly.PLATFORM_TELEMETRY_VIEW).toBe(false);
    expect(tenantOnly.WORKSPACE_HEALTH_VIEW).toBe(true);
  });
});

describe("ADM-013 Phase 1 — PLATFORM_TELEMETRY_VIEW is unreachable from any tenant path", () => {
  const contexts = tenantContexts();

  it("covers the full tenant cross-product", () => {
    // Guards the guard: if a future refactor collapses the generator, the
    // sweep below would pass vacuously.
    expect(contexts.length).toBeGreaterThan(300);
  });

  it("is false in every non-platform-admin context", () => {
    const leaks = contexts
      .filter((c) => resolveCapabilities(c).PLATFORM_TELEMETRY_VIEW === true)
      .map(describeContext);
    expect(leaks).toEqual([]);
  });

  it("is true for a platform admin regardless of which workspace is active", () => {
    for (const scope of [null, ...WORKSPACE_SCOPES]) {
      for (const plan of [null, ...WORKSPACE_PLANS]) {
        const caps = resolveCapabilities({
          scope,
          role: scope ? "VIEWER" : null,
          plan,
          isPlatformAdmin: true,
        } as CapabilityResolverInput);
        expect(
          caps.PLATFORM_TELEMETRY_VIEW,
          `platform admin lost the global key at scope=${scope} plan=${plan} — the authority is the STAFF role, not the workspace they happen to be standing in`,
        ).toBe(true);
      }
    }
  });
});

describe("ADM-013 Phase 1 — WORKSPACE_HEALTH_VIEW tracks the tenant operations authority", () => {
  it("is granted exactly when OPERATIONS_VIEW is", () => {
    const mismatches = tenantContexts()
      .map((c) => ({ c, caps: resolveCapabilities(c) }))
      .filter(
        ({ caps }) =>
          Boolean(caps.WORKSPACE_HEALTH_VIEW) !== Boolean(caps.OPERATIONS_VIEW),
      )
      .map(({ c, caps }) =>
        `${describeContext(c)} → health=${caps.WORKSPACE_HEALTH_VIEW} operations=${caps.OPERATIONS_VIEW}`,
      );
    expect(mismatches).toEqual([]);
  });

  it("reaches the population the split was created for — a Personal Pro operator", () => {
    // The concrete actor the dead end failed: a sole operator on a paid
    // personal space, who produces operational conditions and therefore has a
    // health question, and who is not and will never be platform staff.
    const caps = resolveCapabilities({
      scope: "PERSONAL",
      role: "OWNER",
      plan: "PRO",
      isPlatformAdmin: false,
      workspaceKind: "PERSONAL",
      packageProducesOperationalConditions: true,
      memberCount: 1,
    } as CapabilityResolverInput);
    expect(caps.WORKSPACE_HEALTH_VIEW).toBe(true);
    expect(caps.PLATFORM_TELEMETRY_VIEW).toBe(false);
  });

  it("is withheld from a workspace that cannot produce operational conditions", () => {
    const caps = resolveCapabilities({
      scope: "PERSONAL",
      role: "OWNER",
      plan: "FREE",
      isPlatformAdmin: false,
      workspaceKind: "PERSONAL",
      packageProducesOperationalConditions: false,
      memberCount: 1,
    } as CapabilityResolverInput);
    expect(caps.WORKSPACE_HEALTH_VIEW).toBe(false);
    expect(caps.OPERATIONS_VIEW).toBe(false);
  });
});
