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

import {
  addCaseAssignment,
  removeCaseAssignment,
  CaseError,
} from "../src/services/cases/case-lifecycle.service.js";
import { evaluateCaseMutationPermission } from "../src/services/cases/case-permission.service.js";

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
