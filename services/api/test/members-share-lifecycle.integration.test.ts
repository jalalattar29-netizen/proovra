/**
 * SHARE-LINK LIFECYCLE (members audit SEC-08, owner decision 2026-10-25).
 *
 *   - The record's canonical Public Verify reference (pvr_) and the share token
 *     an issued REPORT carries are publication state: no time expiry, and they
 *     survive their creator's removal — an issued report's QR keeps verifying.
 *     Only the canonical lifecycle (withdraw / reinstate) changes them.
 *   - Owner share links and external-review grants are held in a person's
 *     name: 7 days by default, 30 at most, renewed only by an explicit audited
 *     act, and ended when the creator is removed, suspended, loses authority,
 *     or the workspace closes — unless an OWNER/ADMIN transfers them to the
 *     workspace's ownership in the governed removal.
 *
 * Every case drives the real routes and services against a real PostgreSQL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";

const DAY = 24 * 60 * 60 * 1000;

describe("SEC-08 — share-link lifecycle (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let stepUp: ReturnType<typeof createStepUpCeremony>;
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let shares: typeof import("../src/services/governance/verification-share.service.js");
  let rbac: typeof import("../src/services/identity/rbac.service.js");
  let external: typeof import("../src/services/external-review/external-review-grant.service.js");
  let closure: typeof import("../src/services/workspace/workspace-closure.service.js");
  let authority: typeof import("@proovra/shared-runtime");
  let canonical: typeof import("@proovra/shared-runtime");
  const A = () => h.fixtures.teamA;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as import("@prisma/client").PrismaClient;
    ({ signJwt } = await import("../src/services/jwt.js"));
    shares = await import("../src/services/governance/verification-share.service.js");
    rbac = await import("../src/services/identity/rbac.service.js");
    external = await import("../src/services/external-review/external-review-grant.service.js");
    closure = await import("../src/services/workspace/workspace-closure.service.js");
    authority = await import("@proovra/shared-runtime");
    canonical = authority;
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

  async function person(teamId: string, role: "ADMIN" | "MEMBER") {
    const { REQUIRED_LEGAL_VERSIONS } = await import("../src/legal/legal-versioning.js");
    const email = `share-${tag()}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, displayName: "Sharer", provider: "EMAIL", providerUserId: email },
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

  /** A finalized record with its pvr_ and an issued-report token. */
  async function signedRecord(teamId: string, ownerUserId: string, reportCreatorUserId: string) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    const ev = await prisma.evidence.create({
      data: { title: `Signed ${tag()}`, type: "PHOTO", status: "SIGNED", teamId, organizationId: team.organizationId, ownerUserId },
      select: { id: true },
    });
    const { ref, reportToken } = await prisma.$transaction(async (tx) => {
      const r = await canonical.ensureVerificationRefTx(tx as never, ev.id);
      const minted = await authority.mintVerificationShareTokenTx(tx as never, {
        evidenceId: ev.id,
        teamId,
        purpose: "REPORT",
        createdByUserId: reportCreatorUserId,
      } as never);
      return { ref: r.ref!, reportToken: minted.token };
    });
    return { evidenceId: ev.id, ref, reportToken };
  }

  async function ownerLink(evidenceId: string, creatorUserId: string, days = 7) {
    const record = await shares.loadRecordForShare(evidenceId);
    const created = await shares.createVerificationLink({
      record: record!,
      actorUserId: creatorUserId,
      audience: "Counsel",
      expiresInDays: days,
      projection: "STANDARD",
      maxUses: null,
    });
    return created;
  }

  async function externalGrant(teamId: string, evidenceId: string, inviterUserId: string) {
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

  const publicVerify = (identifier: string) => h.app.inject({ method: "GET", url: `/public/verify/${identifier}` });
  /**
   * The identifier RESOLVED to the record: the page then reports the record's
   * own state (these fixtures are not cryptographically sealed, so that state
   * is 409 NOT_SEALED). A dead link is answered 410 before the record is read;
   * an unknown one 404.
   */
  const resolvesToRecord = async (identifier: string) => {
    const res = await publicVerify(identifier);
    return res.statusCode !== 404 && res.statusCode !== 410;
  };

  it("an owner link is 7 days by default, at most 30, never 'no expiry'; renewal is explicit and audited", async () => {
    const rec = await signedRecord(A().teamId, A().ownerUserId, A().ownerUserId);
    const url = `/v1/evidence/${rec.evidenceId}/verify-links`;
    const created = await h.app.inject({ method: "POST", url, headers: bearer(A().ownerToken), payload: { audience: "Counsel" } });
    expect(created.statusCode, created.body).toBe(201);
    const expiresIn = new Date(created.json().link.expiresAtUtc).getTime() - Date.now();
    expect(expiresIn).toBeGreaterThan(6.9 * DAY);
    expect(expiresIn).toBeLessThanOrEqual(7 * DAY);
    for (const expiresInDays of [31, null]) {
      const refused = await h.app.inject({ method: "POST", url, headers: bearer(A().ownerToken), payload: { audience: "x", expiresInDays } });
      expect(refused.statusCode).toBe(400);
    }

    const linkId = created.json().link.id as string;
    const renewed = await h.app.inject({ method: "POST", url: `${url}/${linkId}/renew`, headers: bearer(A().ownerToken), payload: { days: 30 } });
    expect(renewed.statusCode, renewed.body).toBe(200);
    expect(new Date(renewed.json().link.expiresAtUtc).getTime() - Date.now()).toBeGreaterThan(29.9 * DAY);
    const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: "verification.link_renewed", resourceId: rec.evidenceId } });
    expect(audit.resultingState).toBe(renewed.json().link.expiresAtUtc);
    expect(
      (await h.app.inject({ method: "POST", url: `${url}/${linkId}/renew`, headers: bearer(A().ownerToken), payload: { days: 31 } })).statusCode,
    ).toBe(400);

    await h.app.inject({ method: "POST", url: `${url}/${linkId}/revoke`, headers: bearer(A().ownerToken), payload: {} });
    const revokedRenew = await h.app.inject({ method: "POST", url: `${url}/${linkId}/renew`, headers: bearer(A().ownerToken), payload: { days: 7 } });
    expect(revokedRenew.statusCode).toBe(409);
    expect(revokedRenew.json().code).toBe("VERIFICATION_LINK_NOT_RENEWABLE");
  });

  it("removing the creator ends their owner links and external grants; the pvr_ and the issued report keep verifying", async () => {
    const creator = await person(A().teamId, "ADMIN");
    const rec = await signedRecord(A().teamId, A().ownerUserId, creator.id);
    const link = await ownerLink(rec.evidenceId, creator.id);
    const grantId = await externalGrant(A().teamId, rec.evidenceId, creator.id);

    await rbac.revokeMember({ teamId: A().teamId, teamMemberId: creator.memberId, actorUserId: A().ownerUserId });

    const linkRow = await prisma.verificationShareToken.findUniqueOrThrow({ where: { id: link.link.id } });
    expect(linkRow.revokedAtUtc).not.toBeNull();
    expect(linkRow.revocationReason).toBe("CREATOR_REMOVED");
    expect((await prisma.externalReviewGrant.findUniqueOrThrow({ where: { id: grantId } })).state).toBe("REVOKED");
    expect((await publicVerify(link.token)).statusCode).toBe(410);

    // Publication state is not held in a person's name.
    expect(await resolvesToRecord(rec.ref)).toBe(true);
    expect(await resolvesToRecord(rec.reportToken)).toBe(true);
    const reportRow = await prisma.verificationShareToken.findFirstOrThrow({ where: { evidenceId: rec.evidenceId, purpose: "REPORT" } });
    expect(reportRow.revokedAtUtc).toBeNull();
    expect(reportRow.expiresAtUtc).toBeNull();
  });

  it("suspension ends the creator's grants (restore does not revive them); losing the authority ends them too", async () => {
    const suspended = await person(A().teamId, "ADMIN");
    const rec = await signedRecord(A().teamId, A().ownerUserId, A().ownerUserId);
    const s1 = await ownerLink(rec.evidenceId, suspended.id);
    await rbac.suspendMember({ teamId: A().teamId, teamMemberId: suspended.memberId, actorUserId: A().ownerUserId });
    expect((await prisma.verificationShareToken.findUniqueOrThrow({ where: { id: s1.link.id } })).revocationReason).toBe("CREATOR_SUSPENDED");
    await rbac.restoreMember({ teamId: A().teamId, teamMemberId: suspended.memberId, actorUserId: A().ownerUserId });
    expect((await prisma.verificationShareToken.findUniqueOrThrow({ where: { id: s1.link.id } })).revokedAtUtc).not.toBeNull();

    const demoted = await person(A().teamId, "ADMIN");
    const d1 = await ownerLink(rec.evidenceId, demoted.id);
    const g1 = await externalGrant(A().teamId, rec.evidenceId, demoted.id);
    await rbac.changeMemberRole({ teamId: A().teamId, teamMemberId: demoted.memberId, actorUserId: A().ownerUserId, newRole: "VIEWER" });
    expect((await prisma.verificationShareToken.findUniqueOrThrow({ where: { id: d1.link.id } })).revocationReason).toBe("CREATOR_LOST_AUTHORITY");
    expect((await prisma.externalReviewGrant.findUniqueOrThrow({ where: { id: g1 } })).state).toBe("REVOKED");
  });

  it("a governed removal may transfer the creator's live grants to the workspace owner instead", async () => {
    const leaver = await person(A().teamId, "ADMIN");
    const rec = await signedRecord(A().teamId, A().ownerUserId, A().ownerUserId);
    const link = await ownerLink(rec.evidenceId, leaver.id);
    const grantId = await externalGrant(A().teamId, rec.evidenceId, leaver.id);
    const res = await h.app.inject({
      method: "DELETE",
      url: `/v1/teams/${A().teamId}/members/${leaver.memberId}`,
      headers: {
        ...bearer(A().ownerToken),
        ...(await stepUp.approvedHeader({
          token: A().ownerToken,
          userId: A().ownerUserId,
          teamId: A().teamId,
          purpose: "MEMBER_REVOKE",
          resourceKind: "team_member",
          resourceId: leaver.memberId,
        })),
      },
      payload: { transferShareGrantsToOwner: true },
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    const linkRow = await prisma.verificationShareToken.findUniqueOrThrow({ where: { id: link.link.id } });
    expect(linkRow.revokedAtUtc).toBeNull();
    expect(linkRow.createdByUserId).toBe(A().ownerUserId);
    const grant = await prisma.externalReviewGrant.findUniqueOrThrow({ where: { id: grantId } });
    expect(grant.state).not.toBe("REVOKED");
    expect(grant.invitedByUserId).toBe(A().ownerUserId);
    expect(await resolvesToRecord(link.token)).toBe(true);
    expect(
      await prisma.teamActivity.count({ where: { teamId: A().teamId, eventType: "share_grants_transferred", targetId: leaver.id } }),
    ).toBe(1);
  });

  it("workspace closure ends owner links; the issued report's link is untouched", async () => {
    const org = await prisma.organization.create({
      data: { name: `Closure ${tag()}`, billingOwnerUserId: A().ownerUserId, status: "ACTIVE", kind: "SYSTEM" } as never,
      select: { id: true },
    });
    const ws = await prisma.team.create({
      data: { name: `Closing ${tag()}`, ownerUserId: A().ownerUserId, billingOwnerUserId: A().ownerUserId, isPersonal: false, organizationId: org.id, workspaceKind: "OWNED" } as never,
      select: { id: true },
    });
    await prisma.teamMember.create({ data: { teamId: ws.id, userId: A().ownerUserId, role: "OWNER", status: "ACTIVE" } });
    const rec = await signedRecord(ws.id, A().ownerUserId, A().ownerUserId);
    const link = await ownerLink(rec.evidenceId, A().ownerUserId);
    await closure.executeWorkspaceClosure({ teamId: ws.id, requestedByUserId: A().ownerUserId });
    expect((await prisma.verificationShareToken.findUniqueOrThrow({ where: { id: link.link.id } })).revocationReason).toBe("WORKSPACE_CLOSED");
    const reportRow = await prisma.verificationShareToken.findFirstOrThrow({ where: { evidenceId: rec.evidenceId, purpose: "REPORT" } });
    expect(reportRow.revokedAtUtc).toBeNull();
  });

  it("the pvr_ changes only through the canonical lifecycle: withdraw, then reinstate", async () => {
    const rec = await signedRecord(A().teamId, A().ownerUserId, A().ownerUserId);
    const withdraw = await h.app.inject({
      method: "POST",
      url: `/v1/evidence/${rec.evidenceId}/verification-access/withdraw`,
      headers: bearer(A().ownerToken),
      payload: { reason: "LEGAL_REQUEST" },
    });
    expect(withdraw.statusCode, withdraw.body).toBe(200);
    const withdrawn = await publicVerify(rec.ref);
    expect(JSON.stringify(withdrawn.json())).toContain("WITHDRAWN");
    await h.app.inject({ method: "POST", url: `/v1/evidence/${rec.evidenceId}/verification-access/reinstate`, headers: bearer(A().ownerToken), payload: {} });
    const back = await publicVerify(rec.ref);
    expect(back.statusCode).not.toBe(410);
    expect(JSON.stringify(back.json())).not.toContain("WITHDRAWN");
    // The reference itself never changed.
    expect((await prisma.evidence.findUniqueOrThrow({ where: { id: rec.evidenceId } })).verificationRef).toBe(rec.ref);
  });

  it("external review: 7 days when the issuer names none, renewal is explicit, audited and capped at 30", async () => {
    const rec = await signedRecord(A().teamId, A().ownerUserId, A().ownerUserId);
    const issued = await h.app.inject({
      method: "POST",
      url: "/v1/external-review/grants",
      headers: {
        ...bearer(A().ownerToken),
        ...(await stepUp.approvedHeader({
          token: A().ownerToken,
          userId: A().ownerUserId,
          teamId: A().teamId,
          purpose: "EXTERNAL_REVIEW_GRANT_ISSUE",
          resourceKind: "external_review_grant",
          resourceId: rec.evidenceId,
        })),
      },
      payload: { teamId: A().teamId, scopeKind: "EVIDENCE", evidenceId: rec.evidenceId, reviewerEmail: `r-${tag()}@outside.test` },
    });
    expect(issued.statusCode, issued.body).toBe(201);
    const grant = issued.json().grant as { id: string; expiresAtUtc: string };
    const lifetime = new Date(grant.expiresAtUtc).getTime() - Date.now();
    expect(lifetime).toBeGreaterThan(6.9 * DAY);
    expect(lifetime).toBeLessThanOrEqual(7 * DAY);

    const renew = (days: number) =>
      h.app.inject({ method: "POST", url: `/v1/external-review/grants/${grant.id}/renew`, headers: bearer(A().ownerToken), payload: { teamId: A().teamId, days } });
    expect((await renew(31)).statusCode).toBe(400);
    const renewed = await renew(30);
    expect(renewed.statusCode, renewed.body).toBe(200);
    expect(new Date(renewed.json().grant.expiresAtUtc).getTime() - Date.now()).toBeGreaterThan(29.9 * DAY);
    expect(await prisma.adminAuditLog.count({ where: { action: "external_review.grant_renewed", resourceId: grant.id } })).toBe(1);
  });
});
