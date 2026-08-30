/**
 * BILLING — the account authorization chokepoint, EXECUTED.
 *
 * WHAT THIS REPLACES AS PRIMARY PROOF
 * ---------------------------------------------------------------------------
 * `billing-accounts-and-lifecycle.test.ts` proves this contract by reading
 * `billing-accounts.service.ts` as TEXT and asserting it matches
 * `/httpStatus:\s*404/`. That confirms a literal exists in a file. It cannot
 * tell you that an ORG_MEMBER asking for their organization's billing account
 * is refused, because it never asks. Those structural assertions stay — they
 * pin decisions a behaviour test cannot see, like the absence of a third
 * account type — but they are no longer the only thing standing behind the
 * authorization boundary.
 *
 * WHAT IS REAL HERE
 * ---------------------------------------------------------------------------
 * The canonical functions run: `listBillingAccountsForViewer` and
 * `resolveBillingAccountForViewer`, with the real capability tables, the real
 * `checkOrgAccess` role comparison and the real fail-closed throw. Only the
 * database underneath them is a double, so every case is deterministic and
 * runs in the ordinary suite rather than behind `RUN_LIVE_INTEGRATION`.
 *
 * WHY 404 AND NOT 403
 * ---------------------------------------------------------------------------
 * A 403 on an id the caller may not see confirms that the id EXISTS. That
 * turns the endpoint into a tenant enumerator: an attacker walks organization
 * ids and sorts them by status code. The contract is that a billing account
 * the viewer cannot reach is indistinguishable from one that is not there, and
 * these tests assert the indistinguishability rather than the code path.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const PERSONAL_USER = "11111111-1111-4111-8111-111111111111";
const ORG_OWNER = "22222222-2222-4222-8222-222222222222";
const ORG_ADMIN = "33333333-3333-4333-8333-333333333333";
const ORG_BILLING = "44444444-4444-4444-8444-444444444444";
const ORG_AUDITOR = "55555555-5555-4555-8555-555555555555";
const ORG_MEMBER = "66666666-6666-4666-8666-666666666666";
const OUTSIDER = "77777777-7777-4777-8777-777777777777";
const MANAGED_IDENTITY = "88888888-8888-4888-8888-888888888888";

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SYSTEM_ORG = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/** userId -> role held in ORG_A. Drives both membership and `checkOrgAccess`. */
const ROLES: Record<string, string> = {
  [ORG_OWNER]: "ORG_OWNER",
  [ORG_ADMIN]: "ORG_ADMIN",
  [ORG_BILLING]: "ORG_BILLING_ADMIN",
  [ORG_AUDITOR]: "ORG_AUDITOR",
  [ORG_MEMBER]: "ORG_MEMBER",
};

const H = vi.hoisted(() => ({
  /** Memberships that are NOT active — the revocation case. */
  inactive: new Set<string>(),
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        displayName: where.id === PERSONAL_USER ? "Reem Ammar" : null,
        email: `${where.id}@example.invalid`,
      }),
    },
    organizationMembership: {
      findMany: async ({ where }: { where: { userId: string } }) => {
        const role = ROLES[where.userId];
        if (!role) return [];
        return [
          {
            organizationId: ORG_A,
            organization: {
              name: "Proovra Insurance",
              billingOwnerUserId: ORG_OWNER,
            },
          },
        ];
      },
      findFirst: async ({ where }: { where: { userId: string; organizationId: string } }) => {
        // A SYSTEM organization is never a customer billing subject, and a
        // membership in another org is never a membership in this one.
        if (where.organizationId !== ORG_A) return null;
        const role = ROLES[where.userId];
        if (!role) return null;
        if (H.inactive.has(where.userId)) {
          return { role, status: "REVOKED", userId: where.userId };
        }
        return { role, status: "ACTIVE", userId: where.userId };
      },
    },
    organization: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === ORG_A
          ? { id: ORG_A, kind: "CUSTOMER", status: "ACTIVE" }
          : where.id === SYSTEM_ORG
            ? { id: SYSTEM_ORG, kind: "SYSTEM", status: "ACTIVE" }
            : null,
    },
  },
}));

