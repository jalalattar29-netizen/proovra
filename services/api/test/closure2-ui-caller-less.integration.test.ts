/**
 * PRO-CENZ-01 (owner decision K) — closure phase 2, the "ui" lane: the API side
 * of the caller-less routes that now have a web control, the routes retired to
 * typed tombstones, and the operator-only session revoke.
 *
 *   EP-0450  GET /v1/external-review/grants and GET /v1/external-review/invitations
 *            project `viewerCanRenew` from the renew route's own authority
 *            (governance.legal_hold.manage + the External Review entitlement)
 *            and the grant's renewability; the web offers Renew on it only.
 *   M626     GET /v1/evidence/:id/owner-destruction-approval — what the record
 *            owner's control may offer, from the approval's eligibility rule.
 *   EP-0389  PATCH /v1/evidence/:id/relationships/:relationshipId — allowed for
 *            a writer, refused (concealed) for a viewer and another tenant.
 *   EP-0425 / EP-0446 / EP-0934 / EP-1066  typed 410 tombstones: authenticated,
 *            no read, no write, the canonical route named; 401 without a session.
 *   EP-0538  POST /v1/identity-security/sessions/revoke — operator tooling: a
 *            MEMBER and a VIEWER are refused before anything ends.
 *
 * Live PostgreSQL through the integration harness; no provider is contacted.
 */
import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness } from "./integration-harness.js";
import { seedUser, type FixtureDeps } from "./point7/product-fixtures.js";

const DAY = 86_400_000;

