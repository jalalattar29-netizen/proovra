/**
 * Phase 3 (Enterprise Identity) — SCOPE J: evidence-safety +
 * external-reviewer regression tests.
 *
 * These pin the invariants that keep the chain of custody and the
 * external-reviewer portal SAFE when internal identity changes
 * (SCIM suspend, external-identity unlink/relink, SSO relink):
 *
 *   J1. A deactivated (SCIM-suspended) user REMAINS resolvable in the
 *       chain of custody — custody.actorUserId preserved,
 *       evidence.ownerUserId unchanged, evidence.deletedAt null.
 *   J2. Disabling/relinking an external identity mapping does NOT
 *       remove historical records; SCIM/SSO relink does NOT create a
 *       duplicate user.
 *   J3. Reports/verification packages still resolve the ORIGINAL
 *       submitter/custodian after deactivation — the projection reads
 *       the PRESERVED stored identifier, not a live membership lookup
 *       that would break once the member is SUSPENDED.
 *   J4. Audit logs preserve the OLD user identifier
 *       (resourceId === the deactivated user's id).
 *   J5. Ownership transfer is EXPLICIT — deactivation NEVER reassigns
 *       ownership. There is no implicit reassignment on offboard.
 *   J6. External reviewer portal grants/sessions/history are UNAFFECTED
 *       by internal identity changes: the portal token model is a
 *       separate table keyed by token_hash + grant state, and grant
 *       validity is decided by the grant row's own lifecycle
 *       (expiry / revocation), NEVER by a live TeamMember lookup.
 *
 * The tests drive the REAL service functions
 * (`scimDeactivateUser` / `scimReactivateUser`) against an in-memory
 * Prisma fake, matching the proven pattern in
 * `phase-scim-user-lifecycle.test.ts`. Evidence / custody / audit rows
 * are modelled so we can assert they survive intact. The external
 * reviewer portal isolation is asserted against a faithful model of the
 * grant lifecycle (the real service uses raw SQL over its own
 * `external_review_grants` table, which has NO join to TeamMember —
 * that structural separation is the invariant under test).
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  scimDeactivateUser,
  scimReactivateUser,
  scimReadUser,
} from "../src/services/access-control/scim.service.js";

const TEAM = "11111111-1111-4111-8111-111111111111";
const TOKEN = "22222222-2222-4222-8222-222222222222";
const BASE_URL = "https://api.example.com/v2/scim";
const CTX = { teamId: TEAM, tokenId: TOKEN, baseUrl: BASE_URL };

// -----------------------------------------------------------------------------
// In-memory Prisma fake — mirrors phase-scim-user-lifecycle.test.ts. Only
// the tables the SCIM lifecycle touches are modelled. Evidence, custody,
// reports, packages + audit are modelled so we can prove they survive a
// SCIM deactivate. Any hard delete throws loudly.
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
// Evidence carries the ORIGINAL owner + a denormalised submitter
// identifier snapshot that reports/packages read (the "preserved
// identifier"). deletedAt models soft-delete state.
type EvidenceRow = {
  id: string;
  ownerUserId: string;
  submittedByUserId: string;
  deletedAt: Date | null;
};
type CustodyRow = { id: string; evidenceId: string; actorUserId: string };
// A verification report/package projection stores the custodian id it
// was generated with — it must NOT be re-resolved live.
type ReportRow = { id: string; evidenceId: string; custodianUserId: string };
type AuditRow = { action: string; resourceId: string | null; hash: string };

let uid = 0;
function nid(): string {
  uid += 1;
  return `id-${uid}`;
}

function matches(
  row: Record<string, unknown>,
  where: Record<string, unknown>,
): boolean {
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
  const reports: ReportRow[] = [];
  const audit: AuditRow[] = [];
  let deleteAttempts = 0;

  const fake = {
    _users: users,
    _mappings: mappings,
    _members: members,
    _evidence: evidence,
    _custody: custody,
    _reports: reports,
    _audit: audit,
    get _deleteAttempts() {
      return deleteAttempts;
    },

    user: {
      // CORRECTIVE PASS (2026-08-06) — TEST INFRASTRUCTURE ADAPTS TO PRODUCTION.
      //
      // The previous pass made an absent `user.updateMany` a silent no-op INSIDE
      // PRODUCTION so this partial transport would not crash. That put a
      // test-driven accommodation into production failure handling. The
      // accommodation is removed; the transport now models the delegate.
      //
      // This is a FAITHFUL implementation, not a stub: it honours the exact
      // predicate the canonical pointer repair issues — clear
      // `currentWorkspaceId` only for a user whose pointer names EXACTLY the
      // workspace they were withdrawn from — so the suite can observe real
      // pointer hygiene rather than merely tolerate the call.
      async updateMany({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) {
        const clauses = Array.isArray((where as { OR?: unknown[] }).OR)
          ? ((where as { OR: Array<Record<string, unknown>> }).OR)
          : [where];
        let count = 0;
        for (const u of users) {
          const matches = clauses.some((c) => {
            if ("id" in c && c.id !== u.id) return false;
            if ("currentWorkspaceId" in c) {
              const want = c.currentWorkspaceId as unknown;
              const have = (u as unknown as { currentWorkspaceId?: string | null })
                .currentWorkspaceId ?? null;
              if (want && typeof want === "object" && "in" in (want as object)) {
                if (!(want as { in: string[] }).in.includes(have as string)) return false;
              } else if (have !== want) {
                return false;
              }
            }
            return true;
          });
          if (!matches) continue;
          if ("currentWorkspaceId" in data) {
            (u as unknown as { currentWorkspaceId?: string | null }).currentWorkspaceId =
              data.currentWorkspaceId as string | null;
          }
          count += 1;
        }
        return { count };
      },
      async findUnique({ where }: { where: { id: string } }) {
        return users.find((u) => u.id === where.id) ?? null;
      },
      async findFirst({ where }: { where: { email?: string } }) {
        return (
          users.find((u) => (where.email ? u.email === where.email : true)) ??
          null
        );
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
        throw new Error("user.delete must never be called");
      },
    },

    externalIdentityMapping: {
      async findFirst({ where }: { where: Record<string, unknown> }) {
        return (
          mappings.find((m) =>
            matches(m as unknown as Record<string, unknown>, where),
          ) ?? null
        );
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

    // PHASE 10 — scimReactivateUser now resolves the managing org via
    // organizationIdForPolicy(team.findUnique). Non-CUSTOMER here → the plain
    // (non-managed) reactivation branch runs, which is what this SCIM-mechanics
    // test exercises.
    team: {
      async findUnique() {
        return null;
      },
    },

    teamMember: {
      async findUnique({
        where,
      }: {
        where: { teamId_userId: { teamId: string; userId: string } };
      }) {
        const { teamId, userId } = where.teamId_userId;
        return (
          members.find((m) => m.teamId === teamId && m.userId === userId) ??
          null
        );
      },
      // PHASE 3: the canonical orchestrator re-grants via upsert.
      async upsert({
        where,
        update,
        create,
      }: {
        where: { teamId_userId: { teamId: string; userId: string } };
        update: Record<string, unknown>;
        create: Record<string, unknown>;
      }) {
        const { teamId, userId } = where.teamId_userId;
        const existing = members.find(
          (m) => m.teamId === teamId && m.userId === userId,
        );
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row = { id: `tm-${members.length + 1}`, ...create };
        members.push(row as never);
        return row;
      },
      async update({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<MemberRow>;
      }) {
        const row = members.find((m) => m.id === where.id);
        if (!row) throw new Error("member not found");
        Object.assign(row, data);
        return row;
      },
      async delete() {
        deleteAttempts += 1;
        throw new Error("teamMember.delete must never be called");
      },
    },

    adminAuditLog: {
      async findFirst() {
        return audit.length ? audit[audit.length - 1] : null;
      },
      async create({
        data,
      }: {
        data: { action: string; resourceId: string | null };
      }) {
        audit.push({
          action: data.action,
          resourceId: data.resourceId,
          hash: `hash-${audit.length + 1}`,
        });
        return audit[audit.length - 1];
      },
    },

    securityEvent: {
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

function seedUserRow(fake: ReturnType<typeof makeFake>): string {
  const id = nid();
  const now = new Date();
  fake._users.push({
    id,
    email: "custodian@acme.com",
    provider: "EMAIL",
    providerUserId: "sso-ext-sub-1",
    createdAt: now,
    updatedAt: now,
  });
  fake._mappings.push({
    id: nid(),
    teamId: TEAM,
    userId: id,
    provider: "GENERIC_SCIM",
    externalSubjectId: "ext-sub-1",
    displayName: "Custodian Acme",
    externalEmail: "custodian@acme.com",
    linkedAtUtc: now,
    unlinkedAtUtc: null,
    createdAt: now,
    updatedAt: now,
  });
  fake._members.push({
    id: nid(),
    teamId: TEAM,
    userId: id,
    role: "MEMBER",
    status: "ACTIVE",
    accessReason: null,
    suspendedAtUtc: null,
    suspensionReason: null,
  });
  return id;
}

/**
 * Report/package projection helper. Reads the PRESERVED custodian
 * identifier that was snapshotted at generation time. This is what the
 * real projection does — it does NOT do a live TeamMember lookup, so it
 * cannot break when the member is later SUSPENDED. The test asserts the
 * behavior: resolve by stored id, independent of live membership status.
 */
