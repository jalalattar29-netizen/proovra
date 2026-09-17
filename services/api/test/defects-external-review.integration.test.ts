/**
 * External review defects D2 / D31 / D33 / D17, proven live through
 * `harness.app.inject` against a disposable PostgreSQL 16 and the disposable
 * Redis the harness points REDIS_URL at.
 *
 *   D2  — POST /v1/external-review/invitations/:id/sessions/revoke wrote an
 *         activity row and ended nothing; the reviewer's session kept working.
 *   D31 — POST /v1/portal/logout recorded LOGOUT but the session id kept
 *         working (for an invitation without MFA).
 *   D33 — POST /v1/external-review/access/:token refused every INVITED grant
 *         (the lookup had no `acceptInvited`), so its accept branch was dead;
 *         fixed without letting it bypass the portal's MFA gate.
 *   D17 — acceptCrossOrgReview issued `{ kind: "PACKAGE" }` with no package id,
 *         so no portal invitation could ever be created.
 *
 * The email transport is the RECORDING provider; an MFA code is read from the
 * recorded message.
 */

import { randomUUID } from "node:crypto";

import IORedis from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Json = Record<string, unknown>;

describe("external review defects D2 / D31 / D33 / D17 (live PostgreSQL 16 + Redis)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let recorder: typeof import("@proovra/shared-runtime");
  let challenge: typeof import("../src/services/external-review/portal-mfa-challenge.service.js");
  let redis: IORedis;

  const json = (res: { body: string }) => JSON.parse(res.body) as Json;
  const auth = (payload: Json) =>
    harness.app.inject({
      method: "POST",
      url: "/v1/portal/auth",
      headers: { "content-type": "application/json" },
      payload: payload as never,
    });
  /** portal-client.ts `portalFetch`: bearer = raw token, plus `x-portal-session`. */
  const dashboard = (rawToken: string, sessionId?: string) =>
    harness.app.inject({
      method: "GET",
      url: "/v1/portal/dashboard",
      headers: {
        authorization: `Bearer ${rawToken}`,
        ...(sessionId ? { "x-portal-session": sessionId } : {}),
      },
    });
  const logout = (rawToken: string, sessionId: string) =>
    harness.app.inject({
      method: "POST",
      url: "/v1/portal/logout",
      headers: { authorization: `Bearer ${rawToken}`, "x-portal-session": sessionId },
    });
  const revokeSessions = (token: string, grantId: string, body?: Json) =>
    harness.app.inject({
      method: "POST",
      url: `/v1/external-review/invitations/${grantId}/sessions/revoke`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: (body ?? {}) as never,
    });
  const activity = (grantId: string, code: string) =>
    prisma.externalReviewActivity.findMany({ where: { grantId, code }, orderBy: { occurredAtUtc: "asc" } });
  const grantState = async (grantId: string) =>
    (await prisma.externalReviewGrant.findUniqueOrThrow({ where: { id: grantId } })).state;
  const mfaSessionKey = (grantId: string, sessionId: string) => `portal:mfa-session:${grantId}:${sessionId}`;

  async function issue(opts: { team?: "teamA" | "teamB"; mfaRequired?: boolean } = {}) {
    const { issueInvitation } = await import("../src/services/external-review/portal-invitation.service.js");
    const t = harness.fixtures[opts.team ?? "teamA"];
    const reviewerEmail = `dx-reviewer-${randomUUID().slice(0, 8)}@test.proovra.local`;
    const issued = await issueInvitation({
      teamId: t.teamId,
      invitedByUserId: t.ownerUserId,
      reviewerEmail,
      role: "EXTERNAL_REVIEWER",
      mfaRequired: opts.mfaRequired === true,
      scope: { kind: "EVIDENCE", evidenceId: t.evidenceId },
      expiresAtUtc: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    if (!issued.ok) throw new Error(`invitation refused: ${issued.denial}`);
    return { grantId: issued.grantId, rawToken: issued.rawToken, reviewerEmail };
  }

  async function signIn(rawToken: string): Promise<string> {
    const res = await auth({ token: rawToken });
    expect(res.statusCode, res.body).toBe(200);
    const sessionId = String(json(res).sessionId);
    expect(sessionId).toMatch(/^[0-9a-f]{32}$/);
    return sessionId;
  }

  const mailedCode = (email: string): string => {
    const alias = recorder.recipientAliasFor(email);
    const last = recorder
      .recordedEmails()
      .filter((m) => m.recipientAlias === alias && m.result === "acknowledged")
      .at(-1);
    const match = last ? /^(\d{6}) is your .+ reviewer sign-in code$/.exec(last.subject) : null;
    if (!match) throw new Error("no sign-in code was mailed to the reviewer");
    return match[1]!;
  };

  const deadRedis = () => {
    // Nothing listens on loopback port 1.
    const dead = new IORedis("redis://127.0.0.1:1", {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      connectTimeout: 1_000,
      retryStrategy: () => null,
    });
    dead.on("error", () => undefined);
    return dead;
  };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    recorder = await import("@proovra/shared-runtime");
    challenge = await import("../src/services/external-review/portal-mfa-challenge.service.js");
    redis = new IORedis(process.env.REDIS_URL as string, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    await redis.connect();
    // The operator routes authorize the CURRENT workspace.
    for (const t of [harness.fixtures.teamA, harness.fixtures.teamB]) {
      await prisma.user.update({ where: { id: t.ownerUserId }, data: { currentWorkspaceId: t.teamId } as never });
    }
  }, 180_000);

  afterEach(() => {
    challenge?.setPortalMfaChallengeRedisForTests(null);
  });

  afterAll(async () => {
    redis?.disconnect();
    await harness?.cleanup();
  });

  // ===========================================================================
  // D2 — operator "end sessions" really ends them
  // ===========================================================================

  it("D2 revoke-sessions ends every live portal session of the invitation; the token can sign in again", async () => {
    const a = harness.fixtures.teamA;
    const grant = await issue();
    const first = await signIn(grant.rawToken);
    const second = await signIn(grant.rawToken);
    expect((await dashboard(grant.rawToken, first)).statusCode).toBe(200);
    expect((await dashboard(grant.rawToken, second)).statusCode).toBe(200);

    const res = await revokeSessions(a.ownerToken, grant.grantId);
    expect(res.statusCode, res.body).toBe(200);
    for (const sessionId of [first, second]) {
      const after = await dashboard(grant.rawToken, sessionId);
      expect(after.statusCode, "the ended session must stop working").toBe(401);
      expect(json(after)).toEqual({ denial: "SESSION_ENDED" });
    }
    expect(json(res)).toEqual({ ok: true, sessionsEnded: 2 });
    // Dropping the session header does not get around it.
    const bare = await dashboard(grant.rawToken);
    expect(bare.statusCode).toBe(401);
    expect(json(bare)).toEqual({ denial: "SESSION_ENDED" });
    // Nor does naming the ended session at the token exchange: a NEW id is issued.
    const again = await auth({ token: grant.rawToken, existingSessionId: first });
    expect(again.statusCode, again.body).toBe(200);
    expect(json(again)).toMatchObject({ newLogin: true });
    const fresh = String(json(again).sessionId);
    expect(fresh).not.toBe(first);
    expect((await dashboard(grant.rawToken, fresh)).statusCode).toBe(200);
    expect((await dashboard(grant.rawToken, first)).statusCode).toBe(401);

    // The invitation itself is untouched, and the action is recorded once.
    expect(await grantState(grant.grantId)).toBe("ACTIVE");
    const revoked = await activity(grant.grantId, "PORTAL_SESSION_REVOKED");
    expect(revoked).toHaveLength(1);
    expect(revoked[0]).toMatchObject({ teamId: a.teamId, sessionId: "ALL" });
    expect(revoked[0]!.payload).toEqual({ reason: "OPERATOR_REVOKE" });
  });

  it("D2 revoke-sessions with a session id ends only that session", async () => {
    const a = harness.fixtures.teamA;
    const grant = await issue();
    const kept = await signIn(grant.rawToken);
    const ended = await signIn(grant.rawToken);
    const res = await revokeSessions(a.ownerToken, grant.grantId, { sessionId: ended });
    expect(res.statusCode, res.body).toBe(200);
    expect(json(await dashboard(grant.rawToken, ended))).toEqual({ denial: "SESSION_ENDED" });
    expect((await dashboard(grant.rawToken, kept)).statusCode).toBe(200);
    expect(json(res)).toEqual({ ok: true, sessionsEnded: 1 });
    expect((await activity(grant.grantId, "PORTAL_SESSION_REVOKED"))[0]).toMatchObject({ sessionId: ended });
  });

  it("D2 revoke-sessions ends an MFA session and its answered code: the reviewer must answer a new code", async () => {
    const a = harness.fixtures.teamA;
    const grant = await issue({ mfaRequired: true });
    expect((await auth({ token: grant.rawToken })).statusCode).toBe(401);
    const opened = await auth({ token: grant.rawToken, mfaToken: mailedCode(grant.reviewerEmail) });
    expect(opened.statusCode, opened.body).toBe(200);
    const sessionId = String(json(opened).sessionId);
    expect((await dashboard(grant.rawToken, sessionId)).statusCode).toBe(200);
    expect(await redis.exists(mfaSessionKey(grant.grantId, sessionId))).toBe(1);

    const res = await revokeSessions(a.ownerToken, grant.grantId);
    expect(res.statusCode, res.body).toBe(200);
    const after = await dashboard(grant.rawToken, sessionId);
    expect(after.statusCode, "the ended MFA session must stop working").toBe(401);
    expect(json(after)).toEqual({ denial: "MFA_REQUIRED" });
    expect(await redis.exists(mfaSessionKey(grant.grantId, sessionId))).toBe(0);
    expect(json(res)).toEqual({ ok: true, sessionsEnded: 1 });
    // Re-entry asks for a fresh emailed code.
    const reauth = await auth({ token: grant.rawToken, existingSessionId: sessionId });
    expect(reauth.statusCode).toBe(401);
    expect(json(reauth)).toMatchObject({ denial: "MFA_REQUIRED", codeSent: true });
  });

  it("D2 revoke-sessions: another workspace's invitation answers like a missing one and ends nothing", async () => {
    const a = harness.fixtures.teamA;
    const foreign = await issue({ team: "teamB" });
    const sessionId = await signIn(foreign.rawToken);
    const cross = await revokeSessions(a.ownerToken, foreign.grantId);
    const missing = await revokeSessions(a.ownerToken, randomUUID());
    expect(cross.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(cross.body).toBe(missing.body);
    expect((await dashboard(foreign.rawToken, sessionId)).statusCode).toBe(200);
    expect(await activity(foreign.grantId, "PORTAL_SESSION_REVOKED")).toHaveLength(0);
  });

  it("D2 an unreachable session store fails closed: revoke answers 503 and records nothing; portal requests answer 503", async () => {
    const a = harness.fixtures.teamA;
    const grant = await issue();
    const sessionId = await signIn(grant.rawToken);
    challenge.setPortalMfaChallengeRedisForTests(deadRedis() as never);
    const res = await revokeSessions(a.ownerToken, grant.grantId);
    expect(res.statusCode).toBe(503);
    expect(json(res)).toEqual({ denial: "SESSION_UNAVAILABLE" });
    const read = await dashboard(grant.rawToken, sessionId);
    expect(read.statusCode).toBe(503);
    expect(json(read)).toEqual({ denial: "SESSION_UNAVAILABLE" });
    const exchange = await auth({ token: grant.rawToken });
    expect(exchange.statusCode).toBe(503);
    expect(json(exchange)).toEqual({ denial: "SESSION_UNAVAILABLE" });
    challenge.setPortalMfaChallengeRedisForTests(null);
    expect(await activity(grant.grantId, "PORTAL_SESSION_REVOKED")).toHaveLength(0);
    expect((await dashboard(grant.rawToken, sessionId)).statusCode).toBe(200);
  });

  // ===========================================================================
  // D31 — sign-out ends the session (invitation without MFA)
  // ===========================================================================

  it("D31 logout ends the session: the signed-out id answers SESSION_ENDED, a made-up id never worked", async () => {
    const grant = await issue();
    const sessionId = await signIn(grant.rawToken);
    expect((await dashboard(grant.rawToken, sessionId)).statusCode).toBe(200);

    const out = await logout(grant.rawToken, sessionId);
    expect(out.statusCode, out.body).toBe(200);
    expect(await activity(grant.grantId, "LOGOUT")).toHaveLength(1);

    const after = await dashboard(grant.rawToken, sessionId);
    expect(after.statusCode, "the signed-out session must stop working").toBe(401);
    expect(json(after)).toEqual({ denial: "SESSION_ENDED" });
    // A second sign-out with the ended id records nothing more.
    expect((await logout(grant.rawToken, sessionId)).statusCode).toBe(401);
    expect(await activity(grant.grantId, "LOGOUT")).toHaveLength(1);
    // A session id the exchange never issued does not work either.
    const forged = await dashboard(grant.rawToken, "0".repeat(32));
    expect(forged.statusCode).toBe(401);
    expect(json(forged)).toEqual({ denial: "SESSION_ENDED" });
  });

  // ===========================================================================
  // D33 — legacy path-token accept route
  // ===========================================================================

  it("D33 the legacy accept route accepts an INVITED invitation without MFA", async () => {
    const grant = await issue();
    expect(await grantState(grant.grantId)).toBe("INVITED");
    const res = await harness.app.inject({
      method: "POST",
      url: `/v1/external-review/access/${grant.rawToken}`,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(json(res).context).toMatchObject({ scopeKind: "EVIDENCE" });
    const row = await prisma.externalReviewGrant.findUniqueOrThrow({ where: { id: grant.grantId } });
    expect(row.state).toBe("ACTIVE");
    expect(row.acceptedAtUtc).toBeInstanceOf(Date);
  });

  it("D33 the legacy routes open no ACTIVE MFA invitation: no access recorded, no scope shown", async () => {
    const grant = await issue({ mfaRequired: true });
    // The reviewer passed the portal's emailed-code gate; the invitation is ACTIVE.
    expect((await auth({ token: grant.rawToken })).statusCode).toBe(401);
    const opened = await auth({ token: grant.rawToken, mfaToken: mailedCode(grant.reviewerEmail) });
    expect(opened.statusCode, opened.body).toBe(200);
    expect(await grantState(grant.grantId)).toBe("ACTIVE");

    // A holder of the token alone cannot use the legacy routes to skip the code.
    const accept = await harness.app.inject({
      method: "POST",
      url: `/v1/external-review/access/${grant.rawToken}`,
    });
    expect(accept.statusCode, "the legacy accept must not bypass MFA").toBe(403);
    expect(json(accept)).toEqual({ error: { code: "portal_mfa_required", portalPath: "/portal" } });
    const context = await harness.app.inject({
      method: "GET",
      url: `/v1/external-review/access/${grant.rawToken}/context`,
    });
    expect(context.statusCode, "the legacy context must not bypass MFA").toBe(403);
    expect(json(context)).toEqual({ error: { code: "portal_mfa_required", portalPath: "/portal" } });
    const row = await prisma.externalReviewGrant.findUniqueOrThrow({ where: { id: grant.grantId } });
    expect(row.accessCount).toBe(0);
  });

  it("D33 the legacy accept route neither accepts an INVITED MFA invitation nor answers an unknown token differently", async () => {
    const grant = await issue({ mfaRequired: true });
    const accept = await harness.app.inject({
      method: "POST",
      url: `/v1/external-review/access/${grant.rawToken}`,
    });
    expect(accept.statusCode).toBe(403);
    expect(json(accept)).toEqual({ error: { code: "portal_mfa_required", portalPath: "/portal" } });
    const row = await prisma.externalReviewGrant.findUniqueOrThrow({ where: { id: grant.grantId } });
    expect(row.state).toBe("INVITED");
    expect(row.acceptedAtUtc).toBeNull();
    expect(row.accessCount).toBe(0);

    // An unknown token still answers the same anti-enumeration 401.
    const unknown = await harness.app.inject({
      method: "POST",
      url: `/v1/external-review/access/${"ab".repeat(32)}`,
    });
    expect(unknown.statusCode).toBe(401);
    expect(json(unknown)).toEqual({ error: { code: "grant_not_active" } });
  });

  // ===========================================================================
  // D17 — cross-org acceptance issues a portal invitation for the real subject
  // ===========================================================================

  it("D17 accepting a cross-org review issues a portal invitation scoped to the review's subject", async () => {
    const a = harness.fixtures.teamA;
    const row = await prisma.crossOrgReviewGrant.create({
      data: {
        teamId: a.teamId,
        invitingOrganizationId: randomUUID(),
        invitedOrgSlug: `dx-org-${randomUUID().slice(0, 6)}`,
        state: "INVITED",
        scope: { text: "Review the intake photo", subject: { kind: "EVIDENCE", id: a.evidenceId } },
        createdByUserId: a.ownerUserId,
      },
      select: { id: true },
    });
    // CrossOrgReviewForms.tsx — POST /v1/governance/cross-org-review/:id/accept.
    const res = await harness.app.inject({
      method: "POST",
      url: `/v1/governance/cross-org-review/${row.id}/accept`,
      headers: { authorization: `Bearer ${a.ownerToken}`, "content-type": "application/json" },
      payload: { acceptingOrganizationId: randomUUID() },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(json(res)).toEqual({ ok: true });
    const after = await prisma.crossOrgReviewGrant.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.state).toBe("ACCEPTED");
    expect(after.externalReviewGrantId).not.toBeNull();
    const portal = await prisma.externalReviewGrant.findUniqueOrThrow({
      where: { id: after.externalReviewGrantId! },
    });
    expect(portal).toMatchObject({
      teamId: a.teamId,
      scopeKind: "EVIDENCE",
      evidenceId: a.evidenceId,
      packageId: null,
      state: "INVITED",
    });
  });

  it("D17 the invite route requires a subject of the inviting workspace, records it, and the review can then be accepted", async () => {
    const a = harness.fixtures.teamA;
    const b = harness.fixtures.teamB;
    const invite = (payload: Json) =>
      harness.app.inject({
        method: "POST",
        url: "/v1/governance/cross-org-review",
        headers: { authorization: `Bearer ${a.ownerToken}`, "content-type": "application/json" },
        payload: payload as never,
      });
    // CrossOrgReviewForms.tsx — the invite body.
    const base = {
      invitingOrganizationId: randomUUID(),
      invitedOrgSlug: `dx-org-${randomUUID().slice(0, 6)}`,
      scope: "Review the dock camera footage",
      expiresAtUtc: null,
    };
    // The inviting workspace is licensed for cross-org review (both gates the
    // route checks), granted through the entitlement authority.
    const { upsertEntitlementGrant } = await import("../src/services/packaging/entitlement.service.js");
    for (const key of ["FEATURE_CROSS_ORG_REVIEW", "FEATURE_GOVERNANCE_PLATFORM"] as const) {
      await upsertEntitlementGrant({
        teamId: a.teamId,
        key,
        value: true,
        kind: "FEATURE",
        source: "CUSTOM",
        grantedByUserId: a.ownerUserId,
      });
    }
    const before = await prisma.crossOrgReviewGrant.count({ where: { teamId: a.teamId } });

    const bare = await invite(base);
    expect(bare.statusCode, bare.body).toBe(400);
    const foreign = await invite({ ...base, subject: { kind: "EVIDENCE", id: b.evidenceId } });
    expect(foreign.statusCode, foreign.body).toBe(409);
    expect(json(foreign)).toEqual({ denial: "SUBJECT_NOT_IN_WORKSPACE" });
    expect(await prisma.crossOrgReviewGrant.count({ where: { teamId: a.teamId } })).toBe(before);

    const created = await invite({ ...base, subject: { kind: "EVIDENCE", id: a.evidenceId } });
    expect(created.statusCode, created.body).toBe(201);
    const grantId = String(json(created).grantId);
    const row = await prisma.crossOrgReviewGrant.findUniqueOrThrow({ where: { id: grantId } });
    expect(row).toMatchObject({ teamId: a.teamId, state: "INVITED", createdByUserId: a.ownerUserId });
    expect(row.scope).toEqual({ text: base.scope, subject: { kind: "EVIDENCE", id: a.evidenceId } });

    const accepted = await harness.app.inject({
      method: "POST",
      url: `/v1/governance/cross-org-review/${grantId}/accept`,
      headers: { authorization: `Bearer ${a.ownerToken}`, "content-type": "application/json" },
      payload: { acceptingOrganizationId: randomUUID() },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const after = await prisma.crossOrgReviewGrant.findUniqueOrThrow({ where: { id: grantId } });
    expect(after.state).toBe("ACCEPTED");
    expect(after.externalReviewGrantId).not.toBeNull();
  });

  it("D17 accepting a review with no subject names the reason", async () => {
    const a = harness.fixtures.teamA;
    const row = await prisma.crossOrgReviewGrant.create({
      data: {
        teamId: a.teamId,
        invitingOrganizationId: randomUUID(),
        invitedOrgSlug: `dx-org-${randomUUID().slice(0, 6)}`,
        state: "INVITED",
        scope: { text: "created before subjects were recorded" },
        createdByUserId: a.ownerUserId,
      },
      select: { id: true },
    });
    const res = await harness.app.inject({
      method: "POST",
      url: `/v1/governance/cross-org-review/${row.id}/accept`,
      headers: { authorization: `Bearer ${a.ownerToken}`, "content-type": "application/json" },
      payload: { acceptingOrganizationId: randomUUID() },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(json(res)).toEqual({ denial: "SUBJECT_REQUIRED" });
  });

  it("D17 a cross-org review with no subject, or a subject outside the workspace, is not accepted", async () => {
    const a = harness.fixtures.teamA;
    const b = harness.fixtures.teamB;
    const { acceptCrossOrgReview } = await import("../src/services/governance/cross-org-review.service.js");
    for (const scope of [
      { text: "free text only" },
      { text: "foreign", subject: { kind: "EVIDENCE", id: b.evidenceId } },
    ]) {
      const row = await prisma.crossOrgReviewGrant.create({
        data: {
          teamId: a.teamId,
          invitingOrganizationId: randomUUID(),
          invitedOrgSlug: `dx-org-${randomUUID().slice(0, 6)}`,
          state: "INVITED",
          scope,
          createdByUserId: a.ownerUserId,
        },
        select: { id: true },
      });
      const res = await acceptCrossOrgReview({
        teamId: a.teamId,
        grantId: row.id,
        acceptingOrganizationId: randomUUID(),
        externalReviewGrantId: null,
        actorUserId: a.ownerUserId,
      });
      expect(res.ok).toBe(false);
      const after = await prisma.crossOrgReviewGrant.findUniqueOrThrow({ where: { id: row.id } });
      expect(after).toMatchObject({ state: "INVITED", externalReviewGrantId: null });
    }
    expect(
      await prisma.externalReviewGrant.count({ where: { teamId: a.teamId, evidenceId: b.evidenceId } }),
    ).toBe(0);
  });
});
