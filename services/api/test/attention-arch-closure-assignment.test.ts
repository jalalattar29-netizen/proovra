/**
 * OPERATIONS ASSIGNMENT — END TO END (Attention Architecture closure pass).
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS BROKEN
 * ---------------------------------------------------------------------------
 * `OPERATIONS_ASSIGN` was granted. `POST /v1/ops/incidents/:id/assign` existed
 * and was audited. `assignedOperatorUserId` was persisted. And there was:
 *
 *   * no control anywhere in the product — the capability was unreachable;
 *   * no way to discover WHO could be assigned;
 *   * no projection of the current owner, so no surface could show it;
 *   * no unassign;
 *   * and a validation hole — the assignee check was
 *     `teamMember.findFirst({ teamId, userId })` with NO status predicate, so
 *     a SUSPENDED or REVOKED member was assignable.
 *
 * That last one is the dangerous one. A condition assigned to somebody who
 * cannot open the workspace looks owned and is not, and an invisibly stuck
 * condition is worse than a visibly unassigned one.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { roleHasPermission } from "@proovra/shared";

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), "utf8");
}

/** Source with comments removed — for "is this actually the code?" checks. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

const OPS_ROUTES = read("services/api/src/routes/ops.routes.ts");
const RESOLVER = read(
  "services/api/src/services/operations/assignable-operators.service.ts",
);
const SERVICE = read("services/api/src/services/observability/incident.service.ts");
// The assignment control moved into the Operations route when the workbench
// was rebuilt: it is presentation for ONE route, and living under
// components/operations/ implied a second surface would mount it.
const CONTROL = read(
  "apps/web/app/(app)/operations/_components/AssignmentControl.tsx",
);
const INSPECTOR = read(
  "apps/web/app/(app)/operations/_components/IncidentInspector.tsx",
);
const CONSOLE_PAGE = read("apps/web/app/(app)/operations/page.tsx");
const ROW_MODEL = read("apps/web/app/(app)/operations/_lib/rowModel.ts");

// ============================================================================
// The eligible-assignee resolver
// ============================================================================

/** A fake client so the predicate can be exercised without a database. */
function clientWith(members: Array<Record<string, unknown>>) {
  return {
    teamMember: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        // Model the two predicates the resolver must send.
        const wantsActive = where.status === "ACTIVE";
        const expiryClause = where.OR as
          | Array<{ accessExpiresAtUtc: null | { gt: Date } }>
          | undefined;
        return members.filter((m) => {
          if (m.teamId !== where.teamId) return false;
          if (wantsActive && m.status !== "ACTIVE") return false;
          if (expiryClause) {
            const expiry = m.accessExpiresAtUtc as Date | null;
            if (expiry !== null && expiry.getTime() <= Date.now()) return false;
          }
          return true;
        });
      }),
    },
  };
}

const TEAM = "11111111-1111-4111-8111-111111111111";
const OTHER_TEAM = "22222222-2222-4222-8222-222222222222";

function member(overrides: Record<string, unknown>) {
  return {
    teamId: TEAM,
    userId: "u-1",
    role: "ADMIN",
    status: "ACTIVE",
    accessExpiresAtUtc: null,
    user: { displayName: "A", email: "a@example.com" },
    ...overrides,
  };
}