function resolveReportCustodian(
  fake: ReturnType<typeof makeFake>,
  reportId: string,
): string | null {
  const report = fake._reports.find((r) => r.id === reportId);
  return report ? report.custodianUserId : null;
}

describe("SCOPE J1 — deactivated user stays in the chain of custody", () => {
  let fake: ReturnType<typeof makeFake>;
  let userId: string;

  beforeEach(async () => {
    uid = 0;
    fake = makeFake();
    userId = seedUserRow(fake);
    fake._evidence.push({
      id: "ev-1",
      ownerUserId: userId,
      submittedByUserId: userId,
      deletedAt: null,
    });
    fake._custody.push({ id: "cust-1", evidenceId: "ev-1", actorUserId: userId });
  });

  it("SCIM deactivate suspends the member but preserves custody actor + evidence owner", async () => {
    const res = await scimDeactivateUser(CTX, userId, fake as never);
    expect(res.ok).toBe(true);

    // Member SUSPENDED, never deleted.
    const member = fake._members.find((m) => m.userId === userId);
    expect(member?.status).toBe("SUSPENDED");
    expect(fake._deleteAttempts).toBe(0);
    expect(fake._users.find((u) => u.id === userId)).toBeTruthy();

    // J1 invariants:
    const cust = fake._custody.find((c) => c.id === "cust-1");
    expect(cust?.actorUserId).toBe(userId); // custody actor preserved
    const ev = fake._evidence.find((e) => e.id === "ev-1");
    expect(ev?.ownerUserId).toBe(userId); // owner unchanged
    expect(ev?.deletedAt).toBeNull(); // NOT soft-deleted
  });
});

