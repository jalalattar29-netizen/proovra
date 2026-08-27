/**
 * PHASE 4 (2026-07-22) — §7.3 Personal lifecycle invariants.
 *
 * 1. PRESERVATION — account closure NEVER touches Evidence: no evidence
 *    delegate access, no hard-delete of any model; memberships are
 *    REVOKED via the canonical orchestrator (deactivated, never erased);
 *    solo implicit orgs are ARCHIVED, never deleted.
 *
 * 2. DOWNGRADE — a plan downgrade that leaves the account over the new
 *    lifetime record cap blocks NEW creation only. The gate is read-only
 *    (no writes), so existing records are structurally untouched. Legacy
 *    grandfather override replaces the plan cap when present.
 *
 * 3. STORAGE OVER-LIMIT — usage above the (possibly downgraded) storage
 *    limit rejects growth with STORAGE_LIMIT_REACHED + remediation
 *    actions; the assertion path performs reads only.
 */

import { readFileSync } from "node:fs";
import { NO_CONTRACT_LIMITS } from "../src/services/billing/enterprise-contract-limits.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { model: string; method: string; args: unknown[] };

const H = vi.hoisted(() => ({
  calls: [] as { model: string; method: string; args: unknown[] }[],
  personalTeam: { id: "team-personal" } as { id: string } | null,
  evidenceCount: 0,
  evidenceBytes: 0n as bigint,
  soloOwnerOrgs: [{ organizationId: "org-1" }] as { organizationId: string }[],
  otherOrgMemberCount: 0,
  massRevoked: [] as unknown[],
  orgMembershipsRemoved: [] as unknown[],
  sessionsRevoked: [] as unknown[],
}));

function makeModelProxy(prefix: string) {
  return new Proxy(
    {},
    {
      get(_t, model: string) {
        return new Proxy(
          {},
          {
            get(_t2, method: string) {
              return async (...args: unknown[]) => {
                H.calls.push({ model: `${prefix}${model}`, method, args });
                switch (method) {
                  case "findFirst":
                    return model === "team" ? H.personalTeam : null;
                  case "findUnique":
                    return null;
                  case "findMany":
                    return model === "organizationMembership"
                      ? H.soloOwnerOrgs.map((o) => ({ ...o }))
                      : [];
                  case "count":
                    if (model === "evidence") return H.evidenceCount;
                    if (model === "organizationMembership")
                      return H.otherOrgMemberCount;
                    return 0;
                  case "aggregate":
                    return {
                      _sum: {
                        sizeBytes: model === "evidence" ? H.evidenceBytes : 0n,
                      },
                    };
                  case "updateMany":
                    return { count: 1 };
                  default:
                    return {};
                }
              };
            },
          },
        );
      },
    },
  ) as Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>>;
}

vi.mock("../src/db.js", () => {
  const base = makeModelProxy("");
  return {
    prisma: new Proxy(base, {
      get(t, prop: string) {
        if (prop === "$transaction") {
          return async (cb: (tx: unknown) => Promise<unknown>) =>
            cb(makeModelProxy("tx."));
        }
        return (t as Record<string, unknown>)[prop];
      },
    }),
  };
});

vi.mock(
  "../src/services/identity-security/session-revocation.service.js",
  () => ({
    revokeAllSessionsForUser: async (input: unknown) => {
      H.sessionsRevoked.push(input);
    },
  }),
);

vi.mock("../src/services/identity/membership-provisioning.service.js", () => ({
  massRevokeWorkspaceMemberships: async (_tx: unknown, input: unknown) => {
    H.massRevoked.push(input);
    return { count: 2 };
  },
  removeAllOrganizationMembershipsForUser: async (
    _tx: unknown,
    input: unknown,
  ) => {
    H.orgMembershipsRemoved.push(input);
    return { count: 1 };
  },
}));

vi.mock("../src/services/platform-audit-log.service.js", () => ({
  appendPlatformAuditLog: async () => ({}),
}));

vi.mock(
  "../src/services/identity/account-lifecycle-preflight.service.js",
  () => ({
    evaluateAccountClosurePreflight: async () => ({ blockers: [] }),
  }),
);

