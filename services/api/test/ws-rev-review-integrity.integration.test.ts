/**
 * WS-REV (RG-27 external review, RG-28 decision integrity) — behavioural
 * regressions against the real routes and services on a live PostgreSQL.
 *
 *   PRO-R1-05  a creator demoted by the DIRECTORY loses their outward grants
 *   PRO-LEAD-06 an expired external-review grant is never renewed (old token stays dead)
 *   PRO-P3DZ-01 operator lists read the effective (expiry-aware) state
 *   PRO-R1-13  acceptance is recorded once across repeated token exchanges
 *   PRO-R1-08  the reviewer activity API carries no operator payloads
 *   PRO-R1-03  an SSO bulk request is refused, not issued as a bearer link
 *   PRO-R2-01  a verdict not allowed from the current stage is answered (409), never left pending
 *   PRO-R2-04  disagreement resolution is independent and compare-and-swap
 *   PRO-LEAD-07 VIEWER cannot read reviewer working data
 *   PRO-R2Z-03 reviewer-workspace annotation replies follow the canonical write rule and are audited
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";

const DAY = 24 * 60 * 60 * 1000;

describe("WS-REV — external review and decision integrity (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let stepUp: ReturnType<typeof createStepUpCeremony>;
  let external: typeof import("../src/services/external-review/external-review-grant.service.js");
  let invitations: typeof import("../src/services/external-review/portal-invitation.service.js");
  let activity: typeof import("../src/services/external-review/portal-activity.service.js");
  let provisioning: typeof import("../src/services/identity/membership-provisioning.service.js");
  let disagreements: typeof import("../src/services/reviewer-workspace/reviewer-disagreement.service.js");
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  const A = () => h.fixtures.teamA;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as import("@prisma/client").PrismaClient;
    external = await import("../src/services/external-review/external-review-grant.service.js");
    invitations = await import("../src/services/external-review/portal-invitation.service.js");
    activity = await import("../src/services/external-review/portal-activity.service.js");
    provisioning = await import("../src/services/identity/membership-provisioning.service.js");
    disagreements = await import("../src/services/reviewer-workspace/reviewer-disagreement.service.js");
    ({ signJwt } = await import("../src/services/jwt.js"));
    stepUp = createStepUpCeremony({
      prisma,
      inject: (o) => h.app.inject({ method: o.method, url: o.url, headers: o.headers, payload: o.payload as never }) as never,
    });
    await prisma.team.updateMany({ where: { id: A().teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const tag = () => randomUUID().slice(0, 8);
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  async function person(teamId: string, role: "ADMIN" | "MEMBER" | "VIEWER") {
    const { REQUIRED_LEGAL_VERSIONS } = await import("../src/legal/legal-versioning.js");
    const email = `wsrev-${tag()}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, displayName: "WS-REV", provider: "EMAIL", providerUserId: email },
      select: { id: true },
    });
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion: policyVersion as string,
        source: "integration-harness",
      })),
    });
    const m = await prisma.teamMember.create({ data: { teamId, userId: user.id, role, status: "ACTIVE" } });
    const token = signJwt(
      { sub: user.id, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      process.env.AUTH_JWT_SECRET as string,
      3600,
    );
    return { id: user.id, memberId: m.id, token };
  }

  async function record(teamId: string, ownerUserId: string) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    return prisma.evidence.create({
      data: { title: `WS-REV ${tag()}`, type: "PHOTO", status: "SIGNED", teamId, organizationId: team.organizationId, ownerUserId },
      select: { id: true },
    });
  }

  async function grant(teamId: string, evidenceId: string, inviterUserId: string) {
    const res = await external.issueExternalReviewGrant({
      teamId,
      invitedByUserId: inviterUserId,
      scopeKind: "EVIDENCE",
      evidenceId,
      reviewerEmail: `reviewer-${tag()}@outside.test`,
      expiresAtUtc: new Date(Date.now() + 7 * DAY),
    } as never);
    if (!res.ok) throw new Error(`grant not issued: ${res.reason}`);
    return res.grant.id;
  }

  // ---------------------------------------------------------------------------
  // RG-27
  // ---------------------------------------------------------------------------

  it("PRO-R1-05: an ADMIN demoted by the directory (SCIM role change or group-mapping archive) loses their live grants", async () => {
    const scimAdmin = await person(A().teamId, "ADMIN");
    const groupAdmin = await person(A().teamId, "ADMIN");
    const rec = await record(A().teamId, A().ownerUserId);
    const g1 = await grant(A().teamId, rec.id, scimAdmin.id);
    const g2 = await grant(A().teamId, rec.id, groupAdmin.id);

    const changed = await provisioning.applyDirectoryRoleChange(prisma as never, {
      teamMemberId: scimAdmin.memberId,
      currentRole: "ADMIN",
      desiredRole: "MEMBER",
      source: "SCIM",
      allowPrivilegedChange: true,
    });
    expect(changed.changed).toBe(true);
    expect((await prisma.externalReviewGrant.findUniqueOrThrow({ where: { id: g1 } })).state).toBe("REVOKED");

    // Group-mapping archive: every ACTIVE ADMIN is lowered to MEMBER. Keep the
    // fixture administrators' role afterwards so other cases are unaffected.
    const admins = await prisma.teamMember.findMany({
      where: { teamId: A().teamId, role: "ADMIN", status: "ACTIVE" },
      select: { id: true },
    });
    await prisma.$transaction(async (tx) => {
      await provisioning.demoteGroupMappedRoleOnArchive(tx as never, { teamId: A().teamId, mappedRole: "ADMIN" });
    });
    expect((await prisma.externalReviewGrant.findUniqueOrThrow({ where: { id: g2 } })).state).toBe("REVOKED");
    await prisma.teamMember.updateMany({ where: { id: { in: admins.map((a) => a.id) } }, data: { role: "ADMIN" } });
  });

  it("PRO-LEAD-06 / PRO-P3DZ-01: an expired grant is not renewed and is listed as EXPIRED", async () => {
    const rec = await record(A().teamId, A().ownerUserId);
    const id = await grant(A().teamId, rec.id, A().ownerUserId);
    await prisma.externalReviewGrant.update({ where: { id }, data: { createdAtUtc: new Date(Date.now() - 2 * DAY), expiresAtUtc: new Date(Date.now() - 60_000) } });

    const renew = await h.app.inject({
      method: "POST",
      url: `/v1/external-review/grants/${id}/renew`,
      headers: {
        ...bearer(A().ownerToken),
        ...(await stepUp.approvedHeader({
          token: A().ownerToken,
          userId: A().ownerUserId,
          teamId: A().teamId,
          purpose: "EXTERNAL_REVIEW_GRANT_ISSUE",
          resourceKind: "external_review_grant",
          resourceId: id,
        })),
      },
      payload: { teamId: A().teamId, days: 7 },
    });
    expect(renew.statusCode, renew.body).toBe(409);
    expect(renew.json().error.code).toBe("EXTERNAL_REVIEW_GRANT_NOT_RENEWABLE");
    const row = await prisma.externalReviewGrant.findUniqueOrThrow({ where: { id } });
    expect(row.expiresAtUtc.getTime()).toBeLessThan(Date.now());

    const list = await h.app.inject({
      method: "GET",
      url: `/v1/external-review/grants?teamId=${A().teamId}&evidenceId=${rec.id}`,
      headers: bearer(A().ownerToken),
    });
    expect(list.statusCode, list.body).toBe(200);
    const listed = (list.json().grants as Array<{ id: string; state: string }>).find((g) => g.id === id);
    expect(listed?.state).toBe("EXPIRED");
  });

  it("PRO-R1-13 / PRO-R1-08: acceptance is recorded once; the reviewer reads no operator payloads", async () => {
    const rec = await record(A().teamId, A().ownerUserId);
    const issued = await invitations.issueInvitation({
      teamId: A().teamId,
      invitedByUserId: A().ownerUserId,
      reviewerEmail: `portal-${tag()}@outside.test`,
      role: "EXTERNAL_REVIEWER",
      mfaRequired: false,
      scope: { kind: "EVIDENCE", evidenceId: rec.id },
      expiresAtUtc: new Date(Date.now() + 3 * DAY).toISOString(),
    } as never);
    if (!issued.ok) throw new Error(`invitation not issued: ${issued.denial}`);

    const auth = async () => h.app.inject({ method: "POST", url: "/v1/portal/auth", payload: { token: issued.rawToken } });
    const first = await auth();
    expect(first.statusCode, first.body).toBe(200);
    const second = await auth();
    expect(second.statusCode, second.body).toBe(200);
    expect(
      await prisma.externalReviewActivity.count({ where: { grantId: issued.grantId, code: "GRANT_ACCEPTED" } }),
    ).toBe(1);

    await activity.emitPortalActivity({
      prisma: prisma as never,
      teamId: A().teamId,
      grantId: issued.grantId,
      code: "GRANT_RESENT",
      ip: "203.0.113.9",
      payload: { path: "break_glass", actorUserId: A().ownerUserId, reasonPreview: "internal justification text" },
    });
    const read = await h.app.inject({
      method: "GET",
      url: "/v1/portal/activity",
      headers: { ...bearer(issued.rawToken), "x-portal-session": second.json().sessionId },
    });
    expect(read.statusCode, read.body).toBe(200);
    const rows = read.json().activity as Array<{ code: string; payload: unknown }>;
    expect(rows.some((r) => r.code === "GRANT_RESENT")).toBe(false);
    expect(rows.every((r) => r.payload === null)).toBe(true);
    expect(read.body).not.toContain("internal justification text");
    expect(read.body).not.toContain(A().ownerUserId);
    expect(read.body).not.toContain("203.0.113.9");
  });

  it("PRO-R1-03: a bulk invitation asking for SSO is refused, never issued as a plain link", async () => {
    const rec = await record(A().teamId, A().ownerUserId);
    const before = await prisma.externalReviewGrant.count({ where: { evidenceId: rec.id } });
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/external-review/invitations/bulk",
      headers: {
        ...bearer(A().ownerToken),
        "x-proovra-workspace-id": A().teamId,
        ...(await stepUp.approvedHeader({
          token: A().ownerToken,
          userId: A().ownerUserId,
          teamId: A().teamId,
          purpose: "EXTERNAL_REVIEW_GRANT_ISSUE",
          resourceKind: "external_review_grant_bulk",
          resourceId: null as never,
        })),
      },
      payload: {
        expiresAtUtc: new Date(Date.now() + DAY).toISOString(),
        defaultScope: { kind: "EVIDENCE", evidenceId: rec.id },
        rows: [{ inviteEmail: `sso-${tag()}@outside.test` }],
        defaultAuthMethod: "SSO",
        defaultSsoConnectionId: randomUUID(),
        defaultAllowedDomains: ["outside.test"],
      },
    });
    // The workspace may refuse earlier (entitlement / current-workspace); in
    // no case may an invitation be issued for an SSO request.
    expect(res.statusCode, res.body).not.toBe(201);
    expect(await prisma.externalReviewGrant.count({ where: { evidenceId: rec.id } })).toBe(before);
  });

  // ---------------------------------------------------------------------------
  // RG-28
  // ---------------------------------------------------------------------------

  async function workflow(status: "ASSIGNED" | "IN_REVIEW") {
    const rec = await record(A().teamId, A().ownerUserId);
    return prisma.evidenceReviewWorkflow.create({
      data: {
        evidenceId: rec.id,
        teamId: A().teamId,
        workspaceType: "TEAM",
        status,
        assignedToUserId: A().ownerUserId,
      } as never,
      select: { id: true, evidenceId: true },
    });
  }

  it("PRO-R2-01: APPROVE on a review that has not started answers 409, never a pending request", async () => {
    const wf = await workflow("ASSIGNED");
    const pending = Symbol("pending");
    const outcome = await Promise.race([
      h.app.inject({
        method: "POST",
        url: `/v1/reviewer-ops/workspace/${wf.id}/decisions`,
        headers: bearer(A().ownerToken),
        payload: { teamId: A().teamId, decision: "APPROVE", rationale: "looks right" },
      }),
      new Promise<typeof pending>((resolve) => setTimeout(() => resolve(pending), 8_000)),
    ]);
    expect(outcome).not.toBe(pending);
    const res = outcome as Awaited<ReturnType<typeof h.app.inject>>;
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.reason).toBe("decision_not_from_stage");
  }, 30_000);

  it("PRO-R2-04: the challenger and the challenged reviewer cannot resolve; concurrent resolutions apply once", async () => {
    const wf = await workflow("IN_REVIEW");
    const decision = await prisma.workflowReviewDecision.create({
      data: {
        workflowId: wf.id,
        teamId: A().teamId,
        stage: "FIRST",
        reviewerUserId: A().memberUserId,
        decision: "APPROVE",
        rationale: "first",
      },
      select: { id: true },
    });
    const d = await prisma.reviewerDisagreement.create({
      data: {
        workflowId: wf.id,
        teamId: A().teamId,
        state: "UNDER_SECOND_REVIEW",
        originalDecisionId: decision.id,
        challengerUserId: A().adminUserId,
        challengerRationale: "disagree",
        secondReviewerUserId: A().ownerUserId,
      },
      select: { id: true },
    });
    const resolve = (actorUserId: string, to: "RESOLVED_UPHELD" | "RESOLVED_OVERTURNED") =>
      disagreements.transitionDisagreement({
        prisma: prisma as never,
        teamId: A().teamId,
        disagreementId: d.id,
        to,
        actorUserId,
        verdict: to === "RESOLVED_UPHELD" ? "APPROVE" : "REJECT",
        rationale: "resolution",
      } as never);
    expect(await resolve(A().adminUserId, "RESOLVED_OVERTURNED")).toMatchObject({
      ok: false,
      denial: "DISAGREEMENT_RESOLVER_NOT_INDEPENDENT",
    });
    expect(await resolve(A().memberUserId, "RESOLVED_UPHELD")).toMatchObject({
      ok: false,
      denial: "DISAGREEMENT_RESOLVER_NOT_INDEPENDENT",
    });
    const third = await person(A().teamId, "ADMIN");
    const [r1, r2] = await Promise.all([
      resolve(A().ownerUserId, "RESOLVED_UPHELD"),
      resolve(third.id, "RESOLVED_OVERTURNED"),
    ]);
    expect([r1, r2].filter((r) => r.ok).length).toBe(1);
    expect([r1, r2].find((r) => !r.ok)).toMatchObject({ denial: "DISAGREEMENT_STATE_INVALID" });
  });

  it("PRO-LEAD-07: VIEWER cannot read reviewer disagreements or QC samples; a reviewer can", async () => {
    const url = (p: string) => `${p}?teamId=${A().teamId}`;
    const viewer = await h.app.inject({ method: "GET", url: url("/v1/reviewer/disagreements"), headers: bearer(A().viewerToken) });
    expect(viewer.statusCode, viewer.body).toBe(403);
    const viewerQc = await h.app.inject({ method: "GET", url: url("/v1/reviewer/qc/samples"), headers: bearer(A().viewerToken) });
    expect(viewerQc.statusCode, viewerQc.body).toBe(403);
    const member = await h.app.inject({ method: "GET", url: url("/v1/reviewer/disagreements"), headers: bearer(A().memberToken) });
    expect(member.statusCode, member.body).toBe(200);
  });

  it("PRO-R2Z-03: a reviewer-workspace reply on a trashed record is refused; on an open record it is audited", async () => {
    const open = await record(A().teamId, A().ownerUserId);
    const trashed = await record(A().teamId, A().ownerUserId);
    const root = async (evidenceId: string) =>
      prisma.evidenceAnnotation.create({
        data: { evidenceId, authorUserId: A().ownerUserId, annotationType: "TEXT", coordinateSpace: "DOCUMENT_PAGE", body: "root" },
        select: { id: true },
      });
    const openRoot = await root(open.id);
    const trashedRoot = await root(trashed.id);
    await prisma.evidence.update({ where: { id: trashed.id }, data: { lifecycleState: "TRASHED" } as never });

    const reply = (id: string) =>
      h.app.inject({
        method: "POST",
        url: `/v1/reviewer/annotations/${id}/reply?teamId=${A().teamId}`,
        headers: bearer(A().adminToken),
        payload: { body: "a reply" },
      });
    const refused = await reply(trashedRoot.id);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(await prisma.evidenceAnnotation.count({ where: { parentAnnotationId: trashedRoot.id } })).toBe(0);

    const ok = await reply(openRoot.id);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(
      await prisma.evidenceReviewerAuditEvent.count({ where: { evidenceId: open.id, eventType: "ANNOTATION_CREATED" } }),
    ).toBe(1);
  });
});