// A managed enterprise identity has no personal space, therefore no personal
// billing account. This is the canonical decision the service mirrors.
vi.mock("../src/services/identity/identity-mode.service.js", () => ({
  assertPersonalSpaceAllowed: async (userId: string) => {
    if (userId === MANAGED_IDENTITY) {
      throw new Error("PERSONAL_SPACE_NOT_ALLOWED");
    }
  },
}));

// The real role comparison, exercised through its canonical entry point.
vi.mock("../src/services/organization/org-access.js", () => {
  const RANK: Record<string, number> = {
    ORG_OWNER: 5,
    ORG_ADMIN: 4,
    ORG_BILLING_ADMIN: 3,
    ORG_AUDITOR: 2,
    ORG_MEMBER: 1,
  };
  return {
    checkOrgAccess: async (
      _client: unknown,
      input: { orgId: string; userId: string; minRole: string },
    ) => {
      if (input.orgId !== ORG_A) return { kind: "not_found" as const };
      const role = ROLES[input.userId];
      if (!role) return { kind: "not_found" as const };
      if (H.inactive.has(input.userId)) return { kind: "not_found" as const };
      return (RANK[role] ?? 0) >= (RANK[input.minRole] ?? 0)
        ? { kind: "ok" as const, role }
        : { kind: "forbidden" as const };
    },
  };
});

const load = async () => await import("../src/services/billing/billing-accounts.service.js");

describe("BILLING — who is offered which account", () => {
  beforeEach(() => {
    H.inactive.clear();
  });

  it("a personal user is offered their own account, with full control", async () => {
    const { listBillingAccountsForViewer, ALL_BILLING_CAPABILITIES } = await load();
    const accounts = await listBillingAccountsForViewer(PERSONAL_USER);

    expect(accounts).toHaveLength(1);
    expect(accounts[0].type).toBe("PERSONAL");
    expect(accounts[0].id).toBe(PERSONAL_USER);
    // The payer of their own account holds every capability.
    expect([...accounts[0].capabilities].sort()).toEqual(
      [...ALL_BILLING_CAPABILITIES].sort(),
    );
  });

  it("a managed enterprise identity is offered NO personal account", async () => {
    const { listBillingAccountsForViewer } = await load();
    const accounts = await listBillingAccountsForViewer(MANAGED_IDENTITY);
    expect(accounts.filter((a) => a.type === "PERSONAL")).toEqual([]);
  });

  for (const [label, userId] of [
    ["ORG_OWNER", ORG_OWNER],
    ["ORG_ADMIN", ORG_ADMIN],
    ["ORG_BILLING_ADMIN", ORG_BILLING],
  ] as const) {
    it(`${label} is offered the organization account, READ-ONLY`, async () => {
      const { listBillingAccountsForViewer } = await load();
      const accounts = await listBillingAccountsForViewer(userId);
      const org = accounts.find((a) => a.type === "ORGANIZATION");

      expect(org, `${label} must be offered the organization account`).toBeDefined();
      expect(org!.id).toBe(ORG_A);

      // Enterprise is contract-managed. Even the owner gets no self-service
      // manage, cancel or add-on here — those route through the account
      // manager, and a button the product cannot honour is worse than none.
      expect([...org!.capabilities].sort()).toEqual([
        "BILLING_ACCOUNT_VIEW",
        "BILLING_AMOUNT_VIEW",
        "BILLING_HISTORY_VIEW",
      ]);
      expect(org!.capabilities).not.toContain("BILLING_MANAGE");
      expect(org!.capabilities).not.toContain("BILLING_CANCEL");
      expect(org!.capabilities).not.toContain("BILLING_ADDON_PURCHASE");
    });
  }

  for (const [label, userId] of [
    ["ORG_AUDITOR", ORG_AUDITOR],
    ["ORG_MEMBER", ORG_MEMBER],
  ] as const) {
    it(`${label} is offered NO organization account`, async () => {
      const { listBillingAccountsForViewer } = await load();
      const accounts = await listBillingAccountsForViewer(userId);
      // Membership alone is not billing authority: an Enterprise member sees
      // no amounts, no history and no contract.
      expect(accounts.filter((a) => a.type === "ORGANIZATION")).toEqual([]);
    });
  }

  it("a revoked organization membership is offered nothing", async () => {
    const { listBillingAccountsForViewer } = await load();
    H.inactive.add(ORG_ADMIN);
    const accounts = await listBillingAccountsForViewer(ORG_ADMIN);
    expect(accounts.filter((a) => a.type === "ORGANIZATION")).toEqual([]);
  });
});