describe("closure phase 2 (ui) — caller-less routes with a control, tombstones, operator revoke (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let grants: typeof import("../src/services/external-review/external-review-grant.service.js");
  let invitations: typeof import("../src/services/external-review/portal-invitation.service.js");
  let ownerApproval: typeof import("../src/services/evidence/owner-destruction-approval.service.js");
  let deps: FixtureDeps;
  const A = () => h.fixtures.teamA;
  const B = () => h.fixtures.teamB;
  const originalBilling = new Map<string, Record<string, unknown>>();

  const call = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    token: string | null,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    h.app.inject({
      method,
      url,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });

  async function makeEvidence(teamId: string, ownerUserId: string): Promise<string> {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    return (
      await prisma.evidence.create({
        data: {
          title: `cl2-${randomUUID()}`,
          type: "PHOTO",
          status: "REPORTED" as never,
          lifecycleState: "ACTIVE" as never,
          teamId,
          organizationId: team.organizationId,
          ownerUserId,
        } as never,
        select: { id: true },
      })
    ).id;
  }

  async function issueGrant(teamId: string, invitedByUserId: string, evidenceId: string, expiresInMs = 2 * DAY) {
    const issued = await grants.issueExternalReviewGrant(
      {
        teamId,
        invitedByUserId,
        scopeKind: "EVIDENCE",
        evidenceId,
        reviewerEmail: `cl2-${randomUUID().slice(0, 8)}@reviewer.example.test`,
        expiresAtUtc: new Date(Date.now() + expiresInMs),
      } as never,
      prisma as never,
    );
    if (!issued.ok) throw new Error(`grant issue refused: ${issued.reason}`);
    return issued.grant.id;
  }

  beforeAll(async () => {
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    grants = await import("../src/services/external-review/external-review-grant.service.js");
    invitations = await import("../src/services/external-review/portal-invitation.service.js");
    ownerApproval = await import("../src/services/evidence/owner-destruction-approval.service.js");
    const { signJwt } = await import("../src/services/jwt.js");
    deps = {
      prisma: prisma as never,
      tag: `cl2-${Date.now().toString(36)}`,
      mintToken: (userId: string, email: string) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          process.env.AUTH_JWT_SECRET!,
          3600,
        ),
    };
    for (const teamId of [A().teamId, B().teamId]) {
      const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { billingPlan: true, billingStatus: true } });
      originalBilling.set(teamId, team as unknown as Record<string, unknown>);
      await prisma.team.update({ where: { id: teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never });
    }
    for (const f of [A(), B()]) {
      await prisma.user.update({ where: { id: f.ownerUserId }, data: { currentWorkspaceId: f.teamId } });
    }
    for (const id of [A().adminUserId, A().memberUserId, A().viewerUserId]) {
      await prisma.user.update({ where: { id }, data: { currentWorkspaceId: A().teamId } });
    }
  }, 900_000);

  afterAll(async () => {
    if (prisma) {
      for (const [teamId, billing] of originalBilling) {
        await prisma.team.update({ where: { id: teamId }, data: billing as never }).catch(() => undefined);
      }
    }
    await h?.cleanup();
  }, 300_000);

  // ===========================================================================
  // EP-0450 — viewerCanRenew
  // ===========================================================================
  describe("EP-0450 — the grant lists project whether THIS viewer may renew", () => {
    it("the owner may renew a live grant, not an expired or revoked one; a MEMBER (audit.read, no renew authority) may renew none", async () => {
      const evidenceId = await makeEvidence(A().teamId, A().ownerUserId);
      const live = await issueGrant(A().teamId, A().ownerUserId, evidenceId);
      const shortLived = await issueGrant(A().teamId, A().ownerUserId, evidenceId, 20 * 60_000);
      await prisma.$executeRawUnsafe(
        `UPDATE "external_review_grants" SET "created_at_utc" = now() - interval '2 hours', "expires_at_utc" = now() - interval '1 minute' WHERE "id" = $1::uuid`,
        shortLived,
      );
      const revoked = await issueGrant(A().teamId, A().ownerUserId, evidenceId);
      const rv = await grants.transitionExternalReviewGrant(
        { grantId: revoked, teamId: A().teamId, toState: "REVOKED", actorUserId: A().ownerUserId } as never,
        prisma as never,
      );
      expect(rv.ok).toBe(true);
      const url = `/v1/external-review/grants?teamId=${A().teamId}&evidenceId=${evidenceId}`;

      const asOwner = await call("GET", url, A().ownerToken);
      expect(asOwner.statusCode, asOwner.body).toBe(200);
      const byId = new Map((asOwner.json().grants as Array<{ id: string; viewerCanRenew: boolean }>).map((g) => [g.id, g.viewerCanRenew]));
      expect(byId.get(live)).toBe(true);
      expect(byId.get(shortLived)).toBe(false);
      expect(byId.get(revoked)).toBe(false);

      const asMember = await call("GET", url, A().memberToken);
      expect(asMember.statusCode, asMember.body).toBe(200);
      const memberRows = asMember.json().grants as Array<{ id: string; viewerCanRenew: boolean }>;
      expect(memberRows.length).toBeGreaterThan(0);
      expect(memberRows.every((g) => g.viewerCanRenew === false)).toBe(true);
      // The renew route agrees with the projection: the MEMBER is refused.
      const memberRenew = await call("POST", `/v1/external-review/grants/${live}/renew`, A().memberToken, { teamId: A().teamId });
      expect(memberRenew.statusCode, memberRenew.body).toBe(403);
      // The owner passes the authority and is asked for the step-up proof.
      const ownerRenew = await call("POST", `/v1/external-review/grants/${live}/renew`, A().ownerToken, { teamId: A().teamId });
      expect(ownerRenew.statusCode, ownerRenew.body).toBe(401);
      expect(ownerRenew.json().error.code).toBe("STEP_UP_REQUIRED");
    });

    it("a workspace whose plan no longer includes External Review projects no renewal (the route refuses ENTITLEMENT_REQUIRED)", async () => {
      const evidenceId = await makeEvidence(A().teamId, A().ownerUserId);
      const live = await issueGrant(A().teamId, A().ownerUserId, evidenceId);
      await prisma.team.update({ where: { id: A().teamId }, data: { billingPlan: "FREE" } as never });
      try {
        const list = await call("GET", `/v1/external-review/grants?teamId=${A().teamId}&evidenceId=${evidenceId}`, A().ownerToken);
        expect(list.statusCode, list.body).toBe(200);
        const row = (list.json().grants as Array<{ id: string; viewerCanRenew: boolean }>).find((g) => g.id === live);
        expect(row?.viewerCanRenew).toBe(false);
        const renew = await call("POST", `/v1/external-review/grants/${live}/renew`, A().ownerToken, { teamId: A().teamId });
        expect(renew.statusCode, renew.body).toBe(403);
        expect(renew.json().error.code).toBe("ENTITLEMENT_REQUIRED");
      } finally {
        await prisma.team.update({ where: { id: A().teamId }, data: { billingPlan: "ENTERPRISE" } as never });
      }
    });

    // Review L-1 — the projection applies the renew route's subject-reach rule
    // and the step-up middleware's quarantine refusal, not only the permission.
    it("a grant whose record is in the Trash projects no renewal, exactly as the route answers it (404)", async () => {
      const evidenceId = await makeEvidence(A().teamId, A().ownerUserId);
      const grantId = await issueGrant(A().teamId, A().ownerUserId, evidenceId);
      const url = `/v1/external-review/grants?teamId=${A().teamId}&evidenceId=${evidenceId}`;
      const before = await call("GET", url, A().ownerToken);
      expect((before.json().grants as Array<{ id: string; viewerCanRenew: boolean }>).find((g) => g.id === grantId)?.viewerCanRenew).toBe(true);

      await prisma.evidence.update({ where: { id: evidenceId }, data: { deletedAt: new Date(), deletedAtUtc: new Date() } as never });
      const after = await call("GET", url, A().ownerToken);
      expect(after.statusCode, after.body).toBe(200);
      const row = (after.json().grants as Array<{ id: string; state: string; viewerCanRenew: boolean }>).find((g) => g.id === grantId);
      expect(row?.state).toBe("INVITED"); // live and unexpired: only the subject changed
      expect(row?.viewerCanRenew).toBe(false);
      const renew = await call("POST", `/v1/external-review/grants/${grantId}/renew`, A().ownerToken, { teamId: A().teamId });
      expect(renew.statusCode, renew.body).toBe(404);
      expect(renew.json().error.code).toBe("EXTERNAL_REVIEW_GRANT_NOT_FOUND");
    });

    it("a quarantined session projects no renewal on either list, exactly as the route answers it (403 session_quarantined)", async () => {
      const admin = await seedUser(deps, "cl2-quarantine-admin");
      await prisma.teamMember.create({ data: { teamId: A().teamId, userId: admin.userId, role: "ADMIN", status: "ACTIVE" } as never });
      await prisma.user.update({ where: { id: admin.userId }, data: { currentWorkspaceId: A().teamId } });
      const evidenceId = await makeEvidence(A().teamId, A().ownerUserId);
      const issued = await invitations.issueInvitation({
        prisma: prisma as never,
        teamId: A().teamId,
        invitedByUserId: A().ownerUserId,
        reviewerEmail: `cl2-q-${randomUUID().slice(0, 8)}@reviewer.example.test`,
        role: "EXTERNAL_REVIEWER",
        scope: { kind: "EVIDENCE", evidenceId },
        expiresAtUtc: new Date(Date.now() + 2 * DAY).toISOString(),
      } as never);
      if (!issued.ok) throw new Error(`invitation refused: ${issued.denial}`);
      const ws = { "x-proovra-workspace-id": A().teamId };
      const grantsUrl = `/v1/external-review/grants?teamId=${A().teamId}&evidenceId=${evidenceId}`;
      const fromGrants = async () =>
        ((await call("GET", grantsUrl, admin.token)).json().grants as Array<{ id: string; viewerCanRenew: boolean }>).find(
          (g) => g.id === issued.grantId,
        )?.viewerCanRenew;
      const fromInvitations = async () =>
        ((await call("GET", "/v1/external-review/invitations", admin.token, undefined, ws)).json().invitations as Array<{
          grantId: string;
          viewerCanRenew: boolean;
        }>).find((r) => r.grantId === issued.grantId)?.viewerCanRenew;

      expect(await fromGrants()).toBe(true);
      expect(await fromInvitations()).toBe(true);

      const quarantined = await prisma.authenticatedSession.updateMany({
        where: { userId: admin.userId, revokedAtUtc: null },
        data: { quarantinedAtUtc: new Date(), quarantineReleaseAtUtc: new Date(Date.now() + DAY) } as never,
      });
      expect(quarantined.count).toBeGreaterThan(0);
      expect(await fromGrants()).toBe(false);
      expect(await fromInvitations()).toBe(false);
      const renew = await call("POST", `/v1/external-review/grants/${issued.grantId}/renew`, admin.token, { teamId: A().teamId });
      expect(renew.statusCode, renew.body).toBe(403);
      expect(renew.json().error.code).toBe("session_quarantined");
    });

    it("the console's invitation list carries the same answer: the owner true on a live invitation, a MEMBER false", async () => {
      const evidenceId = await makeEvidence(A().teamId, A().ownerUserId);
      const issued = await invitations.issueInvitation({
        prisma: prisma as never,
        teamId: A().teamId,
        invitedByUserId: A().ownerUserId,
        reviewerEmail: `cl2-inv-${randomUUID().slice(0, 8)}@reviewer.example.test`,
        role: "EXTERNAL_REVIEWER",
        scope: { kind: "EVIDENCE", evidenceId },
        expiresAtUtc: new Date(Date.now() + 2 * DAY).toISOString(),
      } as never);
      if (!issued.ok) throw new Error(`invitation refused: ${issued.denial}`);
      const ws = { "x-proovra-workspace-id": A().teamId };
      const pick = async (token: string) => {
        const res = await call("GET", "/v1/external-review/invitations", token, undefined, ws);
        expect(res.statusCode, res.body).toBe(200);
        return (res.json().invitations as Array<{ grantId: string; viewerCanRenew: boolean }>).find((r) => r.grantId === issued.grantId);
      };
      expect((await pick(A().ownerToken))?.viewerCanRenew).toBe(true);
      expect((await pick(A().memberToken))?.viewerCanRenew).toBe(false);
    });
  });

  // ===========================================================================
  // MATRIX-M626 — the owner control's read
  // ===========================================================================
  describe("M626 — GET owner-destruction-approval tells the owner's control what applies", () => {
    async function teamless(ownerUserId: string, over: Record<string, unknown> = {}) {
      return (
        await prisma.evidence.create({
          data: {
            title: `cl2-m626-${randomUUID()}`,
            type: "DOCUMENT",
            status: "SIGNED",
            teamId: null,
            organizationId: null,
            ownerUserId,
            lifecycleState: "TRASHED",
            deletedAt: new Date(Date.now() - 2 * DAY),
            deletedAtUtc: new Date(Date.now() - 2 * DAY),
            ...over,
          } as never,
          select: { id: true },
        })
      ).id;
    }
    const read = (id: string, token: string | null) => call("GET", `/v1/evidence/${id}/owner-destruction-approval`, token);

    it("offered to the owner of a sealed team-less record in the trash; the standing approval is this cycle's only; another person gets 404", async () => {
      const owner = await seedUser(deps, "cl2-owner");
      const stranger = await seedUser(deps, "cl2-stranger");
      const id = await teamless(owner.userId);

      const before = await read(id, owner.token);
      expect(before.statusCode, before.body).toBe(200);
      expect(before.json()).toMatchObject({ offered: true, approval: null, destructionInProgress: false });

      expect(await ownerApproval.approveOwnRecordDestruction({ evidenceId: id, actorUserId: owner.userId })).toMatchObject({ ok: true });
      const after = await read(id, owner.token);
      expect(after.json().approval).toMatchObject({ id: expect.any(String), approvedAtUtc: expect.any(String) });

      // A new trash cycle (restore + trash again) does not inherit the approval.
      await prisma.evidence.update({ where: { id }, data: { deletedAt: new Date(), deletedAtUtc: new Date() } as never });
      expect((await read(id, owner.token)).json()).toMatchObject({ offered: true, approval: null });

      const asStranger = await read(id, stranger.token);
      expect(asStranger.statusCode).toBe(404);
      expect((await read(id, null)).statusCode).toBe(401);
      // The read wrote nothing.
      expect(await prisma.evidenceOwnerDestructionApproval.count({ where: { evidenceId: id, withdrawnAtUtc: null } })).toBe(1);
    });

    it("not offered for a workspace record, an unsealed upload, or a record not in the trash; a live destruction claim is reported", async () => {
      const owner = await seedUser(deps, "cl2-owner2");
      const ws = await read(await makeEvidence(A().teamId, A().ownerUserId), A().ownerToken);
      // A workspace record that is not in the trash: the eligibility rule names
      // the workspace first.
      expect(ws.json()).toEqual({ offered: false, reason: "WORKSPACE_RECORD_USES_REVIEW" });
      expect((await read(await teamless(owner.userId, { status: "UPLOADING" }), owner.token)).json()).toEqual({
        offered: false,
        reason: "UNSEALED_RECORD",
      });
      expect(
        (await read(await teamless(owner.userId, { deletedAt: null, deletedAtUtc: null, lifecycleState: "ACTIVE" }), owner.token)).json(),
      ).toEqual({ offered: false, reason: "NOT_IN_TRASH" });

      const claimed = await teamless(owner.userId, { lifecycleState: "PENDING_DESTRUCTION", destructionClaimedAtUtc: new Date() });
      expect(await ownerApproval.approveOwnRecordDestruction({ evidenceId: claimed, actorUserId: owner.userId })).toMatchObject({ ok: true });
      expect((await read(claimed, owner.token)).json()).toMatchObject({ offered: true, destructionInProgress: true });
      // …and the withdrawal the control does not offer is refused by the API.
      const withdraw = await call("DELETE", `/v1/evidence/${claimed}/owner-destruction-approval`, owner.token);
      expect(withdraw.statusCode, withdraw.body).toBe(409);
      expect(withdraw.json().code).toBe("DESTRUCTION_IN_PROGRESS");
    });
  });

  // ===========================================================================
  // EP-0389 — relationship edit
  // ===========================================================================
  it("EP-0389 PATCH relationship: a writer changes type and note; a VIEWER and another tenant change nothing", async () => {
    const src = await makeEvidence(A().teamId, A().ownerUserId);
    const tgt = await makeEvidence(A().teamId, A().ownerUserId);
    const created = await call("POST", `/v1/evidence/${src}/relationships`, A().ownerToken, {
      targetEvidenceId: tgt,
      relationshipType: "RELATED",
      note: "first",
    });
    expect(created.statusCode, created.body).toBe(201);
    const relId = created.json().relationshipId as string;
    const url = `/v1/evidence/${src}/relationships/${relId}`;
    const row = () =>
      prisma.evidenceRelationship.findUniqueOrThrow({ where: { id: relId }, select: { relationshipType: true, note: true } });

    for (const token of [A().viewerToken, B().ownerToken]) {
      const refused = await call("PATCH", url, token, { relationshipType: "CONTRADICTS", note: "overwritten" });
      expect(refused.statusCode, refused.body).toBe(404);
    }
    expect(await row()).toEqual({ relationshipType: "RELATED", note: "first" });

    const ok = await call("PATCH", url, A().ownerToken, { relationshipType: "CONTRADICTS", note: "timestamps disagree" });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await row()).toEqual({ relationshipType: "CONTRADICTS", note: "timestamps disagree" });
  });

  // ===========================================================================
  // Retired routes — typed 410 tombstones
  // ===========================================================================
  describe("retired to typed 410 tombstones: authenticated, no read, no write, the canonical route named", () => {
    const cases = () => [
      {
        ep: "EP-0425",
        method: "POST" as const,
        url: "/v1/external-review/invitations",
        code: "EXTERNAL_REVIEW_SINGLE_INVITATION_RETIRED",
        canonical: "/v1/external-review/invitations/bulk",
        payload: {
          reviewerEmail: "x@reviewer.example.test",
          role: "EXTERNAL_REVIEWER",
          scope: { kind: "EVIDENCE", evidenceId: randomUUID() },
          expiresAtUtc: new Date(Date.now() + DAY).toISOString(),
        },
      },
      {
        ep: "EP-0446",
        method: "POST" as const,
        url: `/v1/external-review/invitations/${randomUUID()}/send-email`,
        code: "EXTERNAL_REVIEW_SEND_EMAIL_RETIRED",
        canonical: "/v1/external-review/invitations/{id}/resend",
        payload: {},
      },
      {
        ep: "EP-0934",
        method: "PATCH" as const,
        url: "/v1/redaction/policy",
        code: "REDACTION_POLICY_PATCH_RETIRED",
        canonical: "/v1/redaction/policies",
        payload: { providers: { MANUAL: true } },
      },
      {
        ep: "EP-1066",
        method: "POST" as const,
        url: "/v1/search/relationships",
        code: "SEARCH_RELATIONSHIP_CREATE_RETIRED",
        canonical: "/v1/evidence/{evidenceId}/relationships",
        payload: { teamId: A().teamId, sourceEvidenceId: randomUUID(), targetEvidenceId: randomUUID(), relationshipType: "RELATED" },
      },
    ];

    it("the workspace owner (every authority held) and a viewer are each answered 410 with the code and the canonical route; no row is written", async () => {
      const counts = async () => ({
        grants: await prisma.externalReviewGrant.count({ where: { teamId: A().teamId } }),
        deliveries: await prisma.externalReviewInvitationDelivery.count({ where: { teamId: A().teamId } }),
        links: await prisma.evidenceRelationship.count({ where: { teamId: A().teamId } }),
        policyVersions: await prisma.redactionPolicyAudit.count({ where: { teamId: A().teamId } as never }),
      });
      const before = await counts();
      for (const c of cases()) {
        for (const token of [A().ownerToken, A().viewerToken]) {
          const r = await call(c.method, c.url, token, c.payload, { "x-proovra-workspace-id": A().teamId });
          expect(r.statusCode, `${c.ep} ${r.body}`).toBe(410);
          expect(r.json(), c.ep).toMatchObject({ error: { code: c.code }, canonical: c.canonical });
          expect(r.body, c.ep).not.toMatch(/[a-f0-9]{64}/);
        }
      }
      expect(await counts()).toEqual(before);
    });

    it("an unauthenticated caller is refused 401 on every tombstone", async () => {
      for (const c of cases()) {
        const r = await call(c.method, c.url, null, c.payload);
        expect(r.statusCode, c.ep).toBe(401);
      }
    });
  });

  // ===========================================================================
  // EP-0538 — operator session revoke
  // ===========================================================================
  it("EP-0538 POST /v1/identity-security/sessions/revoke: a MEMBER and a VIEWER are refused 403 and another tenant 404; no session ends", async () => {
    const session = await prisma.authenticatedSession.create({
      data: {
        userId: A().memberUserId,
        teamId: A().teamId,
        sessionIdHash: createHash("sha256").update(randomUUID()).digest("hex"),
        expiresAtUtc: new Date(Date.now() + DAY),
      },
      select: { id: true, sessionIdHash: true },
    });
    const body = { teamId: A().teamId, userId: A().memberUserId, sessionIdHash: session.sessionIdHash };
    const ws = { "x-proovra-workspace-id": A().teamId };
    for (const token of [A().memberToken, A().viewerToken]) {
      const refused = await call("POST", "/v1/identity-security/sessions/revoke", token, body, ws);
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().error.code).toBe("permission_denied");
    }
    const foreign = await call("POST", "/v1/identity-security/sessions/revoke", B().ownerToken, body, ws);
    expect(foreign.statusCode, foreign.body).toBe(404);
    expect(await prisma.revokedSession.count({ where: { userId: A().memberUserId, sessionIdHash: session.sessionIdHash } })).toBe(0);
    expect(
      (await prisma.authenticatedSession.findUniqueOrThrow({ where: { id: session.id }, select: { revokedAtUtc: true } })).revokedAtUtc,
    ).toBeNull();
  });
});
