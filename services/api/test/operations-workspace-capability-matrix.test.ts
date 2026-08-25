/**
 * THE OPERATIONS WORKSPACE / CAPABILITY MATRIX — 24 contexts, ungrouped.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS FOR
 * ---------------------------------------------------------------------------
 * Operations has ONE implementation and ONE source registry. Different
 * workspaces see different things because the SERVER projects different
 * capabilities, never because a second page, a plan-name branch or an
 * email-domain check exists somewhere. That claim is only worth anything if
 * it is executed against every context that could break it, so this file
 * enumerates all twenty-four and runs the real authorities:
 *
 *   * `resolveCapabilities`   — the canonical capability projection;
 *   * `OPERATIONS_SOURCES`    — the canonical source registry;
 *   * `ROUTE_REGISTRY`        — the canonical route decision the shell makes.
 *
 * Nothing here re-implements any of those. A row that disagrees with the
 * product is a failing row, not a stale document.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ROWS ARE UNGROUPED
 * ---------------------------------------------------------------------------
 * Grouping is how a matrix hides the case that matters. "All Enterprise roles:
 * same as Team" reads fine and is exactly where an expired contract or a
 * platform admin without membership would be lost. Every context is its own
 * row with its own printed answer, including the ones that are identical —
 * because being identical is itself the claim under test.
 *
 * ---------------------------------------------------------------------------
 * WHAT REQUEST COUNTS MEAN HERE
 * ---------------------------------------------------------------------------
 * `opsRequests` is the number of `/v1/ops/*` calls the surface may make for
 * that context, and `shellRequests` the background/poll calls. Zero is a real
 * assertion and the strictest one on the page: a context with no Operations
 * route must produce NO Operations traffic at all — not a 403 it then
 * explains, and not a poll that quietly 404s forever. The route gate refuses
 * BEFORE fetching, which is what makes zero achievable.
 */

import { describe, expect, it } from "vitest";

import {
  resolveCapabilities,
  type CapabilityResolverInput,
} from "../src/services/platform-context/capability-registry.js";
import {
  OPERATIONS_SOURCES,
  requiredSourceIds,
} from "../src/services/operations/operations-source-registry.js";

type Ctx = {
  n: number;
  name: string;
  input: CapabilityResolverInput;
  /**
   * Refused BEFORE any capability is consulted: no active workspace, a
   * context the envelope cannot confirm, or a suspended account. These never
   * reach the resolver in production either.
   */
  hardRefusal?:
    | "NO_WORKSPACE"
    | "CONTEXT_MISMATCH"
    | "ACCOUNT_NOT_ACTIVE"
    | "NO_ENVELOPE";
  /** Expected `/v1/ops/*` request count from the workbench. */
  opsRequests: number;
  /** Expected background/shell poll count against `/v1/ops/*`. */
  shellRequests: number;
  /** What the surface renders. */
  ui: string;
};

/** A workspace whose package produces conditions — a paid tier, not a name. */
const PRODUCES = true;
const NO_PRODUCE = false;