describe("Closure — the eligible-assignee resolver", () => {
  async function list(members: Array<Record<string, unknown>>, teamId = TEAM) {
    const { listAssignableOperators } = await import(
      "../src/services/operations/assignable-operators.service.js"
    );
    return listAssignableOperators(
      { teamId },
      clientWith(members) as never,
    );
  }

  it("offers ACTIVE members who can act on operational work", async () => {
    const operators = await list([
      member({ userId: "owner", role: "OWNER" }),
      member({ userId: "admin", role: "ADMIN" }),
      member({ userId: "reviewer", role: "MEMBER" }),
    ]);
    expect(operators.map((o) => o.userId).sort()).toEqual([
      "admin",
      "owner",
      "reviewer",
    ]);
  });

  it("REFUSES a suspended member", async () => {
    const operators = await list([
      member({ userId: "suspended", status: "SUSPENDED" }),
    ]);
    expect(operators).toEqual([]);
  });

  it("REFUSES a revoked member", async () => {
    const operators = await list([
      member({ userId: "revoked", status: "REVOKED" }),
    ]);
    expect(operators).toEqual([]);
  });

  it("REFUSES a member whose temporary access has expired", async () => {
    const operators = await list([
      member({
        userId: "expired",
        accessExpiresAtUtc: new Date(Date.now() - 60_000),
      }),
    ]);
    expect(operators).toEqual([]);
    // …and keeps one whose access has not.
    const live = await list([
      member({
        userId: "still-here",
        accessExpiresAtUtc: new Date(Date.now() + 60_000),
      }),
    ]);
    expect(live.map((o) => o.userId)).toEqual(["still-here"]);
  });

  it("REFUSES a VIEWER — an owner who cannot close it is not an owner", async () => {
    // A viewer may look at Operations and act on nothing, so handing them a
    // condition would create ownership nobody can discharge.
    expect(roleHasPermission("VIEWER", "operations.acknowledge")).toBe(false);
    const operators = await list([
      member({ userId: "viewer", role: "VIEWER" }),
    ]);
    expect(operators).toEqual([]);
  });

  it("NEVER offers somebody from another workspace", async () => {
    const operators = await list([
      member({ userId: "ours" }),
      member({ userId: "theirs", teamId: OTHER_TEAM }),
    ]);
    expect(operators.map((o) => o.userId)).toEqual(["ours"]);
  });

  it("the write path validates through the SAME resolver as the picker", async () => {
    // Two implementations of "who is eligible" is how the list an operator
    // sees and the set the server accepts come apart.
    expect(RESOLVER).toContain("export async function isAssignableOperator");
    expect(RESOLVER).toMatch(
      /isAssignableOperator[\s\S]{0,600}listAssignableOperators\(/,
    );
    expect(OPS_ROUTES).toContain("isAssignableOperator({");
  });

  it("the status-blind membership check is GONE from the assign route", () => {
    const at = OPS_ROUTES.indexOf('"/v1/ops/incidents/:id/assign"');
    expect(at).toBeGreaterThan(0);
    const block = OPS_ROUTES.slice(at, at + 2600);
    expect(block).not.toMatch(
      /teamMember\.findFirst\(\{\s*where: \{ teamId: body\.teamId, userId: body\.assigneeUserId \}/,
    );
  });
});

// ============================================================================
// Authorization
// ============================================================================

describe("Closure — assignment authorization fails closed", () => {
  it("the picker itself requires operations.assign", () => {
    const at = OPS_ROUTES.indexOf('"/v1/ops/assignable-operators"');
    expect(at).toBeGreaterThan(0);
    const block = OPS_ROUTES.slice(at, at + 900);
    expect(block).toContain('"operations.assign"');
  });

  it("the mutation requires operations.assign", () => {
    const at = OPS_ROUTES.indexOf('"/v1/ops/incidents/:id/assign"');
    const block = OPS_ROUTES.slice(at, at + 900);
    expect(block).toContain(
      'requireOpsCapability(req, reply, body.teamId, "operations.assign")',
    );
  });

  it("only ADMIN and OWNER may assign — a reviewer operates, not routes", () => {
    for (const role of ["OWNER", "ADMIN"] as const) {
      expect(roleHasPermission(role, "operations.assign")).toBe(true);
    }
    for (const role of ["REVIEWER", "CONTRIBUTOR", "VIEWER"] as const) {
      expect(roleHasPermission(role, "operations.assign")).toBe(false);
    }
  });

  it("a platform admin with no workspace membership gets the 404", () => {
    // `requireOpsCapability` looks up TeamMember FIRST and anti-enumerates.
    // Platform elevation is not workspace authority.
    expect(OPS_ROUTES).toMatch(
      /async function requireOpsCapability\([\s\S]{0,900}prisma\.teamMember\.findUnique[\s\S]{0,300}code: "not_found"/,
    );
  });

  it("the workspace boundary is structural, not checked", () => {
    // The resolver is scoped to `teamId`, so a foreign user cannot appear in
    // the eligible set at all — there is no comparison to get wrong.
    expect(RESOLVER).toMatch(/where: \{\s*\n\s*teamId: input\.teamId,/);
  });
});

// ============================================================================
// Unassign + audit
// ============================================================================

describe("Closure — unassign and the audit trail", () => {
  it("null means unassign, on the same route and the same gate", () => {
    expect(OPS_ROUTES).toMatch(/assigneeUserId: z\.string\(\)\.uuid\(\)\.nullable\(\)/);
    expect(SERVICE).toMatch(/assigneeUserId: string \| null;/);
    expect(SERVICE).toContain("const isUnassign = input.assigneeUserId === null;");
  });

  it("unassign clears the actor and timestamp too", () => {
    // Leaving them would render "assigned by X at T" beside an empty owner.
    expect(SERVICE).toMatch(/assignedByUserId: isUnassign \? null : input\.actorUserId/);
    expect(SERVICE).toMatch(/assignedAtUtc: isUnassign \? null : new Date\(\)/);
  });

  it("the audit records the full transition, not just the destination", () => {
    expect(SERVICE).toContain(
      "const previousAssigneeUserId = existing.assignedOperatorUserId;",
    );
    expect(SERVICE).toMatch(/previousAssigneeUserId,/);
    expect(SERVICE).toMatch(
      /action: isUnassign\s*\n?\s*\? "observability\.incident\.unassigned"\s*\n?\s*: "observability\.incident\.assigned"/,
    );
    // actor, workspace, resource and timestamp already travel on every
    // tenant-audit event.
    expect(SERVICE).toMatch(/actorUserId: input\.actorUserId/);
    expect(SERVICE).toMatch(/workspaceId: existing\.teamId/);
  });

  it("history survives an unassign — attribution is not erased", () => {
    expect(SERVICE).toMatch(/eventType: isUnassign \? "unassigned" : "assigned"/);
  });
});

// ============================================================================
// The control itself
// ============================================================================

describe("Closure — the assignment control is reachable and accessible", () => {
  it("the workbench reaches it through the incident inspector", () => {
    // Ownership is a DECISION, so it lives where the operator has the
    // context to make it. The row offers Change owner, which opens the
    // inspector; the inspector renders the control.
    expect(CONSOLE_PAGE).toContain("<IncidentInspector");
    expect(INSPECTOR).toContain("<AssignmentControl");
    expect(INSPECTOR).toContain("canAssign={capabilities.canAssign}");
  });

  it("the current owner is projected by the API so it can be shown", () => {
    expect(SERVICE).toMatch(/assignedOperatorUserId: i.assignedOperatorUserId/);
    expect(ROW_MODEL).toContain("assignedOperatorUserId: i.assignedOperatorUserId");
  });

  it("offers assign, self-assign and unassign", () => {
    // Unassign is the first OPTION rather than a second button: assign,
    // reassign and unassign are one transition on one column, and giving
    // that column two controls gives it two ways to disagree with itself.
    expect(CONTROL).toContain("const UNASSIGNED =");
    expect(CONTROL).toContain('label: "Unassigned"');
    expect(CONTROL).toContain("onAssign(v === UNASSIGNED ? null : v)");
    expect(CONTROL).toContain('data-ops-action="self-assign"');
  });

  it("a caller who may NOT assign still sees who owns it, read-only", () => {
    expect(CONTROL).toContain("data-ops-assignee-readonly");
    expect(CONTROL.includes("if (!canAssign) {")).toBe(true);
  });

  it("uses the canonical AppListbox, not a native select", () => {
    // It WAS a native select. Every other redesigned surface in the product
    // uses AppListbox, whose popup can be styled, escapes a clipping
    // ancestor through a portal, and has an audited keyboard contract; the
    // OS popup beside it read as a control from a different product.
    expect(CONTROL).toContain("AppListbox");
    // Asserted over CODE: the module header explains the control it replaced
    // and names the element by hand, so a whole-file search would match the
    // explanation rather than a live mount. `stripComments` is the same
    // tightening this file already applies to the single-operator check.
    const controlCode = stripComments(CONTROL);
    expect(controlCode.includes("<select")).toBe(false);
    expect(CONTROL).toContain("ariaLabelledby={labelId}");
  });

  it("the eligible set is fetched once per workspace, not per row", () => {
    // A queue of fifty conditions must not make fifty identical membership
    // queries. The ORCHESTRATOR owns the read and passes the result down, so
    // the control cannot fetch at all.
    expect(CONSOLE_PAGE).toContain("/v1/ops/assignable-operators");
    expect(CONTROL).not.toContain("apiFetch");
  });

  it("assignment re-reads from the server rather than patching locally", () => {
    // The server re-checks eligibility, so an optimistic write could show an
    // owner the backend refused.
    expect(CONSOLE_PAGE).toContain("const refresh = React.useCallback(() => setReloadToken((n) => n + 1)");
  });

  it("errors flow through the sanctioned feedback path", () => {
    expect(CONSOLE_PAGE).toContain("toSafeUserError");
    expect(CONSOLE_PAGE).not.toMatch(/err.message/);
  });
});
// ============================================================================
// Personal Pro — no meaningless picker
// ============================================================================

describe("Closure — a sole operator gets no person picker", () => {
  it("the control is capability-driven, with no plan or personal branch", async () => {
    const { resolveCapabilities } = await import(
      "../src/services/platform-context/capability-registry.js"
    );
    // A solo Pro workspace produces conditions, so it HAS Operations — and it
    // has nobody to assign to, so it is granted no OPERATIONS_ASSIGN.
    const solo = resolveCapabilities({
      scope: "PERSONAL",
      role: "OWNER",
      plan: "PRO",
      isPlatformAdmin: false,
      workspaceKind: "PERSONAL",
      packageProducesOperationalConditions: true,
      memberCount: 1,
    });
    expect(solo.OPERATIONS_VIEW).toBe(true);
    expect(solo.OPERATIONS_ASSIGN).toBeFalsy();

    // The control reads that boolean and nothing else. Asserted over CODE:
    // the module header explains the single-operator behaviour and names the
    // checks it deliberately does NOT make, so a whole-file search would
    // match the explanation rather than the thing.
    const controlCode = stripComments(CONTROL);
    expect(controlCode).not.toMatch(/isPersonal|plan ===|memberCount/);
  });

  it("a shared workspace's admin DOES get it", async () => {
    const { resolveCapabilities } = await import(
      "../src/services/platform-context/capability-registry.js"
    );
    const shared = resolveCapabilities({
      scope: "TEAM",
      role: "ADMIN",
      plan: "TEAM",
      isPlatformAdmin: false,
      workspaceKind: "ORGANIZATION",
      packageProducesOperationalConditions: true,
      memberCount: 5,
    });
    expect(shared.OPERATIONS_ASSIGN).toBe(true);
  });
});
