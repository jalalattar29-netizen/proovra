/**
 * MEMBERS EXPERIENCE — the closure audit's server findings, on live PostgreSQL.
 *
 *   SEARCH    a member off a restricted Case's list cannot find the Case, or
 *             Evidence linked to it, through /v1/search or /v1/search/suggest;
 *             a listed member can (positive control on the same rows).
 *   GRANT     an external-review grant cannot be issued on a Case, Evidence or
 *             package the ISSUER cannot reach; the refusal is the same
 *             `invalid_scope` a foreign id gets; a listed issuer can.
 *   RESTORE   reinstating a suspended member who holds a position in a group
 *             that refilled meanwhile is refused (409
 *             collaboration_team_capacity_reached); with room it succeeds.
 *   REVOKE    a revoke that loses the race to an acceptance answers
 *             INVITE_NOT_PENDING and never stamps the accepted invitation.
 *   STATS     Members & Access counts only the Cases the caller can see,
 *             separates the open ones, and states active Collaboration Teams
 *             against the plan limit with the per-Team size.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Prisma = (typeof import("../src/db.js"))["prisma"];
type Person = { id: string; memberId: string | null; token: string };
type Role = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

describe("members experience — reach, capacity and counts (live PostgreSQL)", () => {
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

  async function person(role: Role | null = "MEMBER", teamId = A().teamId): Promise<Person> {
    const email = `mx-${tag()}@test.proovra.local`;
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
  async function newCase(ownerUserId: string, name = `mx-case-${tag()}`, status = "OPEN") {
    return prisma.case.create({
      data: { name, teamId: A().teamId, ownerUserId, status } as never,
      select: { id: true, name: true },
    });
  }
  async function restrict(caseId: string, listed: string[]) {
    await prisma.case.update({ where: { id: caseId }, data: { restrictedAtUtc: new Date() } });
    for (const userId of listed) await prisma.caseAccess.create({ data: { caseId, userId } });
  }
  async function newEvidence(ownerUserId: string, title: string) {
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
  /** An index row as the indexers write it: workspace, subject ids, text. */
  function indexDoc(kind: "CASE" | "EVIDENCE", sourceId: string, title: string, ids: { caseId?: string; evidenceId?: string }) {
    return prisma.evidenceSearchDocument.create({
      data: {
        teamId: A().teamId,
        documentType: kind,
        sourceId,
        title,
        searchableText: title,
        caseId: ids.caseId ?? null,
        evidenceId: ids.evidenceId ?? null,
        reviewerRestricted: false,
        contributorScoped: false,
        sourceUpdatedAtUtc: new Date(),
      } as never,
    });
  }

  // ===========================================================================
  describe("SEARCH — a restricted Case is not found by a member off its list", () => {
    async function fixture() {
      const caseOwner = await person("MEMBER");
      const listed = await person("MEMBER");
      const off = await person("ADMIN");
      const needle = `zephyr${tag()}`;
      const c = await newCase(caseOwner.id, `Matter ${needle}`);
      await restrict(c.id, [listed.id]);
      const ev = await newEvidence(caseOwner.id, `Photo ${needle}`);
      await link(c.id, ev);
      await indexDoc("CASE", c.id, `Matter ${needle}`, { caseId: c.id });
      await indexDoc("EVIDENCE", ev, `Photo ${needle}`, { evidenceId: ev });
      return { listed, off, needle, caseId: c.id, evidenceId: ev };
    }

    it("/v1/search: the off-list ADMIN gets neither the Case nor its Evidence; the listed member gets both", async () => {
      const f = await fixture();
      const offRes = await get(`/v1/search?teamId=${A().teamId}&q=${f.needle}`, f.off.token);
      expect(offRes.statusCode).toBe(200);
      expect(offRes.body).not.toContain(f.caseId);
      expect(offRes.body).not.toContain(f.evidenceId);
      expect(offRes.body).not.toContain(f.needle);

      const okRes = await get(`/v1/search?teamId=${A().teamId}&q=${f.needle}`, f.listed.token);
      expect(okRes.statusCode).toBe(200);
      expect(okRes.body).toContain(f.caseId);
      expect(okRes.body).toContain(f.evidenceId);
    });

    it("/v1/search/suggest: the same answer", async () => {
      const f = await fixture();
      const offRes = await get(`/v1/search/suggest?teamId=${A().teamId}&q=${f.needle}`, f.off.token);
      expect(offRes.statusCode).toBe(200);
      expect(offRes.body).not.toContain(f.needle);
      const okRes = await get(`/v1/search/suggest?teamId=${A().teamId}&q=${f.needle}`, f.listed.token);
      expect(okRes.body).toContain(f.needle);
    });

    it("an unrestricted Case stays searchable by every member (the filter only removes the hidden)", async () => {
      const owner = await person("MEMBER");
      const other = await person("VIEWER");
      const needle = `open${tag()}`;
      const c = await newCase(owner.id, `Matter ${needle}`);
      await indexDoc("CASE", c.id, `Matter ${needle}`, { caseId: c.id });
      const res = await get(`/v1/search?teamId=${A().teamId}&q=${needle}`, other.token);
      expect(res.body).toContain(c.id);
    });
  });

  // ===========================================================================
  describe("GRANT — an external-review grant is issued only within the issuer's reach", () => {
    async function issue(issuer: string, kind: "CASE" | "EVIDENCE", id: string) {
      const { issueExternalReviewGrant } = await import("../src/services/external-review/external-review-grant.service.js");
      return issueExternalReviewGrant({
        teamId: A().teamId,
        invitedByUserId: issuer,
        scopeKind: kind,
        caseId: kind === "CASE" ? id : null,
        evidenceId: kind === "EVIDENCE" ? id : null,
        reviewerEmail: `reviewer-${tag()}@outside.test`,
        expiresAtUtc: new Date(Date.now() + 3 * 86_400_000),
      });
    }

    it("off the list: CASE and EVIDENCE are refused invalid_scope and no grant row is written", async () => {
      const caseOwner = await person("MEMBER");
      const off = await person("ADMIN");
      const c = await newCase(caseOwner.id);
      await restrict(c.id, [caseOwner.id]);
      const ev = await newEvidence(caseOwner.id, `ev ${tag()}`);
      await link(c.id, ev);
      const before = await prisma.externalReviewGrant.count({ where: { teamId: A().teamId } });
      expect(await issue(off.id, "CASE", c.id)).toEqual({ ok: false, reason: "invalid_scope" });
      expect(await issue(off.id, "EVIDENCE", ev)).toEqual({ ok: false, reason: "invalid_scope" });
      expect(await prisma.externalReviewGrant.count({ where: { teamId: A().teamId } })).toBe(before);
    });

    it("on the list: the same subjects issue", async () => {
      const caseOwner = await person("MEMBER");
      const listed = await person("ADMIN");
      const c = await newCase(caseOwner.id);
      await restrict(c.id, [listed.id]);
      const ev = await newEvidence(caseOwner.id, `ev ${tag()}`);
      await link(c.id, ev);
      expect((await issue(listed.id, "CASE", c.id)).ok).toBe(true);
      expect((await issue(listed.id, "EVIDENCE", ev)).ok).toBe(true);
    });
  });

  describe("GRANT — a cross-org acceptance is checked against the CREATOR's reach", () => {
    async function invitation(createdByUserId: string, caseId: string) {
      return prisma.crossOrgReviewGrant.create({
        data: {
          teamId: A().teamId,
          invitingOrganizationId: randomUUID(),
          invitedOrgSlug: `mx-org-${tag()}`,
          state: "INVITED",
          scope: { text: "matter review", subject: { kind: "CASE", id: caseId } },
          createdByUserId,
        } as never,
        select: { id: true },
      });
    }
    const accept = async (grantId: string) => {
      const { acceptCrossOrgReview } = await import("../src/services/governance/cross-org-review.service.js");
      // The workspace OWNER decides — and is not on the restricted Case.
      return acceptCrossOrgReview({
        teamId: A().teamId,
        grantId,
        acceptingOrganizationId: randomUUID(),
        externalReviewGrantId: null,
        actorUserId: A().ownerUserId,
      });
    };

    it("a creator on the list: the owner off the list can still accept the exchange", async () => {
      const creator = await person("ADMIN");
      const c = await newCase(creator.id);
      await restrict(c.id, [creator.id]);
      const row = await invitation(creator.id, c.id);
      expect((await accept(row.id)).ok).toBe(true);
    });

    it("a creator off the list: refused, and no external-review grant is minted", async () => {
      const owner = await person("MEMBER");
      const creator = await person("ADMIN");
      const c = await newCase(owner.id);
      await restrict(c.id, [owner.id]);
      const row = await invitation(creator.id, c.id);
      expect((await accept(row.id)).ok).toBe(false);
      expect(await prisma.externalReviewGrant.count({ where: { teamId: A().teamId, caseId: c.id } })).toBe(0);
    });
  });

  describe("SEARCH — the exclusion bound fails closed", () => {
    it("past the bound every match is refused rather than any hidden row shown", async () => {
      const { searchDocumentReachWhere } = await import("../src/services/search/search-reach.js");
      const many = Array.from({ length: 20_001 }, () => ({ id: randomUUID() }));
      const fake = {
        case: { findMany: async () => many },
        evidence: { findMany: async () => [] },
      };
      expect(await searchDocumentReachWhere(fake as never, A().teamId, "u")).toEqual({ AND: [{ id: { in: [] } }] });
    });
  });

  // ===========================================================================
  describe("RESTORE — reinstatement takes back the Team position it held", () => {
    it("a group that refilled while the member was suspended refuses the reinstatement; with room it succeeds", async () => {
      const { suspendMember, restoreMember, RbacError } = await import("../src/services/identity/rbac.service.js");
      const owner = A().ownerUserId;
      // TEAM sells 10 accepted non-owner members per Collaboration Team.
      const people = [] as Person[];
      for (let i = 0; i < 10; i += 1) people.push(await person("MEMBER"));
      const groupId = (
        await prisma.collaborationTeam.create({
          data: {
            workspaceId: A().teamId,
            name: `mx-group-${tag()}`,
            createdByUserId: owner,
            members: { create: people.map((p) => ({ userId: p.id, status: "ACTIVE" })) },
          } as never,
          select: { id: true },
        })
      ).id;
      const suspended = people[0]!;
      await suspendMember({ teamId: A().teamId, teamMemberId: suspended.memberId!, actorUserId: owner });
      // While they are suspended their position is free, and is taken.
      const newcomer = await person("MEMBER");
      await prisma.collaborationTeamMember.create({ data: { teamId: groupId, userId: newcomer.id, status: "ACTIVE" } as never });

      const refused = await restoreMember({ teamId: A().teamId, teamMemberId: suspended.memberId!, actorUserId: owner }).catch((e) => e);
      expect(refused).toBeInstanceOf(RbacError);
      expect((refused as InstanceType<typeof RbacError>).code).toBe("collaboration_team_capacity_reached");
      const still = await prisma.teamMember.findUniqueOrThrow({ where: { id: suspended.memberId! }, select: { status: true } });
      expect(still.status).toBe("SUSPENDED");

      // Room again: the reinstatement goes through.
      await prisma.collaborationTeamMember.updateMany({ where: { teamId: groupId, userId: newcomer.id }, data: { status: "REMOVED" } as never });
      const restored = await restoreMember({ teamId: A().teamId, teamMemberId: suspended.memberId!, actorUserId: owner });
      expect(restored.status).toBe("ACTIVE");
    });

    it("the route answers 409 with the typed code", async () => {
      const { rbacErrorStatus } = await import("../src/http/member-command-gates.js");
      expect(rbacErrorStatus("collaboration_team_capacity_reached")).toBe(409);
      expect(rbacErrorStatus("workspace_seat_limit_reached")).toBe(409);
    });
  });

  // ===========================================================================
  describe("REVOKE — a revoke that loses the race to an acceptance", () => {
    it("answers INVITE_NOT_PENDING and leaves the accepted invitation unrevoked", async () => {
      const { revokeWorkspaceInvitation, WorkspaceInvitationError } = await import(
        "../src/services/identity/workspace-invitation.service.js"
      );
      const invite = await prisma.teamInvite.create({
        data: {
          teamId: A().teamId,
          email: `race-${tag()}@test.proovra.local`,
          role: "MEMBER",
          tokenHash: randomUUID().replace(/-/g, ""),
          invitedByUserId: A().ownerUserId,
          expiresAt: new Date(Date.now() + 86_400_000),
        } as never,
        select: { id: true },
      });
      // The acceptance commits between the revoke's read and its write.
      const racing = new Proxy(prisma, {
        get(target, prop, receiver) {
          if (prop !== "teamInvite") return Reflect.get(target, prop, receiver);
          const delegate = target.teamInvite;
          return new Proxy(delegate, {
            get(d, p, r) {
              if (p !== "findFirst") return Reflect.get(d, p, r);
              return async (args: unknown) => {
                const row = await (d.findFirst as (a: unknown) => Promise<unknown>)(args);
                await target.teamInvite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
                return row;
              };
            },
          });
        },
      });
      const err = await revokeWorkspaceInvitation(
        { workspaceId: A().teamId, inviteId: invite.id, actorUserId: A().ownerUserId },
        racing as never,
      ).catch((e) => e);
      expect(err).toBeInstanceOf(WorkspaceInvitationError);
      expect((err as { code: string }).code).toBe("INVITE_NOT_PENDING");
      const row = await prisma.teamInvite.findUniqueOrThrow({ where: { id: invite.id }, select: { acceptedAt: true, revokedAt: true } });
      expect(row.acceptedAt).not.toBeNull();
      expect(row.revokedAt).toBeNull();
    });
  });

  // ===========================================================================
  describe("STATS — Members & Access figures", () => {
    it("caseCount is the caller's visible Cases; openCaseCount excludes finished ones; Teams are against the plan", async () => {
      const viewer = await person("VIEWER");
      const owner = await person("MEMBER");
      const read = async (token: string) => (await get(`/v1/teams/${A().teamId}`, token)).json().stats;
      const base = await read(viewer.token);

      const hidden = await newCase(owner.id);
      await restrict(hidden.id, [owner.id]);
      await newCase(owner.id, `closed ${tag()}`, "CLOSED");
      await newCase(owner.id, `open ${tag()}`, "INVESTIGATING");

      const after = await read(viewer.token);
      // The restricted Case is not counted for someone off its list…
      expect(after.caseCount).toBe(base.caseCount + 2);
      // …and only the still-worked one is open.
      expect(after.openCaseCount).toBe(base.openCaseCount + 1);
      // The Case owner sees their restricted Case.
      const ownerView = await read(owner.token);
      expect(ownerView.caseCount).toBe(after.caseCount + 1);

      // TEAM: Collaboration Teams against 5, 10 per Team.
      expect(after.collaborationTeams.featureIncluded).toBe(true);
      expect(after.collaborationTeams.limit).toBe(5);
      expect(after.collaborationTeams.membersPerTeam).toBe(10);
      expect(typeof after.collaborationTeams.active).toBe("number");
    });
  });
});
