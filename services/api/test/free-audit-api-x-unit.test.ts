/**
 * FREE-USER AUDIT 0ea0 — API-X (unit): the server halves of the client lanes'
 * cross-lane requests that are decided by pure functions or by a single
 * write's outcome (a unique-constraint race, a lost compare-and-swap).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/queue/redaction-derivative-queue.js", () => ({
  enqueueRedactionDerivativeRender: vi.fn(async () => ({ enqueued: true })),
}));

import { resolveCaseViewerCapabilities } from "../src/services/cases/case-permission.service.js";
import { createRedactionVersion, openRedactionProject } from "../src/services/redaction/redaction-project.service.js";
import { requestRedactionDerivative } from "../src/services/redaction/redaction-derivative.service.js";
import { transitionPolicyVersion } from "../src/services/redaction/redaction-policy-store.service.js";
import { enqueueRedactionDerivativeRender } from "../src/queue/redaction-derivative-queue.js";

const p2002 = () => Object.assign(new Error("Unique constraint failed"), { code: "P2002" });

// ---------------------------------------------------------------------------
// B3C-F-005 — Rename/Delete come from the destructive gate's role input.
// ---------------------------------------------------------------------------
describe("B3C-F-005 — viewer.canRename / canDelete", () => {
  it("a MEMBER case creator (synthetic case OWNER) is not offered Rename/Delete; an ADMIN is", () => {
    // The creator's case-access role is lifted to OWNER (manage access,
    // assign), but the gate decides rename/delete on the LIVE workspace role.
    const creator = resolveCaseViewerCapabilities({
      accessRole: "OWNER",
      assignmentRoles: [],
      destructiveAccessRole: "MEMBER",
    });
    expect(creator.canManage).toBe(true);
    expect(creator.canRename).toBe(false);
    expect(creator.canDelete).toBe(false);
    expect(creator.disabledReasons.rename).toMatch(/OWNER or ADMIN/);

    const admin = resolveCaseViewerCapabilities({ accessRole: "ADMIN", assignmentRoles: [], destructiveAccessRole: "ADMIN" });
    expect(admin.canRename).toBe(true);
    expect(admin.canDelete).toBe(true);

    // A personal case's owner is the synthetic OWNER of the gate too.
    const personal = resolveCaseViewerCapabilities({ accessRole: "OWNER", assignmentRoles: [], destructiveAccessRole: "OWNER" });
    expect(personal.canRename && personal.canDelete).toBe(true);
  });

  it("an unknown destructive role fails closed", () => {
    for (const destructiveAccessRole of [undefined, "NONE" as const]) {
      const caps = resolveCaseViewerCapabilities({ accessRole: "ADMIN", assignmentRoles: [], destructiveAccessRole });
      expect(caps.canRename).toBe(false);
      expect(caps.canDelete).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// B5B-F-203 — redaction double submits and concurrent policy verdicts.
// ---------------------------------------------------------------------------
describe("B5B-F-203 — redaction create races answer the existing row; policy transitions are compare-and-set", () => {
  it("opening a project that a concurrent open just created returns that project (no 500)", async () => {
    let lookups = 0;
    const prisma = {
      // PRO-R3-13 — the opener now scopes the record canonically, requires a
      // sealed record in service and takes the media kind from the record.
      team: { findUnique: async () => ({ isPersonal: false, ownerUserId: null }) },
      $queryRawUnsafe: async () => [{ deleted_at: null, status: "SIGNED", lifecycle_state: "ACTIVE" }],
      evidence: { findFirst: async () => ({ id: "ev-1", mimeType: "image/png", sizeBytes: null, type: "PHOTO" }) },
      redactionProject: {
        // first read: not there yet; after the race: the winner.
        findFirst: async () => (lookups++ === 0 ? null : { id: "proj-winner" }),
        create: async () => {
          throw p2002();
        },
      },
    };
    const res = await openRedactionProject({
      prisma: prisma as never,
      teamId: "t-1",
      evidenceId: "ev-1",
      artifactKind: "IMAGE",
      createdByUserId: "u-1",
    });
    expect(res).toEqual({ ok: true, projectId: "proj-winner", opened: false });
  });

  it("a second 'New version' that lost the ordinal race returns the version that won (no second draft, no 500)", async () => {
    const prisma = {
      redactionProject: { findFirst: async () => ({ id: "proj-1" }) },
      redactionVersion: {
        findFirst: vi.fn(async (args: { where: Record<string, unknown> }) =>
          "versionOrdinal" in args.where ? { id: "ver-winner", versionOrdinal: 3 } : { versionOrdinal: 2 },
        ),
        create: async () => {
          throw p2002();
        },
      },
    };
    const res = await createRedactionVersion({
      prisma: prisma as never,
      teamId: "t-1",
      projectId: "proj-1",
      authoredByUserId: "u-1",
    });
    expect(res).toEqual({ ok: true, versionId: "ver-winner", versionOrdinal: 3 });
  });

  it("a first redacted-copy request that lost the UNIQUE(versionId) race returns the existing derivative and enqueues nothing", async () => {
    vi.mocked(enqueueRedactionDerivativeRender).mockClear();
    const prisma = {
      redactionVersion: {
        findFirst: async () => ({
          id: "ver-1",
          state: "APPROVED",
          projectId: "proj-1",
          project: { artifactKind: "IMAGE", evidenceId: "ev-1" },
          derivative: null,
        }),
      },
      // PRO-R3-15 — the storage-growth check reads the record (none here: skipped).
      evidence: { findFirst: async () => null },
      redactionDerivative: {
        create: async () => {
          throw p2002();
        },
        findUnique: async () => ({ id: "der-winner", state: "QUEUED" }),
      },
    };
    const res = await requestRedactionDerivative({
      prisma: prisma as never,
      teamId: "t-1",
      versionId: "ver-1",
      requestedByUserId: "u-1",
    });
    expect(res).toEqual({ ok: true, derivativeId: "der-winner", state: "QUEUED" });
    expect(enqueueRedactionDerivativeRender).not.toHaveBeenCalled();
  });

  function policyPrisma(swapCount: number) {
    const writes: string[] = [];
    const tx = {
      redactionPolicyVersion: {
        updateMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
          // The compare-and-set targets the checked state; the supersede does not.
          if (args.where.id) {
            writes.push("cas");
            return { count: swapCount };
          }
          writes.push("supersede");
          return { count: 0 };
        }),
        update: vi.fn(async () => {
          writes.push("blind-update");
          return {};
        }),
      },
    };
    const prisma = {
      redactionPolicyVersion: {
        findFirst: async () => ({ id: "pv-1", state: "IN_REVIEW", policyId: "pol-1", authoredByUserId: "author" }),
      },
      redactionPolicyAudit: { create: vi.fn(async () => ({ id: "audit-1" })) },
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    };
    return { prisma, tx, writes };
  }

  it("a verdict whose version moved since it was read is refused INVALID_TRANSITION and writes nothing", async () => {
    const { prisma, writes } = policyPrisma(0);
    const res = await transitionPolicyVersion({
      prisma: prisma as never,
      teamId: "t-1",
      policyVersionId: "pv-1",
      toState: "APPROVED",
      actorUserId: "approver",
    } as never);
    expect(res).toEqual({ ok: false, denial: "INVALID_TRANSITION" });
    expect(writes).not.toContain("blind-update");
    expect(prisma.redactionPolicyAudit.create).not.toHaveBeenCalled();
  });

  it("positive control — the verdict that wins the compare-and-set is recorded", async () => {
    const { prisma, writes } = policyPrisma(1);
    const res = await transitionPolicyVersion({
      prisma: prisma as never,
      teamId: "t-1",
      policyVersionId: "pv-1",
      toState: "APPROVED",
      actorUserId: "approver",
    } as never);
    expect(res).toEqual({ ok: true, from: "IN_REVIEW", to: "APPROVED" });
    expect(writes).toEqual(["cas"]);
    expect(prisma.redactionPolicyAudit.create).toHaveBeenCalledTimes(1);
  });
});
