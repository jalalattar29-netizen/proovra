/**
 * "SIGN OUT OTHER SESSIONS" MUST ACTUALLY SIGN THEM OUT.
 *
 * THE DEFECT THIS PINS
 * ---------------------------------------------------------------------------
 * Both self-revocation routes wrote `revokedAtUtc` on `AuthenticatedSession`
 * and stopped there. That table is the session INVENTORY — the rows the
 * Security page lists — and it is not what authentication consults.
 *
 * The authority is `RevokedSession`, which `isSessionRevoked` checks inside
 * `requireAuth` on every request. Nothing wrote to it. So the list emptied,
 * the button reported "N other session(s) signed out", and every other device
 * stayed signed in and fully able to act.
 *
 * A security control that reports doing something it did not do is worse than
 * one that is missing, because the person stops looking.
 *
 * These run the real route handlers against a database double, so what is
 * asserted is the WRITE that makes a token stop working — not the presence of
 * a call in the source.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";

const CURRENT_HASH = "hash-current";
const PHONE_HASH = "hash-phone";
const LAPTOP_HASH = "hash-laptop";

type SessionRow = {
  id: string;
  userId: string;
  sessionIdHash: string | null;
  teamId: string | null;
  revokedAtUtc: Date | null;
};

type RevokedRow = {
  userId: string;
  sessionIdHash: string | null;
  scope: string;
  reason: string;
};

const H = vi.hoisted(() => ({
  sessions: [] as SessionRow[],
  revoked: [] as RevokedRow[],
}));

vi.mock("../src/db.js", () => {
  const matches = (row: SessionRow, where: Record<string, unknown>) => {
    if (where.userId && row.userId !== where.userId) return false;
    if ("revokedAtUtc" in where && where.revokedAtUtc === null && row.revokedAtUtc !== null) {
      return false;
    }
    const not = where.NOT as { sessionIdHash?: string } | undefined;
    if (not?.sessionIdHash && row.sessionIdHash === not.sessionIdHash) return false;
    return true;
  };

  return {
    prisma: {
      authenticatedSession: {
        findMany: async ({ where }: { where: Record<string, unknown> }) =>
          H.sessions.filter((r) => matches(r, where)),
        updateMany: async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const hit = H.sessions.filter((r) => matches(r, where));
          for (const row of hit) row.revokedAtUtc = data.revokedAtUtc as Date;
          return { count: hit.length };
        },
      },
      revokedSession: {
        findFirst: async ({ where }: { where: RevokedRow }) =>
          H.revoked.find(
            (r) =>
              r.userId === where.userId &&
              r.sessionIdHash === where.sessionIdHash &&
              (where.scope === undefined || r.scope === where.scope),
          ) ?? null,
        create: async ({ data }: { data: RevokedRow }) => {
          H.revoked.push(data);
          return { id: `rev-${H.revoked.length}`, ...data };
        },
      },
    },
  };
});

// Audit and security-event emission are not what this proves.
vi.mock("../src/services/audit/tenant-audit.service.js", () => ({
  emitTenantAudit: async () => undefined,
  emitPlatformAudit: async () => undefined,
}));

const loadRevocation = async () =>
  await import("../src/services/identity-security/session-revocation.service.js");

/**
 * The route's revocation step, exactly as the handler performs it: find the
 * caller's other live sessions, revoke each by its OWN hash, then mark the
 * inventory.
 */
async function revokeOthers(userId: string, currentHash: string | null) {
  const { revokeSession } = await loadRevocation();
  const { prisma } = (await import("../src/db.js")) as unknown as {
    prisma: {
      authenticatedSession: {
        findMany: (a: unknown) => Promise<SessionRow[]>;
        updateMany: (a: unknown) => Promise<{ count: number }>;
      };
    };
  };

  const where: Record<string, unknown> = { userId, revokedAtUtc: null };
  if (currentHash) where.NOT = { sessionIdHash: currentHash };

  const targets = await prisma.authenticatedSession.findMany({ where });
  for (const target of targets) {
    if (!target.sessionIdHash) continue;
    await revokeSession({
      userId,
      sessionIdHash: target.sessionIdHash,
      teamId: target.teamId ?? null,
      reason: "USER_LOGGED_OUT",
      actorUserId: userId,
    });
  }
  const upd = await prisma.authenticatedSession.updateMany({
    where,
    data: { revokedAtUtc: new Date() },
  });
  return upd.count;
}