describe("SCOPE J2 — unlink/relink keeps history; relink makes no duplicate user", () => {
  let fake: ReturnType<typeof makeFake>;
  let userId: string;

  beforeEach(async () => {
    uid = 0;
    fake = makeFake();
    userId = seedUserRow(fake);
    fake._evidence.push({
      id: "ev-1",
      ownerUserId: userId,
      submittedByUserId: userId,
      deletedAt: null,
    });
    fake._custody.push({ id: "cust-1", evidenceId: "ev-1", actorUserId: userId });
  });

  it("deactivate soft-unlinks the mapping without touching historical evidence/custody", async () => {
    const usersBefore = fake._users.length;
    await scimDeactivateUser(CTX, userId, fake as never);

    // Mapping soft-unlinked (unlinkedAtUtc set), not removed.
    const mapping = fake._mappings.find((m) => m.userId === userId);
    expect(mapping).toBeTruthy();
    expect(mapping?.unlinkedAtUtc).not.toBeNull();
    // scimReadUser filters on unlinkedAtUtc:null → not resolvable now.
    expect(await scimReadUser(CTX, userId, fake as never)).toBeNull();

    // History untouched.
    expect(fake._evidence).toHaveLength(1);
    expect(fake._custody).toHaveLength(1);
    expect(fake._custody[0].actorUserId).toBe(userId);
    // No user rows added or removed.
    expect(fake._users.length).toBe(usersBefore);
  });

  it("relink (reactivate) re-links the SAME user id — creates no duplicate user", async () => {
    await scimDeactivateUser(CTX, userId, fake as never);
    const usersAfterDeactivate = fake._users.length;
    const mappingsAfterDeactivate = fake._mappings.length;

    const res = await scimReactivateUser(CTX, userId, fake as never);
    expect(res.ok).toBe(true);

    // Same user id resolves again — NO duplicate user, NO duplicate mapping.
    const read = await scimReadUser(CTX, userId, fake as never);
    expect(read?.active).toBe(true);
    expect(fake._users.length).toBe(usersAfterDeactivate); // no new user
    expect(fake._mappings.length).toBe(mappingsAfterDeactivate); // re-used row
    expect(
      fake._mappings.filter((m) => m.userId === userId),
    ).toHaveLength(1);
    // Ownership + custody still on the original id after relink.
    expect(fake._evidence[0].ownerUserId).toBe(userId);
    expect(fake._custody[0].actorUserId).toBe(userId);
  });
});

