/**
 * MEMBERS RE-AUDIT — PACKAGE D1a: membership commands under concurrency, the
 * owner-of-record predicate, typed refusals and atomic audit (members audit
 * SEC-01, SEC-02, SEC-04, ROLE-01, ROLE-05, ROLE-06, LIFE-14, AUD-01, AUD-03,
 * AUD-04, AUD-05, MEM-01, DOM-02).
 *
 * Every case drives the real routes against a real PostgreSQL. The concurrency
 * cases are DETERMINISTIC, not timing races: a separate transaction holds the
 * very lock the code under test is supposed to take (or makes the conflicting
 * write and holds it open), the requests are sent, the test waits until
 * PostgreSQL reports them waiting on a lock — or until they have already
 * answered, which is what happens when the lock is missing — and only then
 * releases. So "the lock serialises them" is observed, not hoped for.
 *
 * The one seam replaced is the email provider, so lifecycle notices can be
 * counted and nothing leaves this machine.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

import { createStepUpCeremony } from "./support/step-up-ceremony.js";

const sent = vi.hoisted(() => [] as Array<{ to: string; subject: string; deliveryId: string }>);
vi.mock("../src/services/notifications/resend-provider.js", () => ({
  sendViaResend: async (input: { to: string; subject: string; deliveryId: string }) => {
    sent.push({ to: input.to, subject: input.subject, deliveryId: input.deliveryId });
    return { ok: true, providerMessageId: `fake-${input.deliveryId}` };
  },
}));

type Prisma = import("@prisma/client").PrismaClient;
type Person = { id: string; email: string; token: string; memberId: string | null };
type InjectResult = Awaited<ReturnType<IntegrationHarness["app"]["inject"]>>;

describe("Members re-audit D1a — membership concurrency and governed refusals (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let stepUp: ReturnType<typeof createStepUpCeremony>;
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let hashPassword: typeof import("../src/services/email-password-auth.service.js").hashPassword;
  let legalVersions: Record<string, string>;
  const A = () => h.fixtures.teamA;
  const previousFlag = process.env.NOTIFICATIONS_ENABLED;

  beforeAll(async () => {
    process.env.NOTIFICATIONS_ENABLED = "true";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as Prisma;
    ({ signJwt } = await import("../src/services/jwt.js"));
    ({ hashPassword } = await import("../src/services/email-password-auth.service.js"));
    legalVersions = (await import("../src/legal/legal-versioning.js")).REQUIRED_LEGAL_VERSIONS as Record<string, string>;
    stepUp = createStepUpCeremony({
      prisma,
      inject: (o) => h.app.inject({ method: o.method, url: o.url, headers: o.headers, payload: o.payload as never }) as never,
    });
    // A failure-injection seam for AUD-01: a real database error raised by the
    // audit insert for the (action, resource) pairs a case registers.
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS d1a_audit_fail (action text NOT NULL, resource_id text NOT NULL)`);
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION d1a_audit_fail_fn() RETURNS trigger AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM d1a_audit_fail f WHERE f.action = NEW.action AND f.resource_id = NEW.resource_id) THEN
          RAISE EXCEPTION 'd1a injected audit failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS d1a_audit_fail_trg ON admin_audit_logs`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER d1a_audit_fail_trg BEFORE INSERT ON admin_audit_logs FOR EACH ROW EXECUTE FUNCTION d1a_audit_fail_fn()`,
    );
  }, 900_000);

  afterAll(async () => {
    if (prisma) {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS d1a_audit_fail_trg ON admin_audit_logs`).catch(() => undefined);
    }
    if (previousFlag === undefined) delete process.env.NOTIFICATIONS_ENABLED;
    else process.env.NOTIFICATIONS_ENABLED = previousFlag;
    await h?.cleanup();
  }, 300_000);

  const tag = () => randomUUID().slice(0, 8);
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  async function person(teamId: string | null, role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER" | null): Promise<Person> {
    const email = `d1a-${tag()}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, firstName: "D1a", lastName: "Person", provider: "EMAIL", providerUserId: email },
      select: { id: true },
    });
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(legalVersions).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion,
        source: "integration-harness",
      })),
    });
    const token = signJwt(
      { sub: user.id, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      process.env.AUTH_JWT_SECRET as string,
      3600,
    );
    const membership =
      teamId && role
        ? await prisma.teamMember.create({ data: { teamId, userId: user.id, role, status: "ACTIVE" } })
        : null;
    return { id: user.id, email, token, memberId: membership?.id ?? null };
  }

  /** An OWNED workspace (owner-transferable and closable) with its owner. */
  async function ownedWorkspace(opts: { ownerMembership?: boolean } = {}) {
    const owner = await person(null, null);
    const org = await prisma.organization.create({
      data: { name: `D1a container ${tag()}`, billingOwnerUserId: owner.id, status: "ACTIVE", kind: "SYSTEM" } as never,
      select: { id: true },
    });
    const team = await prisma.team.create({
      data: {
        name: `D1a owned ${tag()}`,
        ownerUserId: owner.id,
        billingOwnerUserId: owner.id,
        isPersonal: false,
        organizationId: org.id,
        workspaceKind: "OWNED",
      } as never,
      select: { id: true },
    });
    let ownerMemberId: string | null = null;
    if (opts.ownerMembership !== false) {
      ownerMemberId = (
        await prisma.teamMember.create({ data: { teamId: team.id, userId: owner.id, role: "OWNER", status: "ACTIVE" } })
      ).id;
    }
    return { teamId: team.id, owner: { ...owner, memberId: ownerMemberId } };
  }

  async function withPassword(userId: string): Promise<string> {
    const password = `D1a-${randomUUID()}`;
    await prisma.user.update({ where: { id: userId }, data: { passwordHash: hashPassword(password) } });
    return password;
  }

  async function approved(actor: { token: string; id: string }, teamId: string, purpose: string, resourceKind?: string, resourceId?: string) {
    return stepUp.approvedHeader({ token: actor.token, userId: actor.id, teamId, purpose, resourceKind, resourceId });
  }

  /**
   * A transaction that does `body` and then HOLDS its locks until released.
   * Resolves `ready` once `body` has run inside the open transaction.
   */
  function holdOpen(body: (tx: Prisma) => Promise<unknown>) {
    let release!: () => void;
    let ready!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const readyP = new Promise<void>((r) => (ready = r));
    const done = prisma.$transaction(
      async (tx) => {
        await body(tx as unknown as Prisma);
        ready();
        await released;
      },
      { maxWait: 10_000, timeout: 60_000 },
    );
    return { ready: readyP, release, done };
  }

  /** Lock-waiting backends in this database right now. */
  async function lockWaiters(): Promise<number> {
    const [{ c }] = await prisma.$queryRaw<Array<{ c: number }>>`
      SELECT count(*)::int AS c FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND datname = current_database()`;
    return c;
  }

  /**
   * Wait until `n` backends are blocked on a lock, or until every pending
   * request has already answered (no lock held them). Returns which happened.
   */
  async function untilBlocked(n: number, pending: Array<Promise<unknown>>): Promise<"blocked" | "answered"> {
    let settled = 0;
    for (const p of pending) void p.then(() => (settled += 1), () => (settled += 1));
    for (let i = 0; i < 2_000; i += 1) {
      if (settled === pending.length) return "answered";
      if ((await lockWaiters()) >= n) return "blocked";
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("neither blocked nor answered");
  }

  const errorCode = (res: InjectResult): string | undefined => {
    const body = res.json() as { code?: string; error?: { code?: string } };
    return body.error?.code ?? body.code;
  };

  // ===========================================================================
  // SEC-04 — the removal's transfer target is re-validated under a row lock.
  // ===========================================================================

  describe("SEC-04 — member removal with a records transfer", () => {
    it("a revocation of the transfer target that commits while the removal waits refuses the transfer; nothing moves", async () => {
      const leaver = await person(A().teamId, "MEMBER");
      const heir = await person(A().teamId, "ADMIN");
      const kase = await prisma.case.create({
        data: { name: `d1a-sec04-${tag()}`, teamId: A().teamId, ownerUserId: leaver.id },
        select: { id: true },
      });
      const owner = { token: A().ownerToken, id: A().ownerUserId };
      const header = await approved(owner, A().teamId, "MEMBER_REVOKE", "team_member", leaver.memberId!);

      // The target's revocation is written and held open: not yet committed.
      const holder = holdOpen((tx) =>
        tx.teamMember.update({
          where: { id: heir.memberId! },
          data: { status: "REVOKED", revokedAtUtc: new Date(), revocationReason: "concurrent" },
        }),
      );
      await holder.ready;
      const removal = h.app.inject({
        method: "DELETE",
        url: `/v1/teams/${A().teamId}/members/${leaver.memberId}`,
        headers: { ...bearer(owner.token), ...header, "content-type": "application/json" },
        payload: { transferToUserId: heir.id },
      });
      // The removal must WAIT on the target's row rather than read it unlocked.
      expect(await untilBlocked(1, [removal])).toBe("blocked");
      holder.release();
      await holder.done;
      const res = await removal;

      expect(res.statusCode, res.body).toBe(400);
      expect(errorCode(res)).toBe("INVALID_TRANSFER_TARGET");
      expect((await prisma.case.findUniqueOrThrow({ where: { id: kase.id } })).ownerUserId).toBe(leaver.id);
      expect((await prisma.teamMember.findUniqueOrThrow({ where: { id: leaver.memberId! } })).status).toBe("ACTIVE");
    });

    it("a removal of the heir waits for a transfer to them to commit, then refuses: the heir now owns records", async () => {
      const giver = await person(A().teamId, "MEMBER");
      const heir = await person(A().teamId, "ADMIN");
      const kase = await prisma.case.create({
        data: { name: `d1a-sec04b-${tag()}`, teamId: A().teamId, ownerUserId: giver.id },
        select: { id: true },
      });
      const owner = { token: A().ownerToken, id: A().ownerUserId };
      const header = await approved(owner, A().teamId, "MEMBER_REVOKE", "team_member", heir.memberId!);

      // A removal of `giver` that hands its case to `heir`, mid-transaction:
      // the heir's row is locked (as the route locks it) and the case moved.
      const holder = holdOpen(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "team_members" WHERE "id" = ${heir.memberId!}::uuid FOR UPDATE`;
        await tx.case.update({ where: { id: kase.id }, data: { ownerUserId: heir.id } });
      });
      await holder.ready;
      const removeHeir = h.app.inject({
        method: "DELETE",
        url: `/v1/teams/${A().teamId}/members/${heir.memberId}`,
        headers: { ...bearer(owner.token), ...header },
      });
      expect(await untilBlocked(1, [removeHeir])).toBe("blocked");
      holder.release();
      await holder.done;
      const res = await removeHeir;

      expect(res.statusCode, res.body).toBe(409);
      expect(errorCode(res)).toBe("TRANSFER_TARGET_REQUIRED");
      expect((res.json() as { impact: { ownedCases: number } }).impact.ownedCases).toBe(1);
      expect((await prisma.teamMember.findUniqueOrThrow({ where: { id: heir.memberId! } })).status).toBe("ACTIVE");
    });
  });

  // ===========================================================================
  // ROLE-01 — the managed-identity gate on the Members & Access routes.
  // ===========================================================================

  it("ROLE-01 — a SCIM-managed member cannot be re-roled or removed from /v1/teams/:id/members/:id (409 managed_identity_readonly); a standard member reaches the step-up gate", async () => {
    const orgA = (await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } }))
      .organizationId;
    const managed = await person(A().teamId, "MEMBER");
    await prisma.user.update({
      where: { id: managed.id },
      data: { identityMode: "MANAGED_ENTERPRISE", managingOrganizationId: orgA, managedIdentitySource: "SCIM" } as never,
    });
    const owner = { token: A().ownerToken, id: A().ownerUserId };
    const url = `/v1/teams/${A().teamId}/members/${managed.memberId}`;

    // Even WITH an approved step-up the directory owns this identity.
    const patch = await h.app.inject({
      method: "PATCH",
      url,
      headers: { ...bearer(owner.token), ...(await approved(owner, A().teamId, "MEMBER_ROLE_CHANGE", "team_member", managed.memberId!)) },
      payload: { role: "VIEWER" },
    });
    expect(patch.statusCode, patch.body).toBe(409);
    expect(errorCode(patch)).toBe("managed_identity_readonly");
    const del = await h.app.inject({
      method: "DELETE",
      url,
      headers: { ...bearer(owner.token), ...(await approved(owner, A().teamId, "MEMBER_REVOKE", "team_member", managed.memberId!)) },
    });
    expect(del.statusCode, del.body).toBe(409);
    expect(errorCode(del)).toBe("managed_identity_readonly");
    expect(await prisma.teamMember.findUniqueOrThrow({ where: { id: managed.memberId! } })).toMatchObject({
      role: "MEMBER",
      status: "ACTIVE",
    });

    // Control: the same request for a STANDARD member passes this gate and
    // stops at the step-up gate instead.
    const standard = await person(A().teamId, "MEMBER");
    const control = await h.app.inject({
      method: "PATCH",
      url: `/v1/teams/${A().teamId}/members/${standard.memberId}`,
      headers: bearer(owner.token),
      payload: { role: "VIEWER" },
    });
    expect(control.statusCode).toBe(401);
    expect(errorCode(control)).toBe("STEP_UP_REQUIRED");
  });

  // ===========================================================================
  // ROLE-06 — one owner-of-record predicate for closure, reopen and transfer.
  // ===========================================================================

  it("ROLE-06 — an ADMIN, and an owner of record without a live OWNER membership, are refused closure, transfer and reopen", async () => {
    const w = await ownedWorkspace();
    const admin = await person(w.teamId, "ADMIN");
    const heir = await person(w.teamId, "MEMBER");
    const password = await withPassword(admin.id);
    const ownerPassword = await withPassword(w.owner.id);

    const closure = (actor: Person, pw: string) =>
      h.app.inject({
        method: "POST",
        url: `/v1/teams/${w.teamId}/closure`,
        headers: bearer(actor.token),
        payload: { confirmation: "close workspace", stepUp: { method: "password", currentPassword: pw } },
      });
    const transfer = (actor: Person, pw: string) =>
      h.app.inject({
        method: "POST",
        url: `/v1/teams/${w.teamId}/transfer-ownership`,
        headers: bearer(actor.token),
        payload: { newOwnerUserId: heir.id, stepUp: { method: "password", currentPassword: pw } },
      });
    const reopen = (actor: Person) =>
      h.app.inject({ method: "POST", url: `/v1/teams/${w.teamId}/reopen`, headers: bearer(actor.token) });

    // An ADMIN is not the owner of record.
    for (const res of [await closure(admin, password), await transfer(admin, password)]) {
      expect(res.statusCode, res.body).toBe(403);
      expect(errorCode(res)).toBe("owner_required");
    }
    const adminReopen = await reopen(admin);
    expect(adminReopen.statusCode, adminReopen.body).toBe(403);
    expect(errorCode(adminReopen)).toBe("not_workspace_owner");

    // The owner of record whose OWNER membership is not live (suspended) is
    // refused too: ownership is the record AND a current OWNER membership.
    await prisma.teamMember.update({ where: { id: w.owner.memberId! }, data: { status: "SUSPENDED" } });
    for (const res of [await closure(w.owner, ownerPassword), await transfer(w.owner, ownerPassword)]) {
      expect(res.statusCode, res.body).toBe(403);
      expect(errorCode(res)).toBe("owner_required");
    }
    expect(await prisma.workspaceClosureRequest.count({ where: { teamId: w.teamId } })).toBe(0);
    expect((await prisma.team.findUniqueOrThrow({ where: { id: w.teamId } })).ownerUserId).toBe(w.owner.id);
    expect((await prisma.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId: w.teamId, userId: heir.id } } })).role).toBe(
      "MEMBER",
    );
  });

  // ===========================================================================
  // SEC-01 — two concurrent ownership transfers: exactly one wins.
  // ===========================================================================

  it("SEC-01 — two transfers released together are serialised by the workspace row lock: one wins, one OWNER remains", async () => {
    const w = await ownedWorkspace();
    const x = await person(w.teamId, "MEMBER");
    const y = await person(w.teamId, "MEMBER");
    const password = await withPassword(w.owner.id);
    const transferTo = (to: string) =>
      h.app.inject({
        method: "POST",
        url: `/v1/teams/${w.teamId}/transfer-ownership`,
        headers: bearer(w.owner.token),
        payload: { newOwnerUserId: to, stepUp: { method: "password", currentPassword: password } },
      });

    // Hold the workspace row so both transfers are in flight at once.
    const holder = holdOpen((tx) => tx.$queryRaw`SELECT "id" FROM "teams" WHERE "id" = ${w.teamId}::uuid FOR UPDATE`);
    await holder.ready;
    const first = transferTo(x.id);
    const second = transferTo(y.id);
    expect(await untilBlocked(2, [first, second])).toBe("blocked");
    holder.release();
    await holder.done;
    const results = await Promise.all([first, second]);

    const statuses = results.map((r) => r.statusCode).sort();
    expect(statuses, results.map((r) => r.body).join(" | ")).toEqual([200, 403]);
    const loser = results.find((r) => r.statusCode === 403)!;
    expect(errorCode(loser)).toBe("not_workspace_owner");
    const owners = await prisma.teamMember.findMany({ where: { teamId: w.teamId, role: "OWNER", status: "ACTIVE" } });
    expect(owners).toHaveLength(1);
    const team = await prisma.team.findUniqueOrThrow({ where: { id: w.teamId } });
    expect(team.ownerUserId).toBe(owners[0]!.userId);
    expect(team.billingOwnerUserId).toBe(owners[0]!.userId);
  });

  // ===========================================================================
  // SEC-02 — the last-administrator guard under two concurrent leaves.
  // ===========================================================================

  it("SEC-02 — the last two administrators leaving at once: the guard's lock serialises them and one administrator remains", async () => {
    // An owner without a membership row (identity-mode shape): the two ADMINs
    // are the only administrators, so the guard is the only thing in the way.
    const w = await ownedWorkspace({ ownerMembership: false });
    const a1 = await person(w.teamId, "ADMIN");
    const a2 = await person(w.teamId, "ADMIN");
    const h1 = await approved(a1, w.teamId, "MEMBER_REVOKE", "team_member");
    const h2 = await approved(a2, w.teamId, "MEMBER_REVOKE", "team_member");

    const holder = holdOpen((tx) =>
      tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`workspace-administrators:${w.teamId}`}))`,
    );
    await holder.ready;
    const l1 = h.app.inject({ method: "POST", url: `/v1/teams/${w.teamId}/leave`, headers: { ...bearer(a1.token), ...h1 } });
    const l2 = h.app.inject({ method: "POST", url: `/v1/teams/${w.teamId}/leave`, headers: { ...bearer(a2.token), ...h2 } });
    expect(await untilBlocked(2, [l1, l2])).toBe("blocked");
    holder.release();
    await holder.done;
    const results = await Promise.all([l1, l2]);

    expect(results.map((r) => r.statusCode).sort(), results.map((r) => r.body).join(" | ")).toEqual([204, 409]);
    expect(errorCode(results.find((r) => r.statusCode === 409)!)).toBe("last_administrator_protected");
    expect(
      await prisma.teamMember.count({ where: { teamId: w.teamId, status: "ACTIVE", role: { in: ["OWNER", "ADMIN"] } } }),
    ).toBe(1);
  });

  // ===========================================================================
  // LIFE-14 / AUD-03 / AUD-04 — transfer refusals are typed; a transfer is
  // audited under its request and tells the new owner.
  // ===========================================================================

  it("LIFE-14 — each transfer refusal reaches the client with its own code", async () => {
    const w = await ownedWorkspace();
    const paused = await person(w.teamId, "MEMBER");
    await prisma.teamMember.update({ where: { id: paused.memberId! }, data: { status: "SUSPENDED" } });
    const stranger = await person(null, null);
    const password = await withPassword(w.owner.id);
    const transfer = (teamId: string, actor: Person, pw: string, to: string) =>
      h.app.inject({
        method: "POST",
        url: `/v1/teams/${teamId}/transfer-ownership`,
        headers: bearer(actor.token),
        payload: { newOwnerUserId: to, stepUp: { method: "password", currentPassword: pw } },
      });

    const suspended = await transfer(w.teamId, w.owner, password, paused.id);
    expect(suspended.statusCode, suspended.body).toBe(409);
    expect(errorCode(suspended)).toBe("transfer_target_not_active_member");
    const outsider = await transfer(w.teamId, w.owner, password, stranger.id);
    expect(outsider.statusCode).toBe(409);
    expect(errorCode(outsider)).toBe("transfer_target_not_active_member");
    const self = await transfer(w.teamId, w.owner, password, w.owner.id);
    expect(self.statusCode).toBe(409);
    expect(errorCode(self)).toBe("transfer_target_is_owner");

    // An Organization Workspace's ownership is the organization's.
    const aOwnerPassword = await withPassword(A().ownerUserId);
    const aOwner = { id: A().ownerUserId, email: "", token: A().ownerToken, memberId: null };
    const org = await transfer(A().teamId, aOwner, aOwnerPassword, A().adminUserId);
    expect(org.statusCode, org.body).toBe(409);
    expect(errorCode(org)).toBe("org_workspace_ownership_is_org_governed");

    expect((await prisma.team.findUniqueOrThrow({ where: { id: w.teamId } })).ownerUserId).toBe(w.owner.id);
  });

  it("AUD-03 / AUD-04 — a transfer's audit carries the request id and the new owner receives WORKSPACE_OWNERSHIP_RECEIVED, once", async () => {
    const w = await ownedWorkspace();
    const heir = await person(w.teamId, "MEMBER");
    const password = await withPassword(w.owner.id);
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/teams/${w.teamId}/transfer-ownership`,
      headers: bearer(w.owner.token),
      payload: { newOwnerUserId: heir.id, stepUp: { method: "password", currentPassword: password } },
    });
    expect(res.statusCode, res.body).toBe(200);
    const requestId = res.headers["x-request-id"] as string;
    expect(requestId).toBeTruthy();

    const audit = await prisma.adminAuditLog.findFirstOrThrow({
      where: { action: "identity.workspace_ownership_transferred", workspaceId: w.teamId },
    });
    expect(audit.requestId).toBe(requestId);
    expect((audit.metadata as Record<string, unknown>).correlationId).toBe(requestId);
    expect(audit.metadata).toMatchObject({ fromUserId: w.owner.id, toUserId: heir.id });

    const notices = await prisma.notificationDelivery.findMany({
      where: { recipientUserId: heir.id, eventType: "WORKSPACE_OWNERSHIP_RECEIVED" },
    });
    expect(notices.map((n) => n.status)).toEqual(["SENT"]);
    expect(sent.filter((s) => s.to === heir.email)).toHaveLength(1);
    // The previous owner is not told they received it.
    expect(
      await prisma.notificationDelivery.count({
        where: { recipientUserId: w.owner.id, eventType: "WORKSPACE_OWNERSHIP_RECEIVED" },
      }),
    ).toBe(0);
  });

  // ===========================================================================
  // AUD-01 — the audit write shares the membership mutation's transaction.
  // ===========================================================================

  describe("AUD-01 — a failing in-transaction audit write rolls the membership change back", () => {
    it("a role change whose audit insert fails changes nothing", async () => {
      const m = await person(A().teamId, "MEMBER");
      await prisma.$executeRaw`INSERT INTO d1a_audit_fail (action, resource_id) VALUES ('identity.member.role.change', ${m.memberId!})`;
      const owner = { token: A().ownerToken, id: A().ownerUserId };
      const res = await h.app.inject({
        method: "PATCH",
        url: `/v1/teams/${A().teamId}/members/${m.memberId}`,
        headers: { ...bearer(owner.token), ...(await approved(owner, A().teamId, "MEMBER_ROLE_CHANGE", "team_member", m.memberId!)) },
        payload: { role: "VIEWER" },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect((await prisma.teamMember.findUniqueOrThrow({ where: { id: m.memberId! } })).role).toBe("MEMBER");
      expect(
        await prisma.membershipGrant.count({ where: { teamMemberId: m.memberId!, grantedRole: "VIEWER" } }),
      ).toBe(0);
      expect(await prisma.notificationDelivery.count({ where: { recipientUserId: m.id } })).toBe(0);
    });

    it("a removal whose audit insert fails leaves the membership ACTIVE and its records where they were", async () => {
      const m = await person(A().teamId, "MEMBER");
      const kase = await prisma.case.create({
        data: { name: `d1a-aud01-${tag()}`, teamId: A().teamId, ownerUserId: m.id },
        select: { id: true },
      });
      await prisma.$executeRaw`INSERT INTO d1a_audit_fail (action, resource_id) VALUES ('identity.member.revoke', ${m.memberId!})`;
      const owner = { token: A().ownerToken, id: A().ownerUserId };
      const res = await h.app.inject({
        method: "DELETE",
        url: `/v1/teams/${A().teamId}/members/${m.memberId}`,
        headers: {
          ...bearer(owner.token),
          ...(await approved(owner, A().teamId, "MEMBER_REVOKE", "team_member", m.memberId!)),
          "content-type": "application/json",
        },
        payload: { transferToUserId: A().ownerUserId },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect((await prisma.teamMember.findUniqueOrThrow({ where: { id: m.memberId! } })).status).toBe("ACTIVE");
      expect((await prisma.case.findUniqueOrThrow({ where: { id: kase.id } })).ownerUserId).toBe(m.id);
      expect(
        await prisma.adminAuditLog.count({
          where: { action: "teams.member_delete", outcome: "success", workspaceId: A().teamId, requestId: res.headers["x-request-id"] as string },
        }),
      ).toBe(0);
      expect(await prisma.teamActivity.count({ where: { teamId: A().teamId, eventType: "member_removed", targetId: m.id } })).toBe(0);
    });
  });

  // ===========================================================================
  // ROLE-05 — workspace identity fields need a fresh step-up.
  // ===========================================================================

  it("ROLE-05 — an ADMIN changing the legal email or logo must step up; the change writes a workspace_updated activity row; a rename does not need one", async () => {
    const admin = { token: A().adminToken, id: A().adminUserId };
    const legalEmail = `legal-${tag()}@example.test`;
    const before = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { legalEmail: true, logoUrl: true } });

    for (const payload of [{ legalEmail }, { logoUrl: `https://cdn.example.test/${tag()}.png` }]) {
      const refused = await h.app.inject({ method: "PATCH", url: `/v1/teams/${A().teamId}`, headers: bearer(admin.token), payload });
      expect(refused.statusCode, refused.body).toBe(401);
      expect(errorCode(refused)).toBe("STEP_UP_REQUIRED");
    }
    // The 401 can be on the wire while the handler is still running: wait for
    // the handler itself before asserting the refusal changed nothing.
    await h.handlersSettled();
    expect(await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { legalEmail: true, logoUrl: true } })).toEqual(before);

    const ok = await h.app.inject({
      method: "PATCH",
      url: `/v1/teams/${A().teamId}`,
      headers: {
        ...bearer(admin.token),
        ...(await approved(admin, A().teamId, "WORKSPACE_IDENTITY_UPDATE", "workspace_identity", A().teamId)),
      },
      payload: { legalEmail },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await prisma.team.findUniqueOrThrow({ where: { id: A().teamId } })).legalEmail).toBe(legalEmail);
    const activity = await prisma.teamActivity.findFirstOrThrow({
      where: { teamId: A().teamId, eventType: "workspace_updated", actorUserId: admin.id },
      orderBy: { createdAt: "desc" },
    });
    expect(activity.metadata).toMatchObject({ updatedFields: ["legalEmail"] });

    // An ordinary profile edit (the name) needs no ceremony.
    const rename = await h.app.inject({
      method: "PATCH",
      url: `/v1/teams/${A().teamId}`,
      headers: bearer(admin.token),
      payload: { name: `Workspace A ${tag()}` },
    });
    expect(rename.statusCode, rename.body).toBe(200);
  });

  // ===========================================================================
  // MEM-01 — removal repairs the removed person's current-workspace pointer.
  // ===========================================================================

  it("MEM-01 — removing a member clears their currentWorkspaceId when it names this workspace", async () => {
    const m = await person(A().teamId, "MEMBER");
    await prisma.user.update({ where: { id: m.id }, data: { currentWorkspaceId: A().teamId } });
    const owner = { token: A().ownerToken, id: A().ownerUserId };
    const res = await h.app.inject({
      method: "DELETE",
      url: `/v1/teams/${A().teamId}/members/${m.memberId}`,
      headers: { ...bearer(owner.token), ...(await approved(owner, A().teamId, "MEMBER_REVOKE", "team_member", m.memberId!)) },
    });
    expect(res.statusCode, res.body).toBe(204);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: m.id } })).currentWorkspaceId).toBeNull();
  });

  // ===========================================================================
  // DOM-02 — the workspace list is the accessible-workspace authority.
  // ===========================================================================

  it("DOM-02 — a SUSPENDED membership and an expired time-boxed one are not listed; an ACTIVE one is", async () => {
    const viewer = await person(null, null);
    const live = await ownedWorkspace();
    const suspended = await ownedWorkspace();
    const expired = await ownedWorkspace();
    await prisma.teamMember.createMany({
      data: [
        { teamId: live.teamId, userId: viewer.id, role: "MEMBER", status: "ACTIVE" },
        { teamId: suspended.teamId, userId: viewer.id, role: "MEMBER", status: "SUSPENDED" },
        {
          teamId: expired.teamId,
          userId: viewer.id,
          role: "MEMBER",
          status: "ACTIVE",
          accessExpiresAtUtc: new Date(Date.now() - 60_000),
        },
      ],
    });

    const res = await h.app.inject({ method: "GET", url: "/v1/teams", headers: bearer(viewer.token) });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { teams?: Array<{ id: string }>; items?: Array<{ id: string }> };
    const ids = (body.teams ?? body.items ?? []).map((t) => t.id);
    expect(ids).toContain(live.teamId);
    expect(ids).not.toContain(suspended.teamId);
    expect(ids).not.toContain(expired.teamId);
  });

  // ===========================================================================
  // AUD-05 — business refusals from the workspace routes carry a typed code.
  // ===========================================================================

  it("AUD-05 — refusals that used to be bare {message} bodies now carry a code the client classifies", async () => {
    const outsider = await person(null, null);
    const notMine = await h.app.inject({ method: "GET", url: `/v1/teams/${A().teamId}`, headers: bearer(outsider.token) });
    expect(notMine.statusCode).toBe(404);
    expect(notMine.json()).toMatchObject({ code: "NOT_FOUND" });

    const missingMember = await h.app.inject({
      method: "PATCH",
      url: `/v1/teams/${A().teamId}/members/${randomUUID()}`,
      headers: bearer(A().ownerToken),
      payload: { role: "VIEWER" },
    });
    expect(missingMember.statusCode).toBe(404);
    expect(missingMember.json()).toMatchObject({ code: "NOT_FOUND" });

    const badQuery = await h.app.inject({
      method: "GET",
      url: `/v1/teams/${A().teamId}/activity?limit=5000`,
      headers: bearer(A().ownerToken),
    });
    expect(badQuery.statusCode).toBe(400);
    expect(badQuery.json()).toMatchObject({ code: "INVALID_QUERY" });

    const linked = await h.app.inject({
      method: "POST",
      url: `/v1/teams/${A().teamId}/cases/link`,
      headers: bearer(A().ownerToken),
      payload: { caseId: A().caseId },
    });
    expect(linked.statusCode).toBe(400);
    expect(linked.json()).toMatchObject({ code: "CASE_ALREADY_IN_WORKSPACE" });

    const forbidden = await h.app.inject({ method: "GET", url: `/v1/teams/${A().teamId}/invites`, headers: bearer(A().memberToken) });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: "FORBIDDEN" });
  });
});