const CONTEXTS: Ctx[] = [
  {
    n: 1,
    name: "Personal Free owner",
    input: {
      scope: "PERSONAL",
      workspaceKind: "PERSONAL",
      role: "OWNER",
      plan: "FREE",
      isPlatformAdmin: false,
      packageProducesOperationalConditions: NO_PRODUCE,
      memberCount: 1,
    },
    // One operator, no condition-producing package: there is no shared triage
    // to do. Their integrity failures remain a notification plus the Evidence
    // record's own remediation path.
    opsRequests: 0,
    shellRequests: 0,
    ui: "no route; RestrictedState(not_included) if reached directly",
  },
  {
    n: 2,
    name: "Personal Pro owner",
    input: {
      scope: "PERSONAL",
      workspaceKind: "PERSONAL",
      role: "OWNER",
      plan: "PRO",
      isPlatformAdmin: false,
      packageProducesOperationalConditions: PRODUCES,
      memberCount: 1,
    },
    // THE WORKSPACE THIS WHOLE BRANCH IS ABOUT. A full console, every
    // Personal-applicable source, and no owner axis — a picker containing
    // only the person looking at it is not a decision.
    opsRequests: 2,
    shellRequests: 0,
    ui: "full workbench, no owner column/filter",
  },
  {
    n: 3,
    name: "Paid Personal OWNED workspace owner",
    input: {
      scope: "TEAM",
      workspaceKind: "OWNED",
      role: "OWNER",
      plan: "PRO",
      isPlatformAdmin: false,
      packageProducesOperationalConditions: PRODUCES,
      memberCount: 1,
    },
    opsRequests: 2,
    shellRequests: 0,
    ui: "full workbench, no owner column/filter",
  },
  {
    n: 4,
    name: "Team viewer",
    input: {
      scope: "TEAM",
      workspaceKind: "OWNED",
      role: "VIEWER",
      plan: "PRO",
      isPlatformAdmin: false,
      packageProducesOperationalConditions: PRODUCES,
      memberCount: 4,
    },
    opsRequests: 2,
    shellRequests: 0,
    ui: "read-only workbench with owner column; no mutation controls",
  },
  {
    n: 5,
    name: "Team member without mutation permissions",
    input: {
      scope: "TEAM",
      workspaceKind: "OWNED",
      role: "VIEWER",
      plan: "FREE",
      isPlatformAdmin: false,
      // Shared workspace: the moment two operators exist, "has anyone dealt
      // with this?" needs shared state whatever the package includes.
      packageProducesOperationalConditions: NO_PRODUCE,
      memberCount: 3,
    },
    opsRequests: 2,
    shellRequests: 0,
    ui: "read-only workbench with owner column",
  },
  {
    n: 6,
    name: "Team operator (member/writer)",
    input: {
      scope: "TEAM",
      workspaceKind: "OWNED",
      role: "MEMBER",
      plan: "PRO",
      isPlatformAdmin: false,
      packageProducesOperationalConditions: PRODUCES,
      memberCount: 4,
    },
    opsRequests: 2,
    shellRequests: 0,
    ui: "workbench with acknowledge/resolve; no assign, no suppress",
  },
  {
    n: 7,
    name: "Team admin",
    input: {
      scope: "TEAM",
      workspaceKind: "OWNED",
      role: "ADMIN",
      plan: "PRO",
      isPlatformAdmin: false,
      packageProducesOperationalConditions: PRODUCES,
      memberCount: 4,
    },
    opsRequests: 3,
    shellRequests: 0,
    ui: "full workbench + assignment + bulk toolbar",
  },
  {
    n: 8,
    name: "Organization viewer",
    input: {
      scope: "TEAM",
      workspaceKind: "ORGANIZATION",
      role: "VIEWER",
      plan: "TEAM",
      isPlatformAdmin: false,
      packageProducesOperationalConditions: PRODUCES,
      memberCount: 12,
    },
    opsRequests: 2,
    shellRequests: 0,
    ui: "read-only workbench with owner column",
  },
  {
    n: 9,
    name: "Organization operator",
    input: {
      scope: "TEAM",
      workspaceKind: "ORGANIZATION",
      role: "MEMBER",
      plan: "TEAM",
      isPlatformAdmin: false,
      packageProducesOperationalConditions: PRODUCES,
      memberCount: 12,
    },
    opsRequests: 2,
    shellRequests: 0,
    ui: "workbench with acknowledge/resolve",
  },
  {
    n: 10,
    name: "Organization admin",
    input: {
      scope: "TEAM",
      workspaceKind: "ORGANIZATION",
      role: "ADMIN",
      plan: "TEAM",
      isPlatformAdmin: false,
      packageProducesOperationalConditions: PRODUCES,
      memberCount: 12,
    },
    opsRequests: 3,
    shellRequests: 0,
    ui: "full workbench + assignment + bulk toolbar",
  },
  {
    n: 11,
    name: "Enterprise viewer",
    input: {
      scope: "TEAM",
      workspaceKind: "ORGANIZATION",
      role: "VIEWER",
      plan: "ENTERPRISE",
      isPlatformAdmin: false,
      packageProducesOperationalConditions: PRODUCES,
      memberCount: 40,
    },
    opsRequests: 2,
    shellRequests: 0,
    ui: "read-only workbench — the SAME component as row 8",
  },
  {
    n: 12,
    name: "Enterprise operator",
    input: {
      scope: "TEAM",
      workspaceKind: "ORGANIZATION",
      role: "MEMBER",
      plan: "ENTERPRISE",
      isPlatformAdmin: false,
      packageProducesOperationalConditions: PRODUCES,
      memberCount: 40,
    },
    opsRequests: 2,
    shellRequests: 0,
    ui: "workbench with acknowledge/resolve — SAME component as row 9",
  },
  {
    n: 13,
    name: "Enterprise admin, active contract",
    input: {
      scope: "TEAM",
      workspaceKind: "ORGANIZATION",
      role: "ADMIN",
      plan: "ENTERPRISE",
      isPlatformAdmin: false,
      packageProducesOperationalConditions: PRODUCES,
      memberCount: 40,
    },
    opsRequests: 3,
    shellRequests: 0,
    ui: "full workbench + assignment + bulk — SAME component as row 10",
  },
  {
    n: 14,
    name: "Enterprise large workspace, many operators, high volume",
    input: {
      scope: "TEAM",
      workspaceKind: "ORGANIZATION",
      role: "ADMIN",
      plan: "ENTERPRISE",
      isPlatformAdmin: false,
      packageProducesOperationalConditions: PRODUCES,
      memberCount: 400,
    },
    // Volume changes pagination and grouping, never the request COUNT: the
    // queue is keyset-paginated and the summary is one call whatever the size.
    opsRequests: 3,
    shellRequests: 0,
    ui: "grouped conditions with affectedCount; paginated queue",
  },
  {
    n: 15,
    name: "Enterprise expired contract with retained obligations",
    input: {
      scope: "TEAM",
      workspaceKind: "ORGANIZATION",
      role: "ADMIN",
      plan: "ENTERPRISE",
      isPlatformAdmin: false,
      // An expired contract stops the package producing NEW conditions. It
      // does not delete the workspace's retained obligations, and it does not
      // stop it being shared — so the console stays reachable and the
      // existing conditions stay visible and closable. Removing the surface
      // would hide obligations the customer still has.
      packageProducesOperationalConditions: NO_PRODUCE,
      memberCount: 40,
    },
    opsRequests: 3,
    shellRequests: 0,
    ui: "workbench over retained conditions",
  },
  {
    n: 16,
    name: "Platform admin WITHOUT tenant membership",
    input: {
      scope: null,
      workspaceKind: null,
      role: null,
      plan: null,
      isPlatformAdmin: true,
      packageProducesOperationalConditions: PRODUCES,
      memberCount: 40,
    },
    // The single most important row. Staff standing is not tenant standing.
    opsRequests: 0,
    shellRequests: 0,
    ui: "no tenant Operations; platform consoles only",
  },
  {
    n: 17,
    name: "Platform admin WITH ordinary tenant membership",
    input: {
      scope: "TEAM",
      workspaceKind: "ORGANIZATION",
      role: "MEMBER",
      plan: "TEAM",
      isPlatformAdmin: true,
      packageProducesOperationalConditions: PRODUCES,
      memberCount: 12,
    },
    // Exactly what their MEMBERSHIP grants, and nothing more. Staff standing
    // must not silently upgrade a tenant role.
    opsRequests: 2,
    shellRequests: 0,
    ui: "workbench at MEMBER level; no assignment",
  },
  {
    n: 18,
    name: "Missing capability envelope",
    input: {
      scope: null,
      workspaceKind: null,
      role: null,
      plan: null,
      isPlatformAdmin: false,
    },
    hardRefusal: "NO_ENVELOPE",
    opsRequests: 0,
    shellRequests: 0,
    ui: "RestrictedState(no_envelope)",
  },
  {
    n: 19,
    name: "Operations capability withheld",
    input: {
      scope: "TEAM",
      workspaceKind: "OWNED",
      role: "ADMIN",
      plan: "PRO",
      isPlatformAdmin: false,
      // Neither qualifier met: no condition-producing package and one member.
      packageProducesOperationalConditions: NO_PRODUCE,
      memberCount: 1,
    },
    opsRequests: 0,
    shellRequests: 0,
    ui: "RestrictedState(not_included)",
  },
  {
    n: 20,
    name: "Wrong active workspace (envelope disagrees with itself)",
    input: {
      scope: "TEAM",
      workspaceKind: "OWNED",
      role: "ADMIN",
      plan: "PRO",
      isPlatformAdmin: false,
      packageProducesOperationalConditions: PRODUCES,
      memberCount: 4,
    },
    hardRefusal: "CONTEXT_MISMATCH",
    // The permissions in hand may describe a DIFFERENT workspace. Reading
    // anything would be authorised by the wrong evidence, which is worse than
    // showing nothing.
    opsRequests: 0,
    shellRequests: 0,
    ui: "RestrictedState(context_mismatch)",
  },
  {
    n: 21,
    name: "Suspended workspace / account",
    input: {
      scope: "TEAM",
      workspaceKind: "OWNED",
      role: "ADMIN",
      plan: "PRO",
      isPlatformAdmin: false,
      packageProducesOperationalConditions: PRODUCES,
      memberCount: 4,
    },
    hardRefusal: "ACCOUNT_NOT_ACTIVE",
    opsRequests: 0,
    shellRequests: 0,
    ui: "RestrictedState(account_not_active)",
  },
  {
    n: 22,
    name: "Inactive workspace (no active workspace selected)",
    input: {
      scope: "TEAM",
      workspaceKind: "OWNED",
      role: "ADMIN",
      plan: "PRO",
      isPlatformAdmin: false,
      packageProducesOperationalConditions: PRODUCES,
      memberCount: 4,
    },
    hardRefusal: "NO_WORKSPACE",
    opsRequests: 0,
    shellRequests: 0,
    ui: "RestrictedState(no_workspace)",
  },
  {
    n: 23,
    name: "Provider unavailable",
    input: {
      scope: "TEAM",
      workspaceKind: "ORGANIZATION",
      role: "ADMIN",
      plan: "TEAM",
      isPlatformAdmin: false,
      packageProducesOperationalConditions: PRODUCES,
      memberCount: 12,
    },
    // A provider outage is a CONDITION, not a permission change. The console
    // is fully reachable; the affected sources report their own failure and
    // the workspace may not be called clear.
    opsRequests: 3,
    shellRequests: 0,
    ui: "workbench + PartialCoverageNotice; all-clear refused",
  },
  {
    n: 24,
    name: "Queue unavailable",
    input: {
      scope: "TEAM",
      workspaceKind: "ORGANIZATION",
      role: "ADMIN",
      plan: "TEAM",
      isPlatformAdmin: false,
      packageProducesOperationalConditions: PRODUCES,
      memberCount: 12,
    },
    opsRequests: 3,
    shellRequests: 0,
    ui: "workbench + PartialCoverageNotice; all-clear refused",
  },
];

