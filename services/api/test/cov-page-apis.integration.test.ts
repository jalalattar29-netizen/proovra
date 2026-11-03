/* eslint-disable @typescript-eslint/no-explicit-any -- test support reads Prisma delegates and JSON bodies of many shapes. */
/**
 * THE PAGES THE AUDIT COULD NOT OPEN (BLOCKED_NO_FIXTURE), BY THEIR API.
 *
 *   /collaboration-teams/invites/[token]/accept
 *   /governance-platform/access-reviews/[campaignId]
 *   /redaction/[projectId]
 *
 * (`/portal/[token]/work/[workflowId]` is in cov-external-reviewer.integration.test.ts.)
 *
 * Two real customers, provisioned and accepted through the product. Every refusal
 * reads against a positive control on the same row. FIXTURE (labelled): the
 * invitation rows are written directly because no writer of that table exists any
 * more (WCR-20); what is under test is the accept path that stays live for links
 * already in mailboxes.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { coverageKit, type CoverageKit, type Person } from "./support/coverage-actors.js";
import { customerKit, type Customer } from "./support/coverage-customer.js";

type Prisma = import("@prisma/client").PrismaClient;

describe("the pages the audit could not reach (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let kit: CoverageKit;
  let tenant: Customer;
  let foreign: Customer;
  let admin: Person;
  let member: Person;
  let viewer: Person;
  let foreignAdmin: Person;

  const owner = () => ({ token: tenant.owner.token });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as Prisma;
    kit = await coverageKit(h);
    const customers = await customerKit(h, prisma);
    tenant = await customers.customer();
    foreign = await customers.customer();
    [admin, member, viewer, foreignAdmin] = await Promise.all([
      kit.person(tenant.workspaceId, "ADMIN"),
      kit.person(tenant.workspaceId, "MEMBER"),
      kit.person(tenant.workspaceId, "VIEWER"),
      kit.person(foreign.workspaceId, "ADMIN"),
    ]);
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  // ===========================================================================
  // /collaboration-teams/invites/[token]/accept
  // ===========================================================================
  describe("team invitation accept", () => {
    let teamId: string;
    const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const rawToken = () =>
      `ctit_v1_${Array.from(randomBytes(52), (b) => BASE32[b % 32]).join("")}`;

    async function invitation(email: string | null, over: Record<string, unknown> = {}) {
      const token = rawToken();
      const row = await prisma.collaborationTeamInvite.create({
        data: {
          teamId,
          workspaceId: tenant.workspaceId,
          channel: "EMAIL",
          email,
          tokenHash: createHash("sha256").update(token).digest("hex"),
          role: "MEMBER",
          status: "PENDING",
          expiresAtUtc: new Date(Date.now() + 86_400_000),
          createdByUserId: tenant.owner.userId,
          ...over,
        } as never,
        select: { id: true },
      });
      return { token, id: row.id };
    }
    const accept = (who: { token: string } | null, token: string) =>
      kit.call("POST", "/v1/collaboration-team-invites/accept", who, { token });
    const acceptByPath = (who: { token: string } | null, token: string) =>
      kit.call("POST", `/v1/collaboration-team-invites/${token}/accept`, who);
    const code = (res: { json: () => any }) => res.json().error?.code;
    const memberRows = (userId: string) =>
      prisma.collaborationTeamMember.count({ where: { teamId, userId, status: "ACTIVE" } });

    beforeAll(async () => {
      const created = await kit.call("POST", "/v1/collaboration-teams", owner(), { name: `Team ${kit.tag()}` });
      expect(created.statusCode, created.body).toBeLessThan(300);
      const body = created.json();
      teamId = body.team?.id ?? body.id;
      expect(teamId).toBeTruthy();
    });

    it("POSITIVE: the addressee joins once, the invitation is spent, and it is audited with the membership", async () => {
      const invitee = await kit.person(tenant.workspaceId, "MEMBER");
      const inv = await invitation(invitee.email.toUpperCase());
      const res = await accept(invitee, inv.token);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ teamId, alreadyMember: false });
      expect(await memberRows(invitee.id)).toBe(1);
      expect(
        await prisma.collaborationTeamInvite.findUniqueOrThrow({ where: { id: inv.id } }),
      ).toMatchObject({ status: "ACCEPTED", useCount: 1, acceptedByUserId: invitee.id });
      expect(
        await prisma.adminAuditLog.count({
          where: { action: "collaboration_team.invite.accepted", userId: invitee.id },
        }),
      ).toBe(1);

      // Re-opening the link is a calm success for the member, and adds nothing.
      const again = await accept(invitee, inv.token);
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json()).toMatchObject({ teamId, alreadyMember: true });
      expect(await memberRows(invitee.id)).toBe(1);
    });

    it("a member who is not the addressee is refused; the invitation stays usable by the addressee", async () => {
      const invitee = await kit.person(tenant.workspaceId, "MEMBER");
      const wrong = await kit.person(tenant.workspaceId, "MEMBER");
      const inv = await invitation(invitee.email);
      for (const res of [await accept(wrong, inv.token), await acceptByPath(wrong, inv.token)]) {
        expect(res.statusCode, res.body).toBe(403);
        expect(code(res)).toBe("INVITE_EMAIL_MISMATCH");
      }
      expect(await memberRows(wrong.id)).toBe(0);
      expect(await prisma.collaborationTeamInvite.findUniqueOrThrow({ where: { id: inv.id } })).toMatchObject({
        status: "PENDING",
        useCount: 0,
      });
      const control = await accept(invitee, inv.token);
      expect(control.statusCode, control.body).toBe(200);
    });

    it("the addressee from outside the workspace is refused, and another tenant's admin gets no seat", async () => {
      const outsider = await kit.person(foreign.workspaceId, "MEMBER");
      const inv = await invitation(outsider.email);
      const res = await accept(outsider, inv.token);
      expect(res.statusCode, res.body).toBe(403);
      expect(code(res)).toBe("WORKSPACE_MEMBERSHIP_REQUIRED");
      expect(await memberRows(outsider.id)).toBe(0);
      const stranger = await accept(foreignAdmin, inv.token);
      expect(stranger.statusCode, stranger.body).toBe(403);
      expect(await memberRows(foreignAdmin.id)).toBe(0);
    });

    it("an expired invitation is refused and recorded as expired", async () => {
      const invitee = await kit.person(tenant.workspaceId, "MEMBER");
      const inv = await invitation(invitee.email, { expiresAtUtc: new Date(Date.now() - 60_000) });
      const res = await accept(invitee, inv.token);
      expect(res.statusCode, res.body).toBe(410);
      expect(code(res)).toBe("INVITE_EXPIRED");
      expect(await memberRows(invitee.id)).toBe(0);
      expect((await prisma.collaborationTeamInvite.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe("EXPIRED");
    });

    it("an invitation revoked through the route stops working; another tenant cannot revoke it", async () => {
      const invitee = await kit.person(tenant.workspaceId, "MEMBER");
      const inv = await invitation(invitee.email);
      const url = `/v1/collaboration-teams/${teamId}/invites/${inv.id}/revoke`;
      const cross = await kit.call("POST", url, foreignAdmin, {});
      expect(cross.statusCode, cross.body).toBe(404);
      expect((await prisma.collaborationTeamInvite.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe("PENDING");

      const revoked = await kit.call("POST", url, owner(), {});
      expect(revoked.statusCode, revoked.body).toBeLessThan(300);
      const res = await accept(invitee, inv.token);
      expect(res.statusCode, res.body).toBe(410);
      expect(code(res)).toBe("INVITE_REVOKED");
      expect(await memberRows(invitee.id)).toBe(0);
    });

    it("a token that never existed, and no session at all, are refused without naming a team", async () => {
      const unknown = await accept(member, rawToken());
      expect(unknown.statusCode, unknown.body).toBe(404);
      expect(code(unknown)).toBe("INVITE_NOT_FOUND");
      expect(unknown.body).not.toContain(teamId);
      const inv = await invitation(member.email);
      const anon = await accept(null, inv.token);
      expect(anon.statusCode, anon.body).toBe(401);
      expect(await memberRows(member.id)).toBe(0);
    });
  });

  // ===========================================================================
  // /governance-platform/access-reviews/[campaignId]
  // ===========================================================================
  describe("access review campaign", () => {
    let campaignId: string;
    let itemId: string;
    let selfItemId: string;
    const itemsUrl = () => `/v1/governance/access-reviews/campaigns/${campaignId}/items`;
    const decisionUrl = (id: string) => `/v1/governance/access-reviews/items/${id}/decision`;
    const decisionOf = async (id: string) =>
      (await prisma.accessReviewItem.findUniqueOrThrow({ where: { id } })).decision;

    beforeAll(async () => {
      const scope = async (userId: string) => {
        const row = await prisma.teamMember.findFirstOrThrow({
          where: { teamId: tenant.workspaceId, userId },
          select: { id: true },
        });
        return prisma.memberDelegatedAdminScope.create({
          data: {
            teamMemberId: row.id,
            teamId: tenant.workspaceId,
            scopeKind: "IDENTITY_ADMIN",
            grantedByUserId: tenant.owner.userId,
            reason: "coverage fixture",
          } as never,
          select: { id: true },
        });
      };
      const memberScope = await scope(member.id);
      const ownerScope = await scope(tenant.owner.userId);
      const created = await kit.call("POST", "/v1/governance/access-reviews/campaigns", owner(), {
        kind: "PERIODIC",
        name: `Quarterly ${kit.tag()}`,
        scheduledStartUtc: new Date().toISOString(),
        scheduledEndUtc: new Date(Date.now() + 86_400_000).toISOString(),
        items: [
          { subjectUserId: member.id, grantRef: `delegated_scope:${memberScope.id}` },
          { subjectUserId: tenant.owner.userId, grantRef: `delegated_scope:${ownerScope.id}` },
        ],
      });
      expect(created.statusCode, created.body).toBe(201);
      campaignId = created.json().campaignId;
      const opened = await kit.call("POST", `/v1/governance/access-reviews/campaigns/${campaignId}/open`, owner(), {});
      expect(opened.statusCode, opened.body).toBe(200);
      const items = await kit.call("GET", itemsUrl(), owner());
      expect(items.statusCode, items.body).toBe(200);
      expect(items.json().items).toHaveLength(2);
      itemId = items.json().items.find((i: { subjectUserId: string }) => i.subjectUserId === member.id).id;
      selfItemId = items.json().items.find((i: { subjectUserId: string }) => i.subjectUserId === tenant.owner.userId).id;
    });

    it("POSITIVE: the reviewer reads the items and decides one; the decision names the reviewer", async () => {
      const res = await kit.call("POST", decisionUrl(itemId), owner(), { decision: "APPROVED" });
      expect(res.statusCode, res.body).toBe(200);
      expect(await prisma.accessReviewItem.findUniqueOrThrow({ where: { id: itemId } })).toMatchObject({
        decision: "APPROVED",
        reviewerUserId: tenant.owner.userId,
      });
      const read = await kit.call("GET", itemsUrl(), owner());
      expect(read.json().items.find((i: { id: string }) => i.id === itemId).decision).toBe("APPROVED");
      expect(
        await prisma.intelligenceActivityEvent.count({ where: { targetType: "ACCESS_REVIEW_ITEM", targetId: itemId } }),
      ).toBeGreaterThanOrEqual(1);
    });

    it("the reviewer's own item is refused with its reason", async () => {
      const res = await kit.call("POST", decisionUrl(selfItemId), owner(), { decision: "APPROVED" });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toEqual({ denial: "SELF_REVIEW_REFUSED" });
      expect(await decisionOf(selfItemId)).toBe("PENDING");
    });

    it("another organization's owner and admin read nothing of it and decide nothing, as if the campaign did not exist", async () => {
      for (const who of [foreignAdmin, { token: foreign.owner.token }]) {
        const read = await kit.call("GET", itemsUrl(), who);
        expect(read.statusCode, read.body).toBe(404);
        expect(read.body).not.toContain(member.id);
        const missing = await kit.call("GET", `/v1/governance/access-reviews/campaigns/${randomUUID()}/items`, who);
        expect(missing.statusCode).toBe(404);
        expect(read.body).toBe(missing.body);
      }

      // Naming the victim's workspace does not move the caller into it.
      const named = await kit.call("GET", `${itemsUrl()}?teamId=${tenant.workspaceId}`, foreignAdmin, undefined, {
        "x-workspace-id": tenant.workspaceId,
      });
      expect(named.statusCode, named.body).toBeGreaterThanOrEqual(400);
      expect(named.body).not.toContain(member.id);

      // A foreign owner holds the permission in their own workspace, and finds no such item.
      const decide = await kit.call("POST", decisionUrl(selfItemId), { token: foreign.owner.token }, { decision: "APPROVED" });
      expect(decide.statusCode, decide.body).toBe(409);
      const decideMissing = await kit.call("POST", decisionUrl(randomUUID()), { token: foreign.owner.token }, { decision: "APPROVED" });
      expect(decide.body).toBe(decideMissing.body);
      expect(await decisionOf(selfItemId)).toBe("PENDING");
    });

    it("the read follows governance.policy.read (a viewer holds it); a decision needs the review permission", async () => {
      const read = await kit.call("GET", itemsUrl(), viewer);
      expect(read.statusCode, read.body).toBe(200);
      for (const who of [viewer, member, admin]) {
        const decide = await kit.call("POST", decisionUrl(selfItemId), who, { decision: "APPROVED" });
        expect(decide.statusCode, decide.body).toBe(403);
        expect(decide.json()).toEqual({ denial: "PERMISSION_REQUIRED", permission: "governance.access_review.decide" });
      }
      expect(await decisionOf(selfItemId)).toBe("PENDING");
    });
  });

  // ===========================================================================
  // /redaction/[projectId]
  // ===========================================================================
  describe("redaction project", () => {
    let restrictedCaseId: string;
    let projectId: string;
    let versionId: string;
    let openProjectId: string;
    let hiddenEvidenceId: string;
    let listedAdmin: Person;
    let offListAdmin: Person;

    async function record(title: string) {
      return (
        await prisma.evidence.create({
          data: {
            title,
            type: "PHOTO",
            status: "SIGNED",
            teamId: tenant.workspaceId,
            organizationId: tenant.orgId,
            ownerUserId: tenant.owner.userId,
          } as never,
          select: { id: true },
        })
      ).id;
    }
    const open = async (evidenceId: string, who: { token: string }) => {
      const res = await kit.call("POST", "/v1/redaction/projects", who, { evidenceId, artifactKind: "IMAGE" });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().projectId as string;
    };

    beforeAll(async () => {
      [listedAdmin, offListAdmin] = await Promise.all([
        kit.person(tenant.workspaceId, "ADMIN"),
        kit.person(tenant.workspaceId, "ADMIN"),
      ]);
      const r = await prisma.case.create({
        data: {
          name: `Restricted ${kit.tag()}`,
          teamId: tenant.workspaceId,
          ownerUserId: tenant.owner.userId,
          restrictedAtUtc: new Date(),
        } as never,
        select: { id: true },
      });
      restrictedCaseId = r.id;
      await prisma.caseAccess.create({ data: { caseId: restrictedCaseId, userId: listedAdmin.id } });
      hiddenEvidenceId = await record(`SENTINEL-RECORD-${kit.tag()}`);
      await prisma.caseEvidenceLink.create({
        data: { caseId: restrictedCaseId, evidenceId: hiddenEvidenceId, teamId: tenant.workspaceId } as never,
      });
      projectId = await open(hiddenEvidenceId, listedAdmin);
      openProjectId = await open(await record(`open ${kit.tag()}`), offListAdmin);
      const v = await kit.call("POST", `/v1/redaction/projects/${projectId}/versions`, listedAdmin, {});
      expect(v.statusCode, v.body).toBe(201);
      versionId = v.json().versionId;
    });

    it("POSITIVE: the listed author reads the project, its activity and its versions", async () => {
      const read = await kit.call("GET", `/v1/redaction/projects/${projectId}`, listedAdmin);
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json().project.versions.map((v: { id: string }) => v.id)).toContain(versionId);
      const activity = await kit.call("GET", `/v1/redaction/projects/${projectId}/activity`, listedAdmin);
      expect(activity.statusCode, activity.body).toBe(200);
      expect(activity.json().activity.length).toBeGreaterThan(0);
    });

    it("another tenant's admin sees a redaction project as missing, and writes nothing", async () => {
      const read = await kit.call("GET", `/v1/redaction/projects/${projectId}`, foreignAdmin);
      expect(read.statusCode, read.body).toBe(404);
      const missing = await kit.call("GET", `/v1/redaction/projects/${randomUUID()}`, foreignAdmin);
      expect(read.body).toBe(missing.body);
      const activity = await kit.call("GET", `/v1/redaction/projects/${projectId}/activity`, foreignAdmin);
      expect(activity.body).not.toContain(tenant.owner.userId);
      expect(activity.json().activity ?? []).toEqual([]);
      const before = await prisma.redactionVersion.count({ where: { projectId } });
      const write = await kit.call("POST", `/v1/redaction/projects/${projectId}/versions`, foreignAdmin, {});
      expect(write.statusCode, write.body).toBeGreaterThanOrEqual(400);
      expect(await prisma.redactionVersion.count({ where: { projectId } })).toBe(before);
    });

    it("a member off a restricted case's list sees the project of its record as missing, on every project-keyed read", async () => {
      // The refusal must read as a row that is not there, not as a closed door:
      // byte for byte what the same route says of an id that never existed.
      const reads = [
        (id: string) => `/v1/redaction/projects/${id}`,
        (id: string) => `/v1/redaction/projects/${id}/activity`,
      ];
      const versionReads = [
        (id: string) => `/v1/redaction/versions/${id}/detections`,
        (id: string) => `/v1/redaction/versions/${id}/derivative`,
      ];
      for (const [urls, id] of [[reads, projectId], [versionReads, versionId]] as const) {
        for (const url of urls) {
          const control = await kit.call("GET", url(id), listedAdmin);
          expect(control.statusCode, control.body).toBeLessThan(500);
          const res = await kit.call("GET", url(id), offListAdmin);
          const missing = await kit.call("GET", url(randomUUID()), offListAdmin);
          expect(res.statusCode, `${url(id)} ${res.body}`).toBe(missing.statusCode);
          expect(res.body).toBe(missing.body);
          expect(res.body).not.toContain(hiddenEvidenceId);
        }
      }
      const project = await kit.call("GET", `/v1/redaction/projects/${projectId}`, offListAdmin);
      expect(project.statusCode, project.body).toBe(404);
      const control = await kit.call("GET", `/v1/redaction/projects/${projectId}`, listedAdmin);
      expect(control.statusCode, control.body).toBe(200);
    });

    it("the off-list member's list omits the project; their open project stays", async () => {
      const list = await kit.call("GET", "/v1/redaction/projects", offListAdmin);
      expect(list.statusCode, list.body).toBe(200);
      const ids = list.json().projects.map((p: { id: string }) => p.id);
      expect(ids).toContain(openProjectId);
      expect(ids).not.toContain(projectId);
      const listed = await kit.call("GET", "/v1/redaction/projects", listedAdmin);
      expect(listed.json().projects.map((p: { id: string }) => p.id)).toContain(projectId);
    });

    it("the off-list member can neither open a project on the record nor write to one that exists", async () => {
      const opened = await kit.call("POST", "/v1/redaction/projects", offListAdmin, {
        evidenceId: hiddenEvidenceId,
        artifactKind: "IMAGE",
      });
      const openMissing = await kit.call("POST", "/v1/redaction/projects", offListAdmin, {
        evidenceId: randomUUID(),
        artifactKind: "IMAGE",
      });
      expect(opened.statusCode, opened.body).toBe(409);
      expect(opened.body).toBe(openMissing.body);

      const versions = await prisma.redactionVersion.count({ where: { projectId } });
      const regions = await prisma.redactionRegion.count({ where: { versionId } });
      const writes: Array<[(id: string) => string, unknown, string]> = [
        [(id) => `/v1/redaction/projects/${id}/versions`, {}, projectId],
        [
          (id) => `/v1/redaction/versions/${id}/regions`,
          { kind: "BBOX_NORMALIZED", method: "BLACKOUT", geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
          versionId,
        ],
        [(id) => `/v1/redaction/versions/${id}/submit`, {}, versionId],
        [(id) => `/v1/redaction/versions/${id}/approve`, { verdict: "APPROVE" }, versionId],
        [(id) => `/v1/redaction/versions/${id}/derivative`, {}, versionId],
        [
          (id) => `/v1/redaction/versions/${id}/decisions/bulk`,
          { rows: [{ detectionId: randomUUID(), decisionState: "ACCEPTED" }] },
          versionId,
        ],
      ];
      for (const [url, body, id] of writes) {
        const res = await kit.call("POST", url(id), offListAdmin, body);
        const missing = await kit.call("POST", url(randomUUID()), offListAdmin, body);
        expect(res.statusCode, `${url(id)} ${res.body}`).toBe(missing.statusCode);
        expect(res.body).toBe(missing.body);
      }
      expect(await prisma.redactionVersion.count({ where: { projectId } })).toBe(versions);
      expect(await prisma.redactionRegion.count({ where: { versionId } })).toBe(regions);
      expect((await prisma.redactionVersion.findUniqueOrThrow({ where: { id: versionId } })).state).toBe("DRAFT");

      // POSITIVE: the same region write from the listed author lands.
      const landed = await kit.call("POST", `/v1/redaction/versions/${versionId}/regions`, listedAdmin, {
        kind: "BBOX_NORMALIZED",
        method: "BLACKOUT",
        geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      });
      expect(landed.statusCode, landed.body).toBeLessThan(300);
      const regionId = landed.json().regionId as string;
      const removed = await kit.call("DELETE", `/v1/redaction/regions/${regionId}`, offListAdmin);
      const removedMissing = await kit.call("DELETE", `/v1/redaction/regions/${randomUUID()}`, offListAdmin);
      expect(removed.statusCode, removed.body).toBe(removedMissing.statusCode);
      expect(removed.body).toBe(removedMissing.body);
      expect(await prisma.redactionRegion.count({ where: { id: regionId } })).toBe(1);
    });

    it("a bulk decision on a version the caller may work cannot reach a detection of a closed record", async () => {
      const detection = await prisma.redactionDetection.create({
        data: {
          versionId,
          teamId: tenant.workspaceId,
          provider: "MANUAL",
          kind: "FACE",
          rawConfidence: 0.9,
          confidenceBand: "HIGH",
          suggestedRegionKind: "BBOX_NORMALIZED",
          suggestedRegionGeometry: { x: 0, y: 0, width: 0.1, height: 0.1 },
          suggestedMethod: "BLACKOUT",
          decisionState: "SUGGESTED",
        } as never,
        select: { id: true },
      });
      const version = await kit.call("POST", `/v1/redaction/projects/${openProjectId}/versions`, offListAdmin, {});
      expect(version.statusCode, version.body).toBe(201);
      const res = await kit.call("POST", `/v1/redaction/versions/${version.json().versionId}/decisions/bulk`, offListAdmin, {
        rows: [{ detectionId: detection.id, decisionState: "ACCEPTED" }],
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().outcomes).toEqual([expect.objectContaining({ outcome: "NOT_FOUND", denial: "DETECTION_NOT_FOUND" })]);
      expect((await prisma.redactionDetection.findUniqueOrThrow({ where: { id: detection.id } })).decisionState).toBe("SUGGESTED");
      const direct = await kit.call("POST", `/v1/redaction/detections/${detection.id}/decision`, offListAdmin, { decisionState: "ACCEPTED" });
      expect(direct.statusCode, direct.body).toBe(409);
      expect(direct.json()).toEqual({ denial: "DETECTION_NOT_FOUND" });
      expect((await prisma.redactionDetection.findUniqueOrThrow({ where: { id: detection.id } })).decisionState).toBe("SUGGESTED");
    });

    it("the workspace summary counts only what the caller may open", async () => {
      await prisma.redactionVersion.update({ where: { id: versionId }, data: { state: "PUBLISHED" } });
      const seen = await kit.call("GET", "/v1/redaction/workspace/summary", listedAdmin);
      const off = await kit.call("GET", "/v1/redaction/workspace/summary", offListAdmin);
      expect(seen.json().summary.publishedCount).toBe(1);
      expect(off.json().summary.publishedCount).toBe(0);
    });
  });
});