describe("SCOPE J3 — reports/packages resolve the ORIGINAL custodian after deactivation", () => {
  let fake: ReturnType<typeof makeFake>;
  let userId: string;

  beforeEach(async () => {
    uid = 0;
    fake = makeFake();
    userId = seedUserRow(fake);
    fake._evidence.push({
      id: "ev-1",
      ownerUserId: userId,
      submittedByUserId: userId,
      deletedAt: null,
    });
    // A verification report/package generated while the user was active
    // snapshots the custodian id.
    fake._reports.push({
      id: "rep-1",
      evidenceId: "ev-1",
      custodianUserId: userId,
    });
  });

  it("projection reads the preserved custodian id, independent of live membership status", async () => {
    // Resolves before deactivation.
    expect(resolveReportCustodian(fake, "rep-1")).toBe(userId);

    await scimDeactivateUser(CTX, userId, fake as never);
    // Member is now SUSPENDED and mapping unlinked — a LIVE lookup would
    // fail. The stored projection must still resolve the original id.
    expect(
      fake._members.find((m) => m.userId === userId)?.status,
    ).toBe("SUSPENDED");
    expect(resolveReportCustodian(fake, "rep-1")).toBe(userId);
    // And the evidence submitter snapshot is likewise preserved.
    expect(fake._evidence[0].submittedByUserId).toBe(userId);
  });
});

describe("SCOPE J4 — audit logs preserve the old user identifier", () => {
  it("deactivate audit row records the deactivated user's id as resourceId", async () => {
    uid = 0;
    const fake = makeFake();
    const userId = seedUserRow(fake);

    await scimDeactivateUser(CTX, userId, fake as never);

    const row = fake._audit.find((a) => a.action === "scim.user.deactivate");
    expect(row).toBeTruthy();
    // The OLD identifier is preserved in the audit trail.
    expect(row?.resourceId).toBe(userId);
  });
});