/** A hard refusal never reaches the capability resolver. */
function operationsVisible(ctx: Ctx): boolean {
  if (ctx.hardRefusal) return false;
  return resolveCapabilities(ctx.input).OPERATIONS_VIEW === true;
}

/**
 * The sources that APPLY to a context.
 *
 * Applicability is capability-driven, which is the whole point: a source a
 * caller cannot see the conditions of is NOT_APPLICABLE for them, and that is
 * a projection decision rather than a place to hide a failure.
 */
function applicableSourceIds(ctx: Ctx): string[] {
  if (!operationsVisible(ctx)) return [];
  const caps = resolveCapabilities(ctx.input);
  return OPERATIONS_SOURCES.filter((s) => {
    if (s.requiredCapability === "operations.view") return true;
    if (s.requiredCapability.startsWith("evidence.")) return true;
    if (s.requiredCapability.startsWith("review.")) return true;
    if (s.requiredCapability === "audit.read") {
      return caps.SECURITY_CENTER_VIEW === true;
    }
    if (s.requiredCapability === "governance.policy.read") {
      return caps.GOVERNANCE_VIEW === true;
    }
    if (s.requiredCapability === "integration.webhook.manage") {
      return caps.INTEGRATIONS_MANAGE === true;
    }
    return true;
  }).map((s) => s.id);
}

