/**
 * ATTENTION ARCHITECTURE — PHASE 4B (2026-08-22).
 * TENANT OPERATIONS UNLOCK + CANONICAL PERMISSIONS.
 *
 * Two things happen in this phase and both are load-bearing:
 *
 *   THE UNLOCK.  `/operations` stops being a PROOVRA-staff console and becomes
 *                the tenant's own view of its unresolved shared work, gated on
 *                a valid active workspace plus OPERATIONS_VIEW.
 *
 *   D29.         Generic Operations mutations stop borrowing
 *                `identity.access_review.action` — the permission that decides
 *                whether somebody keeps their ACCESS to a workspace — and use
 *                permissions that describe what they actually do.
 *
 * The unlock is only safe because the platform boundary survives it, so the
 * boundary is re-asserted here and in
 * `apps/web/__tests__/platform-admin-route-access.test.ts`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  PERMISSIONS,
  roleHasPermission,
  type CanonicalRole,
  type Permission,
} from "@proovra/shared";

import { resolveCapabilities } from "../src/services/platform-context/capability-registry.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const OPS_ROUTES = readSource("../src/routes/ops.routes.ts");

const OPERATIONS_PERMISSIONS = [
  "operations.view",
  "operations.acknowledge",
  "operations.assign",
  "operations.resolve",
  "operations.suppress",
] as const;

// ============================================================================
// 4B.2 — the D29 fix
// ============================================================================

describe("Phase 4B.2 — canonical Operations permissions replace D29", () => {
  it("declares the five Operations permissions", () => {
    for (const permission of OPERATIONS_PERMISSIONS) {
      expect(PERMISSIONS as readonly string[]).toContain(permission);
    }
  });

  it("does NOT declare a generic operations.retry", () => {
    // Retry is a DOMAIN action. A generic retry permission would be
    // Operations acquiring authority over every domain it displays.
    expect(PERMISSIONS as readonly string[]).not.toContain("operations.retry");
    expect(PERMISSIONS as readonly string[]).not.toContain("operations.remediate");

    // SIX, since operations.saved_views.manage joined the family.
    //
    // The count is pinned rather than left open BECAUSE of the rule above: a
    // new operations.* permission is exactly how a generic retry authority
    // would arrive, so adding one has to be a deliberate edit here. This one
    // governs shared workspace CONFIGURATION — a TEAM saved view appears in
    // every colleague's toolbar — and confers nothing over any domain
    // Operations displays.
    const opsPermissions = (PERMISSIONS as readonly string[]).filter((p) =>
      p.startsWith("operations."),
    );
    expect(opsPermissions.length).toBe(6);
    expect(opsPermissions).toContain("operations.saved_views.manage");
  });

  it("no Operations route is authorized by identity.access_review.action", () => {
    // THE defect. The only surviving mentions are the doc comments recording
    // why it was removed, so the assertion is over CODE.
    const code = OPS_ROUTES.split("\n")
      .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toContain("identity.access_review.action");
  });

  it("the D29 guard function is gone, not merely unused", () => {
    expect(OPS_ROUTES).not.toMatch(
      /async function requireOpsActorAction\(/,
    );
  });

  it("every ops mutation resolves through the canonical capability gate", () => {
    const gated = OPS_ROUTES.match(/requireOpsCapability\(/g) ?? [];
    // 1 definition + 1 read wrapper + 12 single-item mutations + 1 bulk.
    expect(gated.length).toBeGreaterThanOrEqual(14);
  });

  it("reads require operations.view, not identity.member.read", () => {
    expect(OPS_ROUTES).toMatch(
      /async function requireOpsActor\([\s\S]{0,400}"operations\.view"/,
    );
  });

  it("each mutation uses the permission that describes it", () => {
    const expectations: ReadonlyArray<[string, string]> = [
      ["/v1/ops/incidents/:id/ack", "operations.acknowledge"],
      ["/v1/ops/incidents/:id/resolve", "operations.resolve"],
      ["/v1/ops/incidents/:id/suppress", "operations.suppress"],
      ["/v1/ops/incidents/:id/assign", "operations.assign"],
      ["/v1/ops/workflows/:id/suppress", "operations.suppress"],
      ["/v1/ops/workflows/:id/escalate", "operations.assign"],
    ];
    for (const [route, permission] of expectations) {
      const at = OPS_ROUTES.indexOf(`"${route}"`);
      expect(at, `${route} must be registered`).toBeGreaterThan(0);
      const block = OPS_ROUTES.slice(at, at + 2200);
      expect(block, `${route} must require ${permission}`).toContain(
        `"${permission}"`,
      );
    }
  });

  it("bulk actions inherit the permission of the action they fan out into", () => {
    // Otherwise the bulk endpoint is a hole through every single-item gate:
    // an acknowledger could suppress 200 conditions through it.
    expect(OPS_ROUTES).toContain("BULK_ACTION_PERMISSION");
    expect(OPS_ROUTES).toMatch(
      /BULK_SUPPRESS_INCIDENTS: "operations\.suppress"/,
    );
    expect(OPS_ROUTES).toMatch(/BULK_ASSIGN_WORKFLOWS: "operations\.assign"/);
    expect(OPS_ROUTES).toMatch(
      /BULK_ACKNOWLEDGE_INCIDENTS: "operations\.acknowledge"/,
    );
    expect(OPS_ROUTES).toMatch(
      /BULK_ACTION_PERMISSION\[body\.actionType\]/,
    );
  });

  it("a genuinely workspace-scoped domain action stays DOMAIN-authorized", () => {
    expect(OPS_ROUTES).toMatch(
      /async function requireDomainActionOnOpsSurface\([\s\S]{0,600}"intelligence\.run"/,
    );
    // Dismissing a run is the domain action this gate was written for, and it
    // is scoped in fact: `dismissRun(runId, teamId)` narrows on `team_id` in
    // SQL, so the workspace permission authorizes work in that workspace.
    const at = OPS_ROUTES.indexOf('"/v1/ops/media-intelligence/runs/:runId/dismiss"');
    expect(at).toBeGreaterThan(0);
    const block = OPS_ROUTES.slice(at, at + 1200);
    expect(block).toContain("requireDomainActionOnOpsSurface");
    expect(block).toContain('"intelligence.run"');
  });

  it("the two PLATFORM-WIDE queue actions carry PLATFORM authority, not a workspace permission", () => {
    // CORRECTED. This case previously asserted that DLQ replay and single-job
    // retry were gated by `requireDomainActionOnOpsSurface(…, "intelligence.run")`
    // — a workspace permission held by the OWNER, ADMIN and REVIEWER of ANY
    // workspace. The functions behind them are `replayMediaIntelligenceDlq({maxJobs})`
    // and `retryMediaIntelligenceJob(jobId)`: neither takes a teamId, and the
    // replay calls `getFailed()` on the single global queue. So the workspace
    // permission authorized a fleet-wide action, and an org owner of one
    // workspace could requeue every other tenant's dead-lettered jobs. That was
    // reproduced at runtime — org-owner received a 200.
    //
    // The scope is not something that can be filtered away: the DLQ is one
    // global queue and this surface is platform-scoped. So the AUTHORITY was
    // moved to match the blast radius, using the same guard the sibling
    // platform-operations families already use. The assertion is inverted here
    // deliberately: it now fails if the workspace gate ever returns.
    for (const route of [
      "/v1/ops/media-intelligence/runs/:runId/retry",
      "/v1/ops/media-intelligence/dlq/replay",
    ]) {
      const at = OPS_ROUTES.indexOf(`"${route}"`);
      expect(at).toBeGreaterThan(0);
      const block = OPS_ROUTES.slice(at, at + 1600);
      // Match the CALL, not the mere presence of the name: the handler carries
      // a comment explaining which gate it moved away from, and a bare
      // substring check would read that prose as the defect it describes.
      expect(block).toMatch(/await requirePlatformOpsActor\(req, reply,/);
      expect(block).not.toMatch(/await requireDomainActionOnOpsSurface\(req, reply,/);
    }
  });
});

// ============================================================================
// 4B.3 — the role matrix, tested through the resolved answer
// ============================================================================

describe("Phase 4B.3 — role x action, from the canonical matrix", () => {
  const MATRIX: ReadonlyArray<{
    role: CanonicalRole;
    allowed: readonly Permission[];
    denied: readonly Permission[];
  }> = [
    {
      role: "OWNER",
      allowed: OPERATIONS_PERMISSIONS as unknown as readonly Permission[],
      denied: [],
    },
    {
      role: "ADMIN",
      allowed: OPERATIONS_PERMISSIONS as unknown as readonly Permission[],
      denied: [],
    },
    {
      role: "REVIEWER",
      allowed: [
        "operations.view",
        "operations.acknowledge",
        "operations.resolve",
      ],
      // A reviewer operates; they do not decide somebody else's workload and
      // they do not decide the workspace stops hearing about unresolved work.
      denied: ["operations.assign", "operations.suppress"],
    },
    {
      role: "CONTRIBUTOR",
      allowed: ["operations.view"],
      denied: [
        "operations.acknowledge",
        "operations.assign",
        "operations.resolve",
        "operations.suppress",
      ],
    },
    {
      role: "VIEWER",
      allowed: ["operations.view"],
      denied: [
        "operations.acknowledge",
        "operations.assign",
        "operations.resolve",
        "operations.suppress",
      ],
    },
    {
      role: "EXTERNAL_CONTRIBUTOR",
      allowed: [],
      denied: OPERATIONS_PERMISSIONS as unknown as readonly Permission[],
    },
    {
      role: "PUBLIC_VERIFIER",
      allowed: [],
      denied: OPERATIONS_PERMISSIONS as unknown as readonly Permission[],
    },
  ];

  for (const { role, allowed, denied } of MATRIX) {
    it(`${role}: ${allowed.length} allowed / ${denied.length} denied`, () => {
      for (const permission of allowed) {
        expect(
          roleHasPermission(role, permission),
          `${role} should hold ${permission}`,
        ).toBe(true);
      }
      for (const permission of denied) {
        expect(
          roleHasPermission(role, permission),
          `${role} must NOT hold ${permission}`,
        ).toBe(false);
      }
    });
  }

  it("VIEWER may look and may not act — the whole point of the tier", () => {
    expect(roleHasPermission("VIEWER", "operations.view")).toBe(true);
    for (const permission of OPERATIONS_PERMISSIONS.filter(
      (p) => p !== "operations.view",
    )) {
      expect(roleHasPermission("VIEWER", permission as Permission)).toBe(false);
    }
  });
});

// ============================================================================
// 4B.1 / Phase 0 — the capability, and what grants it
// ============================================================================

describe("Phase 4B.1 — OPERATIONS_VIEW is capability-driven, never plan-named", () => {
  const base = {
    scope: "TEAM" as const,
    role: "ADMIN" as const,
    isPlatformAdmin: false,
    workspaceKind: "ORGANIZATION" as const,
  };

  it("a Free PERSONAL workspace with one operator gets NO Operations", () => {
    const caps = resolveCapabilities({
      scope: "PERSONAL",
      role: "OWNER",
      plan: "FREE",
      isPlatformAdmin: false,
      workspaceKind: "PERSONAL",
      packageProducesOperationalConditions: false,
      memberCount: 1,
    });
    expect(caps.OPERATIONS_VIEW).toBeFalsy();
  });

  it("a solo Pro investigator DOES get Operations — their package produces conditions", () => {
    const caps = resolveCapabilities({
      scope: "PERSONAL",
      role: "OWNER",
      plan: "PRO",
      isPlatformAdmin: false,
      workspaceKind: "PERSONAL",
      packageProducesOperationalConditions: true,
      memberCount: 1,
    });
    expect(caps.OPERATIONS_VIEW).toBe(true);
  });

  it("a SHARED workspace gets it regardless of package", () => {
    // The moment two operators exist, "has anyone dealt with this?" needs
    // shared state.
    const caps = resolveCapabilities({
      ...base,
      plan: "FREE",
      packageProducesOperationalConditions: false,
      memberCount: 2,
    });
    expect(caps.OPERATIONS_VIEW).toBe(true);
  });

  it("VIEWER sees but cannot act; ADMIN can assign and suppress", () => {
    const viewer = resolveCapabilities({
      ...base,
      role: "VIEWER",
      plan: "TEAM",
      packageProducesOperationalConditions: true,
      memberCount: 3,
    });
    expect(viewer.OPERATIONS_VIEW).toBe(true);
    expect(viewer.OPERATIONS_ACKNOWLEDGE).toBeFalsy();
    expect(viewer.OPERATIONS_SUPPRESS).toBeFalsy();

    const admin = resolveCapabilities({
      ...base,
      plan: "TEAM",
      packageProducesOperationalConditions: true,
      memberCount: 3,
    });
    expect(admin.OPERATIONS_ASSIGN).toBe(true);
    expect(admin.OPERATIONS_SUPPRESS).toBe(true);
  });

  it("an UNKNOWN workspace kind fails closed", () => {
    const caps = resolveCapabilities({
      ...base,
      workspaceKind: "UNKNOWN",
      plan: "ENTERPRISE",
      packageProducesOperationalConditions: true,
      memberCount: 9,
    });
    expect(caps.OPERATIONS_VIEW).toBeFalsy();
  });

  it("the capability registry contains no plan-name comparison for Operations", () => {
    const REGISTRY = readSource(
      "../src/services/platform-context/capability-registry.ts",
    );
    const at = REGISTRY.indexOf("PHASE 4B (2026-08-22) — TENANT OPERATIONS");
    expect(at).toBeGreaterThan(0);
    const block = REGISTRY.slice(at, REGISTRY.indexOf("Platform admin elevation", at));
    // The gate reads two derived booleans and a structural kind. No plan
    // string may appear.
    for (const planName of ['"FREE"', '"PRO"', '"TEAM"', '"ENTERPRISE"']) {
      expect(block, `Operations gate must not read ${planName}`).not.toContain(
        planName,
      );
    }
  });
});

// ============================================================================
// 4B.4 — the platform boundary after the unlock
// ============================================================================

describe("Phase 4B.4 — platform isolation survives the unlock", () => {
  it("the tenant Operations route no longer requires the platform space", () => {
    const REGISTRY = readSource(
      "../../../apps/web/lib/navigation/routeRegistry.ts",
    );
    const at = REGISTRY.indexOf('id: "workspace.operations"');
    expect(at).toBeGreaterThan(0);
    // Bound the slice to THIS entry — the registry is a flat array, so an
    // over-long window reads the next route's gate and would pass or fail on
    // the wrong entry entirely.
    const end = REGISTRY.indexOf("\n  },", at);
    expect(end).toBeGreaterThan(at);
    const block = REGISTRY.slice(at, end);
    expect(block).toContain('requiredCapabilities: ["OPERATIONS_VIEW"]');
    expect(block).toContain('requiredActiveSpace: "PERSONAL_OR_ORG"');
    expect(block).not.toMatch(/requiredActiveSpace: "PLATFORM_ADMIN",/);
  });

  it("the platform consoles all still require PLATFORM_ADMIN", () => {
    const REGISTRY = readSource(
      "../../../apps/web/lib/navigation/routeRegistry.ts",
    );
    for (const href of [
      "/admin/platform/observability",
      "/admin/platform/readiness",
      "/admin/platform/runbooks",
      "/admin/platform/queues",
    ]) {
      const at = REGISTRY.indexOf(`href: "${href}"`);
      expect(at, `${href} must be registered`).toBeGreaterThan(0);
      const block = REGISTRY.slice(at, at + 1400);
      expect(block, `${href} must stay platform-gated`).toContain(
        'requiredActiveSpace: "PLATFORM_ADMIN"',
      );
    }
  });

  it("the nav projection moved Operations out of Platform Health", () => {
    const NAV = readSource(
      "../src/services/platform-context/navigation-registry.ts",
    );
    const at = NAV.indexOf('id: "workspace.operations"');
    expect(at).toBeGreaterThan(0);
    const block = NAV.slice(at, at + 400);
    expect(block).toContain('requiresCapability: "OPERATIONS_VIEW"');
    expect(block).toContain('domain: "WORKSPACE"');
    expect(block).not.toContain('requiresCapability: "OPS_CENTER_VIEW"');
  });

  it("PROOVRA's own raw ops console stays INTERNAL", () => {
    const TIERS = readSource("../../../apps/web/lib/surface/tiers.ts");
    expect(TIERS).toMatch(
      /\{ pathPrefix: "\/ops", tier: "INTERNAL", directAccessPolicy: "notFound"/,
    );
    // /platform is the public marketing route; it stays INTERNAL as an app
    // prefix and the accepted Phase-4A decision keeps the consoles under
    // /admin/platform/*.
    expect(TIERS).toMatch(/\{ pathPrefix: "\/platform", tier: "INTERNAL"/);
  });
});
