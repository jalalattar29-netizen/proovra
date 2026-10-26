/**
 * MEMBERS RE-AUDIT, SECOND ROUND — CASE REACH (live PostgreSQL).
 *
 *   P1        an OWNER / ADMIN off a restricted case's list cannot put themself
 *             (or a Collaboration Team they belong to) on it; the access-review
 *             and external-collaborator listings omit a case the caller cannot
 *             see; the legacy grant revoke refuses it and opens nothing. The
 *             case owner and a listed manager can (positive controls).
 *   Defect 2  a case restricted only by its flag is projected as restricted.
 *   Defect 3  GET /v1/reports and GET /v1/cases/:id/linkable-evidence omit a
 *             record linked to a restricted case the caller cannot see.
 *   Defect 5  POST /v1/batch-analysis admits each record through the canonical
 *             record authority, not the uploader column.
 *   Defect 4  a creator's owner links and external-review grants end when the
 *             creator loses reach to the record through a restricted case;
 *             history is kept; everyone who keeps reach keeps their links.
 *
 * Every refusal is paired with a positive control on the same fixture.
 */
import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Prisma = (typeof import("../src/db.js"))["prisma"];
type Person = { id: string; memberId: string | null; token: string };
type Role = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

describe("members re-audit 2 — case reach: self-grant, listings, lists, batch, creator grants (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let legalVersions: Record<string, string>;
  const A = () => h.fixtures.teamA;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ signJwt } = await import("../src/services/jwt.js"));
    ({ REQUIRED_LEGAL_VERSIONS: legalVersions } = (await import("../src/legal/legal-versioning.js")) as never);
    await prisma.team.updateMany({ where: { id: A().teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const tag = () => randomUUID().slice(0, 8);
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const get = (url: string, token: string) => h.app.inject({ method: "GET", url, headers: bearer(token) });
  const post = (url: string, token: string, payload: unknown) =>
    h.app.inject({ method: "POST", url, headers: bearer(token), payload: payload as never });
  const del = (url: string, token: string) => h.app.inject({ method: "DELETE", url, headers: bearer(token) });

  async function person(role: Role | null = "MEMBER", teamId = A().teamId): Promise<Person> {
    const email = `ra2-${tag()}@test.proovra.local`;
    const user = await prisma.user.create({ data: { email, provider: "EMAIL", providerUserId: email }, select: { id: true } });
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(legalVersions).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion,
        source: "integration-harness",
      })),
    });
    const m = role ? await prisma.teamMember.create({ data: { teamId, userId: user.id, role, status: "ACTIVE" } }) : null;
    const token = signJwt(
      { sub: user.id, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      process.env.AUTH_JWT_SECRET as string,
      3600,
    );
    return { id: user.id, memberId: m?.id ?? null, token };
  }
  async function newCase(ownerUserId: string, teamId = A().teamId) {
    return (
      await prisma.case.create({ data: { name: `ra2-case-${tag()}`, teamId, ownerUserId }, select: { id: true, name: true } })
    );
  }
  /** Restrict a case to `listed`: the flag plus the rows, as the grant route writes them. */
  async function restrict(caseId: string, listed: string[]) {
    await prisma.case.update({ where: { id: caseId }, data: { restrictedAtUtc: new Date() } });
    for (const userId of listed) await prisma.caseAccess.create({ data: { caseId, userId } });
  }
  async function newEvidence(ownerUserId: string, title = `ra2 ${tag()}`) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    return (
      await prisma.evidence.create({
        data: {
          title,
          type: "PHOTO",
          status: "SIGNED",
          teamId: A().teamId,
          organizationId: team.organizationId,
          ownerUserId,
          sizeBytes: 1_000n,
        } as never,
        select: { id: true },
      })
    ).id;
  }
  const link = (caseId: string, evidenceId: string) =>
    prisma.caseEvidenceLink.create({ data: { caseId, evidenceId, teamId: A().teamId } as never });
  async function group(memberIds: string[]) {
    return (
      await prisma.collaborationTeam.create({
        data: {
          workspaceId: A().teamId,
          name: `ra2-group-${tag()}`,
          createdByUserId: A().ownerUserId,
          members: { create: memberIds.map((userId) => ({ userId, status: "ACTIVE" })) },
        } as never,
        select: { id: true },
      })
    ).id;
  }
  const listOf = async (caseId: string) =>
    (await prisma.caseAccess.findMany({ where: { caseId }, select: { userId: true }, orderBy: { userId: "asc" } })).map((r) => r.userId);
  const teamGrantsOf = (caseId: string) => prisma.caseCollaborationTeamAccess.count({ where: { caseId } });

  // ===========================================================================
  // P1 — the self-grant
  // ===========================================================================
  describe("P1 — a manager off a restricted case cannot put themself on it", () => {
    async function fixture() {
      const caseOwner = await person("MEMBER");
      const listedAdmin = await person("ADMIN");
      const offAdmin = await person("ADMIN");
      const c = await newCase(caseOwner.id);
      await restrict(c.id, [listedAdmin.id]);
      return { caseOwner, listedAdmin, offAdmin, caseId: c.id, caseName: c.name };
    }
    const workspaceOwner = () => ({ id: A().ownerUserId, token: A().ownerToken });

    for (const who of ["the workspace OWNER", "an ADMIN"] as const) {
      it(`${who} off the list: POST /access, share-team and team-access with themself are concealed 404 and the list is unchanged`, async () => {
        const f = await fixture();
        const actor = who === "an ADMIN" ? f.offAdmin : workspaceOwner();
        const theirGroup = await group([actor.id]);
        const before = await listOf(f.caseId);

        const viaAccess = await post(`/v1/cases/${f.caseId}/access`, actor.token, { userId: actor.id });
        expect(viaAccess.statusCode, viaAccess.body).toBe(404);
        const viaShare = await post(`/v1/cases/${f.caseId}/share-team`, actor.token, { userId: actor.id });
        expect(viaShare.statusCode, viaShare.body).toBe(404);
        const viaGroup = await post(`/v1/cases/${f.caseId}/team-access`, actor.token, { collaborationTeamId: theirGroup });
        expect(viaGroup.statusCode, viaGroup.body).toBe(404);
        // Removing an entry is the same authority: also concealed.
        const entry = await prisma.caseAccess.findFirstOrThrow({ where: { caseId: f.caseId } });
        const viaRevoke = await del(`/v1/cases/${f.caseId}/access/${entry.id}`, actor.token);
        expect(viaRevoke.statusCode, viaRevoke.body).toBe(404);

        expect(await listOf(f.caseId)).toEqual(before);
        expect(await teamGrantsOf(f.caseId)).toBe(0);
        expect((await get(`/v1/cases/${f.caseId}`, actor.token)).statusCode).toBe(404);
      });
    }

    it("positive control: the case owner and a listed ADMIN can grant (a person and a Collaboration Team)", async () => {
      const f = await fixture();
      const byOwner = await post(`/v1/cases/${f.caseId}/access`, f.caseOwner.token, { userId: f.offAdmin.id });
      expect(byOwner.statusCode, byOwner.body).toBe(201);
      const extra = await person("MEMBER");
      const byListed = await post(`/v1/cases/${f.caseId}/share-team`, f.listedAdmin.token, { userId: extra.id });
      expect(byListed.statusCode, byListed.body).toBe(201);
      const g = await group([extra.id]);
      const byListedGroup = await post(`/v1/cases/${f.caseId}/team-access`, f.listedAdmin.token, { collaborationTeamId: g });
      expect(byListedGroup.statusCode, byListedGroup.body).toBe(201);
      expect(await listOf(f.caseId)).toEqual([f.listedAdmin.id, f.offAdmin.id, extra.id].sort());
      expect(await teamGrantsOf(f.caseId)).toBe(1);
    });

    it("access-review and external-collaborators omit an invisible case's name and id; a listed ADMIN sees it", async () => {
      const f = await fixture();
      const outsider = await person(null); // not a member: an external collaborator
      await prisma.caseAccess.create({ data: { caseId: f.caseId, userId: outsider.id } });

      for (const path of ["external-collaborators", "access-review"]) {
        const off = await get(`/v1/teams/${A().teamId}/${path}`, f.offAdmin.token);
        expect(off.statusCode, off.body).toBe(200);
        expect(off.body).not.toContain(f.caseId);
        expect(off.body).not.toContain(f.caseName);
        const listed = await get(`/v1/teams/${A().teamId}/${path}`, f.listedAdmin.token);
        expect(listed.statusCode, listed.body).toBe(200);
        expect(listed.body).toContain(f.caseId);
      }
    });

    it("the legacy grant revoke refuses a grant on an invisible case as not found and does not open the case; a listed ADMIN can revoke it", async () => {
      const f = await fixture();
      // A case whose ONLY entry is an external grant: removing it would open the case.
      const lone = await newCase(f.caseOwner.id);
      const outsider = await person(null);
      await restrict(lone.id, [outsider.id]);
      const grant = await prisma.caseAccess.findFirstOrThrow({ where: { caseId: lone.id } });
      const viewer = await person("VIEWER");

      const off = await del(`/v1/teams/${A().teamId}/external-grants/${grant.id}`, f.offAdmin.token);
      expect(off.statusCode, off.body).toBe(404);
      expect((off.json() as { code?: string }).code).toBe("GRANT_NOT_FOUND");
      expect(await prisma.caseAccess.count({ where: { id: grant.id } })).toBe(1);
      expect((await prisma.case.findUniqueOrThrow({ where: { id: lone.id } })).restrictedAtUtc).not.toBeNull();
      expect((await get(`/v1/cases/${lone.id}`, viewer.token)).statusCode).toBe(404);

      // Positive control: someone who can see the case (its owner is a MEMBER,
      // so put a listed ADMIN on it) revokes the same grant.
      await prisma.caseAccess.create({ data: { caseId: lone.id, userId: f.listedAdmin.id } });
      const ok = await del(`/v1/teams/${A().teamId}/external-grants/${grant.id}`, f.listedAdmin.token);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await prisma.caseAccess.count({ where: { id: grant.id } })).toBe(0);
    });
  });

  // ===========================================================================
  // Defect 2 — the restriction is projected
  // ===========================================================================
  it("Defect 2 — GET /v1/cases/:id says restricted for a case restricted only by its flag (empty list); an open case is not", async () => {
    const owner = await person("MEMBER");
    const flagged = await newCase(owner.id);
    await restrict(flagged.id, []);
    const open = await newCase(owner.id);
    const r1 = await get(`/v1/cases/${flagged.id}`, owner.token);
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r1.json().case).toMatchObject({ restricted: true, access: [], teamAccess: [] });
    const r2 = await get(`/v1/cases/${open.id}`, owner.token);
    expect(r2.json().case.restricted).toBe(false);
  });

  it("Defect 2 — the access explanation names a flag-only case's owner CASE_OWNER (not workspace capability); an open case's owner is explained by capability", async () => {
    const admin = await person("ADMIN");
    const flagged = await newCase(admin.id);
    await restrict(flagged.id, []);
    const open = await newCase(admin.id);
    const explain = async (caseId: string) => {
      const res = await get(`/v1/teams/${A().teamId}/members/${admin.memberId}/access?caseId=${caseId}`, admin.token);
      expect(res.statusCode, res.body).toBe(200);
      return res.json().explanation.record;
    };
    expect(await explain(flagged.id)).toMatchObject({ kind: "case", restricted: true, allowed: true, via: "CASE_OWNER" });
    expect(await explain(open.id)).toMatchObject({ kind: "case", restricted: false, allowed: true, via: "WORKSPACE_CAPABILITY" });
  });

  // ===========================================================================
  // Defect 3 — two lists
  // ===========================================================================
  describe("Defect 3 — lists omit records of a restricted case the caller cannot see", () => {
    async function fixture() {
      const caseOwner = await person("MEMBER");
      const listedViewer = await person("VIEWER");
      const offViewer = await person("VIEWER");
      const offAdmin = await person("ADMIN");
      const marker = `ra2mark${tag()}`;
      const restrictedCase = await newCase(caseOwner.id);
      await restrict(restrictedCase.id, [listedViewer.id]);
      const hidden = await newEvidence(caseOwner.id, `${marker} hidden`);
      await link(restrictedCase.id, hidden);
      const visible = await newEvidence(caseOwner.id, `${marker} visible`);
      return { caseOwner, listedViewer, offViewer, offAdmin, hidden, visible, marker };
    }
    const reportIds = async (token: string) => {
      const res = await get(`/v1/reports?teamId=${A().teamId}&limit=100`, token);
      expect(res.statusCode, res.body).toBe(200);
      return (res.json().items as Array<{ evidenceId: string }>).map((i) => i.evidenceId);
    };

    it("GET /v1/reports — off-list VIEWER and ADMIN do not get the record; a listed VIEWER does; an open record is listed for all", async () => {
      const f = await fixture();
      for (const p of [f.offViewer, f.offAdmin]) {
        const ids = await reportIds(p.token);
        expect(ids).toContain(f.visible);
        expect(ids).not.toContain(f.hidden);
      }
      const listed = await reportIds(f.listedViewer.token);
      expect(listed).toContain(f.hidden);
      expect(listed).toContain(f.visible);
    });

    it("GET /v1/cases/:id/linkable-evidence — off-list VIEWER and ADMIN are not offered the record; a listed VIEWER is", async () => {
      const f = await fixture();
      const openCase = await newCase(f.caseOwner.id);
      const offered = async (token: string) => {
        const res = await get(`/v1/cases/${openCase.id}/linkable-evidence?search=${f.marker}&limit=50`, token);
        expect(res.statusCode, res.body).toBe(200);
        return (res.json().items as Array<{ id: string }>).map((i) => i.id);
      };
      for (const p of [f.offViewer, f.offAdmin]) {
        const ids = await offered(p.token);
        expect(ids).toContain(f.visible);
        expect(ids).not.toContain(f.hidden);
      }
      expect(await offered(f.listedViewer.token)).toEqual(expect.arrayContaining([f.hidden, f.visible]));
    });
  });

  // ===========================================================================
  // Defect 5 — batch analysis
  // ===========================================================================
  describe("Defect 5 — POST /v1/batch-analysis admits records through the canonical record authority", () => {
    const batch = (token: string, evidenceIds: string[]) =>
      post(`/v1/batch-analysis`, token, { evidenceIds, name: `ra2 batch ${tag()}` });

    it("the uploader shut out of a restricted case is refused; a listed non-uploader is refused; the listed uploader is admitted", async () => {
      const caseOwner = await person("MEMBER");
      const uploader = await person("MEMBER");
      const listed = await person("MEMBER");
      const c = await newCase(caseOwner.id);
      await restrict(c.id, [listed.id]);
      const ev = await newEvidence(uploader.id);
      await link(c.id, ev);

      const refused = await batch(uploader.token, [ev]);
      expect(refused.statusCode, refused.body).toBe(404);
      expect(await prisma.batchAnalysisJobItem.count({ where: { evidenceId: ev } })).toBe(0);

      // A batch is built from the caller's own uploads: reach alone does not
      // make someone else's record theirs to analyse.
      const notTheirs = await batch(listed.token, [ev]);
      expect(notTheirs.statusCode, notTheirs.body).toBe(404);
      expect(await prisma.batchAnalysisJobItem.count({ where: { evidenceId: ev } })).toBe(0);

      await prisma.caseAccess.create({ data: { caseId: c.id, userId: uploader.id } });
      const admitted = await batch(uploader.token, [ev]);
      expect(admitted.statusCode, admitted.body).toBe(200);
      expect(await prisma.batchAnalysisJobItem.count({ where: { evidenceId: ev } })).toBe(1);
    });

    it("a SUSPENDED uploader is refused; the same uploader ACTIVE is admitted", async () => {
      const uploader = await person("MEMBER");
      const ev = await newEvidence(uploader.id);
      await prisma.teamMember.update({ where: { id: uploader.memberId! }, data: { status: "SUSPENDED" } });
      const refused = await batch(uploader.token, [ev]);
      expect(refused.statusCode, refused.body).toBe(404);
      expect(await prisma.batchAnalysisJobItem.count({ where: { evidenceId: ev } })).toBe(0);

      await prisma.teamMember.update({ where: { id: uploader.memberId! }, data: { status: "ACTIVE" } });
      const admitted = await batch(uploader.token, [ev]);
      expect(admitted.statusCode, admitted.body).toBe(200);
    });
  });

  // ===========================================================================
  // Defect 4 — a creator's grants end with their reach
  // ===========================================================================
  describe("Defect 4 — creator links and external-review grants end with the creator's reach", () => {
    const hash = () => createHash("sha256").update(randomUUID()).digest("hex");
    const inDays = (d: number) => new Date(Date.now() + d * 24 * 60 * 60 * 1000);
    const ownerLink = async (evidenceId: string, createdByUserId: string) =>
      (
        await prisma.verificationShareToken.create({
          data: { evidenceId, teamId: A().teamId, tokenHash: hash(), purpose: "OWNER_SHARE", createdByUserId, expiresAtUtc: inDays(7) },
          select: { id: true },
        })
      ).id;
    const reviewGrant = async (scope: { evidenceId?: string; caseId?: string }, invitedByUserId: string) =>
      (
        await prisma.externalReviewGrant.create({
          data: {
            teamId: A().teamId,
            scopeKind: scope.caseId ? "CASE" : "EVIDENCE",
            evidenceId: scope.evidenceId ?? null,
            caseId: scope.caseId ?? null,
            tokenHash: hash(),
            reviewerEmail: `reviewer-${tag()}@outside.test`,
            invitedByUserId,
            state: "ACTIVE",
            expiresAtUtc: inDays(7),
          },
          select: { id: true },
        })
      ).id;
    const linkState = (id: string) =>
      prisma.verificationShareToken.findUniqueOrThrow({ where: { id }, select: { revokedAtUtc: true, revocationReason: true } });
    const grantState = async (id: string) =>
      (await prisma.externalReviewGrant.findUniqueOrThrow({ where: { id }, select: { state: true } })).state;

    it("removed from the list: the creator's links and grants on the case's records (and the case) end; a listed colleague's survive; rows are kept", async () => {
      const caseOwner = await person("MEMBER");
      const creator = await person("MEMBER");
      const colleague = await person("MEMBER");
      const c = await newCase(caseOwner.id);
      await restrict(c.id, [creator.id, colleague.id]);
      const ev = await newEvidence(caseOwner.id);
      await link(c.id, ev);
      const elsewhere = await newEvidence(caseOwner.id); // not in the case: untouched

      const creatorLink = await ownerLink(ev, creator.id);
      const creatorGrant = await reviewGrant({ evidenceId: ev }, creator.id);
      const creatorCaseGrant = await reviewGrant({ caseId: c.id }, creator.id);
      const creatorOther = await ownerLink(elsewhere, creator.id);
      const colleagueLink = await ownerLink(ev, colleague.id);

      const entry = await prisma.caseAccess.findFirstOrThrow({ where: { caseId: c.id, userId: creator.id } });
      const res = await del(`/v1/cases/${c.id}/access/${entry.id}`, caseOwner.token);
      expect(res.statusCode, res.body).toBe(204);

      expect(await linkState(creatorLink)).toMatchObject({ revocationReason: "CREATOR_LOST_RECORD_REACH" });
      expect((await linkState(creatorLink)).revokedAtUtc).not.toBeNull();
      expect(await grantState(creatorGrant)).toBe("REVOKED");
      expect(await grantState(creatorCaseGrant)).toBe("REVOKED");
      expect((await linkState(creatorOther)).revokedAtUtc).toBeNull();
      expect((await linkState(colleagueLink)).revokedAtUtc).toBeNull();
    });

    it("a case restricted without them: the creator's link ends; the case owner's and the newly listed person's do not", async () => {
      const caseOwner = await person("MEMBER");
      const creator = await person("MEMBER");
      const grantee = await person("MEMBER");
      const c = await newCase(caseOwner.id);
      const ev = await newEvidence(caseOwner.id);
      await link(c.id, ev);
      const creatorLink = await ownerLink(ev, creator.id);
      const creatorGrant = await reviewGrant({ evidenceId: ev }, creator.id);
      const ownerOwnLink = await ownerLink(ev, caseOwner.id);
      const granteeLink = await ownerLink(ev, grantee.id);

      const res = await post(`/v1/cases/${c.id}/access`, caseOwner.token, { userId: grantee.id });
      expect(res.statusCode, res.body).toBe(201);

      expect(await linkState(creatorLink)).toMatchObject({ revocationReason: "CREATOR_LOST_RECORD_REACH" });
      expect(await grantState(creatorGrant)).toBe("REVOKED");
      expect((await linkState(ownerOwnLink)).revokedAtUtc).toBeNull();
      expect((await linkState(granteeLink)).revokedAtUtc).toBeNull();
    });

    it("a Collaboration Team grant that restricts the case ends an outsider's link; a team member's survives", async () => {
      const caseOwner = await person("MEMBER");
      const outsiderCreator = await person("MEMBER");
      const teamCreator = await person("MEMBER");
      const g = await group([teamCreator.id]);
      const c = await newCase(caseOwner.id);
      const ev = await newEvidence(caseOwner.id);
      await link(c.id, ev);
      const outsiderLink = await ownerLink(ev, outsiderCreator.id);
      const teamLink = await ownerLink(ev, teamCreator.id);

      const res = await post(`/v1/cases/${c.id}/team-access`, caseOwner.token, { collaborationTeamId: g });
      expect(res.statusCode, res.body).toBe(201);
      expect((await linkState(outsiderLink)).revokedAtUtc).not.toBeNull();
      expect((await linkState(teamLink)).revokedAtUtc).toBeNull();
    });

    it("control: a grant on an already-restricted case ends nobody's link (no one lost reach)", async () => {
      const caseOwner = await person("MEMBER");
      const listed = await person("MEMBER");
      const next = await person("MEMBER");
      const c = await newCase(caseOwner.id);
      await restrict(c.id, [listed.id]);
      const ev = await newEvidence(caseOwner.id);
      await link(c.id, ev);
      const listedLink = await ownerLink(ev, listed.id);
      const res = await post(`/v1/cases/${c.id}/access`, caseOwner.token, { userId: next.id });
      expect(res.statusCode, res.body).toBe(201);
      expect((await linkState(listedLink)).revokedAtUtc).toBeNull();
    });
  });

  describe("Unlink — removing a record from a restricted case is a manager's act", () => {
    const unlink = (caseId: string, evidenceId: string, token: string) =>
      del(`/v1/cases/${caseId}/evidence/${evidenceId}`, token);
    const links = (caseId: string, evidenceId: string) =>
      prisma.caseEvidenceLink.count({ where: { caseId, evidenceId } });

    it("a listed MEMBER cannot unlink (typed 403, link kept); a listed ADMIN can; on an open case the MEMBER can", async () => {
      const member = await person("MEMBER");
      const admin = await person("ADMIN");
      const kase = await newCase(A().ownerUserId);
      await restrict(kase.id, [member.id, admin.id]);
      const ev = await newEvidence(A().ownerUserId);
      await link(kase.id, ev);

      const refused = await unlink(kase.id, ev, member.token);
      expect(refused.statusCode, refused.body).toBe(403);
      expect((refused.json() as { code?: string }).code).toBe("CASE_RESTRICTED_UNLINK_MANAGER_REQUIRED");
      expect(await links(kase.id, ev)).toBe(1);

      const ok = await unlink(kase.id, ev, admin.token);
      expect(ok.statusCode, ok.body).toBeLessThan(300);
      expect(await links(kase.id, ev)).toBe(0);

      // Control: the rule is the restriction — on an open case the MEMBER unlinks.
      const open = await newCase(A().ownerUserId);
      const ev2 = await newEvidence(A().ownerUserId);
      await link(open.id, ev2);
      const plain = await unlink(open.id, ev2, member.token);
      expect(plain.statusCode, plain.body).toBeLessThan(300);
      expect(await links(open.id, ev2)).toBe(0);
    });
  });
});
