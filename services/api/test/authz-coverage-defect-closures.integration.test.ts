/* eslint-disable @typescript-eslint/no-explicit-any -- rows of many shapes. */
/**
 * The defects the coverage round found, each on real rows: an authorized request
 * beside every refusal, and the row checked afterwards, not only the status.
 *
 * Proven elsewhere, so not repeated: the API key on a restricted evidence request
 * (cov-token-gated-routes), the billing admin and the audit trail
 * (org-persona-authorization-matrix), step-up with a null resource and the adaptive
 * gate (acceptance-repairs), a redaction project read off the list (cov-page-apis).
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { coverageKit, type CoverageKit, type Person } from "./support/coverage-actors.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";
import { RowFactory, RowSet, type Tenant } from "./support/write-sweep-engine.js";
import { enterpriseTenantMaker } from "./support/write-sweep-world.js";

describe("coverage defect closures (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: any;
  let kit: CoverageKit;
  let stepUp: ReturnType<typeof createStepUpCeremony>;
  let mine: Tenant;
  let other: Tenant;
  let factory: RowFactory;
  let hdr: (t: Tenant) => Record<string, string>;

  const rows = (t: Tenant) => new RowSet(factory, prisma, t);

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma;
    kit = await coverageKit(h);
    stepUp = createStepUpCeremony({ prisma, inject: h.app.inject.bind(h.app) as never });
    factory = new RowFactory(prisma);
    const make = await enterpriseTenantMaker(h);
    mine = await make();
    other = await make();
    hdr = (t) => ({ "x-proovra-workspace-id": t.teamId });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  describe("a session revocation", () => {
    const stepUpFor = async (actor: Person, teamId: string, userId: string) =>
      stepUp.approvedHeader({
        token: actor.token,
        userId: actor.id,
        teamId,
        purpose: "CONTRIBUTOR_SESSION_REVOKE",
        resourceKind: "user",
        resourceId: userId,
      });

    it("a person of another tenant is out of reach, even behind a real step-up", async () => {
      const before = await prisma.revokedSession.count({ where: { userId: other.member.id } });
      const res = await kit.call(
        "POST",
        "/v1/identity-security/sessions/revoke-all",
        mine.owner,
        { teamId: mine.teamId, userId: other.member.id },
        { ...hdr(mine), ...(await stepUpFor(mine.owner, mine.teamId, other.member.id)) },
      );
      expect(res.statusCode, res.body).toBe(404);
      expect(await prisma.revokedSession.count({ where: { userId: other.member.id } })).toBe(before);
      expect((await kit.call("GET", "/v1/auth/me", other.member)).statusCode).toBe(200);
    });

    it("a former member is out of reach: their sessions in other tenants are not this workspace's to end", async () => {
      const former = await kit.person(mine.teamId, "MEMBER");
      await prisma.teamMember.updateMany({ where: { teamId: mine.teamId, userId: former.id }, data: { status: "REVOKED" } });
      for (const url of ["/v1/identity-security/sessions/revoke-all", `/v1/admin/identity/sessions/user/${former.id}/revoke-all`]) {
        const res = await kit.call(
          "POST",
          url,
          mine.owner,
          { teamId: mine.teamId, userId: former.id },
          { ...hdr(mine), ...(await stepUpFor(mine.owner, mine.teamId, former.id)) },
        );
        expect(res.statusCode, `${url} ${res.body}`).toBe(404);
      }
      expect(await prisma.revokedSession.count({ where: { userId: former.id } })).toBe(0);
    });

    it("this door asks the same re-proof as the admin console's, and then lands", async () => {
      const person = await kit.person(mine.teamId, "MEMBER");
      const body = { teamId: mine.teamId, userId: person.id };
      const bare = await kit.call("POST", "/v1/identity-security/sessions/revoke-all", mine.owner, body, hdr(mine));
      expect(bare.statusCode, bare.body).toBe(401);
      expect(bare.json().error.code).toBe("STEP_UP_REQUIRED");
      expect(await prisma.revokedSession.count({ where: { userId: person.id } })).toBe(0);

      const done = await kit.call(
        "POST",
        "/v1/identity-security/sessions/revoke-all",
        mine.owner,
        body,
        { ...hdr(mine), ...(await stepUpFor(mine.owner, mine.teamId, person.id)) },
      );
      expect(done.statusCode, done.body).toBe(200);
      expect(await prisma.revokedSession.count({ where: { userId: person.id, scope: "ALL_FOR_USER" } })).toBe(1);
    });
  });

  it("redaction frames: another tenant's record gets none, one's own does", async () => {
    const theirs = await rows(other).id("Evidence");
    const own = await rows(mine).id("Evidence");
    const body = { extractor: "OPERATOR_INLINE", frames: [{ frameIndex: 0, timestampMs: 0 }] };
    const refused = await kit.call("POST", `/v1/redaction/videos/${theirs}/frames/batch?teamId=${mine.teamId}`, mine.owner, body, hdr(mine));
    expect(refused.statusCode, refused.body).toBe(404);
    expect(await prisma.videoFrame.count({ where: { evidenceId: theirs } })).toBe(0);

    const done = await kit.call("POST", `/v1/redaction/videos/${own}/frames/batch?teamId=${mine.teamId}`, mine.owner, body, hdr(mine));
    expect(done.statusCode, done.body).toBeLessThan(300);
    expect(await prisma.videoFrame.count({ where: { evidenceId: own } })).toBe(1);
  });

  it("SIU: a VIEWER writes nothing on a case; an OWNER writes the same request", async () => {
    const caseId = await rows(mine).id("Case");
    const body = { claimType: "auto" };
    const refused = await kit.call("PUT", `/v1/cases/${caseId}/siu-profile`, mine.viewer, body, hdr(mine));
    expect(refused.statusCode, refused.body).toBe(403);
    expect(await prisma.caseSiuProfile.count({ where: { caseId } })).toBe(0);

    const done = await kit.call("PUT", `/v1/cases/${caseId}/siu-profile`, mine.owner, body, hdr(mine));
    expect(done.statusCode, done.body).toBeLessThan(300);
    expect(await prisma.caseSiuProfile.count({ where: { caseId } })).toBe(1);
  });

  describe("a restricted case, for an admin off its list", () => {
    let off: Person;
    let listed: Person;

    beforeAll(async () => {
      off = await kit.person(mine.teamId, "ADMIN");
      listed = await kit.person(mine.teamId, "ADMIN");
    });

    const restricted = async () => {
      const set = rows(mine);
      const caseId = (await set.id("Case")) as string;
      await prisma.case.update({ where: { id: caseId }, data: { restrictedAtUtc: new Date() } });
      await prisma.caseAccess.create({ data: { caseId, userId: listed.id } });
      return { set, caseId };
    };

    it("cannot unlink it from the workspace, and the case stays; a listed admin reaches the same route", async () => {
      const { caseId } = await restricted();
      const refused = await kit.call("DELETE", `/v1/teams/${mine.teamId}/cases/${caseId}`, off, undefined, hdr(mine));
      expect(refused.statusCode, refused.body).toBe(404);
      expect((await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).teamId).toBe(mine.teamId);

      const reached = await kit.call("DELETE", `/v1/teams/${mine.teamId}/cases/${caseId}`, listed, undefined, hdr(mine));
      expect(reached.statusCode, reached.body).not.toBe(404);
    });

    it("cannot resume a paused review on it; the holder can, and the hold ends", async () => {
      const { set, caseId } = await restricted();
      const evidenceId = (await set.id("Evidence")) as string;
      await prisma.caseEvidenceLink.create({ data: { caseId, evidenceId, teamId: mine.teamId } });
      const workflow = await prisma.evidenceReviewWorkflow.create({
        data: {
          evidenceId,
          teamId: mine.teamId,
          workspaceType: "TEAM",
          status: "IN_REVIEW",
          assignedToUserId: listed.id,
          slaPausedAtUtc: new Date(),
        },
      });
      const url = `/v1/reviewer-ops/reviews/${workflow.id}/resume`;
      const body = { teamId: mine.teamId, note: "resuming" };

      const offList = await kit.call("POST", url, off, body, hdr(mine));
      expect(offList.statusCode, offList.body).toBe(404);
      const foreign = await kit.call("POST", url, other.owner, { ...body, teamId: other.teamId }, hdr(other));
      expect(foreign.statusCode, foreign.body).toBe(404);
      const viewer = await kit.call("POST", url, mine.viewer, body, hdr(mine));
      expect(viewer.statusCode, viewer.body).toBeGreaterThanOrEqual(403);
      expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: workflow.id } })).slaPausedAtUtc).not.toBeNull();

      const done = await kit.call("POST", url, listed, body, hdr(mine));
      expect(done.statusCode, done.body).toBe(200);
      expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: workflow.id } })).slaPausedAtUtc).toBeNull();
    });
  });

  describe("found by the write sweep's second round", () => {

    it("a bulk review leaves no event on another tenant's workflow; the same request on one's own does", async () => {
      const theirs = rows(other);
      const foreignEvidence = (await theirs.id("Evidence")) as string;
      const foreign = await prisma.evidenceReviewWorkflow.create({
        data: { evidenceId: foreignEvidence, teamId: other.teamId, workspaceType: "TEAM", status: "NOT_STARTED" },
      });
      const own = rows(mine);
      const ownEvidence = (await own.id("Evidence")) as string;
      await prisma.evidenceReviewWorkflow.create({
        data: { evidenceId: ownEvidence, teamId: mine.teamId, workspaceType: "TEAM", status: "NOT_STARTED" },
      });
      const send = (evidenceIds: string[]) =>
        kit.call(
          "POST",
          "/v1/review-operations/bulk",
          mine.owner,
          { teamId: mine.teamId, evidenceIds, action: "ASSIGN", assignedToUserId: mine.owner.id },
          hdr(mine),
        );
      // A foreign id first: the breadcrumb used to land on whatever the first id named.
      const mixed = await send([foreignEvidence, ownEvidence]);
      expect(mixed.statusCode, mixed.body).toBe(200);
      expect(mixed.json().result).toMatchObject({ succeeded: 1, failed: 1 });
      expect(await prisma.evidenceReviewWorkflowEvent.count({ where: { workflowId: foreign.id } })).toBe(0);
      expect(
        await prisma.evidenceReviewWorkflowEvent.count({
          where: { workflow: { evidenceId: ownEvidence }, eventType: "BULK_ACTION" },
        }),
      ).toBe(1);
    });

    it("a rule names only someone of its workspace, on create and on update", async () => {
      const body = (userId: string) => ({
        teamId: mine.teamId,
        name: `rule ${kit.tag()}`,
        triggerType: "EVIDENCE_CREATED",
        actionType: "NOTIFY_USER",
        actionConfigJson: { userId, template: "sweep" },
      });
      const refused = await kit.call("POST", "/v1/automation/rules", mine.owner, body(other.member.id), hdr(mine));
      expect(refused.statusCode, refused.body).toBe(400);
      expect(refused.json().code).toBe("NOT_A_MEMBER");
      const before = await prisma.automationRule.count({ where: { teamId: mine.teamId } });

      const created = await kit.call("POST", "/v1/automation/rules", mine.owner, body(mine.member.id), hdr(mine));
      expect(created.statusCode, created.body).toBe(201);
      expect(await prisma.automationRule.count({ where: { teamId: mine.teamId } })).toBe(before + 1);

      const id = created.json().id;
      const edited = await kit.call(
        "PATCH",
        `/v1/automation/rules/${id}`,
        mine.owner,
        { teamId: mine.teamId, actionConfigJson: { userId: other.member.id, template: "sweep" } },
        hdr(mine),
      );
      expect(edited.statusCode, edited.body).toBe(400);
      const row = await prisma.automationRule.findUniqueOrThrow({ where: { id } });
      expect((row.actionConfigJson as { userId: string }).userId).toBe(mine.member.id);
    });

    it("a preference is written only for someone of this workspace", async () => {
      const body = (userId: string) => ({ teamId: mine.teamId, target: { kind: "user", userId }, smsOptOut: true });
      const refused = await kit.call("POST", "/v1/communications/preferences", mine.owner, body(other.member.id), hdr(mine));
      expect(refused.statusCode, refused.body).toBe(404);
      expect(await prisma.communicationPreference.count({ where: { userId: other.member.id } })).toBe(0);
      const done = await kit.call("POST", "/v1/communications/preferences", mine.owner, body(mine.member.id), hdr(mine));
      expect(done.statusCode, done.body).toBe(200);
      expect(await prisma.communicationPreference.count({ where: { teamId: mine.teamId, userId: mine.member.id } })).toBe(1);
    });

    it("a transfer closes only on this workspace's own package", async () => {
      const own = rows(mine);
      const evidenceId = (await own.id("Evidence")) as string;
      const transfer = await prisma.chainTransfer.create({
        data: {
          teamId: mine.teamId,
          fromOrganizationId: mine.orgId,
          toOrganizationId: other.orgId,
          toOrganizationSlug: "recipient",
          evidenceIds: [evidenceId],
          state: "ACCEPTED",
          initiatedByUserId: mine.owner.id,
        },
      });
      const foreignPackage = (await rows(other).id("EvidenceExchangePackage")) as string;
      const ownPackage = (await own.id("EvidenceExchangePackage")) as string;
      const url = `/v1/exchange/chain-transfers/${transfer.id}/complete`;
      const refused = await kit.call("POST", url, mine.owner, { packageId: foreignPackage }, hdr(mine));
      expect(refused.statusCode, refused.body).toBe(409);
      const after = await prisma.chainTransfer.findUniqueOrThrow({ where: { id: transfer.id } });
      expect(after).toMatchObject({ state: "ACCEPTED", packageId: null });

      const done = await kit.call("POST", url, mine.owner, { packageId: ownPackage }, hdr(mine));
      expect(done.statusCode, done.body).toBe(200);
      expect(await prisma.chainTransfer.findUniqueOrThrow({ where: { id: transfer.id } })).toMatchObject({ state: "COMPLETED", packageId: ownPackage });
    });

    it("a restricted unlinked case stays closed to an admin off its list; its owner links it", async () => {
      const off = await kit.person(mine.teamId, "ADMIN");
      const name = `link ${kit.tag()}`;
      const row = await prisma.case.create({
        data: { name, ownerUserId: mine.member.id, teamId: null, restrictedAtUtc: new Date() },
      });
      const url = `/v1/teams/${mine.teamId}/cases/link`;
      const refused = await kit.call("POST", url, off, { caseId: row.id }, hdr(mine));
      expect(refused.statusCode, refused.body).toBe(404);
      expect(refused.body).not.toContain(name);
      expect((await prisma.case.findUniqueOrThrow({ where: { id: row.id } })).teamId).toBeNull();

      const done = await kit.call("POST", url, mine.member, { caseId: row.id }, hdr(mine));
      expect(done.statusCode, done.body).toBe(200);
      expect((await prisma.case.findUniqueOrThrow({ where: { id: row.id } })).teamId).toBe(mine.teamId);
    });

    it("two tenants can each hold the same vendor, and the seed runs for both", async () => {
      for (const t of [mine, other]) {
        const seeded = await kit.call("POST", `/v1/trust/subprocessors/seed?teamId=${t.teamId}`, t.owner, {}, hdr(t));
        expect(seeded.statusCode, seeded.body).toBe(200);
      }
      const shared = await prisma.subprocessor.findFirstOrThrow({ where: { teamId: mine.teamId } });
      expect(await prisma.subprocessor.count({ where: { name: shared.name } })).toBe(2);
    });
  });

  it("a random id answers as a refusal too, so the 404s above are not a missing fixture", async () => {
    const res = await kit.call("POST", `/v1/redaction/videos/${randomUUID()}/frames/batch?teamId=${mine.teamId}`, mine.owner, {
      extractor: "OPERATOR_INLINE",
      frames: [{ frameIndex: 0, timestampMs: 0 }],
    }, hdr(mine));
    expect(res.statusCode).toBe(404);
  });
});