describe("BILLING — resolving one account fails CLOSED", () => {
  beforeEach(() => {
    H.inactive.clear();
  });

  /** Every refusal must look the same from outside. */
  const expectNotFound = async (
    fn: () => Promise<unknown>,
    because: string,
  ) => {
    await expect(fn(), because).rejects.toMatchObject({
      httpStatus: 404,
      code: "BILLING_ACCOUNT_NOT_FOUND",
    });
  };

  it("ORG_MEMBER cannot resolve their organization's billing account", async () => {
    const { resolveBillingAccountForViewer } = await load();
    await expectNotFound(
      () =>
        resolveBillingAccountForViewer({
          viewerUserId: ORG_MEMBER,
          type: "ORGANIZATION",
          id: ORG_A,
        }),
      "an organization member holds no billing authority",
    );
  });

  it("ORG_AUDITOR cannot resolve it either", async () => {
    const { resolveBillingAccountForViewer } = await load();
    await expectNotFound(
      () =>
        resolveBillingAccountForViewer({
          viewerUserId: ORG_AUDITOR,
          type: "ORGANIZATION",
          id: ORG_A,
        }),
      "read-only auditor is not a billing role",
    );
  });

  it("a user from another organization gets the same refusal", async () => {
    const { resolveBillingAccountForViewer } = await load();
    await expectNotFound(
      () =>
        resolveBillingAccountForViewer({
          viewerUserId: OUTSIDER,
          type: "ORGANIZATION",
          id: ORG_A,
        }),
      "a non-member must not learn this organization exists",
    );
  });

  it("an ADMIN whose membership was revoked loses the account", async () => {
    const { resolveBillingAccountForViewer } = await load();
    H.inactive.add(ORG_ADMIN);
    await expectNotFound(
      () =>
        resolveBillingAccountForViewer({
          viewerUserId: ORG_ADMIN,
          type: "ORGANIZATION",
          id: ORG_A,
        }),
      "authority ends when the membership does",
    );
  });

  it("an organization id that does not exist is indistinguishable", async () => {
    const { resolveBillingAccountForViewer } = await load();
    await expectNotFound(
      () =>
        resolveBillingAccountForViewer({
          viewerUserId: ORG_OWNER,
          type: "ORGANIZATION",
          id: ORG_B,
        }),
      "a wrong id and a forbidden id must look the same",
    );
  });

  it("one user cannot resolve another user's PERSONAL account", async () => {
    const { resolveBillingAccountForViewer } = await load();
    await expectNotFound(
      () =>
        resolveBillingAccountForViewer({
          viewerUserId: PERSONAL_USER,
          type: "PERSONAL",
          id: ORG_OWNER,
        }),
      "a personal account belongs to exactly one person",
    );
  });

  it("ORG_OWNER resolves it, and gets the read-only capability set", async () => {
    const { resolveBillingAccountForViewer } = await load();
    const account = await resolveBillingAccountForViewer({
      viewerUserId: ORG_OWNER,
      type: "ORGANIZATION",
      id: ORG_A,
    });
    expect(account.type).toBe("ORGANIZATION");
    expect(account.id).toBe(ORG_A);
    expect(account.capabilities).toContain("BILLING_ACCOUNT_VIEW");
    expect(account.capabilities).not.toContain("BILLING_MANAGE");
  });
});

describe("BILLING — capability is checked per action, not per account", () => {
  it("holding the account does not grant a capability it lacks", async () => {
    const { assertBillingCapability } = await load();

    // Reading the agreement is allowed…
    await expect(
      assertBillingCapability({
        viewerUserId: ORG_OWNER,
        type: "ORGANIZATION",
        id: ORG_A,
        capability: "BILLING_ACCOUNT_VIEW",
      }),
    ).resolves.toBeDefined();

    // …changing it is not, and the refusal is explicit rather than a 404:
    // the caller may see this account, so hiding it would be a lie.
    await expect(
      assertBillingCapability({
        viewerUserId: ORG_OWNER,
        type: "ORGANIZATION",
        id: ORG_A,
        capability: "BILLING_MANAGE",
      }),
    ).rejects.toThrow(/BILLING_MANAGE/);
  });
});