import {
  assertWorkspaceAllowsEvidenceCreation,
  assertWorkspaceAllowsStorageGrowth,
} from "../src/services/billing-enforcement.service.js";
import { executeAccountClosure } from "../src/services/identity/account-closure.service.js";
import type { WorkspaceScope } from "../src/services/workspace-billing.service.js";

function personalScope(over: Partial<WorkspaceScope> = {}): WorkspaceScope {
  return {
    billingShape: "SINGLE_OCCUPANT",
    ownerUserId: "u1",
    teamId: null,
    organizationId: null,
    plan: "FREE" as WorkspaceScope["plan"],
    credits: 0,
    teamSeats: 0,
    storageBytesOverride: null,
    activeStorageAddonBytes: 0n,
    legacyRecordCapOverride: null,
    contractLimits: NO_CONTRACT_LIMITS,
    authenticatedUserEmail: null,
    ...over,
  };
}

beforeEach(() => {
  H.calls = [];
  H.personalTeam = { id: "team-personal" };
  H.evidenceCount = 0;
  H.evidenceBytes = 0n;
  H.soloOwnerOrgs = [{ organizationId: "org-1" }];
  H.otherOrgMemberCount = 0;
  H.massRevoked = [];
  H.orgMembershipsRemoved = [];
  H.sessionsRevoked = [];
});

const isWrite = (c: Call) =>
  /^(create|createMany|update|updateMany|upsert|delete|deleteMany)$/.test(
    c.method,
  );