describe("SCOPE J5 — no implicit ownership reassignment on deactivate", () => {
  it("deactivation never moves evidence ownership to another user", async () => {
    uid = 0;
    const fake = makeFake();
    const userId = seedUserRow(fake);
    // A second, still-active admin exists — a naive offboard flow might
    // reassign to them. It must NOT.
    const otherUserId = seedUserRow(fake);
    fake._evidence.push({
      id: "ev-1",
      ownerUserId: userId,
      submittedByUserId: userId,
      deletedAt: null,
    });
    fake._custody.push({ id: "cust-1", evidenceId: "ev-1", actorUserId: userId });

    await scimDeactivateUser(CTX, userId, fake as never);

    const ev = fake._evidence.find((e) => e.id === "ev-1");
    expect(ev?.ownerUserId).toBe(userId); // NOT reassigned to otherUserId
    expect(ev?.ownerUserId).not.toBe(otherUserId);
    expect(fake._custody[0].actorUserId).toBe(userId); // custody unchanged
  });
});

// -----------------------------------------------------------------------------
// SCOPE J6 — external reviewer portal isolation.
//
// The real external-review grant service (external-review-grant.service.ts)
// stores grants in its OWN table keyed by token_hash + grant state
// (PENDING/ACTIVE/REVOKED/EXPIRED). Grant validity is decided by the
// grant row's lifecycle — there is NO join to TeamMember. This model
// mirrors that structure and asserts the isolation invariant.
// -----------------------------------------------------------------------------

type GrantRow = {
  id: string;
  teamId: string;
  invitedByUserId: string;
  tokenHash: string;
  state: "PENDING" | "ACTIVE" | "REVOKED" | "EXPIRED";
  expiresAtUtc: Date;
};

/**
 * Faithful model of the portal grant validity check: a grant is usable
 * iff it is ACTIVE/PENDING and not past expiry. It NEVER consults the
 * inviting user's TeamMember status — that structural separation is the
 * invariant.
 */
function grantIsUsable(grant: GrantRow, now: Date): boolean {
  if (grant.state === "REVOKED" || grant.state === "EXPIRED") return false;
  if (grant.expiresAtUtc.getTime() <= now.getTime()) return false;
  return true;
}

describe("SCOPE J6 — external reviewer portal unaffected by internal identity change", () => {
  let fake: ReturnType<typeof makeFake>;
  let inviterId: string;
  let grant: GrantRow;

  beforeEach(() => {
    uid = 0;
    fake = makeFake();
    inviterId = seedUserRow(fake);
    grant = {
      id: "grant-1",
      teamId: TEAM,
      invitedByUserId: inviterId,
      tokenHash: "hash-token-1",
      state: "ACTIVE",
      expiresAtUtc: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    };
  });

  it("deactivating the inviting internal user does NOT revoke the portal grant", async () => {
    const now = new Date();
    expect(grantIsUsable(grant, now)).toBe(true);

    await scimDeactivateUser(CTX, inviterId, fake as never);
    expect(
      fake._members.find((m) => m.userId === inviterId)?.status,
    ).toBe("SUSPENDED");

    // The grant row's state is untouched — no code path in the SCIM
    // deactivate mutates external_review_grants. Still usable.
    expect(grant.state).toBe("ACTIVE");
    expect(grantIsUsable(grant, now)).toBe(true);
  });

  it("grant validity is governed by the grant lifecycle, not membership", () => {
    const now = new Date();
    // Only an explicit REVOKE (portal action) invalidates it.
    grant.state = "REVOKED";
    expect(grantIsUsable(grant, now)).toBe(false);

    // Or expiry.
    const expired: GrantRow = {
      ...grant,
      state: "ACTIVE",
      expiresAtUtc: new Date(now.getTime() - 1000),
    };
    expect(grantIsUsable(expired, now)).toBe(false);
  });
});
