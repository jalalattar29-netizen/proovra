/**
 * Phase 3 (Enterprise Identity) — SCIM User lifecycle behaviour tests.
 *
 * Drives the SCIM User service functions against an in-memory Prisma
 * fake (no DB). Covers the REPAIR to the previously deactivate-only
 * PATCH plus the critical evidence-safety invariant.
 *
 * Coverage:
 *   - PATCH `replace active=false` → SOFT deactivate (TeamMember
 *     SUSPENDED), NEVER a hard delete; evidence ownership + custody
 *     rows survive intact.
 *   - PATCH `replace active=true`  → reactivate (SUSPENDED→ACTIVE) AND
 *     re-links the mapping so the resource resolves again.
 *   - PATCH supported attribute updates: displayName → mapping;
 *     userType/role → TeamMember.role (VIEWER|MEMBER only; never
 *     OWNER/ADMIN, never demotes a privileged member).
 *   - Unsupported PATCH attribute → `no_supported_attribute_target`
 *     (noTarget) — NOT a silent success.
 *   - Audit events emitted per op (create / update / deactivate /
 *     reactivate) via appendPlatformAuditLog.
 *
 * Non-enterprise → 402 is enforced at the route layer
 * (authenticateScim → resolveTeamEnterpriseFeatureGate) and is asserted
 * by source-text in phase26 route tests; here we exercise the service
 * layer that the gated route calls.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { interpretScimUserPatch } from "@proovra/shared";
import {
  scimCreateUser,
  scimDeactivateUser,
  scimReactivateUser,
  scimReadUser,
  scimUpdateUserAttributes,
} from "../src/services/access-control/scim.service.js";

const TEAM = "11111111-1111-4111-8111-111111111111";
const TOKEN = "22222222-2222-4222-8222-222222222222";
const BASE_URL = "https://api.example.com/v2/scim";

const CTX = { teamId: TEAM, tokenId: TOKEN, baseUrl: BASE_URL };

// -----------------------------------------------------------------------------
// In-memory Prisma fake. Only the tables the SCIM User service touches
// are modelled. Evidence + CustodyEvent are modelled READ-ONLY so we can
// assert that a SCIM deactivate never deletes or orphans them.
// -----------------------------------------------------------------------------

type UserRow = {
  id: string;
  email: string | null;
  provider: string;
  providerUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

type MappingRow = {
  id: string;
  teamId: string;
  userId: string;
  provider: string;
  externalSubjectId: string;
  displayName: string | null;
  externalEmail: string | null;
  linkedAtUtc: Date;
  unlinkedAtUtc: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type MemberRow = {
  id: string;
  teamId: string;
  userId: string;
  role: string;
  status: string;
  accessReason: string | null;
  suspendedAtUtc: Date | null;
  suspensionReason: string | null;
};

type EvidenceRow = { id: string; ownerUserId: string; deletedAt: Date | null };
type CustodyRow = { id: string; evidenceId: string; actorUserId: string };
type AuditRow = { action: string; resourceId: string | null; hash: string };

let uid = 0;
function nid(): string {
  uid += 1;
  return `id-${uid}`;
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (v === null) {
      if (row[k] !== null && row[k] !== undefined) return false;
    } else if (row[k] !== v) {
      return false;
    }
  }
  return true;
}

function makeFake() {
  const users: UserRow[] = [];
  const mappings: MappingRow[] = [];
  const members: MemberRow[] = [];
  const evidence: EvidenceRow[] = [];
  const custody: CustodyRow[] = [];
  const audit: AuditRow[] = [];
  // Guard: fail loudly if any code path ever tries a hard delete.
  let deleteAttempts = 0;

  const fake = {
    _users: users,
    _mappings: mappings,
    _members: members,
    _evidence: evidence,
    _custody: custody,
    _audit: audit,
    get _deleteAttempts() {
      return deleteAttempts;
    },

    // PHASE 10 §3 — scimCreateUser resolves the parent org for the atomic
    // managed-identity binding. This fixture's team has no CUSTOMER org, so
    // organizationIdForPolicy → null and the managed binding is skipped (this
    // suite covers SCIM user mechanics, not managed identity — see
    // phase-10-managed-provisioning.test.ts for the atomic binding).
    team: {
      findUnique: async () => ({ organizationId: null, organization: null }),
    },

    user: {
      async findUnique({ where }: { where: { id: string } }) {
        return users.find((u) => u.id === where.id) ?? null;
      },
      async findFirst({ where }: { where: { email?: string } }) {
        return users.find((u) => (where.email ? u.email === where.email : true)) ?? null;
      },
      async create({ data }: { data: Partial<UserRow> }) {
        const now = new Date();
        const row: UserRow = {
          id: nid(),
          email: data.email ?? null,
          provider: data.provider ?? "EMAIL",
          providerUserId: data.providerUserId ?? "",
          createdAt: now,
          updatedAt: now,
        };
        users.push(row);
        return row;
      },
      async delete() {
        deleteAttempts += 1;
        throw new Error("user.delete must never be called by SCIM");
      },
    },

    externalIdentityMapping: {
      async findFirst({
        where,
        orderBy: _orderBy,
      }: {
        where: Record<string, unknown>;
        orderBy?: unknown;
      }) {
        return mappings.find((m) => matches(m as unknown as Record<string, unknown>, where)) ?? null;
      },
      async create({ data }: { data: Partial<MappingRow> }) {
        const now = new Date();
        const row: MappingRow = {
          id: nid(),
          teamId: data.teamId!,
          userId: data.userId!,
          provider: data.provider ?? "GENERIC_SCIM",
          externalSubjectId: data.externalSubjectId!,
          displayName: data.displayName ?? null,
          externalEmail: data.externalEmail ?? null,
          linkedAtUtc: now,
          unlinkedAtUtc: null,
          createdAt: now,
          updatedAt: now,
        };
        mappings.push(row);
        return row;
      },
      async update({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<MappingRow>;
      }) {
        const row = mappings.find((m) => m.id === where.id);
        if (!row) throw new Error("mapping not found");
        Object.assign(row, data);
        return row;
      },
      async updateMany({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Partial<MappingRow>;
      }) {
        let count = 0;
        for (const m of mappings) {
          if (matches(m as unknown as Record<string, unknown>, where)) {
            Object.assign(m, data);
            count += 1;
          }
        }
        return { count };
      },
    },

    teamMember: {
      async findUnique({
        where,
      }: {
        where: { teamId_userId: { teamId: string; userId: string } };
      }) {
        const { teamId, userId } = where.teamId_userId;
        return members.find((m) => m.teamId === teamId && m.userId === userId) ?? null;
      },
      async upsert({
        where,
        update,
        create,
      }: {
        where: { teamId_userId: { teamId: string; userId: string } };
        update: Partial<MemberRow>;
        create: Partial<MemberRow>;
      }) {
        const { teamId, userId } = where.teamId_userId;
        const existing = members.find((m) => m.teamId === teamId && m.userId === userId);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row: MemberRow = {
          id: nid(),
          teamId: create.teamId!,
          userId: create.userId!,
          role: create.role ?? "MEMBER",
          status: create.status ?? "ACTIVE",
          accessReason: create.accessReason ?? null,
          suspendedAtUtc: null,
          suspensionReason: null,
        };
        members.push(row);
        return row;
      },
      async update({ where, data }: { where: { id: string }; data: Partial<MemberRow> }) {
        const row = members.find((m) => m.id === where.id);
        if (!row) throw new Error("member not found");
        Object.assign(row, data);
        return row;
      },
      async delete() {
        deleteAttempts += 1;
        throw new Error("teamMember.delete must never be called by SCIM");
      },
    },

    adminAuditLog: {
      async findFirst() {
        return audit.length ? audit[audit.length - 1] : null;
      },
      async create({ data }: { data: { action: string; resourceId: string | null } }) {
        audit.push({
          action: data.action,
          resourceId: data.resourceId,
          hash: `hash-${audit.length + 1}`,
        });
        return audit[audit.length - 1];
      },
    },

    securityEvent: {
      // fire-and-forget; safeEmitSecurityEvent swallows failures
      async create() {
        return { id: nid() };
      },
    },

    async $executeRaw() {
      return 0;
    },
    async $transaction(fn: (tx: unknown) => Promise<unknown>) {
      return fn(fake);
    },
  };

  return fake;
}

async function seedActiveUser(fake: ReturnType<typeof makeFake>) {
  const res = await scimCreateUser(
    CTX,
    {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "alice@acme.com",
      displayName: "Alice Acme",
      active: true,
      emails: [{ value: "alice@acme.com", primary: true }],
      externalId: "ext-alice",
    },
    fake as never,
  );
  if (!res.ok) throw new Error("seed failed");
  return res.user.id;
}

// -----------------------------------------------------------------------------

describe("SCIM User lifecycle — create + audit", () => {
  let fake: ReturnType<typeof makeFake>;
  beforeEach(() => {
    uid = 0;
    fake = makeFake();
  });

  it("create provisions a User + mapping + ACTIVE member and audits SCIM_USER_CREATED", async () => {
    const userId = await seedActiveUser(fake);
    expect(fake._users).toHaveLength(1);
    expect(fake._mappings).toHaveLength(1);
    expect(fake._members[0].status).toBe("ACTIVE");
    expect(fake._audit.map((a) => a.action)).toContain("scim.user.create");
    // resource is resolvable
    const read = await scimReadUser(CTX, userId, fake as never);
    expect(read?.active).toBe(true);
  });
});

describe("SCIM User lifecycle — deactivate is SOFT + evidence-safe", () => {
  let fake: ReturnType<typeof makeFake>;
  let userId: string;

  beforeEach(async () => {
    uid = 0;
    fake = makeFake();
    userId = await seedActiveUser(fake);
    // This user OWNS evidence + appears in the custody chain.
    fake._evidence.push({ id: "ev-1", ownerUserId: userId, deletedAt: null });
    fake._custody.push({ id: "cust-1", evidenceId: "ev-1", actorUserId: userId });
  });

  it("deactivate suspends the member and NEVER deletes the user", async () => {
    const res = await scimDeactivateUser(CTX, userId, fake as never);
    expect(res.ok).toBe(true);
    expect(fake._deleteAttempts).toBe(0);
    // user row still present
    expect(fake._users.find((u) => u.id === userId)).toBeTruthy();
    // member SUSPENDED, not removed
    const member = fake._members.find((m) => m.userId === userId);
    expect(member?.status).toBe("SUSPENDED");
    expect(fake._members).toHaveLength(1);
  });

  it("deactivate leaves owned evidence + custody rows intact and resolvable", async () => {
    await scimDeactivateUser(CTX, userId, fake as never);
    const ev = fake._evidence.find((e) => e.id === "ev-1");
    expect(ev).toBeTruthy();
    expect(ev?.ownerUserId).toBe(userId); // ownership NOT orphaned/moved
    expect(ev?.deletedAt).toBeNull(); // evidence NOT soft-deleted
    const cust = fake._custody.find((c) => c.id === "cust-1");
    expect(cust?.actorUserId).toBe(userId); // custody chain intact
  });

  it("deactivate emits SCIM_USER_DEACTIVATED audit event", async () => {
    await scimDeactivateUser(CTX, userId, fake as never);
    expect(fake._audit.map((a) => a.action)).toContain("scim.user.deactivate");
  });
});

describe("SCIM User lifecycle — reactivate", () => {
  let fake: ReturnType<typeof makeFake>;
  let userId: string;

  beforeEach(async () => {
    uid = 0;
    fake = makeFake();
    userId = await seedActiveUser(fake);
    await scimDeactivateUser(CTX, userId, fake as never);
  });

  it("reactivate flips SUSPENDED→ACTIVE, re-links mapping, and audits", async () => {
    // After deactivate the mapping is unlinked → not resolvable.
    expect(await scimReadUser(CTX, userId, fake as never)).toBeNull();

    const res = await scimReactivateUser(CTX, userId, fake as never);
    expect(res.ok).toBe(true);

    const member = fake._members.find((m) => m.userId === userId);
    expect(member?.status).toBe("ACTIVE");
    expect(member?.suspendedAtUtc).toBeNull();
    // mapping re-linked → resolvable again
    const read = await scimReadUser(CTX, userId, fake as never);
    expect(read?.active).toBe(true);
    expect(fake._audit.map((a) => a.action)).toContain("scim.user.reactivate");
  });

  it("reactivate on an unknown user returns notFound (no delete)", async () => {
    const res = await scimReactivateUser(CTX, "nope", fake as never);
    expect(res.ok).toBe(false);
    expect(res.notFound).toBe(true);
    expect(fake._deleteAttempts).toBe(0);
  });
});

describe("SCIM User lifecycle — supported attribute updates", () => {
  let fake: ReturnType<typeof makeFake>;
  let userId: string;

  beforeEach(async () => {
    uid = 0;
    fake = makeFake();
    userId = await seedActiveUser(fake);
  });

  it("displayName update persists to the mapping + audits SCIM_USER_UPDATED", async () => {
    const res = await scimUpdateUserAttributes(
      CTX,
      userId,
      { displayName: "Alice Renamed" },
      fake as never,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.appliedFields).toContain("displayName");
    const mapping = fake._mappings.find((m) => m.userId === userId);
    expect(mapping?.displayName).toBe("Alice Renamed");
    expect(fake._audit.map((a) => a.action)).toContain("scim.user.update");
  });

  it("role update to VIEWER persists to TeamMember.role", async () => {
    const res = await scimUpdateUserAttributes(CTX, userId, { role: "VIEWER" }, fake as never);
    expect(res.ok).toBe(true);
    expect(fake._members.find((m) => m.userId === userId)?.role).toBe("VIEWER");
  });

  it("never assigns/demotes a privileged (OWNER/ADMIN) member via SCIM role", async () => {
    // Promote the seeded member to OWNER out-of-band.
    fake._members[0].role = "OWNER";
    const res = await scimUpdateUserAttributes(
      CTX,
      userId,
      { role: "MEMBER" },
      fake as never,
    );
    // The role write is skipped; nothing else applied → noTarget.
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.scimType).toBe("noTarget");
    expect(fake._members[0].role).toBe("OWNER"); // privilege preserved
  });

  it("no supported attribute → noTarget (NOT a silent success)", async () => {
    const res = await scimUpdateUserAttributes(CTX, userId, {}, fake as never);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(400);
      expect(res.scimType).toBe("noTarget");
    }
  });
});

describe("SCIM User PATCH interpreter → service integration", () => {
  it("interpreter classifies a mixed real-world PATCH the way the route applies it", async () => {
    uid = 0;
    const fake = makeFake();
    const userId = await seedActiveUser(fake);

    const plan = interpretScimUserPatch([
      { op: "replace", path: "displayName", value: "Alice Q" },
      { op: "replace", path: "phoneNumbers", value: "+15551230000" },
    ]);
    expect(plan.hasSupported).toBe(true);
    expect(plan.unsupported).toEqual(["phoneNumbers"]);

    // Route applies only the supported piece.
    const res = await scimUpdateUserAttributes(
      CTX,
      userId,
      { displayName: plan.displayName ?? null },
      fake as never,
    );
    expect(res.ok).toBe(true);
    expect(fake._mappings.find((m) => m.userId === userId)?.displayName).toBe("Alice Q");
  });
});