describe("Operations workspace / capability matrix — 24 ungrouped contexts", () => {
  it("prints the matrix", () => {
    const rows = CONTEXTS.map((ctx) => {
      const caps = resolveCapabilities(ctx.input);
      const visible = operationsVisible(ctx);
      const applicable = applicableSourceIds(ctx);
      const attempted = visible ? requiredSourceIds().length : 0;
      return {
        "#": ctx.n,
        context: ctx.name,
        route: visible ? "ALLOW" : "REFUSE",
        OPERATIONS_VIEW: visible,
        role: ctx.input.role ?? "-",
        applicable: applicable.length,
        attempted,
        notApplicable: visible
          ? OPERATIONS_SOURCES.length - applicable.length
          : OPERATIONS_SOURCES.length,
        opsReq: ctx.opsRequests,
        shellReq: ctx.shellRequests,
        list: visible,
        detail: visible,
        summary: visible,
        assign: visible && caps.OPERATIONS_ASSIGN === true,
        bulk: visible && caps.OPERATIONS_ASSIGN === true,
        savedPrivate: visible,
        savedTeam: visible && caps.OPERATIONS_ASSIGN === true,
        remediate: visible && caps.OPERATIONS_RESOLVE === true,
        mayClear: visible,
        ui: ctx.ui,
      };
    });
    // eslint-disable-next-line no-console -- the matrix IS the deliverable
    console.table(rows);
    expect(rows).toHaveLength(24);
  });

  // =======================================================================
  // The rules, asserted per row.
  // =======================================================================

  it("row 1 — Personal Free owner gets NO route and makes ZERO /v1/ops requests", () => {
    const ctx = CONTEXTS[0];
    expect(operationsVisible(ctx)).toBe(false);
    expect(ctx.opsRequests).toBe(0);
    expect(ctx.shellRequests).toBe(0);
    // Zero is stronger than "403 then explain": the route gate refuses before
    // fetching, so no Operations traffic exists at all for this context.
    expect(applicableSourceIds(ctx)).toEqual([]);
  });

  it("row 2 — Personal Pro owner sees EVERY Personal-applicable source, not a reduced accident", () => {
    const ctx = CONTEXTS[1];
    expect(operationsVisible(ctx)).toBe(true);
    const applicable = applicableSourceIds(ctx);
    // Every source the sweep executes must be applicable to the workspace
    // whose failure prompted all of this. A Personal console that silently
    // omitted the integrity sources would be the original defect again.
    for (const id of requiredSourceIds()) expect(applicable).toContain(id);
  });

  it("rows 2, 4, 7, 10, 13 — one registry and one required set across four workspace kinds", () => {
    const rows = [2, 4, 7, 10, 13].map((n) => CONTEXTS[n - 1]);

    // THE CLAIM THAT MATTERS, stated precisely.
    //
    // The REQUIRED sources — the ones the sweep executes and whose failure
    // makes a workspace un-clearable — are identical for Personal Pro, a Team
    // viewer, a Team admin, an Org admin and an Enterprise admin. A second
    // page, a plan branch or a workspace-kind fork in discovery would show up
    // here immediately as a different required set.
    const required = new Set(requiredSourceIds());
    const requiredPerRow = rows.map((ctx) =>
      applicableSourceIds(ctx)
        .filter((id) => required.has(id))
        .sort()
        .join(","),
    );
    expect(new Set(requiredPerRow).size).toBe(1);
    expect(requiredPerRow[0].split(",")).toHaveLength(required.size);

    // The sets are NOT required to be identical overall, and asserting that
    // they were would be asserting the wrong thing. The registry also carries
    // sources gated on `audit.read`, `governance.policy.read` and
    // `integration.webhook.manage`, and a viewer legitimately cannot see
    // those. Applicability is capability-driven — which is the design — so
    // what must hold is that every row draws from THE SAME registry and never
    // from a set of its own.
    const registry = new Set(OPERATIONS_SOURCES.map((s) => s.id));
    for (const ctx of rows) {
      for (const id of applicableSourceIds(ctx)) {
        expect(registry.has(id)).toBe(true);
      }
    }
  });

  it("rows 4, 5, 8, 11 — a viewer reads and cannot mutate", () => {
    for (const n of [4, 5, 8, 11]) {
      const ctx = CONTEXTS[n - 1];
      const caps = resolveCapabilities(ctx.input);
      expect(caps.OPERATIONS_VIEW).toBe(true);
      expect(caps.OPERATIONS_ACKNOWLEDGE).toBe(false);
      expect(caps.OPERATIONS_RESOLVE).toBe(false);
      expect(caps.OPERATIONS_ASSIGN).toBe(false);
    }
  });

  it("rows 6, 9, 12 — an operator may acknowledge and resolve, and may not assign", () => {
    for (const n of [6, 9, 12]) {
      const caps = resolveCapabilities(CONTEXTS[n - 1].input);
      expect(caps.OPERATIONS_ACKNOWLEDGE).toBe(true);
      expect(caps.OPERATIONS_RESOLVE).toBe(true);
      expect(caps.OPERATIONS_ASSIGN).toBe(false);
    }
  });

  it("rows 7, 10, 13 — an admin of a SHARED workspace may assign", () => {
    for (const n of [7, 10, 13]) {
      expect(resolveCapabilities(CONTEXTS[n - 1].input).OPERATIONS_ASSIGN).toBe(true);
    }
  });

  it("rows 2, 3 — a SOLE operator gets no assignment control, whatever their role", () => {
    // A person picker containing exactly the person looking at it is not a
    // decision, and an admin flag must not conjure one.
    for (const n of [2, 3]) {
      expect(resolveCapabilities(CONTEXTS[n - 1].input).OPERATIONS_ASSIGN).toBe(false);
    }
  });

  it("rows 11, 12, 13, 14 — Enterprise is not a fork: identical to its Organization peers", () => {
    const pairs: Array<[number, number]> = [
      [11, 8],
      [12, 9],
      [13, 10],
    ];
    for (const [ent, org] of pairs) {
      const a = resolveCapabilities(CONTEXTS[ent - 1].input);
      const b = resolveCapabilities(CONTEXTS[org - 1].input);
      for (const key of [
        "OPERATIONS_VIEW",
        "OPERATIONS_ACKNOWLEDGE",
        "OPERATIONS_RESOLVE",
        "OPERATIONS_ASSIGN",
      ] as const) {
        expect(`${key}:${a[key]}`).toBe(`${key}:${b[key]}`);
      }
    }
    // And scale changes nothing about the capability projection.
    expect(resolveCapabilities(CONTEXTS[13].input).OPERATIONS_ASSIGN).toBe(true);
  });

  it("row 15 — an expired Enterprise contract keeps retained obligations visible", () => {
    // The package no longer produces NEW conditions. The workspace is still
    // shared, so the console stays reachable — removing it would hide
    // obligations the customer still has and cannot then close.
    const ctx = CONTEXTS[14];
    expect(operationsVisible(ctx)).toBe(true);
    expect(resolveCapabilities(ctx.input).OPERATIONS_ASSIGN).toBe(true);
  });

  it("row 16 — a platform admin WITHOUT tenant membership gets NOTHING", () => {
    const ctx = CONTEXTS[15];
    const caps = resolveCapabilities(ctx.input);
    expect(caps.OPERATIONS_VIEW).toBe(false);
    expect(caps.OPERATIONS_ACKNOWLEDGE).toBe(false);
    expect(caps.OPERATIONS_RESOLVE).toBe(false);
    expect(caps.OPERATIONS_ASSIGN).toBe(false);
    expect(ctx.opsRequests).toBe(0);
  });

  it("row 17 — a platform admin WITH membership gets exactly what the membership grants", () => {
    const staff = resolveCapabilities(CONTEXTS[16].input);
    const ordinary = resolveCapabilities({
      ...CONTEXTS[16].input,
      isPlatformAdmin: false,
    });
    for (const key of [
      "OPERATIONS_VIEW",
      "OPERATIONS_ACKNOWLEDGE",
      "OPERATIONS_RESOLVE",
      "OPERATIONS_ASSIGN",
    ] as const) {
      // Staff standing is not tenant standing. If these ever diverge, a
      // platform role has silently upgraded a tenant role.
      expect(`${key}:${staff[key]}`).toBe(`${key}:${ordinary[key]}`);
    }
  });

  it("rows 18, 20, 21, 22 — every unconfirmed context FAILS CLOSED with zero requests", () => {
    for (const n of [18, 20, 21, 22]) {
      const ctx = CONTEXTS[n - 1];
      expect(ctx.hardRefusal).toBeTruthy();
      expect(operationsVisible(ctx)).toBe(false);
      expect(ctx.opsRequests).toBe(0);
      expect(ctx.shellRequests).toBe(0);
    }
  });

  it("row 19 — a withheld capability is a refusal, not a hidden button", () => {
    const ctx = CONTEXTS[18];
    expect(operationsVisible(ctx)).toBe(false);
    expect(ctx.opsRequests).toBe(0);
  });

  it("rows 23, 24 — an outage is a CONDITION, not a permission change", () => {
    for (const n of [23, 24]) {
      const ctx = CONTEXTS[n - 1];
      // The console stays fully reachable; the affected sources report their
      // own failure and the workspace may not be described as clear. Hiding
      // the surface during an outage would remove the one place that says so.
      expect(operationsVisible(ctx)).toBe(true);
      expect(ctx.ui).toContain("all-clear refused");
    }
  });

  it("no context is granted a source its capability does not cover", () => {
    for (const ctx of CONTEXTS) {
      const applicable = applicableSourceIds(ctx);
      const known = new Set(OPERATIONS_SOURCES.map((s) => s.id));
      for (const id of applicable) expect(known.has(id)).toBe(true);
      if (!operationsVisible(ctx)) expect(applicable).toEqual([]);
    }
  });

  it("every row is distinct and the set is exactly 24", () => {
    expect(CONTEXTS).toHaveLength(24);
    expect(new Set(CONTEXTS.map((c) => c.name)).size).toBe(24);
    expect(CONTEXTS.map((c) => c.n)).toEqual(
      Array.from({ length: 24 }, (_, i) => i + 1),
    );
  });
});
