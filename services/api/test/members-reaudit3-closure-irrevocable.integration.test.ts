/**
 * MEMBERS RE-AUDIT, THIRD ROUND — N4: ONCE PHASE A COMMITS, AN ACCOUNT CLOSURE
 * IS IRREVOCABLY IN PROGRESS (live PostgreSQL).
 *
 *   - Access ends in the SAME transaction that closes the workspaces: if the
 *     session revocation cannot be written, nothing closes (proof by a real
 *     PostgreSQL BEFORE INSERT trigger on revoked_sessions). Control: without
 *     the injection the workspace closes AND the sessions and login methods end.
 *   - A closure whose phase A committed and whose phase B did not (B's audit
 *     refused by a trigger) is resumed by the reaper. A legal hold placed on
 *     the closed workspace in between does NOT turn it into BLOCKED (which would
 *     strand a closed account half-done and cancellable) and does NOT let it
 *     anonymise under the hold: the request stays PROCESSING with access ended.
 *     After the hold is released, the reaper completes it.
 *   - The earlier rule still holds where it applies: a blocker found BEFORE A
 *     ever committed records BLOCKED and closes nothing
 *     (members-reaudit2-audit-atomicity "Defect 7 …").
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedPersonalTenant, type FixtureDeps } from "./point7/product-fixtures.js";

type Prisma = (typeof import("../src/db.js"))["prisma"];

describe("members re-audit 3 — N4: a committed account closure is irrevocable, and holds still govern anonymisation", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let accountClosure: typeof import("../src/services/identity/account-closure.service.js");
  let holds: typeof import("../src/services/governance/legal-hold.service.js");
  let deps: FixtureDeps;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { signJwt } = await import("../src/services/jwt.js");
    accountClosure = await import("../src/services/identity/account-closure.service.js");
    holds = await import("../src/services/governance/legal-hold.service.js");
    deps = {
      prisma: prisma as never,
      tag: `ra3c-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt({ sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) }, process.env.AUTH_JWT_SECRET as string, 3600),
    };

    // Failure-injection seams: real database errors raised by the audit insert
    // for a registered (action, resource), and by the session deny-list insert
    // for a registered user.
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS ra3c_fail (kind text NOT NULL, key text NOT NULL)`);
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION ra3c_audit_fail_fn() RETURNS trigger AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM ra3c_fail f WHERE f.kind = 'audit' AND f.key = NEW.action || ':' || COALESCE(NEW.resource_id, '')) THEN
          RAISE EXCEPTION 'ra3c injected audit failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION ra3c_session_fail_fn() RETURNS trigger AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM ra3c_fail f WHERE f.kind = 'session' AND f.key = NEW.user_id::text) THEN
          RAISE EXCEPTION 'ra3c injected session revocation failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ra3c_audit_fail_trg ON admin_audit_logs`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ra3c_audit_fail_trg BEFORE INSERT ON admin_audit_logs FOR EACH ROW EXECUTE FUNCTION ra3c_audit_fail_fn()`,
    );
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ra3c_session_fail_trg ON revoked_sessions`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ra3c_session_fail_trg BEFORE INSERT ON revoked_sessions FOR EACH ROW EXECUTE FUNCTION ra3c_session_fail_fn()`,
    );
  }, 900_000);

  afterAll(async () => {
    if (prisma) {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ra3c_audit_fail_trg ON admin_audit_logs`).catch(() => undefined);
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ra3c_session_fail_trg ON revoked_sessions`).catch(() => undefined);
    }
    await h?.cleanup();
  }, 300_000);

  async function withInjected<T>(kind: "audit" | "session", key: string, body: () => Promise<T>): Promise<T> {
    await prisma.$executeRawUnsafe(`INSERT INTO ra3c_fail (kind, key) VALUES ($1, $2)`, kind, key);
    try {
      return await body();
    } finally {
      await prisma.$executeRawUnsafe(`DELETE FROM ra3c_fail`);
    }
  }
  const STALE = () => new Date(Date.now() - 2 * 60 * 60 * 1000);
  const processingRequest = (userId: string) =>
    prisma.accountClosureRequest.create({
      data: { userId, status: "PROCESSING", startedAtUtc: STALE() },
      select: { id: true },
    });
  const accountClosedRevocations = (userId: string) =>
    prisma.revokedSession.count({ where: { userId, scope: "ALL_FOR_USER", reason: "ACCOUNT_CLOSED" } });
  const audits = (action: string, resourceId: string) => prisma.adminAuditLog.count({ where: { action, resourceId } });

  it("access ends in the transaction that closes the workspaces: a session revocation that cannot be written closes nothing; control: both happen", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const userId = t.owner.userId;
    const req = await processingRequest(userId);

    await withInjected("session", userId, async () => {
      await expect(accountClosure.executeAccountClosure(userId, { closureRequestId: req.id })).rejects.toThrow();
    });
    // Never "workspace closed, account still signed in": nothing committed.
    expect((await prisma.team.findUniqueOrThrow({ where: { id: t.personalTeamId } })).closedAtUtc).toBeNull();
    const untouched = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(untouched.providerUserId).not.toBe(`closed:${userId}`);
    expect(untouched.email).not.toBeNull();
    expect(await prisma.teamMember.count({ where: { userId, status: "ACTIVE" } })).toBeGreaterThan(0);
    expect(await accountClosedRevocations(userId)).toBe(0);

    // Control: the same execution without the injection.
    await accountClosure.executeAccountClosure(userId, { closureRequestId: req.id });
    expect((await prisma.team.findUniqueOrThrow({ where: { id: t.personalTeamId } })).closedAtUtc).not.toBeNull();
    expect(await accountClosedRevocations(userId)).toBe(1);
    const closed = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(closed.providerUserId).toBe(`closed:${userId}`);
    expect(closed.passwordHash).toBeNull();
    expect(closed.email).toBeNull();
    expect((await prisma.accountClosureRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("COMPLETED");
  });

  it("a hold placed after phase A committed neither BLOCKS the resumed closure nor lets it anonymise; after release the reaper completes it", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const userId = t.owner.userId;
    const req = await processingRequest(userId);

    // 1. Phase A commits; phase B fails (its completion audit is refused) —
    //    the shape of a run interrupted between the two transactions.
    await withInjected("audit", `identity.account_closure_completed:${req.id}`, async () => {
      await expect(accountClosure.executeAccountClosure(userId, { closureRequestId: req.id })).rejects.toThrow();
    });
    expect((await prisma.team.findUniqueOrThrow({ where: { id: t.personalTeamId } })).closedAtUtc).not.toBeNull();
    const afterA = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(afterA.providerUserId).toBe(`closed:${userId}`); // login methods ended with A
    expect(afterA.passwordHash).toBeNull();
    expect(afterA.email).not.toBeNull(); // not anonymised: B rolled back
    expect(await accountClosedRevocations(userId)).toBe(1); // sessions ended with A
    expect((await prisma.accountClosureRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("PROCESSING");

    // 2. A legal hold is placed on the workspace that already closed.
    const hold = (await holds.placeCanonicalLegalHold({
      teamId: t.personalTeamId,
      scope: "WORKSPACE",
      actorUserId: userId,
      title: `placed mid-closure ${randomUUID().slice(0, 6)}`,
    } as never)) as { id: string };

    // 3. The reaper resumes the request.
    await accountClosure.processAccountClosures(new Date());
    const held = await prisma.accountClosureRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(held.status).toBe("PROCESSING"); // irrevocably in progress: not BLOCKED, not FAILED
    expect(await audits("identity.account_closure_blocked", req.id)).toBe(0);
    const underHold = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(underHold.email).not.toBeNull(); // the hold governs anonymisation
    expect(underHold.providerUserId).toBe(`closed:${userId}`); // access stays ended
    expect(await accountClosedRevocations(userId)).toBe(1); // not re-revoked, not restored
    expect((await prisma.team.findUniqueOrThrow({ where: { id: t.personalTeamId } })).closedAtUtc).not.toBeNull();
    expect(await audits("identity.account_closure_completed", req.id)).toBe(0);

    // 4. The hold is released; the next reaper pass completes the closure.
    await prisma.evidenceLegalHold.update({ where: { id: hold.id }, data: { status: "RELEASED", releasedAtUtc: new Date() } as never });
    await prisma.accountClosureRequest.update({ where: { id: req.id }, data: { startedAtUtc: STALE() } });
    await accountClosure.processAccountClosures(new Date());
    expect((await prisma.accountClosureRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("COMPLETED");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).email).toBeNull();
    expect(await audits("identity.account_closure_completed", req.id)).toBe(1);
    expect(await accountClosedRevocations(userId)).toBe(1);
  });

  it("control: a hold present BEFORE phase A ever committed still records BLOCKED and closes nothing, sessions untouched", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const userId = t.owner.userId;
    const hold = (await holds.placeCanonicalLegalHold({
      teamId: t.personalTeamId,
      scope: "WORKSPACE",
      actorUserId: userId,
      title: "placed before execution",
    } as never)) as { id: string };
    const req = await processingRequest(userId);
    await accountClosure.processAccountClosures(new Date());
    expect((await prisma.accountClosureRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("BLOCKED");
    expect((await prisma.team.findUniqueOrThrow({ where: { id: t.personalTeamId } })).closedAtUtc).toBeNull();
    expect(await accountClosedRevocations(userId)).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).providerUserId).not.toBe(`closed:${userId}`);
    await prisma.evidenceLegalHold.update({ where: { id: hold.id }, data: { status: "RELEASED", releasedAtUtc: new Date() } as never });
  });
});
