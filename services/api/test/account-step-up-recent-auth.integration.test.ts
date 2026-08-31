/**
 * RECENT-AUTH STEP-UP, against live PostgreSQL.
 *
 * THE BUG THIS PROVES FIXED
 * ---------------------------------------------------------------------------
 * "Request data export" answered `STEP_UP_REQUIRED` with "sign out and sign
 * back in with your identity provider, then retry within 10 minutes". Doing
 * exactly that produced the same denial, forever.
 *
 * The recent-auth branch read `req.sessionIdHash`. `requireAuth` never sets
 * that property — it puts the hashed `sid` on `req.user.sessionIdHash`, and
 * `getAuthSessionId` is the one accessor for it. The value was always
 * undefined, so the `AuthenticatedSession` lookup never ran and the branch
 * fell straight through to deny. No sign-in, however fresh, was ever read.
 *
 * These are BEHAVIOUR tests against the real verifier and the real table:
 * the freshness decision is made by the server from a row it reads, and the
 * fixtures below never tell it what to conclude.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

/** The window the service enforces; a stale row sits well outside it. */
const WELL_INSIDE_MS = 60_000;
const WELL_OUTSIDE_MS = 6 * 60 * 60 * 1000;

describe("account step-up — recent auth (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let verifyAccountStepUp: (typeof import("../src/services/identity-security/account-step-up.service.js"))["verifyAccountStepUp"];
  let hashSessionId: (sid: string) => string;
  let userA = "";
  let userB = "";

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ verifyAccountStepUp } = await import(
      "../src/services/identity-security/account-step-up.service.js"
    ));
    ({ hashSessionId } = await import(
      "../src/services/identity-security/session-revocation.service.js"
    ));
    userA = harness.fixtures.teamA.ownerUserId;
    userB = harness.fixtures.teamB.ownerUserId;

    // The recent-auth path is the OAuth-only path: no password, no factor.
    // Anything else and the verifier legitimately demands a proof instead.
    for (const id of [userA, userB]) {
      await prisma.user.update({ where: { id }, data: { passwordHash: null } });
      await prisma.mfaFactor.deleteMany({ where: { userId: id } });
    }
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  /** A request shaped the way `requireAuth` actually leaves it. */
  function reqFor(sid: string | null) {
    return {
      user: sid ? { sessionIdHash: hashSessionId(sid) } : {},
      headers: {},
    } as never;
  }

  /** Record a session for `userId`, issued `agoMs` ago. */
  async function seedSession(userId: string, agoMs: number): Promise<string> {
    const sid = randomUUID();
    const issued = new Date(Date.now() - agoMs);
    await prisma.authenticatedSession.create({
      data: {
        userId,
        teamId: null,
        sessionIdHash: hashSessionId(sid),
        issuedAtUtc: issued,
        expiresAtUtc: new Date(Date.now() + 86_400_000),
        lastSeenAtUtc: issued,
      },
    });
    return sid;
  }

  const call = (userId: string, sid: string | null) =>
    verifyAccountStepUp({
      req: reqFor(sid),
      reply: {} as never,
      userId,
      action: "data_export_request",
      proof: null,
    });

  it("a FRESH session satisfies recent auth", async () => {
    const sid = await seedSession(userA, WELL_INSIDE_MS);
    const verdict = await call(userA, sid);
    expect(verdict.ok, "a sign-in a minute ago must satisfy the gate").toBe(true);
  });

  it("a STALE session is still denied", async () => {
    const sid = await seedSession(userA, WELL_OUTSIDE_MS);
    const verdict = await call(userA, sid);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.denial.status).toBe(401);
      expect(JSON.stringify(verdict.denial.body)).toContain("STEP_UP_REQUIRED");
    }
  });

  it("signing out and back in changes the verdict — the loop is gone", async () => {
    // Stale session: denied, exactly as the person first experienced.
    const stale = await seedSession(userA, WELL_OUTSIDE_MS);
    expect((await call(userA, stale)).ok).toBe(false);

    // Sign out: the session is revoked.
    await prisma.authenticatedSession.updateMany({
      where: { sessionIdHash: hashSessionId(stale) },
      data: { revokedAtUtc: new Date() },
    });
    expect(
      (await call(userA, stale)).ok,
      "a revoked session must never satisfy freshness",
    ).toBe(false);

    // Sign back in: a new session row, and the retry now succeeds.
    const fresh = await seedSession(userA, WELL_INSIDE_MS);
    expect(
      (await call(userA, fresh)).ok,
      "the retry after a real re-authentication must be allowed",
    ).toBe(true);
  });

  it("a REVOKED but recent session does not count", async () => {
    const sid = await seedSession(userA, WELL_INSIDE_MS);
    await prisma.authenticatedSession.updateMany({
      where: { sessionIdHash: hashSessionId(sid) },
      data: { revokedAtUtc: new Date() },
    });
    expect((await call(userA, sid)).ok).toBe(false);
  });

  it("another user's fresh session cannot authorize this user", async () => {
    // The lookup is scoped by userId AND session hash, so B's live session is
    // not a credential for A even when the hash is presented.
    const sidB = await seedSession(userB, WELL_INSIDE_MS);
    expect(
      (await call(userA, sidB)).ok,
      "cross-user session reuse must be refused",
    ).toBe(false);
  });

  it("no resolvable session denies rather than passing", async () => {
    // A token with no `sid` cannot be bound to a session. That is precisely
    // the case the gate exists for, so it must deny, never fall open.
    expect((await call(userA, null)).ok).toBe(false);
  });

  it("a session hash the table does not know is denied", async () => {
    // The client controls the hash it presents; only a row the SERVER wrote
    // can satisfy the gate.
    const unknown = randomUUID();
    expect((await call(userA, unknown)).ok).toBe(false);
  });
});
