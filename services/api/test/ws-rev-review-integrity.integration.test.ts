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
 *
 * RG-29 redaction integrity:
 *   PRO-R3-13  a project opens only on a sealed record in service, of the record's own media
 *   PRO-W2C2-04 a record above the one source budget is refused with a size reason
 *   PRO-R3-01  a region the renderer cannot burn is refused at write time; the product's PDF rect is accepted
 *   PRO-R3-03  a version with no region cannot be submitted
 *   PRO-R3-04  only the rendered method (black-out) is accepted on image/PDF
 *   PRO-R3-02  accepting an out-of-bounds detection writes nothing and says why
 *   PRO-R3-12  removing a promoted region returns its detection to the queue
 *   PRO-R3-05  a MEMBER prepares; the author (or a region author) cannot approve, by name
 *   PRO-R3-14  a publish that cannot happen is refused before any step-up is asked
 *   PRO-R3-08  the policy quick toggle no longer self-approves under a system actor;
 *              a BLOCK_PUBLICATION kind stops submission while its suggestion is undecided
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { roleHasPermission } from "@proovra/shared";

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

    // Group-mapping archive. Integration (PRO-A2Z-02, WS-ORG): the archive
    // lowers only the ADMIN that THIS group's provenance granted, so the
    // fixture gives groupAdmin a live group grant and names it. Keep the
    // fixture administrators' role afterwards so other cases are unaffected.
    const admins = await prisma.teamMember.findMany({
      where: { teamId: A().teamId, role: "ADMIN", status: "ACTIVE" },
      select: { id: true },
    });
    const groupRef = `scim-group:${randomUUID()}`;
    await provisioning.recordMembershipGrant(prisma as never, {
      teamMemberId: groupAdmin.memberId,
      source: "IDP_GROUP",
      intent: "GROUP_MAPPING",
      externalRef: groupRef,
      grantedRole: "ADMIN",
    });
    await prisma.$transaction(async (tx) => {
      await provisioning.demoteGroupMappedRoleOnArchive(tx as never, {
        teamId: A().teamId,
        mappedRole: "ADMIN",
        provenanceRefs: [groupRef],
      });
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
    // PRO-R1-06 — the record had no review workflow; issuing ensured one, so
    // the portal has something to open.
    const wf = await prisma.evidenceReviewWorkflow.findFirst({ where: { evidenceId: rec.id }, select: { id: true } });
    expect(wf).not.toBeNull();

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

    // PRO-R1-02 — the workspace reads what the reviewer said on THIS invitation.
    await prisma.externalReviewDecision.create({
      data: { teamId: A().teamId, grantId: issued.grantId, workflowId: wf!.id, verdict: "REJECT", rationale: "Hash chain gap at 14:02", reviewerEmail: "r@outside.test" },
    });
    await prisma.externalReviewComment.create({
      data: { teamId: A().teamId, grantId: issued.grantId, workflowId: wf!.id, body: "Which clock was used?", authorEmail: "r@outside.test" },
    });
    const feedback = await h.app.inject({
      method: "GET",
      url: `/v1/external-review/invitations/${issued.grantId}/feedback`,
      headers: { ...bearer(A().ownerToken), "x-proovra-workspace-id": A().teamId },
    });
    expect(feedback.statusCode, feedback.body).toBe(200);
    expect(feedback.json().decisions[0]).toMatchObject({ verdict: "REJECT", rationale: "Hash chain gap at 14:02" });
    expect(feedback.json().comments[0]).toMatchObject({ body: "Which clock was used?" });
    const viewerFeedback = await h.app.inject({
      method: "GET",
      url: `/v1/external-review/invitations/${issued.grantId}/feedback`,
      headers: { ...bearer(A().viewerToken), "x-proovra-workspace-id": A().teamId },
    });
    expect(viewerFeedback.statusCode).not.toBe(200);
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

  it("PRO-R1-01: a Pro workspace issues (with step-up), lists and revokes through the existing routes; Free is refused", async () => {
    // A genuine PRO Personal workspace: the plan is its owner's entitlement.
    const P = h.fixtures.personal;
    const B = { teamId: P.teamId, ownerUserId: P.userId, ownerToken: P.token };
    const setPlan = async (plan: "PRO" | "FREE") => {
      await prisma.team.updateMany({ where: { id: B.teamId }, data: { billingPlan: plan, billingStatus: "ACTIVE" } });
      const ent = await prisma.entitlement.findFirst({ where: { userId: B.ownerUserId }, select: { id: true } });
      if (ent) await prisma.entitlement.update({ where: { id: ent.id }, data: { plan, active: true } });
      else await prisma.entitlement.create({ data: { userId: B.ownerUserId, plan } });
    };
    await setPlan("PRO");
    // The Personal workspace's own sealed record (a personal record carries no organization).
    const rec = { id: P.evidenceId };
    await prisma.externalReviewGrant.deleteMany({ where: { evidenceId: rec.id } });
    const email = `pro-${tag()}@outside.test`;
    const payload = {
      expiresAtUtc: new Date(Date.now() + 3 * DAY).toISOString(),
      defaultScope: { kind: "EVIDENCE", evidenceId: rec.id },
      rows: [{ inviteEmail: email }],
    };
    const base = { ...bearer(B.ownerToken), "x-proovra-workspace-id": B.teamId };
    const issueUrl = "/v1/external-review/invitations/bulk";

    // Issue needs a fresh step-up: without one nothing is issued.
    const bare = await h.app.inject({ method: "POST", url: issueUrl, headers: base, payload });
    expect(bare.statusCode, bare.body).toBe(401);
    expect(await prisma.externalReviewGrant.count({ where: { evidenceId: rec.id } })).toBe(0);

    const stepUpHeader = async () =>
      stepUp.approvedHeader({
        token: B.ownerToken,
        userId: B.ownerUserId,
        teamId: B.teamId,
        purpose: "EXTERNAL_REVIEW_GRANT_ISSUE",
        resourceKind: "external_review_grant_bulk",
        resourceId: null as never,
      });
    const issued = await h.app.inject({ method: "POST", url: issueUrl, headers: { ...base, ...(await stepUpHeader()) }, payload });
    expect(issued.statusCode, issued.body).toBe(201);
    const grantId = (issued.json().rows as Array<{ grantId: string | null }>)[0]?.grantId as string;
    expect(grantId).toBeTruthy();

    // List (what the record panel reads) and inspect.
    const list = await h.app.inject({
      method: "GET",
      url: `/v1/external-review/grants?teamId=${B.teamId}&evidenceId=${rec.id}`,
      headers: bearer(B.ownerToken),
    });
    expect(list.statusCode, list.body).toBe(200);
    expect((list.json().grants as Array<{ id: string; reviewerEmail: string }>).map((g) => [g.id, g.reviewerEmail])).toEqual([[grantId, email]]);
    const feedback = await h.app.inject({ method: "GET", url: `/v1/external-review/invitations/${grantId}/feedback`, headers: base });
    expect(feedback.statusCode, feedback.body).toBe(200);

    // Revoke.
    const revoked = await h.app.inject({ method: "POST", url: `/v1/external-review/invitations/${grantId}/revoke`, headers: base, payload: {} });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect((await prisma.externalReviewGrant.findUniqueOrThrow({ where: { id: grantId } })).state).toBe("REVOKED");

    // Free: not entitled, even with a valid step-up; nothing is issued.
    await setPlan("FREE");
    const free = await h.app.inject({ method: "POST", url: issueUrl, headers: { ...base, ...(await stepUpHeader()) }, payload: { ...payload, rows: [{ inviteEmail: `free-${tag()}@outside.test` }] } });
    expect(free.statusCode, free.body).toBe(403);
    expect(JSON.stringify(free.json())).toContain("ENTITLEMENT_REQUIRED");
    expect(await prisma.externalReviewGrant.count({ where: { evidenceId: rec.id } })).toBe(1);
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

  it("PRO-R2-03: a plain MEMBER cannot hand work to others on either route family; an ADMIN can (DEC-17)", async () => {
    const wf = await workflow("IN_REVIEW");
    const colleague = await person(A().teamId, "MEMBER");
    const assign = (token: string) =>
      h.app.inject({
        method: "POST",
        url: `/v1/reviewer-ops/reviews/${wf.id}/assign`,
        headers: bearer(token),
        payload: { teamId: A().teamId, assignedToUserId: colleague.id },
      });
    // Family 1 — /v1/reviewer-ops/* (canonical capability).
    const memberAssign = await assign(A().memberToken);
    expect(memberAssign.statusCode, memberAssign.body).toBe(403);
    expect(memberAssign.json().error).toMatchObject({ code: "REVIEW_PERMISSION_DENIED", reason: "review_assign_required" });
    expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: wf.id } })).assignedToUserId).toBe(A().ownerUserId);
    const adminAssign = await assign(A().adminToken);
    expect(adminAssign.statusCode, adminAssign.body).not.toBe(403);
    // Family 2 — /v1/reviewer/* (reviewer-role table, now derived from the same rule).
    const metrics = (token: string) =>
      h.app.inject({ method: "GET", url: `/v1/reviewer/metrics?teamId=${A().teamId}`, headers: bearer(token) });
    expect((await metrics(A().memberToken)).statusCode).toBe(403);
    expect((await metrics(A().adminToken)).statusCode).toBe(200);
    // The same answer from the one definition, for both vocabularies.
    expect(roleHasPermission("REVIEWER", "review.assign")).toBe(false);
    expect(roleHasPermission("ADMIN", "review.assign")).toBe(true);
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

  // ---------------------------------------------------------------------------
  // RG-29
  // ---------------------------------------------------------------------------
  describe("RG-29 redaction integrity", () => {
    const q = () => `?teamId=${A().teamId}`;
    const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, token: string, payload?: unknown) =>
      h.app.inject({ method, url, headers: { ...bearer(token), "x-proovra-workspace-id": A().teamId }, ...(payload !== undefined ? { payload: payload as never } : {}) });

    let store: typeof import("../src/services/redaction/redaction-policy-store.service.js");

    beforeAll(async () => {
      store = await import("../src/services/redaction/redaction-policy-store.service.js");
      const { upsertEntitlementGrant } = await import("../src/services/packaging/entitlement.service.js");
      await upsertEntitlementGrant({
        prisma: prisma as never,
        teamId: A().teamId,
        key: "FEATURE_REDACTION",
        kind: "FEATURE",
        value: true,
        source: "CUSTOM",
        grantedByUserId: A().ownerUserId,
      } as never);
    }, 120_000);

    async function media(over: Record<string, unknown>) {
      const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
      return prisma.evidence.create({
        data: {
          title: `WS-REV media ${tag()}`,
          type: "PHOTO",
          status: "SIGNED",
          mimeType: "image/png",
          teamId: A().teamId,
          organizationId: team.organizationId,
          ownerUserId: A().ownerUserId,
          ...over,
        } as never,
        select: { id: true },
      });
    }
    async function project(evidenceId: string, artifactKind: "IMAGE" | "PDF", token = A().adminToken) {
      const open = await call("POST", `/v1/redaction/projects${q()}`, token, { evidenceId, artifactKind });
      expect(open.statusCode, open.body).toBe(201);
      const projectId = open.json().projectId as string;
      const ver = await call("POST", `/v1/redaction/projects/${projectId}/versions${q()}`, token, {});
      expect(ver.statusCode, ver.body).toBe(201);
      return { projectId, versionId: ver.json().versionId as string };
    }

    it("PRO-R3-13 / PRO-W2C2-04: unsealed, trashed, wrong-media and over-budget records are refused by name", async () => {
      const unsealed = await media({ status: "CREATED" });
      const r1 = await call("POST", `/v1/redaction/projects${q()}`, A().adminToken, { evidenceId: unsealed.id, artifactKind: "IMAGE" });
      expect(r1.statusCode, r1.body).toBe(409);
      expect(r1.json().denial).toBe("EVIDENCE_NOT_ELIGIBLE");
      const trashed = await media({ lifecycleState: "TRASHED" });
      expect((await call("POST", `/v1/redaction/projects${q()}`, A().adminToken, { evidenceId: trashed.id, artifactKind: "IMAGE" })).json().denial).toBe("EVIDENCE_NOT_ELIGIBLE");
      const image = await media({});
      const wrongKind = await call("POST", `/v1/redaction/projects${q()}`, A().adminToken, { evidenceId: image.id, artifactKind: "PDF" });
      expect(wrongKind.json().denial).toBe("ARTIFACT_NOT_REDACTABLE");
      const huge = await media({ sizeBytes: BigInt(300 * 1024 * 1024) });
      expect((await call("POST", `/v1/redaction/projects${q()}`, A().adminToken, { evidenceId: huge.id, artifactKind: "IMAGE" })).json().denial).toBe("SOURCE_TOO_LARGE");
      expect(await prisma.redactionProject.count({ where: { evidenceId: { in: [unsealed.id, trashed.id, image.id, huge.id] } } })).toBe(0);
    });

    it("PRO-R3-01 / PRO-R3-03 / PRO-R3-04: region writes are refused unless the renderer burns them; an empty version is not submitted", async () => {
      const pdf = await media({ type: "DOCUMENT", mimeType: "application/pdf" });
      const { versionId } = await project(pdf.id, "PDF");
      const regions = `/v1/redaction/versions/${versionId}/regions${q()}`;
      const submit = await call("POST", `/v1/redaction/versions/${versionId}/submit${q()}`, A().adminToken, {});
      expect(submit.statusCode, submit.body).toBe(409);
      expect(submit.json().denial).toBe("VERSION_HAS_NO_REGIONS");
      // A text range without the box the renderer would burn.
      const textRange = await call("POST", regions, A().adminToken, { kind: "PDF_TEXT_RANGE", method: "BLACKOUT", geometry: { pageIndex: 0, charStart: 0, charEnd: 4 } });
      expect(textRange.json().denial).toBe("REGION_KIND_UNSUPPORTED");
      // A flat box with a page the document cannot have (page 0, 1-based).
      const pageZero = await call("POST", regions, A().adminToken, { kind: "BBOX_NORMALIZED", method: "BLACKOUT", geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2, page: 0 } });
      expect(pageZero.json().denial).toBe("REGION_KIND_UNSUPPORTED");
      // A method the renderer does not apply.
      const blur = await call("POST", regions, A().adminToken, { kind: "PDF_PAGE_RECT", method: "REMOVE_CONTENT", geometry: { pageIndex: 0, rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } } });
      expect(blur.json().denial).toBe("REGION_METHOD_UNSUPPORTED");
      expect(await prisma.redactionRegion.count({ where: { versionId } })).toBe(0);
      // The shape the product's PDF editor sends is accepted.
      const rect = await call("POST", regions, A().adminToken, { kind: "PDF_PAGE_RECT", method: "BLACKOUT", geometry: { pageIndex: 0, rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } } });
      expect(rect.statusCode, rect.body).toBe(201);
      expect((await call("POST", `/v1/redaction/versions/${versionId}/submit${q()}`, A().adminToken, {})).statusCode).toBe(200);
    });

    it("PRO-R3-02 / PRO-R3-12: an out-of-bounds acceptance writes nothing; removing a promoted region re-queues its detection", async () => {
      const image = await media({});
      const { versionId } = await project(image.id, "IMAGE");
      const detection = (geometry: Record<string, number>) =>
        prisma.redactionDetection.create({
          data: {
            teamId: A().teamId, versionId, kind: "FACE", provider: "MANUAL",
            rawConfidence: 0.9, confidenceBand: "HIGH",
            suggestedRegionKind: "BBOX_NORMALIZED", suggestedRegionGeometry: geometry,
            suggestedMethod: "BLUR", decisionState: "SUGGESTED",
          },
          select: { id: true },
        });
      const edge = await detection({ x: 0.9, y: 0.1, width: 0.3, height: 0.2 });
      const refused = await call("POST", `/v1/redaction/detections/${edge.id}/decision${q()}`, A().adminToken, { decisionState: "ACCEPTED" });
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().denial).toBe("REGION_OUT_OF_BOUNDS");
      expect((await prisma.redactionDetection.findUniqueOrThrow({ where: { id: edge.id } })).decisionState).toBe("SUGGESTED");
      expect(await prisma.redactionDecision.count({ where: { detectionId: edge.id } })).toBe(0);

      const ok = await detection({ x: 0.2, y: 0.2, width: 0.2, height: 0.2 });
      const accepted = await call("POST", `/v1/redaction/detections/${ok.id}/decision${q()}`, A().adminToken, { decisionState: "ACCEPTED" });
      expect(accepted.statusCode, accepted.body).toBe(200);
      const regionId = accepted.json().promotedRegionId as string;
      expect(regionId).toBeTruthy();
      expect((await prisma.redactionRegion.findUniqueOrThrow({ where: { id: regionId } })).method).toBe("BLACKOUT");
      const removed = await call("DELETE", `/v1/redaction/regions/${regionId}${q()}`, A().adminToken);
      expect(removed.statusCode, removed.body).toBe(200);
      expect((await prisma.redactionDetection.findUniqueOrThrow({ where: { id: ok.id } })).decisionState).toBe("SUGGESTED");
    });

    it("PRO-R3-05 / PRO-R3-14: a MEMBER prepares; the region author cannot approve; publish refuses before step-up", async () => {
      const image = await media({});
      const { versionId } = await project(image.id, "IMAGE", A().adminToken);
      const regions = `/v1/redaction/versions/${versionId}/regions${q()}`;
      const member = await call("POST", regions, A().memberToken, { kind: "BBOX_NORMALIZED", method: "BLACKOUT", geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } });
      expect(member.statusCode, member.body).toBe(201);
      expect((await call("POST", regions, A().viewerToken, { kind: "BBOX_NORMALIZED", method: "BLACKOUT", geometry: { x: 0.3, y: 0.1, width: 0.2, height: 0.2 } })).statusCode).toBe(403);
      // An ADMIN who drew a region of the version is not an independent approver.
      const drawingAdmin = await person(A().teamId, "ADMIN");
      expect((await call("POST", regions, drawingAdmin.token, { kind: "BBOX_NORMALIZED", method: "BLACKOUT", geometry: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 } })).statusCode).toBe(201);
      expect((await call("POST", `/v1/redaction/versions/${versionId}/submit${q()}`, A().memberToken, {})).statusCode).toBe(200);
      const own = await call("POST", `/v1/redaction/versions/${versionId}/approve${q()}`, A().adminToken, { verdict: "APPROVE" });
      expect(own.json().denial).toBe("APPROVER_MUST_DIFFER_FROM_AUTHOR");
      const drew = await call("POST", `/v1/redaction/versions/${versionId}/approve${q()}`, drawingAdmin.token, { verdict: "APPROVE" });
      expect(drew.json().denial).toBe("APPROVER_MUST_DIFFER_FROM_AUTHOR");
      // No READY copy: refused before any step-up is asked (no 401 challenge).
      const publish = await call("POST", `/v1/redaction/versions/${versionId}/publish${q()}`, A().ownerToken, {});
      expect(publish.statusCode, publish.body).toBe(409);
      expect(publish.json().denial).toBe("DERIVATIVE_NOT_READY");
      expect(await prisma.stepUpChallenge.count({ where: { initiatedByUserId: A().ownerUserId, purpose: "REDACTION_PUBLISH", resourceId: versionId } })).toBe(0);
    });

    it("PRO-R3-08: the policy quick toggle submits a version for review; nothing is approved or applied by a system actor", async () => {
      const patchRes = await call("PATCH", `/v1/redaction/policy${q()}`, A().ownerToken, { providers: { MANUAL: true, REGEX_PII: true, POLICY_RULE: true, AWS_REKOGNITION_FACES: false, AWS_REKOGNITION_TEXT: true, AZURE_DOCUMENT_INTELLIGENCE: true, OCR_TEXT_LAYER: true, DEEPGRAM_TRANSCRIPT: true, CUSTOM_PROVIDER: true } });
      expect([202, 409]).toContain(patchRes.statusCode);
      const nilActor = "00000000-0000-0000-0000-000000000000";
      expect(await prisma.redactionPolicyAudit.count({ where: { teamId: A().teamId, actorUserId: nilActor } as never })).toBe(0);
      const effective = await call("GET", `/v1/redaction/policy/effective${q()}`, A().ownerToken);
      expect(effective.statusCode, effective.body).toBe(200);
      expect(JSON.stringify(effective.json())).not.toContain('"AWS_REKOGNITION_FACES":false');
    });

    it("PRO-R3-08: a BLOCK_PUBLICATION kind stops submission while a suggestion of that kind is undecided", async () => {
      const image = await media({});
      const { projectId, versionId } = await project(image.id, "IMAGE");
      const region = await call("POST", `/v1/redaction/versions/${versionId}/regions${q()}`, A().adminToken, {
        kind: "BBOX_NORMALIZED", method: "BLACKOUT", geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      });
      expect(region.statusCode, region.body).toBe(201);
      const face = await prisma.redactionDetection.create({
        data: {
          teamId: A().teamId, versionId, kind: "FACE", provider: "MANUAL",
          rawConfidence: 0.9, confidenceBand: "HIGH",
          suggestedRegionKind: "BBOX_NORMALIZED", suggestedRegionGeometry: { x: 0.5, y: 0.5, width: 0.2, height: 0.2 },
          suggestedMethod: "BLACKOUT", decisionState: "SUGGESTED",
        },
        select: { id: true },
      });

      // A policy for THIS project only (other cases share the workspace),
      // authored by the owner and approved/published by a second administrator.
      const policy = await store.createPolicy({ teamId: A().teamId, name: `WS-REV block ${tag()}`, createdByUserId: A().ownerUserId });
      if (!policy.ok) throw new Error(`policy: ${policy.denial}`);
      const pv = await store.createPolicyVersion({
        teamId: A().teamId,
        policyId: policy.policyId,
        authoredByUserId: A().ownerUserId,
        document: {
          schemaVersion: "PROOVRA_REDACTION_POLICY_V1",
          providers: {},
          kinds: {},
          ruleActions: { FACE: "BLOCK_PUBLICATION" },
          customRules: [],
        } as never,
      });
      if (!pv.ok) throw new Error(`policy version: ${pv.denial}`);
      for (const [toState, actorUserId] of [
        ["IN_REVIEW", A().ownerUserId],
        ["APPROVED", A().adminUserId],
        ["PUBLISHED", A().adminUserId],
      ] as const) {
        const moved = await store.transitionPolicyVersion({ teamId: A().teamId, policyVersionId: pv.policyVersionId, toState, actorUserId });
        expect(moved.ok, `${toState}: ${JSON.stringify(moved)}`).toBe(true);
      }
      const assigned = await store.assignPolicyVersion({
        teamId: A().teamId,
        policyVersionId: pv.policyVersionId,
        scope: "PROJECT",
        scopeTargetId: projectId,
        assignedByUserId: A().adminUserId,
      });
      expect(assigned.ok, JSON.stringify(assigned)).toBe(true);

      const blocked = await call("POST", `/v1/redaction/versions/${versionId}/submit${q()}`, A().adminToken, {});
      expect(blocked.statusCode, blocked.body).toBe(409);
      expect(blocked.json().denial).toBe("POLICY_REJECTED");
      expect((await prisma.redactionVersion.findUniqueOrThrow({ where: { id: versionId } })).state).toBe("DRAFT");

      // Deciding the suggestion lifts the block.
      const decided = await call("POST", `/v1/redaction/detections/${face.id}/decision${q()}`, A().adminToken, { decisionState: "REJECTED" });
      expect(decided.statusCode, decided.body).toBe(200);
      const submitted = await call("POST", `/v1/redaction/versions/${versionId}/submit${q()}`, A().adminToken, {});
      expect(submitted.statusCode, submitted.body).toBe(200);
    });
  });
});
