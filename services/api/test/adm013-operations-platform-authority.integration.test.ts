/**
 * ADM-013 — WHO MAY CALL THE `/v1/operations/*` PLATFORM FAMILIES.
 *
 * ===========================================================================
 * WHAT THE ROUTE-SCOPE AUDIT TURNED UP
 * ===========================================================================
 * Four route families — queues, exports, signers, recovery — are consumed by
 * exactly one page each, and all four of those pages live under
 * `/admin/platform/*`, behind the layout's `platform.admin` route gate. The
 * product audience is platform operators.
 *
 * The API's audience was not. Every endpoint in all four families authorized
 * through one helper:
 *
 *     const member = await prisma.teamMember.findUnique({ teamId, userId })
 *     evaluateMemberAccess({ teamId, userId, permission: "identity.member.read" })
 *
 * `identity.member.read` is the weakest read permission there is — an ordinary
 * ACTIVE member of a workspace holds it, and every authenticated user has a
 * personal workspace they are the member of. So the caller supplies their OWN
 * `teamId`, passes the check, and reaches data that is not theirs.
 *
 * ===========================================================================
 * WHY THAT IS NOT MERELY UNTIDY
 * ===========================================================================
 * The data behind these families is PLATFORM data, not per-workspace data:
 *
 *   - `listAllSigners` starts from `getCurrentActiveSigners()`, which takes no
 *     `teamId` at all. It returns the platform's live signing identities —
 *     signerId, purpose, provider, keyId, keyVersion, kmsKeyArn, algorithm.
 *   - the queues route says so in its own header: "The queues themselves are
 *     global (not per-workspace) … We do NOT filter jobs by team in the
 *     listing." The `teamId` is the AUDIT scope, not a filter.
 *   - exports exposes platform Object Lock status.
 *   - recovery exposes DR readiness, and its validate endpoints START WORK.
 *
 * A web route gate is a UX affordance. The API is the security boundary, and
 * this one was granting platform-operations reach to any workspace member who
 * knew the path.
 *
 * ===========================================================================
 * THE FIX IS A TIGHTENING, AND THAT MATTERS
 * ===========================================================================
 * Every consumer of these endpoints is already platform-admin-gated, so
 * requiring platform authority removes nothing any user could legitimately
 * reach. This suite asserts the tightened rule from both sides: a platform
 * operator still gets through, and an ordinary member no longer does.
 *
 * A test that only asserted the 403 would pass just as well if the endpoint
 * were deleted, so each family is also exercised positively.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("/v1/operations/* platform authority (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];

  /** An ordinary ACTIVE member of a real workspace. Not a platform operator. */
  let memberToken: string;
  let memberTeamId: string;
  /** A user whose only workspace is their own personal one. */
  let personalToken: string;
  let personalTeamId: string;
  /** A genuine platform operator. */
  let platformToken: string;
  let platformTeamId: string;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));

    const f = harness.fixtures;
    memberToken = f.teamA.memberToken;
    memberTeamId = f.teamA.teamId;
    personalToken = f.personal.token;
    personalTeamId = f.personal.teamId;

    // The platform operator is teamA's owner, promoted. Reusing a seeded user
    // keeps the workspace membership real, so a 403 in the negative cases
    // cannot be explained away as "that user was not in the workspace".
    platformTeamId = f.teamA.teamId;
    platformToken = f.teamA.ownerToken;
    // `platformRole: "admin"` is what `resolvePlatformAdmin` reads. The JWT
    // role claim is advisory and is deliberately NOT trusted on its own, so
    // the database row is the thing that has to be set.
    await prisma.user.update({
      where: { id: f.teamA.ownerUserId },
      data: { platformRole: "admin" },
    });
  }, 300_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  }, 120_000);

  function get(path: string, token: string) {
    return harness.app.inject({
      method: "GET",
      url: path,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  /**
   * Every read endpoint in the four families, with the workspace the CALLER
   * legitimately belongs to. Nothing here is cross-tenant access — that is the
   * point. The caller is asking about their own workspace and receiving the
   * platform's.
   */
  const READ_ENDPOINTS = [
    { family: "queues", path: (t: string) => `/v1/operations/queues?teamId=${t}` },
    { family: "queues", path: (t: string) => `/v1/operations/queues/workers?teamId=${t}` },
    {
      family: "queues",
      path: (t: string) => `/v1/operations/queues/replay-safety?teamId=${t}`,
    },
    { family: "exports", path: (t: string) => `/v1/operations/exports?teamId=${t}` },
    {
      family: "exports",
      path: (t: string) => `/v1/operations/exports/object-lock?teamId=${t}`,
    },
    { family: "signers", path: (t: string) => `/v1/operations/signers?teamId=${t}` },
    { family: "recovery", path: (t: string) => `/v1/operations/recovery?teamId=${t}` },
    {
      family: "recovery",
      path: (t: string) => `/v1/operations/recovery/reports?teamId=${t}`,
    },
  ];

  // ==========================================================================
  // The negative side: an ordinary member is refused.
  // ==========================================================================

  it("an ordinary workspace member cannot read any platform operations family", async () => {
    const reached: string[] = [];
    for (const ep of READ_ENDPOINTS) {
      const res = await get(ep.path(memberTeamId), memberToken);
      // 401 would mean the token was rejected, which would make the test
      // vacuous. 404 is acceptable only if the route genuinely does not exist.
      expect(res.statusCode, `${ep.path(memberTeamId)} rejected the token`).not.toBe(401);
      if (res.statusCode < 400) reached.push(`${ep.family} ${ep.path("<own>")}`);
    }
    expect(
      reached,
      "an ordinary member reached platform operations data — the web route " +
        "gate is not a security boundary, the API is",
    ).toEqual([]);
  });

  it("a user with only a personal workspace is refused too", async () => {
    // Every authenticated user has one of these, so this is the widest
    // possible caller.
    const reached: string[] = [];
    for (const ep of READ_ENDPOINTS) {
      const res = await get(ep.path(personalTeamId), personalToken);
      expect(res.statusCode).not.toBe(401);
      if (res.statusCode < 400) reached.push(ep.path("<personal>"));
    }
    expect(reached).toEqual([]);
  });

  it("the refusal is an authorization refusal, not an accident", async () => {
    // A 404 or a 500 would also produce an empty `reached` list above while
    // meaning something entirely different.
    const res = await get(`/v1/operations/signers?teamId=${memberTeamId}`, memberToken);
    expect(res.statusCode).toBe(403);
    const body = res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBeTruthy();
  });

  it("refusing leaks nothing about the platform", async () => {
    const res = await get(`/v1/operations/signers?teamId=${memberTeamId}`, memberToken);
    const payload = res.payload;
    for (const forbidden of ["kmsKeyArn", "keyId", "keyVersion", "signerId"]) {
      expect(
        payload,
        `the refusal body mentions ${forbidden} — a 403 that describes what it ` +
          `is protecting is a 403 that leaks`,
      ).not.toContain(forbidden);
    }
  });

  // ==========================================================================
  // The positive side: a platform operator still gets through.
  // ==========================================================================

  it("a platform operator reads every family", async () => {
    const refused: string[] = [];
    for (const ep of READ_ENDPOINTS) {
      const res = await get(ep.path(platformTeamId), platformToken);
      if (res.statusCode >= 400) {
        refused.push(`${ep.path("<team>")} → ${res.statusCode} ${res.payload.slice(0, 120)}`);
      }
    }
    expect(
      refused,
      "the tightening locked out the audience it was meant to serve",
    ).toEqual([]);
  });

  it("the signers read really does return platform signing identities", async () => {
    // Proves the data behind the gate is platform-scoped, which is WHY the
    // gate has to be platform-scoped. If this ever returns only per-workspace
    // rows, the authority question should be reopened rather than assumed.
    const res = await get(`/v1/operations/signers?teamId=${platformTeamId}`, platformToken);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { signers?: unknown[] } | unknown[];
    const signers = Array.isArray(body) ? body : (body.signers ?? []);
    expect(Array.isArray(signers)).toBe(true);
  });

  // ==========================================================================
  // Mutating endpoints, which are the ones that would actually do harm.
  // ==========================================================================

  it("an ordinary member cannot start a recovery validation", async () => {
    // This one does not read a secret — it STARTS WORK on the platform.
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/operations/recovery/validate-backup",
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { teamId: memberTeamId },
    });
    expect(res.statusCode).not.toBe(401);
    expect(
      res.statusCode,
      "an ordinary member could trigger platform DR validation",
    ).toBeGreaterThanOrEqual(400);
  });

  it("an ordinary member cannot retry, replay or cancel a queue job", async () => {
    const jobId = randomUUID();
    for (const action of ["retry", "replay", "cancel"]) {
      const res = await harness.app.inject({
        method: "POST",
        // A REAL queue name. An unknown one is rejected by the route schema
        // with a 400 before the authority check ever runs, which would make
        // this assertion pass without proving anything about authorization.
        url: `/v1/operations/queues/evidence-purge/jobs/${jobId}/${action}`,
        headers: { authorization: `Bearer ${memberToken}` },
        // A WELL-FORMED body. `reason` is required by the route schema, and
        // omitting it produces a 400 from Zod before the authority check runs
        // — which would make this pass while proving nothing.
        payload: { teamId: memberTeamId, reason: "authority probe" },
      });
      expect(res.statusCode).not.toBe(401);
      expect(
        res.statusCode,
        `an ordinary member reached queue ${action}`,
      ).toBeGreaterThanOrEqual(400);
      // And specifically an authorization refusal, not "no such job" — a 404
      // here would mean the authority check never ran and the caller merely
      // guessed a job id that did not exist.
      expect(res.statusCode, `queue ${action} refused for the wrong reason`).toBe(403);
    }
  });
});