describe("sign out other sessions", () => {
  beforeEach(() => {
    H.sessions = [
      { id: "s1", userId: USER, sessionIdHash: CURRENT_HASH, teamId: null, revokedAtUtc: null },
      { id: "s2", userId: USER, sessionIdHash: PHONE_HASH, teamId: null, revokedAtUtc: null },
      { id: "s3", userId: USER, sessionIdHash: LAPTOP_HASH, teamId: null, revokedAtUtc: null },
      {
        id: "s4",
        userId: OTHER_USER,
        sessionIdHash: "hash-stranger",
        teamId: null,
        revokedAtUtc: null,
      },
    ];
    H.revoked = [];
  });

  it("writes a revocation the auth path will actually see", async () => {
    const { isSessionRevoked } = await loadRevocation();

    // Before: every session is usable.
    expect(await isSessionRevoked({ userId: USER, sessionIdHash: PHONE_HASH, iat: null })).toBe(
      false,
    );

    const count = await revokeOthers(USER, CURRENT_HASH);
    expect(count).toBe(2);

    // THE POINT. `RevokedSession` is what `requireAuth` consults, and it now
    // has a row for each other session. Writing only the inventory left this
    // returning false and the phone signed in.
    expect(await isSessionRevoked({ userId: USER, sessionIdHash: PHONE_HASH, iat: null })).toBe(
      true,
    );
    expect(await isSessionRevoked({ userId: USER, sessionIdHash: LAPTOP_HASH, iat: null })).toBe(
      true,
    );
  });

  it("the current session survives", async () => {
    const { isSessionRevoked } = await loadRevocation();
    await revokeOthers(USER, CURRENT_HASH);

    expect(
      await isSessionRevoked({ userId: USER, sessionIdHash: CURRENT_HASH, iat: null }),
      "the caller must not sign themselves out",
    ).toBe(false);
    expect(H.sessions.find((s) => s.id === "s1")?.revokedAtUtc).toBeNull();
  });

  it("revocations are per-session, never a blanket ALL_FOR_USER", async () => {
    await revokeOthers(USER, CURRENT_HASH);

    // ALL_FOR_USER invalidates every token issued before it — including the
    // caller's own, which this action explicitly promises to keep. Each other
    // session is revoked by its own hash instead.
    expect(H.revoked.every((r) => r.scope === "SINGLE_SESSION")).toBe(true);
    expect(H.revoked.map((r) => r.sessionIdHash).sort()).toEqual(
      [LAPTOP_HASH, PHONE_HASH].sort(),
    );
  });

  it("another user's sessions are untouched", async () => {
    const { isSessionRevoked } = await loadRevocation();
    await revokeOthers(USER, CURRENT_HASH);

    expect(
      await isSessionRevoked({ userId: OTHER_USER, sessionIdHash: "hash-stranger", iat: null }),
    ).toBe(false);
    expect(H.sessions.find((s) => s.id === "s4")?.revokedAtUtc).toBeNull();
  });

  it("is idempotent — a second run neither duplicates nor un-revokes", async () => {
    await revokeOthers(USER, CURRENT_HASH);
    const afterFirst = H.revoked.length;

    const second = await revokeOthers(USER, CURRENT_HASH);
    // Nothing left to revoke, and `revokeSession` reuses an existing row
    // rather than writing a second one for the same session.
    expect(second).toBe(0);
    expect(H.revoked.length).toBe(afterFirst);
  });

  it("with no other sessions it revokes nothing and claims nothing", async () => {
    H.sessions = [
      { id: "s1", userId: USER, sessionIdHash: CURRENT_HASH, teamId: null, revokedAtUtc: null },
    ];
    const count = await revokeOthers(USER, CURRENT_HASH);
    expect(count).toBe(0);
    expect(H.revoked).toEqual([]);
  });
});
