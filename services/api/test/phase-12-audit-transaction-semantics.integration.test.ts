/**
 * PHASE 12 CORRECTIVE PASS §1.5 — AUDIT TRANSACTION SEMANTICS, SETTLED.
 *
 * The question
 * ---------------------------------------------------------------------------
 * NEW-001 made `appendPlatformAuditLog` USE a caller's transaction instead of
 * opening a nested one. That fixed a hard TypeError (member revocation could
 * not complete at all against real PostgreSQL), and it changed a semantic: the
 * audit row now lives or dies with the business transaction.
 *
 * That is right for one class of audit event and wrong for another, so the
 * classes have to be named:
 *
 *   CLASS A — STATE-TRANSITION AUDIT. "This membership was revoked."
 *             Its truth is the transaction's truth. It MUST commit atomically
 *             with the change, and a rolled-back change must leave no row
 *             claiming it succeeded. Sharing the transaction is not a
 *             workaround here; it is the only correct semantic.
 *
 *   CLASS B — SECURITY ATTEMPT / REFUSAL AUDIT. "This caller was refused."
 *             Its truth is INDEPENDENT of any business transaction — indeed a
 *             refusal usually means no transaction was ever opened. If such an
 *             event were emitted inside a transaction that then rolled back,
 *             the refusal would be erased, and an attacker's failed attempts
 *             would leave no trace. It must therefore be durable on its own.
 *
 * What the source says, and what this suite proves
 * ---------------------------------------------------------------------------
 * Tracing every caller: EXACTLY FOUR sites hand a transaction to the audit
 * sink, all in `rbac.service.ts` (role change, suspend, restore, revoke), and
 * all four are Class A. Every Class B emission — the canonical
 * permission-decision audit in `access-policy.service.ts`, and every
 * `outcome: "denied"` envelope — is emitted on the ROOT client, outside any
 * business transaction.
 *
 * The source can be read; it cannot be trusted alone. This suite drives the
 * real orchestrator against real PostgreSQL and asserts on durable rows.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bootIntegrationHarness,
  type IntegrationHarness,
} from "./integration-harness.js";

describe("§1.5 — audit events commit with the right thing", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;

  let workspaceId: string;
  let ownerUserId: string;

  beforeAll(async () => {
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as
      import("@prisma/client").PrismaClient;
    workspaceId = h.fixtures.teamA.teamId;
    ownerUserId = h.fixtures.teamA.ownerUserId;
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const countRevokeAudits = async (subjectMemberId: string): Promise<number> =>
    prisma.adminAuditLog.count({
      where: {
        action: "identity.member.revoke",
        outcome: "success",
        resourceId: subjectMemberId,
      },
    });

  /** A disposable ACTIVE member to act on, so probes never race each other. */
  const seedMember = async (
    role: "ADMIN" | "MEMBER" = "MEMBER",
  ): Promise<{ id: string; userId: string }> => {
    const user = await prisma.user.create({
      data: {
        email: `p12-audit-${Math.random().toString(36).slice(2, 10)}@example.test`,
        firstName: "Audit",
        lastName: "Probe",
        provider: "EMAIL",
        providerUserId: `p12-${Math.random().toString(36).slice(2, 12)}`,
      },
      select: { id: true },
    });
    const member = await prisma.teamMember.create({
      data: { teamId: workspaceId, userId: user.id, role, status: "ACTIVE" },
      select: { id: true, userId: true },
    });
    return member;
  };

  // ---------------------------------------------------------------------------
  // CLASS A — the state change and its audit are one fact.
  // ---------------------------------------------------------------------------

  it("a SUCCESSFUL revoke and its audit event commit together", async () => {
    const member = await seedMember();
    expect(await countRevokeAudits(member.id)).toBe(0);

    const { revokeMember } = await import(
      "../src/services/identity/rbac.service.js"
    );
    await revokeMember({
      teamId: workspaceId,
      teamMemberId: member.id,
      actorUserId: ownerUserId,
      reason: "§1.5 probe — successful transition",
    });

    const row = await prisma.teamMember.findUnique({
      where: { id: member.id },
      select: { status: true },
    });
    expect(row?.status).toBe("REVOKED");
    // Both halves, or neither. This asserts the "both" half.
    expect(await countRevokeAudits(member.id)).toBe(1);
  });

  it("a REFUSED revoke records no successful-revoke audit event", async () => {
    // The refusal used here is a REAL production path, not injected chaos:
    // `assertNotLastAdministrator` runs INSIDE the transaction, after the
    // audit emission point is reachable, and throws — rolling the whole
    // transaction back. If the audit row were written outside the caller's
    // transaction, it would survive that rollback and the log would assert a
    // revocation that never happened.
    const { revokeMember, RbacError } = await import(
      "../src/services/identity/rbac.service.js"
    );

    // Make the fixture's ADMIN the ONLY remaining ACTIVE administrator.
    //
    // The OWNER row is manipulated DIRECTLY here rather than through the
    // orchestrator, deliberately: `assertNotOwner` forbids suspending or
    // revoking an OWNER through the product path, so the condition
    // `assertNotLastAdministrator` guards against is not reachable via the
    // orchestrator on this fixture. Seeding the precondition by hand is the
    // only way to exercise the guard; the guard itself, and the transaction it
    // aborts, are the real production code.
    const admins = await prisma.teamMember.findMany({
      where: {
        teamId: workspaceId,
        status: "ACTIVE",
        role: { in: ["OWNER", "ADMIN"] },
      },
      select: { id: true, userId: true, role: true },
    });
    const soleAdmin = admins.find((a) => a.role === "ADMIN");
    expect(soleAdmin, "fixture must contain an ADMIN").toBeTruthy();
    const stoodDown = admins.filter((a) => a.id !== soleAdmin!.id);

    for (const a of stoodDown) {
      await prisma.teamMember.update({
        where: { id: a.id },
        data: { status: "SUSPENDED" },
      });
    }
    try {
      const before = await countRevokeAudits(soleAdmin!.id);
      let threw: unknown;
      try {
        await revokeMember({
          teamId: workspaceId,
          teamMemberId: soleAdmin!.id,
          actorUserId: ownerUserId,
          reason: "§1.5 probe — must be refused",
        });
      } catch (err) {
        threw = err;
      }
      expect(
        threw,
        "revoking the last administrator must be refused",
      ).toBeInstanceOf(RbacError);
      expect((threw as InstanceType<typeof RbacError>).message).toContain(
        "last_administrator_protected",
      );

      // THE PROPERTY: the state did not change…
      const row = await prisma.teamMember.findUnique({
        where: { id: soleAdmin!.id },
        select: { status: true },
      });
      expect(row?.status).toBe("ACTIVE");
      // …and no audit row claims it did.
      expect(await countRevokeAudits(soleAdmin!.id)).toBe(before);
    } finally {
      for (const a of stoodDown) {
        await prisma.teamMember.update({
          where: { id: a.id },
          data: { status: "ACTIVE" },
        });
      }
    }
  });

  it("a RETRY after a refusal does not leave a duplicate outcome event", async () => {
    const member = await seedMember();
    const { revokeMember, RbacError } = await import(
      "../src/services/identity/rbac.service.js"
    );

    // First attempt: self-action, refused before any write.
    let threw: unknown;
    try {
      await revokeMember({
        teamId: workspaceId,
        teamMemberId: member.id,
        actorUserId: member.userId,
        reason: "§1.5 probe — self action",
      });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(RbacError);
    expect(await countRevokeAudits(member.id)).toBe(0);

    // Retry, correctly this time.
    await revokeMember({
      teamId: workspaceId,
      teamMemberId: member.id,
      actorUserId: ownerUserId,
      reason: "§1.5 probe — retry",
    });
    expect(await countRevokeAudits(member.id)).toBe(1);

    // Retrying a completed revoke is refused by the transition guard and adds
    // nothing — the outcome event is not re-emitted.
    try {
      await revokeMember({
        teamId: workspaceId,
        teamMemberId: member.id,
        actorUserId: ownerUserId,
        reason: "§1.5 probe — duplicate retry",
      });
    } catch {
      /* invalid_status_transition is the expected refusal */
    }
    expect(await countRevokeAudits(member.id)).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // BOTH CLIENT SHAPES. NEW-001 was found because one of these two was never
  // exercised against a real database.
  // ---------------------------------------------------------------------------

  it("the audit sink works on the ROOT client (opens its own transaction)", async () => {
    const { appendPlatformAuditLog } = await import(
      "../src/services/platform-audit-log.service.js"
    );
    const marker = `p12-root-${Math.random().toString(36).slice(2, 10)}`;
    await appendPlatformAuditLog({
      userId: ownerUserId,
      action: "p12.audit.probe.root",
      category: "test",
      outcome: "success",
      resourceType: "probe",
      resourceId: marker,
      workspaceId,
      metadata: { probe: "root-client" },
    });
    expect(
      await prisma.adminAuditLog.count({ where: { resourceId: marker } }),
    ).toBe(1);
  });

  it("the audit sink works INSIDE a caller transaction, and rolls back with it", async () => {
    const { appendPlatformAuditLog } = await import(
      "../src/services/platform-audit-log.service.js"
    );
    const committed = `p12-tx-commit-${Math.random().toString(36).slice(2, 10)}`;
    const aborted = `p12-tx-abort-${Math.random().toString(36).slice(2, 10)}`;

    // (a) inside a transaction that COMMITS — this is the call shape that threw
    //     `db.$transaction is not a function` before NEW-001.
    await prisma.$transaction(async (tx) => {
      await appendPlatformAuditLog({
        userId: ownerUserId,
        action: "p12.audit.probe.tx",
        category: "test",
        outcome: "success",
        resourceType: "probe",
        resourceId: committed,
        workspaceId,
        metadata: { probe: "tx-client-commit" },
        db: tx as unknown as import("@prisma/client").PrismaClient,
      });
    });
    expect(
      await prisma.adminAuditLog.count({ where: { resourceId: committed } }),
    ).toBe(1);

    // (b) inside a transaction that ABORTS — the row must NOT survive.
    await expect(
      prisma.$transaction(async (tx) => {
        await appendPlatformAuditLog({
          userId: ownerUserId,
          action: "p12.audit.probe.tx",
          category: "test",
          outcome: "success",
          resourceType: "probe",
          resourceId: aborted,
          workspaceId,
          metadata: { probe: "tx-client-abort" },
          db: tx as unknown as import("@prisma/client").PrismaClient,
        });
        throw new Error("§1.5 deliberate abort");
      }),
    ).rejects.toThrow("§1.5 deliberate abort");
    expect(
      await prisma.adminAuditLog.count({ where: { resourceId: aborted } }),
    ).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // CLASS B — a refusal is durable on its own, because no business transaction
  // is ever opened for it.
  // ---------------------------------------------------------------------------

  it("a REFUSED authorization records a durable permission-decision event", async () => {
    const { evaluateMemberAccess } = await import(
      "../src/services/identity/access-policy.service.js"
    );
    const outsider = await prisma.user.create({
      data: {
        email: `p12-outsider-${Math.random().toString(36).slice(2, 10)}@example.test`,
        firstName: "Out",
        lastName: "Sider",
        provider: "EMAIL",
        providerUserId: `p12-${Math.random().toString(36).slice(2, 12)}`,
      },
      select: { id: true },
    });

    // The class-B sink is `SecurityEvent` with eventType `permission_denied`,
    // emitted by `recordPermissionDecision`. Note the actor is NOT a member,
    // so the event carries a null teamId — which is exactly why it is counted
    // by event type and time rather than by tenant.
    const since = new Date(Date.now() - 1000);
    const before = await prisma.securityEvent.count({
      where: { eventType: "permission_denied", createdAt: { gte: since } },
    });
    const decision = await evaluateMemberAccess({
      teamId: workspaceId,
      userId: outsider.id,
      permission: "evidence.read",
    });
    expect(decision.allowed).toBe(false);

    // The refusal is written on the ROOT client — no business transaction was
    // opened, so there is nothing that could roll it back. Emission is
    // fire-and-forget by design (a failing audit must not deny a live user a
    // decision), so settle before reading.
    await new Promise((r) => setTimeout(r, 1000));
    const after = await prisma.securityEvent.count({
      where: { eventType: "permission_denied", createdAt: { gte: since } },
    });
    expect(
      after,
      "a refusal must leave a durable trace; otherwise failed attempts are invisible",
    ).toBeGreaterThan(before);
  });

  it("NO class-B refusal event is emitted inside a business transaction", async () => {
    // The structural half of the claim, checked against the source of the four
    // transaction-sharing call sites rather than inferred. Every one of them
    // must carry `outcome: "success"` — a `denied` envelope inside a
    // transaction would be a refusal that a rollback could erase.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const rbac = readFileSync(
      fileURLToPath(new URL("../src/services/identity/rbac.service.ts", import.meta.url)),
      "utf8",
    );
    // Each `emitTenantAudit({ … }, tx)` block, isolated.
    const txBlocks = [...rbac.matchAll(/await emitTenantAudit\(\{([\s\S]*?)\},\s*tx\)/g)];
    expect(
      txBlocks.length,
      "the four transaction-sharing audit emissions must still be exactly four",
    ).toBe(4);
    for (const [, body] of txBlocks) {
      expect(body).toMatch(/outcome:\s*"success"/);
      expect(body).not.toMatch(/outcome:\s*"denied"/);
    }
  });
});
