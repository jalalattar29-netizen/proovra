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
const CONTROL = read("apps/web/components/operations/IncidentAssignmentControl.tsx");
const CONSOLE_PAGE = read("apps/web/app/(app)/operations/page.tsx");

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
  it("the console renders it", () => {
    expect(CONSOLE_PAGE).toContain("<IncidentAssignmentControl");
    expect(CONSOLE_PAGE).toContain("canAssign={canAssign}");
  });

  it("the current owner is projected by the API so it can be shown", () => {
    expect(SERVICE).toMatch(/assignedOperatorUserId: i\.assignedOperatorUserId/);
    expect(CONSOLE_PAGE).toContain("assignedOperatorUserId: string | null;");
  });

  it("offers assign, self-assign and unassign", () => {
    expect(CONTROL).toContain('data-ops-assignment-select');
    expect(CONTROL).toContain('data-ops-action="self-assign"');
    expect(CONTROL).toContain('data-ops-action="unassign"');
  });

  it("a caller who may NOT assign still sees who owns it, read-only", () => {
    expect(CONTROL).toContain("data-ops-assignee-readonly");
    expect(CONTROL).toMatch(/if \(!canAssign\) \{/);
  });

  it("uses a native select — keyboard and screen-reader operable", () => {
    // The repository bans reinventing a listbox, and a native control is
    // mobile-native for free.
    expect(CONTROL).toMatch(/<select/);
    expect(CONTROL).not.toMatch(/role="listbox"/);
    expect(CONTROL).toContain("htmlFor={`assign-${incidentId}`}");
    expect(CONTROL).toContain("id={`assign-${incidentId}`}");
  });

  it("the label names the action AND the condition", () => {
    expect(CONTROL).toContain("Assign this condition to an operator");
    expect(CONTROL).toContain("ops-visually-hidden");
  });

  it("busy and error states are ANNOUNCED, not only shown", () => {
    expect(CONTROL).toMatch(/role="status"/);
    expect(CONTROL).toMatch(/role="alert"/);
  });

  it("errors flow through the sanctioned feedback path", () => {
    expect(CONTROL).toContain("toSafeUserError");
    expect(CONTROL).not.toMatch(/err\.message/);
  });

  it("the eligible set is fetched once per workspace, not per row", () => {
    // A console showing fifty conditions must not make fifty identical
    // membership queries.
    expect(CONTROL).toMatch(
      /if \(state\.kind === "ready" \|\| state\.kind === "loading"\) return;/,
    );
  });

  it("assignment re-reads from the server rather than patching locally", () => {
    // The server re-checks eligibility, so an optimistic write could show an
    // owner the backend refused.
    expect(CONSOLE_PAGE).toContain("setReloadToken((n) => n + 1)");
    expect(CONSOLE_PAGE).toMatch(/\}, \[teamId, status, severity, reloadToken\]\)/);
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
