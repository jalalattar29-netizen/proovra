/**
 * PRO-CENZ-01 (closure, owner decision K) — the caller-less write routes that
 * are KEPT must each carry an authorization test. These had none at route level
 * (docs/architecture/caller-less-routes.md):
 *
 *   EP-0174 POST /v1/capture/direct-sessions/:id/attestation
 *   EP-0449 POST /v1/external-review/grants/:id/revoke
 *   EP-0843 POST /v1/orgs/:id/data-export/:requestId/manifest
 *   EP-0844 POST /v1/orgs/:id/data-export/:requestId/links
 *   EP-0934 PATCH /v1/redaction/policy
 *   EP-1066 POST /v1/search/relationships
 *   EP-1067 POST /v1/search/reindex/evidence/:id
 *
 * Each case drives the REAL route: a refused actor (wrong user, missing
 * permission, another tenant) changes nothing, and the authorized actor gets
 * past the guard. Live PostgreSQL through the integration harness; no provider
 * is contacted.
 */

import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness } from "./integration-harness.js";

describe("PRO-CENZ-01 — kept caller-less write routes refuse the wrong actor (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let grants: typeof import("../src/services/external-review/external-review-grant.service.js");
  const A = () => h.fixtures.teamA;
  const B = () => h.fixtures.teamB;
  const originalBilling = new Map<string, Record<string, unknown>>();

  const call = (method: "POST" | "PATCH", url: string, token: string, payload?: unknown) =>
    h.app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });

  async function makeEvidence(teamId: string, ownerUserId: string): Promise<string> {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    return (
      await prisma.evidence.create({
        data: {
          title: `cenz-${randomUUID()}`,
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

  beforeAll(async () => {
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    grants = await import("../src/services/external-review/external-review-grant.service.js");
    for (const teamId of [A().teamId, B().teamId]) {
      const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { billingPlan: true, billingStatus: true } });
      originalBilling.set(teamId, team as unknown as Record<string, unknown>);
      // The guards under test sit behind the commercial gate; a paid plan
      // keeps the plan refusal out of the way so the AUTHORIZATION answer is
      // what each case observes.
      await prisma.team.update({ where: { id: teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never });
    }
    for (const f of [A(), B()]) {
      await prisma.user.update({ where: { id: f.ownerUserId }, data: { currentWorkspaceId: f.teamId } });
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

  it("EP-0174 attestation: another member and another tenant get the unknown-session answer and record nothing; the session owner is heard", async () => {
    const device = await prisma.device.create({
      data: {
        teamId: A().teamId,
        ownerUserId: A().ownerUserId,
        label: "CENZ attesting device",
        publicKeyHex: randomBytes(32).toString("hex"),
        publicKeyFingerprint: randomBytes(32).toString("hex"),
        attestationProvider: "GOOGLE_PLAY_INTEGRITY",
        signatureAlgorithm: "Ed25519",
      },
      select: { id: true },
    });
    const open = await call("POST", "/v1/capture/direct-sessions", A().ownerToken, {
      mode: "PROOVRA_MOBILE_APP",
      teamId: A().teamId,
      deviceId: device.id,
    });
    expect(open.statusCode, open.body).toBe(201);
    const s = open.json().session as { captureSessionId: string; nonceHex: string };
    const url = `/v1/capture/direct-sessions/${s.captureSessionId}/attestation`;
    const body = {
      provider: "GOOGLE_PLAY_INTEGRITY",
      rawAssertionBase64: Buffer.from("t".repeat(400)).toString("base64"),
      nonceHex: s.nonceHex,
      assertedAtUtc: new Date().toISOString(),
    };
    const attestationEvents = () =>
      prisma.captureTrustEventRecord.count({
        where: { captureSessionId: s.captureSessionId, code: { startsWith: "ATTESTATION_" } },
      });

    for (const token of [A().adminToken, A().memberToken, B().ownerToken]) {
      const refused = await call("POST", url, token, body);
      expect(refused.statusCode, refused.body).toBe(404);
    }
    expect(await attestationEvents()).toBe(0);

    const ok = await call("POST", url, A().ownerToken, body);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().attestation.verdict).toBe("UNVERIFIED");
    expect(await attestationEvents()).toBe(1);
  });

  it("EP-0449 grant revoke: a member without the manage capability and another tenant's owner revoke nothing; the workspace owner revokes", async () => {
    const evidenceId = await makeEvidence(A().teamId, A().ownerUserId);
    const issued = await grants.issueExternalReviewGrant(
      {
        teamId: A().teamId,
        invitedByUserId: A().ownerUserId,
        scopeKind: "EVIDENCE",
        evidenceId,
        reviewerEmail: `cenz-${randomUUID().slice(0, 8)}@reviewer.example.test`,
        expiresAtUtc: new Date(Date.now() + 2 * 24 * 3_600_000),
      },
      prisma as never,
    );
    if (!issued.ok) throw new Error(`grant issue refused: ${issued.reason}`);
    const grantId = issued.grant.id;
    const url = `/v1/external-review/grants/${grantId}/revoke`;
    const state = async () =>
      ((await prisma.$queryRawUnsafe(`SELECT "state" FROM "external_review_grants" WHERE "id" = $1`, grantId)) as Array<{ state: string }>)[0]!.state;
    const before = await state();

    const member = await call("POST", url, A().memberToken, { teamId: A().teamId });
    expect(member.statusCode, member.body).toBe(403);
    // Another tenant, naming this workspace: concealed.
    const foreignHere = await call("POST", url, B().ownerToken, { teamId: A().teamId });
    expect(foreignHere.statusCode, foreignHere.body).toBe(404);
    // Another tenant, naming its own workspace: the grant is not there.
    const foreignOwn = await call("POST", url, B().ownerToken, { teamId: B().teamId });
    expect(foreignOwn.statusCode, foreignOwn.body).toBe(404);
    expect(await state()).toBe(before);

    const ok = await call("POST", url, A().ownerToken, { teamId: A().teamId });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await state()).toBe("REVOKED");
  });

  it("EP-0843 / EP-0844 data-export manifest and links: only the organization owner gets past the owner gate; nothing is counted for anyone else", async () => {
    const orgId = (await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } })).organizationId!;
    const request = await prisma.organizationDataExportRequest.create({
      data: { organizationId: orgId, requestedByUserId: A().ownerUserId, status: "REQUESTED" },
      select: { id: true },
    });
    const urls = [
      `/v1/orgs/${orgId}/data-export/${request.id}/manifest`,
      `/v1/orgs/${orgId}/data-export/${request.id}/links`,
    ];
    // An organization ADMIN — a member of this organization, not its owner.
    const orgAdmin = await prisma.organizationMembership.create({
      data: { organizationId: orgId, userId: A().adminUserId, role: "ORG_ADMIN" },
      select: { id: true },
    });
    try {
      for (const url of urls) {
        // Another organization's owner: concealed.
        const foreign = await call("POST", url, B().ownerToken, {});
        expect(foreign.statusCode, `${url} ${foreign.body}`).toBe(404);
        // A workspace member with no organization membership: concealed.
        const outsider = await call("POST", url, A().memberToken, {});
        expect(outsider.statusCode, `${url} ${outsider.body}`).toBe(404);
        // The organization's ADMIN is a member but not the owner: refused.
        const admin = await call("POST", url, A().adminToken, {});
        expect(admin.statusCode, `${url} ${admin.body}`).toBe(403);
        // The owner passes the owner gate and is asked for the step-up proof
        // (none sent) — a different answer from every refusal above.
        const owner = await call("POST", url, A().ownerToken, {});
        expect(owner.statusCode, `${url} ${owner.body}`).toBe(401);
        expect(owner.json().error.code).toBe("STEP_UP_REQUIRED");
      }
    } finally {
      await prisma.organizationMembership.delete({ where: { id: orgAdmin.id } });
    }
    const row = await prisma.organizationDataExportRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(row.downloadCount).toBe(0);
    expect(row.lastDownloadedAtUtc).toBeNull();
  });

  // Closure phase 2 — EP-0934 is retired to a typed 410 tombstone (the
  // legacy unversioned policy write). Every caller, the owner included, is
  // answered 410 with the canonical versioned route; no version is written.
  it("EP-0934 PATCH /v1/redaction/policy (retired): a member, a viewer, another tenant and the owner get the typed 410; no policy version is written", async () => {
    const patch = (token: string) =>
      h.app.inject({
        method: "PATCH",
        url: "/v1/redaction/policy",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-proovra-workspace-id": A().teamId,
        },
        payload: JSON.stringify({
          providers: {
            MANUAL: true, REGEX_PII: true, POLICY_RULE: true, AWS_REKOGNITION_FACES: true, AWS_REKOGNITION_TEXT: true,
            AZURE_DOCUMENT_INTELLIGENCE: true, OCR_TEXT_LAYER: true, DEEPGRAM_TRANSCRIPT: true, CUSTOM_PROVIDER: true,
          },
        }),
      });
    const versions = () => prisma.redactionPolicyAudit.count({ where: { teamId: A().teamId } as never });
    const before = await versions();
    for (const token of [A().memberToken, A().viewerToken, B().ownerToken, A().ownerToken]) {
      const r = await patch(token);
      expect(r.statusCode, r.body).toBe(410);
      expect(r.json()).toMatchObject({
        error: { code: "REDACTION_POLICY_PATCH_RETIRED" },
        canonical: "/v1/redaction/policies",
      });
    }
    expect(await versions()).toBe(before);
    const anonymous = await h.app.inject({ method: "PATCH", url: "/v1/redaction/policy", payload: {} });
    expect(anonymous.statusCode).toBe(401);
  });

  // Closure phase 2 — EP-1066 is retired to a typed 410 tombstone (it duplicated
  // POST /v1/evidence/:id/relationships). Its contract is now: every caller,
  // the operator included, is answered 410 with the canonical route, and no
  // link is written for anyone.
  it("EP-1066 POST /v1/search/relationships (retired): every caller, the operator included, gets the typed 410 and no link is written", async () => {
    const src = await makeEvidence(A().teamId, A().ownerUserId);
    const tgt = await makeEvidence(A().teamId, A().ownerUserId);
    const links = () =>
      prisma.evidenceRelationship.count({ where: { sourceEvidenceId: src, targetEvidenceId: tgt } as never });
    const body = (teamId: string) => ({ teamId, sourceEvidenceId: src, targetEvidenceId: tgt, relationshipType: "RELATED" });

    for (const [token, teamId] of [
      [A().memberToken, A().teamId],
      [B().ownerToken, A().teamId],
      [B().ownerToken, B().teamId],
      [A().ownerToken, A().teamId],
    ] as const) {
      const r = await call("POST", "/v1/search/relationships", token, body(teamId));
      expect(r.statusCode, r.body).toBe(410);
      expect(r.json()).toMatchObject({
        error: { code: "SEARCH_RELATIONSHIP_CREATE_RETIRED" },
        canonical: "/v1/evidence/{evidenceId}/relationships",
      });
    }
    expect(await links()).toBe(0);
    const anonymous = await h.app.inject({ method: "POST", url: "/v1/search/relationships", payload: body(A().teamId) });
    expect(anonymous.statusCode).toBe(401);
  });

  it("EP-1067 POST /v1/search/reindex/evidence/:id: a non-operator, another tenant and a cross-tenant record index nothing; the operator reindexes", async () => {
    const evidenceId = await makeEvidence(A().teamId, A().ownerUserId);
    const url = `/v1/search/reindex/evidence/${evidenceId}`;

    const member = await call("POST", url, A().memberToken, { teamId: A().teamId });
    expect(member.statusCode, member.body).toBe(403);
    expect(member.json().error.reason).toBe("operator_required");
    const viewer = await call("POST", url, A().viewerToken, { teamId: A().teamId });
    expect(viewer.statusCode, viewer.body).toBe(403);
    const foreignHere = await call("POST", url, B().ownerToken, { teamId: A().teamId });
    expect(foreignHere.statusCode, foreignHere.body).toBe(404);
    const foreignOwn = await call("POST", url, B().ownerToken, { teamId: B().teamId });
    expect(foreignOwn.statusCode, foreignOwn.body).toBe(409);
    expect(foreignOwn.json().error.reason).toBe("evidence_not_found");

    const ok = await call("POST", url, A().ownerToken, { teamId: A().teamId });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(typeof ok.json().documentId).toBe("string");
  });
});
