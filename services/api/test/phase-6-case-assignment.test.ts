/**
 * Phase 6 (Enterprise Collaboration) — SCOPE B: CASE/MATTER ASSIGNMENT.
 *
 * The canonical case-assignment capability already existed end-to-end
 * (model CaseAssignment, service add/removeCaseAssignment, routes
 * POST/DELETE /v1/cases/:id/assignments, gate
 * evaluateCaseMutationPermission("ASSIGN"), matter-queue
 * `?assignedToUserId=&status=` filter). This suite pins the SCOPE-B
 * contract behaviorally against that reused capability:
 *
 *   - assign a case to a user (create ACTIVE CaseAssignment)
 *   - change assignment (idempotent reactivation of a REMOVED row)
 *   - unassign (soft REMOVE, not a delete)
 *   - unauthorized actor cannot assign (403 via the ASSIGN gate)
 *   - assignment enforces workspace membership (invalid_assignee)
 *   - assignment does NOT alter case ownership / custody / evidence
 *     (the write touches ONLY the case_assignments table)
 *   - every assign / unassign writes a canonical platform audit row
 *
 * The service functions accept an injected Prisma client, so we drive
 * them with a bounded mock client + a mocked audit sink. This keeps the
 * test deterministic and offline (no live DB required).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the canonical audit sink BEFORE importing the SUT so the service
// binds to the stub. We assert on this to prove audit emission.
// `vi.hoisted` keeps the mock fn accessible from the hoisted factory.
const { appendPlatformAuditLogMock } = vi.hoisted(() => ({
  appendPlatformAuditLogMock: vi.fn(async () => undefined),
}));
vi.mock("../src/services/platform-audit-log.service.js", () => ({
  appendPlatformAuditLog: appendPlatformAuditLogMock,
}));

// Members audit ACC-05 — the assignee must be able to open the case. The
// record authority is substituted here (these cases are about the assignment
// row); a refusal case below proves the writer asks it.
const reach = vi.hoisted(() => ({ allowed: true }));
vi.mock("../src/services/cases/case-permission.service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveCaseRecordAccess: vi.fn(async () => ({ allowed: reach.allowed })),
}));

import {
  addCaseAssignment,
  removeCaseAssignment,
  CaseError,
} from "../src/services/cases/case-lifecycle.service.js";
import { evaluateCaseMutationPermission } from "../src/services/cases/case-permission.service.js";

// THE ONE ASSIGNEE AUTHORITY (`assertWorkAssigneeEligible`) is proven against
// PostgreSQL in members-unassigned-rule.integration.test.ts and
// members-assignment-surfaces.integration.test.ts. `addCaseAssignment` asks it
// inside the write's transaction, and there it reads capability through the
// real default client — which this offline suite has no database for. So the
// authority is substituted by a faithful miniature of its two rules that this
// suite's fake can model: (1) an ACTIVE membership row on the transaction
// client (`makeClient({ member: null })` removes it), and (2) reach to the case
// through the record authority mocked above (`reach.allowed`). Either failing
// throws the real `AssigneeEligibilityError("NOT_ELIGIBLE")`, so the SERVICE's
// own mapping to `invalid_assignee` is what the refusal cases below test.
const authority = vi.hoisted(() => ({
  calls: [] as Array<{ input: Record<string, unknown>; inTransaction: boolean }>,
}));
vi.mock("../src/services/assignment/assignee-eligibility.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/assignment/assignee-eligibility.js")>();
  const { resolveCaseRecordAccess } = await import("../src/services/cases/case-permission.service.js");
  return {
    ...actual,
    assertWorkAssigneeEligible: vi.fn(
      async (
        input: { workspaceId: string; assigneeUserId: string; permission: string; caseId?: string | null },
        client: { teamMember: { findFirst: (a: unknown) => Promise<unknown> } },
        options: { inTransaction?: boolean } = {},
      ) => {
        authority.calls.push({ input, inTransaction: options.inTransaction === true });
        const member = await client.teamMember.findFirst({
          where: { teamId: input.workspaceId, userId: input.assigneeUserId, status: "ACTIVE" },
        });
        if (!member) throw new actual.AssigneeEligibilityError("NOT_ELIGIBLE");
        if (input.caseId) {
          const r = await resolveCaseRecordAccess(
            { userId: input.assigneeUserId, caseId: input.caseId },
            client as never,
          );
          if (!r.allowed) throw new actual.AssigneeEligibilityError("NOT_ELIGIBLE");
        }
      },
    ),
  };
});


// The placement prerequisite is proven against PostgreSQL in
// members-unassigned-rule.integration.test.ts; this suite tests its own module.
// PLACEMENT IS NOT THIS SUITE'S SUBJECT (members re-audit defect 22). The
// placement seam is stubbed open so the suite isolates its own rule; this mock
// proves nothing about the unassigned-member rule. The placement proof drives
// every assignment writer over HTTP against real PostgreSQL in
// members-assignment-surfaces.integration.test.ts (and the service-level
// members-unassigned-rule.integration.test.ts).
vi.mock("../src/services/assignment/placement-policy.js", () => ({
  assignmentRequiresPlacement: async () => false,
  meetsPlacementPolicy: async () => true,
  placedUserIdsForWorkspace: async (_workspaceId: string, ids: readonly string[]) => new Set(ids),
}));


type AnyFn = ReturnType<typeof vi.fn>;

function makeClient(overrides?: {
  caseRow?: { id: string; teamId: string | null } | null;
  member?: { id: string } | null;
  existingAssignment?: Record<string, unknown> | null;
}) {
  const caseRow =
    overrides?.caseRow === undefined
      ? { id: "case-1", teamId: "team-1" }
      : overrides.caseRow;
  const client = {
    case: {
      findUnique: vi.fn(async () => caseRow),
    },
    teamMember: {
      findFirst: vi.fn(async () =>
        overrides?.member === undefined ? { id: "tm-1" } : overrides.member,
      ),
    },
    caseAssignment: {
      findFirst: vi.fn(async () => overrides?.existingAssignment ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "asg-created",
        status: "ACTIVE",
        ...data,
      })),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => ({
          id: where.id,
          assignedToUserId: "user-2",
          role: "INVESTIGATOR",
          teamId: "team-1",
          ...data,
        }),
      ),
    },
  };
  return client as unknown as Parameters<typeof addCaseAssignment>[1] & {
    case: { findUnique: AnyFn };
    teamMember: { findFirst: AnyFn };
    caseAssignment: { findFirst: AnyFn; create: AnyFn; update: AnyFn };
  };
}

beforeEach(() => {
  reach.allowed = true;
  authority.calls.length = 0;
  appendPlatformAuditLogMock.mockClear();
});

describe("SCOPE B — assign a case to a user", () => {
  it("creates an ACTIVE CaseAssignment and writes an audit row", async () => {
    const client = makeClient();
    const row = await addCaseAssignment(
      {
        caseId: "case-1",
        assignedToUserId: "user-2",
        role: "INVESTIGATOR",
        note: "picked up",
        actorUserId: "admin-1",
      },
      client,
    );
    expect(client.caseAssignment.create).toHaveBeenCalledTimes(1);
    expect(row.status).toBe("ACTIVE");
    // The writer asked the one assignee authority, inside its write, with the
    // work the case role names (B6) and the case it must reach.
    expect(authority.calls).toEqual([
      {
        input: {
          workspaceId: "team-1",
          assigneeUserId: "user-2",
          permission: "evidence.update_metadata",
          caseId: "case-1",
        },
        inTransaction: true,
      },
    ]);
    // Audit emitted with the canonical action + no secret payload.
    expect(appendPlatformAuditLogMock).toHaveBeenCalledTimes(1);
    const audit = (
      appendPlatformAuditLogMock.mock.calls[0] as unknown as [
        {
          action: string;
          resourceType: string;
          metadata: Record<string, unknown>;
        },
      ]
    )[0];
    expect(audit.action).toBe("cases.assignment_added");
    expect(audit.resourceType).toBe("case_assignment");
    expect(audit.metadata.assignedToUserId).toBe("user-2");
    expect(audit.metadata.role).toBe("INVESTIGATOR");
  });

  it("enforces workspace membership on team cases (invalid_assignee)", async () => {
    const client = makeClient({ member: null });
    await expect(
      addCaseAssignment(
        {
          caseId: "case-1",
          assignedToUserId: "outsider",
          role: "REVIEWER",
          actorUserId: "admin-1",
        },
        client,
      ),
    ).rejects.toMatchObject({ code: "invalid_assignee" });
    expect(client.caseAssignment.create).not.toHaveBeenCalled();
    expect(appendPlatformAuditLogMock).not.toHaveBeenCalled();
  });

  it("rejects assignment on a missing case (case_not_found)", async () => {
    const client = makeClient({ caseRow: null });
    await expect(
      addCaseAssignment(
        {
          caseId: "missing",
          assignedToUserId: "user-2",
          role: "OWNER",
          actorUserId: "admin-1",
        },
        client,
      ),
    ).rejects.toMatchObject({ code: "case_not_found" });
  });
});

describe("SCOPE B — change assignment (idempotent reactivation)", () => {
  it("reactivates a REMOVED row instead of creating a duplicate", async () => {
    const client = makeClient({
      existingAssignment: {
        id: "asg-old",
        status: "REMOVED",
        role: "INVESTIGATOR",
        assignedToUserId: "user-2",
      },
    });
    const row = await addCaseAssignment(
      {
        caseId: "case-1",
        assignedToUserId: "user-2",
        role: "INVESTIGATOR",
        actorUserId: "admin-1",
      },
      client,
    );
    expect(client.caseAssignment.update).toHaveBeenCalledTimes(1);
    expect(client.caseAssignment.create).not.toHaveBeenCalled();
    expect(row.status).toBe("ACTIVE");
  });

  it("rejects a duplicate ACTIVE assignment (assignment_exists)", async () => {
    const client = makeClient({
      existingAssignment: {
        id: "asg-live",
        status: "ACTIVE",
        role: "INVESTIGATOR",
        assignedToUserId: "user-2",
      },
    });
    await expect(
      addCaseAssignment(
        {
          caseId: "case-1",
          assignedToUserId: "user-2",
          role: "INVESTIGATOR",
          actorUserId: "admin-1",
        },
        client,
      ),
    ).rejects.toMatchObject({ code: "assignment_exists" });
  });
});

describe("SCOPE B — unassign", () => {
  it("soft-REMOVEs the assignment (never deletes) and audits it", async () => {
    const client = makeClient();
    client.caseAssignment.findFirst = vi.fn(async () => ({
      id: "asg-1",
      caseId: "case-1",
      teamId: "team-1",
      assignedToUserId: "user-2",
      role: "INVESTIGATOR",
      status: "ACTIVE",
    })) as AnyFn;
    const row = await removeCaseAssignment(
      { caseId: "case-1", assignmentId: "asg-1", actorUserId: "admin-1" },
      client,
    );
    // Soft remove: update to REMOVED, no delete call exists on the client.
    expect(client.caseAssignment.update).toHaveBeenCalledTimes(1);
    const updateArg = client.caseAssignment.update.mock.calls[0][0] as {
      data: { status: string };
    };
    expect(updateArg.data.status).toBe("REMOVED");
    expect(row.status).toBe("REMOVED");
    expect(appendPlatformAuditLogMock).toHaveBeenCalledTimes(1);
    expect(
      (
        appendPlatformAuditLogMock.mock.calls[0] as unknown as [
          { action: string },
        ]
      )[0].action,
    ).toBe("cases.assignment_removed");
  });

  it("rejects unassigning a non-existent row (assignment_not_found)", async () => {
    const client = makeClient();
    client.caseAssignment.findFirst = vi.fn(async () => null) as AnyFn;
    await expect(
      removeCaseAssignment(
        { caseId: "case-1", assignmentId: "nope", actorUserId: "admin-1" },
        client,
      ),
    ).rejects.toMatchObject({ code: "assignment_not_found" });
  });
});

describe("SCOPE B — permission gate (assignment requires manage-level)", () => {
  it("VIEWER cannot assign", () => {
    const d = evaluateCaseMutationPermission({
      mutation: "ASSIGN",
      accessRole: "VIEWER",
      assignmentRoles: [],
    });
    expect(d.allowed).toBe(false);
  });

  it("plain MEMBER (team writer) cannot assign", () => {
    const d = evaluateCaseMutationPermission({
      mutation: "ASSIGN",
      accessRole: "MEMBER",
      assignmentRoles: [],
    });
    expect(d.allowed).toBe(false);
  });

  it("OWNER / ADMIN workspace role CAN assign", () => {
    for (const role of ["OWNER", "ADMIN"] as const) {
      expect(
        evaluateCaseMutationPermission({
          mutation: "ASSIGN",
          accessRole: role,
          assignmentRoles: [],
        }).allowed,
      ).toBe(true);
    }
  });

  it("a case-OWNER assignment CAN assign even as a MEMBER", () => {
    expect(
      evaluateCaseMutationPermission({
        mutation: "ASSIGN",
        accessRole: "MEMBER",
        assignmentRoles: ["OWNER"],
      }).allowed,
    ).toBe(true);
  });
});

describe("SCOPE B — assignment is NOT ownership / custody / evidence mutation", () => {
  it("the add path touches ONLY the case_assignments table", async () => {
    const client = makeClient();
    // Attach spies for tables that MUST NOT be written by an assignment.
    (client as unknown as Record<string, unknown>).evidence = {
      update: vi.fn(),
      updateMany: vi.fn(),
    };
    (client as unknown as Record<string, unknown>).custodyEvent = {
      create: vi.fn(),
    };
    // case.update would rewrite ownership — it must never be called.
    (client.case as unknown as { update: AnyFn }).update = vi.fn();

    await addCaseAssignment(
      {
        caseId: "case-1",
        assignedToUserId: "user-2",
        role: "REVIEWER",
        actorUserId: "admin-1",
      },
      client,
    );

    expect(
      (client.case as unknown as { update: AnyFn }).update,
    ).not.toHaveBeenCalled();
    expect(
      (client as unknown as { evidence: { update: AnyFn } }).evidence.update,
    ).not.toHaveBeenCalled();
    expect(
      (client as unknown as { evidence: { updateMany: AnyFn } }).evidence
        .updateMany,
    ).not.toHaveBeenCalled();
    expect(
      (client as unknown as { custodyEvent: { create: AnyFn } }).custodyEvent
        .create,
    ).not.toHaveBeenCalled();
  });
});

describe("SCOPE B — CaseError type is exported for route mapping", () => {
  it("throws a CaseError instance (route maps to 4xx)", async () => {
    const client = makeClient({ caseRow: null });
    await expect(
      addCaseAssignment(
        {
          caseId: "x",
          assignedToUserId: "y",
          role: "OWNER",
          actorUserId: "z",
        },
        client,
      ),
    ).rejects.toBeInstanceOf(CaseError);
  });
});

describe("Members audit ACC-05 — an assignee who cannot open the case is refused", () => {
  it("refuses invalid_assignee and writes nothing", async () => {
    reach.allowed = false;
    const client = makeClient();
    await expect(
      addCaseAssignment(
        { caseId: "case-1", assignedToUserId: "user-2", role: "INVESTIGATOR", actorUserId: "user-1" },
        client,
      ),
    ).rejects.toMatchObject({ code: "invalid_assignee" });
    expect(client.caseAssignment.create).not.toHaveBeenCalled();
  });
});