describe("Phase 4 §7.3 — downgrade record-cap behavior (creation gate only)", () => {
  it("downgraded-to-FREE account over the FREE cap: new creation blocked, gate is read-only", async () => {
    H.evidenceCount = 50; // records accumulated on a higher plan
    await expect(
      assertWorkspaceAllowsEvidenceCreation(personalScope({ plan: "FREE" as WorkspaceScope["plan"] })),
    ).rejects.toMatchObject({ statusCode: 409, code: "FREE_LIMIT_REACHED" });
    // Preservation: the enforcement path never writes — existing
    // records cannot be mutated by hitting the cap.
    expect(H.calls.filter(isWrite)).toEqual([]);
  });

  it("PRO over the 100-record lifetime cap → EVIDENCE_RECORD_LIMIT_REACHED", async () => {
    H.evidenceCount = 150;
    await expect(
      assertWorkspaceAllowsEvidenceCreation(personalScope({ plan: "PRO" as WorkspaceScope["plan"] })),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "EVIDENCE_RECORD_LIMIT_REACHED",
    });
  });

  it("grandfather override replaces the plan cap (over-limit accounts keep creating up to override)", async () => {
    // §9.7 — the override is interpreted ONLY by the canonical envelope;
    // enforcement consumes the envelope-resolved `commercialLimits` attached
    // at the chokepoint (raw legacyRecordCapOverride is a mute projection).
    H.evidenceCount = 150;
    await expect(
      assertWorkspaceAllowsEvidenceCreation(
        personalScope({
          plan: "PRO" as WorkspaceScope["plan"],
          legacyRecordCapOverride: 200,
          commercialLimits: {
            effectiveLifetimeRecordCap: 200,
            effectiveMonthlyRecordCap: null,
            source: "LEGACY_RECORD_CAP_OVERRIDE",
          },
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("§9.7 — a RAW override WITHOUT the envelope no longer raises the cap (envelope is the only interpreter)", async () => {
    H.evidenceCount = 150; // above the PRO plan cap of 100
    await expect(
      assertWorkspaceAllowsEvidenceCreation(
        personalScope({ plan: "PRO" as WorkspaceScope["plan"], legacyRecordCapOverride: 200 }),
      ),
    ).rejects.toMatchObject({ code: "EVIDENCE_RECORD_LIMIT_REACHED" });
  });

  it("PAYG is credit-bound, not record-capped; without credits → 402", async () => {
    H.evidenceCount = 9999;
    await expect(
      assertWorkspaceAllowsEvidenceCreation(
        personalScope({ plan: "PAYG" as WorkspaceScope["plan"], credits: 1 }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertWorkspaceAllowsEvidenceCreation(
        personalScope({ plan: "PAYG" as WorkspaceScope["plan"], credits: 0 }),
      ),
      // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — a grandfathered
      // `entitlements.plan = 'PAYG'` row is still credit-bound: that row grants
      // no free record allowance, so every completion needs a credit. The
      // denial is now the canonical DomainError, which carries `publicCode`.
    ).rejects.toMatchObject({
      httpStatus: 402,
      publicCode: "INSUFFICIENT_EVIDENCE_CREDITS",
    });
  });
});

describe("Phase 4 §7.3 — storage over-limit after downgrade", () => {
  it("usage above the downgraded limit rejects growth with remediation actions; read-only path", async () => {
    // 1 GB used on FREE (250 MB) — the downgraded-over-limit shape.
    H.evidenceBytes = 1024n * 1024n * 1024n;
    let caught: (Error & { code?: string; details?: Record<string, unknown> }) | null = null;
    try {
      await assertWorkspaceAllowsStorageGrowth({
        scope: personalScope({ plan: "FREE" as WorkspaceScope["plan"] }),
        incomingBytes: 1n,
      });
    } catch (e) {
      caught = e as typeof caught & Error;
    }
    expect(caught).not.toBeNull();
    expect(caught).toMatchObject({ code: "STORAGE_LIMIT_REACHED" });
    const actions = (caught!.details as { actions: Record<string, unknown> })
      .actions;
    // Over-limit is remediable, never destructive: the error offers
    // upgrade/review paths; nothing was deleted or mutated.
    expect(actions.canReviewArchivedEvidence).toBe(true);
    expect(H.calls.filter(isWrite)).toEqual([]);
  });

  it("under the limit growth is allowed", async () => {
    H.evidenceBytes = 1024n * 1024n; // 1 MB on FREE
    await expect(
      assertWorkspaceAllowsStorageGrowth({
        scope: personalScope({ plan: "FREE" as WorkspaceScope["plan"] }),
        incomingBytes: 1024,
      }),
    ).resolves.toBeTruthy();
  });
});

describe("Phase 4 §7.3 — account closure preserves Personal Evidence", () => {
  it("executeAccountClosure never touches the evidence delegate and never hard-deletes anything", async () => {
    await executeAccountClosure("u1");

    // No evidence access AT ALL — preservation is structural.
    expect(H.calls.some((c) => c.model.endsWith("evidence"))).toBe(false);
    // No hard-delete of ANY model through the closure path.
    expect(
      H.calls.some((c) => c.method === "delete" || c.method === "deleteMany"),
    ).toBe(false);
  });

  it("memberships are revoked via the canonical orchestrator; solo org is ARCHIVED, never deleted", async () => {
    await executeAccountClosure("u1");

    expect(H.orgMembershipsRemoved).toEqual([{ userId: "u1" }]);
    expect(H.massRevoked).toEqual([
      { where: { userId: "u1" }, reason: "account closure" },
    ]);
    const orgUpdates = H.calls.filter(
      (c) => c.model === "tx.organization" && c.method === "update",
    );
    expect(orgUpdates.length).toBe(1);
    expect(
      (orgUpdates[0].args[0] as { data: { status: string } }).data.status,
    ).toBe("ARCHIVED");
    expect(H.sessionsRevoked).toEqual([
      { userId: "u1", reason: "ACCOUNT_CLOSED" },
    ]);
  });

  it("multi-member org is NOT archived by account closure (preflight owns that blocker)", async () => {
    H.otherOrgMemberCount = 2;
    await executeAccountClosure("u1");
    expect(
      H.calls.some(
        (c) => c.model === "tx.organization" && c.method === "update",
      ),
    ).toBe(false);
  });
});

describe("Phase 4 §7.3 — source contract: closure file cannot hard-delete", () => {
  const SRC = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "src",
      "services",
      "identity",
      "account-closure.service.ts",
    ),
    "utf8",
  );

  it("account-closure.service.ts has no evidence delegate access and no delete calls", () => {
    expect(SRC).not.toMatch(/\.(evidence|report|verificationPackage)\./);
    expect(SRC).not.toMatch(/\.delete(Many)?\(/);
  });
});
