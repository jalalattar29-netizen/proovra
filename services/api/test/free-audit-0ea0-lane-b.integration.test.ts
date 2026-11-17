/* eslint-disable @typescript-eslint/no-explicit-any -- JSON response bodies of many shapes. */
/**
 * FREE-USER AUDIT 0ea0 — closure lane B (live PostgreSQL, real routes).
 *
 * What a workspace keeps, and what it may still do, after it loses a paid
 * capability. Each row follows the owner's directive:
 *
 *   B3B-F-104  the server contract the web's manage-only Intake Links mode
 *              relies on: after a downgrade the scoped list and revoke stay
 *              open under the object and actor rules (A1-06); create and
 *              resend stay refused on the plan.
 *   B3B-F-305  an External Review grant issued while entitled is honoured
 *              through its own expiry or earlier revocation; new grants and
 *              renewals ask the current entitlement; expiry, revocation and
 *              closure still end it; re-upgrade renews again.
 *   B3C-F-007  existing cases after a downgrade: read, delete and access
 *              revocation stay open; creation and paid case edits / workflow
 *              writes ask the current Cases entitlement (`casesIncluded`).
 *   B3C-F-008  discussion vs reviewer operations: ordinary discussion stays
 *              open on reachable records; assign / escalate and the review-kind
 *              thread workflow ask the review ladder.
 *   B7B-F05    webhooks after a downgrade: manual retry and lifecycle replay ask
 *              FEATURE_WEBHOOKS; already-ACTIVE endpoints and removal are left
 *              alone (F-15); the endpoint ceiling counts lifecycle endpoints
 *              only, as the contract defines it.
 *   B7B-F06    governance automation asks FEATURE_GOVERNANCE_PLATFORM (create,
 *              re-author, enable, and the queued executor); Trust Center
 *              authoring asks FEATURE_TRUST_CENTER on every authoring route.
 *
 * Every refusal checks the status, the body and that nothing was written; every
 * gate has a positive control. Every workspace here is created by this file.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { coverageKit, type CoverageKit, type Person } from "./support/coverage-actors.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";

type Prisma = (typeof import("../src/db.js"))["prisma"];
type Tenant = { teamId: string; orgId: string; owner: Person };
type Plan = "FREE" | "PRO" | "TEAM" | "ENTERPRISE";

const DAY = 86_400_000;

describe("free-audit 0ea0 — lane B: what survives a downgrade (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let kit: CoverageKit;
  let stepUp: ReturnType<typeof createStepUpCeremony>;
  let grants: typeof import("../src/services/external-review/external-review-grant.service.js");
  let invitations: typeof import("../src/services/external-review/portal-invitation.service.js");
  let entitlements: typeof import("../src/services/packaging/entitlement.service.js");
  let lifecycleWebhooks: typeof import("../src/services/packaging/webhooks/webhook-platform.service.js");
  let runtime: typeof import("../src/services/automation/automation-dispatch-runtime.service.js");
  let discussion: typeof import("../src/services/collaboration/discussion.service.js");
  let contracts: typeof import("../src/services/organization/enterprise-contract.service.js");
  let closure: typeof import("../src/services/workspace/workspace-closure.service.js");
  let intake: typeof import("../src/services/workflow-intake-link.service.js");

  const tag = () => randomUUID().slice(0, 8);
  const ws = (teamId: string) => ({ "x-proovra-workspace-id": teamId });
  const call = (method: string, url: string, who: Person | null, payload?: unknown, headers?: Record<string, string>) =>
    kit.call(method, url, who, payload, headers);
  const setPlan = (teamId: string, plan: Plan) =>
    prisma.team.update({ where: { id: teamId }, data: { billingPlan: plan, billingStatus: "ACTIVE" } as never });

  async function tenant(plan: Plan, opts: { contract?: boolean } = {}): Promise<Tenant> {
    const owner = await kit.person(null);
    const org = await prisma.organization.create({
      data: { name: `lb-${tag()}`, billingOwnerUserId: owner.id, status: "ACTIVE", kind: "CUSTOMER" } as never,
      select: { id: true },
    });
    await prisma.organizationMembership.create({
      data: { organizationId: org.id, userId: owner.id, role: "ORG_OWNER" } as never,
    });
    const team = await prisma.team.create({
      data: {
        name: `lb-${tag()}`,
        ownerUserId: owner.id,
        isPersonal: false,
        organizationId: org.id,
        workspaceKind: "ORGANIZATION",
        billingPlan: plan,
        billingStatus: "ACTIVE",
      } as never,
      select: { id: true },
    });
    await prisma.organizationSecurityPolicy.create({ data: { organizationId: org.id, teamId: team.id } as never });
    await prisma.teamMember.create({ data: { teamId: team.id, userId: owner.id, role: "OWNER", status: "ACTIVE" } as never });
    await prisma.user.update({ where: { id: owner.id }, data: { currentWorkspaceId: team.id } as never });
    if (opts.contract) {
      await contracts.upsertEnterpriseContract(prisma as never, {
        organizationId: org.id,
        status: "ACTIVE",
        activationState: "ACTIVATED",
        seatCount: 25,
      } as never);
    }
    return { teamId: team.id, orgId: org.id, owner };
  }

  async function record(t: Tenant, title = `rec-${tag()}`): Promise<string> {
    return (
      await prisma.evidence.create({
        data: {
          title,
          displayFileName: `${title}.pdf`,
          type: "PHOTO",
          status: "SIGNED",
          teamId: t.teamId,
          organizationId: t.orgId,
          ownerUserId: t.owner.id,
          sizeBytes: 1_000n,
        } as never,
        select: { id: true },
      })
    ).id;
  }

  beforeAll(async () => {
    process.env.INTEGRATIONS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_LINKS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_TOKEN_SECRET = randomBytes(32).toString("hex");
    process.env.API_KEY_SECRET = process.env.API_KEY_SECRET ?? randomBytes(32).toString("hex");
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    kit = await coverageKit(h);
    stepUp = createStepUpCeremony({
      prisma: prisma as never,
      inject: (o) => h.app.inject({ method: o.method, url: o.url, headers: o.headers, payload: o.payload as never }) as never,
    });
    grants = await import("../src/services/external-review/external-review-grant.service.js");
    invitations = await import("../src/services/external-review/portal-invitation.service.js");
    entitlements = await import("../src/services/packaging/entitlement.service.js");
    lifecycleWebhooks = await import("../src/services/packaging/webhooks/webhook-platform.service.js");
    runtime = await import("../src/services/automation/automation-dispatch-runtime.service.js");
    discussion = await import("../src/services/collaboration/discussion.service.js");
    contracts = await import("../src/services/organization/enterprise-contract.service.js");
    closure = await import("../src/services/workspace/workspace-closure.service.js");
    intake = await import("../src/services/workflow-intake-link.service.js");
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  // ===========================================================================
  // B3B-F-104 — standing intake links after a downgrade (server side of the
  // web's manage-only mode)
  // ===========================================================================
  describe("B3B-F-104 — standing intake links stay listable and revocable after a downgrade; creation does not", () => {
    const mintLink = async (t: Tenant) =>
      (await intake.createWorkflowIntakeLink(
        {
          teamId: t.teamId,
          workflowTemplateSlug: "general-evidence-record",
          intakeMode: "EXTERNAL_REUSABLE",
          recipientLabel: "lane-b",
          maxUses: 5,
          expiresAtUtc: new Date(Date.now() + DAY),
        } as never,
        { actorUserId: t.owner.id },
      )) as unknown as { link: { id: string } };
    const linkStatus = async (id: string) =>
      (await prisma.workflowIntakeLink.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

    it("downgraded owner: list and revoke answer; a new link is refused; a viewer and a foreign owner are refused and change nothing", async () => {
      const t = await tenant("TEAM");
      const viewer = await kit.person(t.teamId, "VIEWER");
      const foreign = await tenant("TEAM");
      const standing = (await mintLink(t)).link.id;
      const second = (await mintLink(t)).link.id;
      await setPlan(t.teamId, "FREE");

      const list = await call("GET", `/v1/workflow/intake-links?teamId=${t.teamId}&archiveScope=all`, t.owner);
      expect(list.statusCode, list.body).toBe(200);
      expect(JSON.stringify(list.json())).toContain(standing);

      const create = await call("POST", "/v1/workflow/intake-links", t.owner, {
        teamId: t.teamId,
        workflowTemplateSlug: "general-evidence-record",
        intakeMode: "EXTERNAL_REUSABLE",
        maxUses: 1,
        expiresAtUtc: new Date(Date.now() + DAY).toISOString(),
      });
      expect(create.statusCode, create.body).toBe(409);
      expect(JSON.stringify(create.json())).toContain("INTAKE_NOT_INCLUDED");
      expect(await prisma.workflowIntakeLink.count({ where: { teamId: t.teamId } })).toBe(2);

      const byViewer = await call("POST", `/v1/workflow/intake-links/${second}/revoke`, viewer, {});
      expect([403, 404]).toContain(byViewer.statusCode);
      const byForeign = await call("POST", `/v1/workflow/intake-links/${second}/revoke`, foreign.owner, {});
      expect([403, 404]).toContain(byForeign.statusCode);
      expect(await linkStatus(second)).toBe("ACTIVE");

      const revoke = await call("POST", `/v1/workflow/intake-links/${standing}/revoke`, t.owner, {});
      expect(revoke.statusCode, revoke.body).toBe(200);
      expect(await linkStatus(standing)).toBe("REVOKED");
      // A link already revoked stays revoked; asking again changes nothing.
      const again = await call("POST", `/v1/workflow/intake-links/${standing}/revoke`, t.owner, {});
      expect(again.statusCode).toBeLessThan(500);
      expect(await linkStatus(standing)).toBe("REVOKED");
    });
  });

  // ===========================================================================
  // B3B-F-305 — External Review grants after a downgrade
  // ===========================================================================
  describe("B3B-F-305 — an issued External Review grant is honoured to its own end", () => {
    async function invite(t: Tenant, evidenceId: string, expiresInDays = 3) {
      const issued = await invitations.issueInvitation({
        teamId: t.teamId,
        invitedByUserId: t.owner.id,
        reviewerEmail: `lb-reviewer-${tag()}@outside.test`,
        role: "EXTERNAL_REVIEWER",
        mfaRequired: false,
        scope: { kind: "EVIDENCE", evidenceId },
        expiresAtUtc: new Date(Date.now() + expiresInDays * DAY).toISOString(),
      });
      if (!issued.ok) throw new Error(`invitation refused: ${issued.denial}`);
      return issued;
    }
    const lookup = (rawToken: string) =>
      grants.lookupExternalReviewGrantByToken(rawToken, prisma as never, { acceptInvited: true, deferAcceptance: true });
    const grantRow = (id: string) =>
      prisma.externalReviewGrant.findUniqueOrThrow({ where: { id }, select: { expiresAtUtc: true, state: true } });
    const renew = async (t: Tenant, grantId: string, withStepUp: boolean) =>
      call(
        "POST",
        `/v1/external-review/grants/${grantId}/renew`,
        t.owner,
        { teamId: t.teamId, days: 20 },
        withStepUp
          ? await stepUp.approvedHeader({
              token: t.owner.token,
              userId: t.owner.id,
              teamId: t.teamId,
              purpose: "EXTERNAL_REVIEW_GRANT_ISSUE",
              resourceKind: "external_review_grant",
              resourceId: grantId,
            })
          : {},
      );

    it("downgrade: the existing grant keeps resolving; a new grant and a renewal are refused and write nothing; re-upgrade renews", async () => {
      const t = await tenant("TEAM");
      const subject = await record(t);
      const issued = await invite(t, subject);
      await setPlan(t.teamId, "FREE");

      // Honoured: the token issued while entitled still resolves.
      expect((await lookup(issued.rawToken)).ok).toBe(true);

      // A NEW grant asks the current entitlement: refused before step-up, nothing written.
      const before = await prisma.externalReviewGrant.count({ where: { teamId: t.teamId } });
      const fresh = await call("POST", "/v1/external-review/grants", t.owner, {
        teamId: t.teamId,
        scopeKind: "EVIDENCE",
        evidenceId: subject,
        reviewerEmail: `lb-new-${tag()}@outside.test`,
      });
      expect(fresh.statusCode, fresh.body).toBe(403);
      expect(fresh.json()).toMatchObject({ denial: "ENTITLEMENT_REQUIRED", entitlement: "EXTERNAL_REVIEW" });
      expect(await prisma.externalReviewGrant.count({ where: { teamId: t.teamId } })).toBe(before);

      // EXTENDING the expiry asks it too.
      const expiryBefore = (await grantRow(issued.grantId)).expiresAtUtc;
      const renewed = await renew(t, issued.grantId, false);
      expect(renewed.statusCode, renewed.body).toBe(403);
      expect(renewed.json()).toMatchObject({ denial: "ENTITLEMENT_REQUIRED", entitlement: "EXTERNAL_REVIEW" });
      expect((await grantRow(issued.grantId)).expiresAtUtc).toEqual(expiryBefore);
      // Still honoured after the refused renewal.
      expect((await lookup(issued.rawToken)).ok).toBe(true);

      // Re-upgrade: renewal is offered again (with its step-up).
      await setPlan(t.teamId, "TEAM");
      const again = await renew(t, issued.grantId, true);
      expect(again.statusCode, again.body).toBe(200);
      expect((await grantRow(issued.grantId)).expiresAtUtc.getTime()).toBeGreaterThan(expiryBefore.getTime());
    });

    it("expiry and revocation still end a downgraded workspace's grant; revoke stays open without the entitlement", async () => {
      const t = await tenant("TEAM");
      const expiring = await invite(t, await record(t));
      const revoking = await invite(t, await record(t));
      await setPlan(t.teamId, "FREE");

      // Time passes: the grant reaches its own expiry (created two days ago).
      await prisma.externalReviewGrant.update({
        where: { id: expiring.grantId },
        data: { createdAtUtc: new Date(Date.now() - 2 * DAY), expiresAtUtc: new Date(Date.now() - 60_000) } as never,
      });
      expect(await lookup(expiring.rawToken)).toEqual({ ok: false, reason: "grant_expired" });

      const revoke = await call("POST", `/v1/external-review/grants/${revoking.grantId}/revoke`, t.owner, { teamId: t.teamId });
      expect(revoke.statusCode, revoke.body).toBe(200);
      expect((await grantRow(revoking.grantId)).state).toBe("REVOKED");
      expect(await lookup(revoking.rawToken)).toEqual({ ok: false, reason: "grant_revoked" });
    });

    it("closure ends a downgraded workspace's grant like a revoked one", async () => {
      const t = await tenant("TEAM");
      const issued = await invite(t, await record(t));
      await setPlan(t.teamId, "FREE");
      expect((await lookup(issued.rawToken)).ok).toBe(true);
      await prisma.team.update({ where: { id: t.teamId }, data: { closedAtUtc: new Date() } as never });
      expect(await lookup(issued.rawToken)).toEqual({ ok: false, reason: "grant_not_active" });
    });
  });

  // ===========================================================================
  // B3C-F-007 — existing cases after a downgrade
  // ===========================================================================
  describe("B3C-F-007 — existing cases: reads and safety actions stay, paid case writes ask casesIncluded", () => {
    let t: Tenant;
    let admin: Person;
    let viewer: Person;
    let outsider: Person;
    let caseId: string;
    let linked: string;
    let spare: string;
    const notIncluded = (res: { statusCode: number; json: () => any }) => {
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "CASES_NOT_INCLUDED", error: { code: "CASES_NOT_INCLUDED" } });
    };
    const caseRow = () =>
      prisma.case.findUniqueOrThrow({ where: { id: caseId }, select: { name: true, status: true, restrictedAtUtc: true } });

    beforeAll(async () => {
      t = await tenant("TEAM");
      [admin, viewer, outsider] = await Promise.all([
        kit.person(t.teamId, "ADMIN"),
        kit.person(t.teamId, "VIEWER"),
        kit.person(null),
      ]);
      // Created while entitled, through the real route.
      const created = await call("POST", "/v1/cases", t.owner, { name: `matter-${tag()}`, teamId: t.teamId });
      expect(created.statusCode, created.body).toBe(201);
      caseId = (created.json().case?.id ?? created.json().id) as string;
      linked = await record(t);
      spare = await record(t);
      const link = await call("POST", `/v1/cases/${caseId}/evidence-links`, t.owner, { evidenceId: linked });
      expect(link.statusCode, link.body).toBe(200);
      await setPlan(t.teamId, "FREE");
    }, 300_000);

    it("direct case writes are refused with the create route's code and change nothing", async () => {
      const before = await caseRow();
      const comments = await prisma.caseComment.count({ where: { caseId } });
      const links = await prisma.caseEvidenceLink.count({ where: { caseId } });
      const accessRows = await prisma.caseAccess.count({ where: { caseId } });

      // Creation (the existing gate, unchanged: its flat body).
      const create = await call("POST", "/v1/cases", t.owner, { name: `new-${tag()}`, teamId: t.teamId });
      expect(create.statusCode, create.body).toBe(409);
      expect(create.json().code).toBe("CASES_NOT_INCLUDED");
      notIncluded(await call("PATCH", `/v1/cases/${caseId}`, t.owner, { name: "renamed after downgrade" }));
      notIncluded(await call("POST", `/v1/cases/${caseId}/status`, t.owner, { toStatus: "INVESTIGATING" }));
      notIncluded(await call("POST", `/v1/cases/${caseId}/comments`, t.owner, { body: "a note" }));
      notIncluded(await call("POST", `/v1/cases/${caseId}/evidence-links`, t.owner, { evidenceId: spare }));
      notIncluded(await call("POST", `/v1/cases/${caseId}/evidence`, t.owner, { evidenceId: spare }));
      notIncluded(await call("DELETE", `/v1/cases/${caseId}/evidence/${linked}`, t.owner));
      notIncluded(await call("POST", `/v1/cases/${caseId}/access`, t.owner, { userId: admin.id }));
      notIncluded(await call("POST", `/v1/cases/${caseId}/share-team`, t.owner, { userId: admin.id }));
      const bulk = await call("POST", "/v1/cases/bulk", t.owner, { ids: [caseId], action: "RESOLVE" });
      expect(bulk.statusCode, bulk.body).toBe(200);
      expect(bulk.json().results).toEqual([{ id: caseId, outcome: "SKIPPED", reason: "CASES_NOT_INCLUDED" }]);

      expect(await caseRow()).toEqual(before);
      expect(await prisma.caseComment.count({ where: { caseId } })).toBe(comments);
      expect(await prisma.caseEvidenceLink.count({ where: { caseId } })).toBe(links);
      expect(await prisma.caseAccess.count({ where: { caseId } })).toBe(accessRows);
    });

    it("actor and object checks still answer first: a Viewer is refused as before, an outsider sees a missing case", async () => {
      const byViewer = await call("PATCH", `/v1/cases/${caseId}`, viewer, { name: "viewer rename" });
      expect(byViewer.statusCode, byViewer.body).toBe(403);
      expect(byViewer.json().code).toBe("CASE_RENAME_DENIED");
      const comment = await call("POST", `/v1/cases/${caseId}/comments`, viewer, { body: "viewer note" });
      expect(comment.statusCode, comment.body).toBe(403);
      const foreign = await call("PATCH", `/v1/cases/${caseId}`, outsider, { name: "outsider rename" });
      expect(foreign.statusCode, foreign.body).toBe(404);
    });

    it("retained: the case reads, the workspace says which writes the plan withholds, and access revocation stays open", async () => {
      const read = await call("GET", `/v1/cases/${caseId}`, t.owner);
      expect(read.statusCode, read.body).toBe(200);
      const matter = await call("GET", `/v1/cases/${caseId}/matter-workspace`, t.owner);
      expect(matter.statusCode, matter.body).toBe(200);
      const v = matter.json().viewer;
      expect(v).toMatchObject({
        canComment: false,
        canChangeStatus: false,
        canLinkEvidence: false,
        canUnlinkEvidence: false,
        canRename: false,
        canDelete: true,
        canManageAccess: true,
      });
      expect(v.disabledReasons.comment).toMatch(/not included in this workspace's current plan/);

      // An access row granted before the downgrade can still be withdrawn.
      const access = await prisma.caseAccess.create({ data: { caseId, userId: admin.id } });
      await prisma.case.update({ where: { id: caseId }, data: { restrictedAtUtc: new Date() } });
      const revoke = await call("DELETE", `/v1/cases/${caseId}/access/${access.id}`, t.owner);
      expect(revoke.statusCode, revoke.body).toBe(204);
      expect(await prisma.caseAccess.count({ where: { id: access.id } })).toBe(0);
    });

    it("deletion stays open after the downgrade (subject to its step-up)", async () => {
      const doomed = await prisma.case.create({
        data: { name: `doomed-${tag()}`, teamId: t.teamId, ownerUserId: t.owner.id } as never,
        select: { id: true },
      });
      const header = await stepUp.approvedHeader({
        token: t.owner.token,
        userId: t.owner.id,
        teamId: t.teamId,
        purpose: "CASE_DELETE",
        resourceKind: "case",
        resourceId: doomed.id,
      });
      const del = await call("DELETE", `/v1/cases/${doomed.id}`, t.owner, undefined, header);
      expect(del.statusCode, del.body).toBe(204);
      expect(await prisma.case.count({ where: { id: doomed.id } })).toBe(0);
    });

    it("re-upgrade restores the writes", async () => {
      const u = await tenant("TEAM");
      const c = await call("POST", "/v1/cases", u.owner, { name: `matter-${tag()}`, teamId: u.teamId });
      const id = (c.json().case?.id ?? c.json().id) as string;
      await setPlan(u.teamId, "FREE");
      notIncluded(await call("POST", `/v1/cases/${id}/comments`, u.owner, { body: "while free" }));
      await setPlan(u.teamId, "TEAM");
      const note = await call("POST", `/v1/cases/${id}/comments`, u.owner, { body: "after re-upgrade" });
      expect(note.statusCode, note.body).toBe(200);
      const rename = await call("PATCH", `/v1/cases/${id}`, u.owner, { name: "renamed after re-upgrade" });
      expect(rename.statusCode, rename.body).toBe(200);
      const matter = await call("GET", `/v1/cases/${id}/matter-workspace`, u.owner);
      expect(matter.json().viewer).toMatchObject({ canComment: true, canRename: true });
    });
  });

  // ===========================================================================
  // B3C-F-008 — discussion vs reviewer operations
  // ===========================================================================
  describe("B3C-F-008 — ordinary discussion stays open; reviewer operations ask the review ladder", () => {
    let free: Tenant;
    let freeAdmin: Person;
    let freeViewer: Person;
    let evidenceId: string;
    const reviewerOps = (res: { statusCode: number; json: () => any }, capability: string) => {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({
        error: { code: "ENTITLEMENT_REQUIRED", reason: "reviewer_operations_not_included", entitlement: capability },
      });
    };
    const threadRow = (id: string) =>
      prisma.discussionThread.findUniqueOrThrow({
        where: { id },
        select: { status: true, assignedToUserId: true, escalatedAtUtc: true },
      });

    beforeAll(async () => {
      free = await tenant("FREE");
      [freeAdmin, freeViewer] = await Promise.all([kit.person(free.teamId, "ADMIN"), kit.person(free.teamId, "VIEWER")]);
      evidenceId = await record(free);
    }, 300_000);

    it("Free: an ordinary thread is created, discussed and resolved; assign and escalate are refused and change nothing", async () => {
      const created = await call("POST", "/v1/collaboration/threads", free.owner, {
        teamId: free.teamId,
        evidenceId,
        kind: "EVIDENCE_GENERAL",
        visibility: "INTERNAL",
        title: "About this photo",
      });
      expect(created.statusCode, created.body).toBe(201);
      const threadId = created.json().thread.id as string;
      const msg = await call("POST", `/v1/collaboration/threads/${threadId}/messages`, freeAdmin, { teamId: free.teamId, body: "Looks right." });
      expect(msg.statusCode, msg.body).toBe(201);

      const before = await threadRow(threadId);
      reviewerOps(
        await call("POST", `/v1/collaboration/threads/${threadId}/assign`, free.owner, { teamId: free.teamId, assignedToUserId: freeAdmin.id }),
        "REVIEW_ASSIGNMENTS",
      );
      reviewerOps(
        await call("POST", `/v1/collaboration/threads/${threadId}/escalate`, free.owner, { teamId: free.teamId, reason: "needs a lead" }),
        "REVIEW_ESCALATION",
      );
      expect(await threadRow(threadId)).toEqual(before);

      const resolved = await call("POST", `/v1/collaboration/threads/${threadId}/resolve`, free.owner, { teamId: free.teamId });
      expect(resolved.statusCode, resolved.body).toBe(200);
    });

    it("Free: a review-kind thread is a review workflow — creating one is refused; a legacy one is closed to messages and state changes", async () => {
      const before = await prisma.discussionThread.count({ where: { teamId: free.teamId } });
      reviewerOps(
        await call("POST", "/v1/collaboration/threads", free.owner, {
          teamId: free.teamId,
          evidenceId,
          kind: "REVIEW_REQUEST_CLARIFICATION",
          visibility: "INTERNAL",
          title: "Clarify the review",
        }),
        "BASIC_RECORD_REVIEW",
      );
      expect(await prisma.discussionThread.count({ where: { teamId: free.teamId } })).toBe(before);

      const legacy = await discussion.createDiscussionThread(
        {
          teamId: free.teamId,
          evidenceId,
          evidenceRequestId: null,
          kind: "REVIEW_REQUEST_CLARIFICATION",
          visibility: "INTERNAL",
          title: "Opened while on a paid plan",
          createdByUserId: free.owner.id,
          initialBody: null,
        } as never,
        prisma as never,
      );
      const messagesBefore = await prisma.discussionMessage.count({ where: { threadId: legacy.id } });
      reviewerOps(
        await call("POST", `/v1/collaboration/threads/${legacy.id}/messages`, free.owner, { teamId: free.teamId, body: "still there?" }),
        "BASIC_RECORD_REVIEW",
      );
      reviewerOps(
        await call("POST", `/v1/collaboration/threads/${legacy.id}/resolve`, free.owner, { teamId: free.teamId }),
        "BASIC_RECORD_REVIEW",
      );
      expect(await prisma.discussionMessage.count({ where: { threadId: legacy.id } })).toBe(messagesBefore);
      expect((await threadRow(legacy.id)).status).toBe("OPEN");
      // Reading what exists stays open.
      const read = await call("GET", `/v1/collaboration/threads/${legacy.id}/messages?teamId=${free.teamId}`, free.owner);
      expect(read.statusCode, read.body).toBe(200);
    });

    it("current collaboration policy still answers first: a Viewer, a foreign thread id and a restricted record all look missing", async () => {
      const own = await call("POST", "/v1/collaboration/threads", free.owner, {
        teamId: free.teamId,
        evidenceId,
        kind: "EVIDENCE_GENERAL",
        visibility: "INTERNAL",
        title: "Viewer probe",
      });
      const ownId = own.json().thread.id as string;
      const byViewer = await call("POST", `/v1/collaboration/threads/${ownId}/assign`, freeViewer, { teamId: free.teamId, assignedToUserId: freeAdmin.id });
      expect(byViewer.statusCode, byViewer.body).toBe(404);

      // Nested id: another workspace's thread addressed through this workspace.
      const other = await tenant("TEAM");
      const otherThread = await discussion.createDiscussionThread(
        {
          teamId: other.teamId,
          evidenceId: await record(other),
          evidenceRequestId: null,
          kind: "EVIDENCE_GENERAL",
          visibility: "INTERNAL",
          title: "Foreign",
          createdByUserId: other.owner.id,
          initialBody: null,
        } as never,
        prisma as never,
      );
      const nested = await call("POST", `/v1/collaboration/threads/${otherThread.id}/messages`, free.owner, { teamId: free.teamId, body: "hi" });
      expect(nested.statusCode, nested.body).toBe(404);

      // A record on a restricted case the caller is not listed on.
      const team = await tenant("TEAM");
      const offList = await kit.person(team.teamId, "ADMIN");
      const hidden = await record(team);
      const restricted = await prisma.case.create({
        data: { name: `R-${tag()}`, teamId: team.teamId, ownerUserId: team.owner.id, restrictedAtUtc: new Date() } as never,
        select: { id: true },
      });
      await prisma.caseEvidenceLink.create({ data: { caseId: restricted.id, evidenceId: hidden, teamId: team.teamId } as never });
      const hiddenThread = await discussion.createDiscussionThread(
        {
          teamId: team.teamId,
          evidenceId: hidden,
          evidenceRequestId: null,
          kind: "EVIDENCE_GENERAL",
          visibility: "INTERNAL",
          title: "Restricted",
          createdByUserId: team.owner.id,
          initialBody: null,
        } as never,
        prisma as never,
      );
      const closed = await call("POST", `/v1/collaboration/threads/${hiddenThread.id}/escalate`, offList, { teamId: team.teamId, reason: "x" });
      expect(closed.statusCode, closed.body).toBe(404);
      const create = await call("POST", "/v1/collaboration/threads", offList, {
        teamId: team.teamId,
        evidenceId: hidden,
        kind: "EVIDENCE_GENERAL",
        visibility: "INTERNAL",
        title: "Probe",
      });
      expect(create.statusCode, create.body).toBe(404);
    });

    it("control: a TEAM workspace assigns, escalates and opens review-kind threads", async () => {
      const team = await tenant("TEAM");
      const teamAdmin = await kit.person(team.teamId, "ADMIN");
      const evidence = await record(team);
      const review = await call("POST", "/v1/collaboration/threads", team.owner, {
        teamId: team.teamId,
        evidenceId: evidence,
        kind: "REVIEW_REQUEST_CLARIFICATION",
        visibility: "INTERNAL",
        title: "Clarify",
      });
      expect(review.statusCode, review.body).toBe(201);
      const id = review.json().thread.id as string;
      const assign = await call("POST", `/v1/collaboration/threads/${id}/assign`, team.owner, { teamId: team.teamId, assignedToUserId: teamAdmin.id });
      expect(assign.statusCode, assign.body).toBe(200);
      const escalate = await call("POST", `/v1/collaboration/threads/${id}/escalate`, team.owner, { teamId: team.teamId, reason: "needs a lead" });
      expect(escalate.statusCode, escalate.body).toBe(200);
    });
  });

  // ===========================================================================
  // B7B-F05 — webhooks after a downgrade
  // ===========================================================================
  describe("B7B-F05 — retry and replay ask FEATURE_WEBHOOKS; F-15 endpoints and removal are untouched", () => {
    async function integrationDelivery(t: Tenant) {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          teamId: t.teamId,
          url: "https://hooks.example.com/lane-b",
          status: "ACTIVE",
          secretCiphertext: "x",
          secretPrefix: "whsec_lb",
          createdByUserId: t.owner.id,
        },
        select: { id: true },
      });
      const delivery = await prisma.integrationWebhookDelivery.create({
        data: {
          teamId: t.teamId,
          endpointId: endpoint.id,
          eventId: randomUUID(),
          eventType: "evidence.created",
          payloadJson: {},
          status: "FAILED",
          attemptCount: 1,
        } as never,
        select: { id: true, status: true, attemptCount: true },
      });
      return { endpointId: endpoint.id, delivery };
    }
    async function lifecycleDelivery(t: Tenant) {
      const endpoint = await prisma.lifecycleWebhookEndpoint.create({
        data: { teamId: t.teamId, url: "https://hooks.example.com/life", secret: "s", subscribedEvents: [], createdByUserId: t.owner.id },
        select: { id: true },
      });
      const delivery = await prisma.lifecycleWebhookDelivery.create({
        data: {
          teamId: t.teamId,
          endpointId: endpoint.id,
          eventKind: "EVIDENCE_CREATED",
          payload: {},
          signature: "sig",
          state: "DEAD_LETTERED",
          attemptCount: 5,
        } as never,
        select: { id: true },
      });
      return { endpointId: endpoint.id, deliveryId: delivery.id };
    }
    const lifecycleState = (id: string) =>
      prisma.lifecycleWebhookDelivery.findUniqueOrThrow({ where: { id }, select: { state: true, attemptCount: true } });

    it("downgraded: manual retry and replay are refused before any step-up and change nothing; disabling and deactivating stay open", async () => {
      const t = await tenant("FREE");
      const integ = await integrationDelivery(t);
      const life = await lifecycleDelivery(t);

      const retry = await call("POST", `/v1/integrations/webhook-deliveries/${integ.delivery.id}/retry`, t.owner, { teamId: t.teamId }, ws(t.teamId));
      expect(retry.statusCode, retry.body).toBe(403);
      expect(retry.json()).toEqual({ denial: "ENTITLEMENT_REQUIRED", key: "FEATURE_WEBHOOKS" });
      expect(await prisma.stepUpChallenge.count({ where: { initiatedByUserId: t.owner.id, purpose: "INTEGRATION_WEBHOOK_RETRY" } })).toBe(0);
      expect(
        await prisma.integrationWebhookDelivery.findUniqueOrThrow({ where: { id: integ.delivery.id }, select: { status: true, attemptCount: true } }),
      ).toEqual({ status: integ.delivery.status, attemptCount: integ.delivery.attemptCount });

      const before = await lifecycleState(life.deliveryId);
      const replay = await call("POST", `/v1/integrations/webhooks/lifecycle-deliveries/${life.deliveryId}/replay`, t.owner, {}, ws(t.teamId));
      expect(replay.statusCode, replay.body).toBe(403);
      expect(replay.json()).toEqual({ denial: "ENTITLEMENT_REQUIRED", key: "FEATURE_WEBHOOKS" });
      expect(await lifecycleState(life.deliveryId)).toEqual(before);

      // F-15: the refusals leave the already-ACTIVE endpoints as they were.
      expect((await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: integ.endpointId } })).status).toBe("ACTIVE");
      expect((await prisma.lifecycleWebhookEndpoint.findUniqueOrThrow({ where: { id: life.endpointId } })).state).toBe("ACTIVE");

      // Removal stays open without the entitlement.
      const disable = await call(
        "POST",
        `/v1/integrations/webhooks/${integ.endpointId}/disable`,
        t.owner,
        { teamId: t.teamId },
        {
          ...ws(t.teamId),
          ...(await stepUp.approvedHeader({
            token: t.owner.token,
            userId: t.owner.id,
            teamId: t.teamId,
            purpose: "INTEGRATION_WEBHOOK_DISABLE",
            resourceKind: "webhook_endpoint",
            resourceId: integ.endpointId,
          })),
        },
      );
      expect(disable.statusCode, disable.body).toBe(200);
      const deactivate = await call("POST", `/v1/integrations/webhooks/endpoints/${life.endpointId}/deactivate`, t.owner, {}, ws(t.teamId));
      expect(deactivate.statusCode, deactivate.body).toBe(200);
    });

    it("control: an entitled workspace passes the gate (retry reaches its step-up, replay re-queues)", async () => {
      const t = await tenant("ENTERPRISE", { contract: true });
      const integ = await integrationDelivery(t);
      const life = await lifecycleDelivery(t);
      const retry = await call("POST", `/v1/integrations/webhook-deliveries/${integ.delivery.id}/retry`, t.owner, { teamId: t.teamId }, ws(t.teamId));
      expect(retry.statusCode, retry.body).toBe(401);
      expect(retry.json().error.code).toBe("STEP_UP_REQUIRED");
      const replay = await call("POST", `/v1/integrations/webhooks/lifecycle-deliveries/${life.deliveryId}/replay`, t.owner, {}, ws(t.teamId));
      expect(replay.statusCode, replay.body).toBe(200);
      expect((await lifecycleState(life.deliveryId)).state).toBe("PENDING");
    });

    it("closure: the closed workspace's deactivated endpoint is not replayed to, even while entitled", async () => {
      const t = await tenant("ENTERPRISE", { contract: true });
      const life = await lifecycleDelivery(t);
      await prisma.$transaction(async (tx) => {
        await closure.closeWorkspacesTx(tx as never, { teamIds: [t.teamId], actorUserId: t.owner.id, reason: "lane-b closure" });
      });
      expect((await prisma.lifecycleWebhookEndpoint.findUniqueOrThrow({ where: { id: life.endpointId } })).state).toBe("DEACTIVATED");
      const before = await lifecycleState(life.deliveryId);
      const replay = await call("POST", `/v1/integrations/webhooks/lifecycle-deliveries/${life.deliveryId}/replay`, t.owner, {}, ws(t.teamId));
      expect(replay.statusCode).toBeGreaterThanOrEqual(400);
      expect(replay.statusCode).toBeLessThan(500);
      expect(await lifecycleState(life.deliveryId)).toEqual(before);
    });

    it("the endpoint ceiling counts the family the contract names (lifecycle), not integration endpoints", async () => {
      const t = await tenant("ENTERPRISE", { contract: true });
      await entitlements.upsertEntitlementGrant({
        teamId: t.teamId,
        key: "INTEGRATION_WEBHOOK_ENDPOINTS_MAX",
        value: 1,
        kind: "LIMIT",
        source: "CUSTOM",
        grantedByUserId: t.owner.id,
      } as never);
      // Two ACTIVE integration endpoints do not consume the lifecycle ceiling.
      await integrationDelivery(t);
      await integrationDelivery(t);
      const first = await lifecycleWebhooks.createWebhookEndpoint({
        teamId: t.teamId,
        url: "https://hooks.example.com/first",
        subscribedEvents: ["EVIDENCE_CREATED"] as never,
        createdByUserId: t.owner.id,
      });
      expect(first.endpointId).toBeTruthy();
      await expect(
        lifecycleWebhooks.createWebhookEndpoint({
          teamId: t.teamId,
          url: "https://hooks.example.com/second",
          subscribedEvents: ["EVIDENCE_CREATED"] as never,
          createdByUserId: t.owner.id,
        }),
      ).rejects.toBeInstanceOf(lifecycleWebhooks.WebhookEndpointLimitError);
      expect(await prisma.lifecycleWebhookEndpoint.count({ where: { teamId: t.teamId, state: "ACTIVE" } })).toBe(1);
    });
  });

  // ===========================================================================
  // B7B-F06 — governance automation and Trust Center authoring
  // ===========================================================================
  describe("B7B-F06 — automation asks FEATURE_GOVERNANCE_PLATFORM; Trust Center authoring asks FEATURE_TRUST_CENTER", () => {
    const ruleBody = (teamId: string) => ({
      teamId,
      name: `label ${tag()}`,
      triggerType: "EVIDENCE_CREATED",
      conditionJson: {},
      actionType: "APPLY_LABEL",
      actionConfigJson: { label: "needs-review" },
    });
    const governance = (res: { statusCode: number; json: () => any }) => {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ denial: "ENTITLEMENT_REQUIRED", key: "FEATURE_GOVERNANCE_PLATFORM" });
    };
    async function legacyRule(t: Tenant, enabled: boolean) {
      return prisma.automationRule.create({
        data: {
          teamId: t.teamId,
          name: `legacy ${tag()}`,
          enabled,
          triggerType: "EVIDENCE_CREATED",
          conditionJson: {},
          actionType: "APPLY_LABEL",
          actionConfigJson: { label: "legacy" },
          createdByUserId: t.owner.id,
          updatedByUserId: t.owner.id,
        } as never,
        select: { id: true, version: true, conditionJson: true },
      });
    }

    it("Free: rule create, re-author and enable are refused and write nothing; list, rename and disable stay open", async () => {
      const t = await tenant("FREE");
      governance(await call("POST", "/v1/automation/rules", t.owner, ruleBody(t.teamId)));
      expect(await prisma.automationRule.count({ where: { teamId: t.teamId } })).toBe(0);

      const legacy = await legacyRule(t, false);
      governance(await call("POST", `/v1/automation/rules/${legacy.id}/enable`, t.owner, {}));
      governance(await call("PATCH", `/v1/automation/rules/${legacy.id}`, t.owner, { conditionJson: {} }));
      const row = await prisma.automationRule.findUniqueOrThrow({ where: { id: legacy.id }, select: { enabled: true, version: true } });
      expect(row).toEqual({ enabled: false, version: legacy.version });

      const list = await call("GET", `/v1/automation/rules?teamId=${t.teamId}`, t.owner);
      expect(list.statusCode, list.body).toBe(200);
      const rename = await call("PATCH", `/v1/automation/rules/${legacy.id}`, t.owner, { name: "renamed" });
      expect(rename.statusCode, rename.body).toBe(200);
      const enabledLegacy = await legacyRule(t, true);
      const disable = await call("POST", `/v1/automation/rules/${enabledLegacy.id}/disable`, t.owner, {});
      expect(disable.statusCode, disable.body).toBe(200);
    });

    it("Free: the queued executor skips a legacy enabled rule's run instead of executing it", async () => {
      const t = await tenant("FREE");
      const legacy = await legacyRule(t, true);
      const run = await prisma.automationRun.create({
        data: {
          teamId: t.teamId,
          ruleId: legacy.id,
          triggerType: "EVIDENCE_CREATED",
          targetType: "evidence",
          targetId: randomUUID(),
          status: "PENDING",
          idempotencyKey: `lane-b:${randomUUID()}`,
          actionIdempotencyKey: `lane-b:${randomUUID()}`,
        } as never,
        select: {
          id: true,
          teamId: true,
          ruleId: true,
          triggerType: true,
          targetType: true,
          targetId: true,
          actionIdempotencyKey: true,
          attemptCount: true,
          claimGeneration: true,
        },
      });
      const result = await runtime.claimAndExecute({ prisma: prisma as never, run: run as never });
      expect(result).toBe("skipped");
      const after = await prisma.automationRun.findUniqueOrThrow({ where: { id: run.id }, select: { status: true, reason: true } });
      expect(after).toEqual({ status: "SKIPPED", reason: "entitlement_required:FEATURE_GOVERNANCE_PLATFORM" });
    });

    it("control: an Enterprise workspace (ACTIVE contract) creates and enables a rule", async () => {
      const t = await tenant("ENTERPRISE", { contract: true });
      const created = await call("POST", "/v1/automation/rules", t.owner, ruleBody(t.teamId));
      expect(created.statusCode, created.body).toBe(201);
      const enable = await call("POST", `/v1/automation/rules/${created.json().id}/enable`, t.owner, {});
      expect(enable.statusCode, enable.body).toBe(200);
    });

    it("Trust Center authoring: a workspace without FEATURE_TRUST_CENTER is refused on every authoring route before any step-up", async () => {
      const t = await tenant("TEAM");
      await entitlements.upsertEntitlementGrant({
        teamId: t.teamId,
        key: "FEATURE_TRUST_CENTER",
        value: false,
        kind: "FEATURE",
        source: "CUSTOM",
        grantedByUserId: t.owner.id,
      } as never);
      const trust = (res: { statusCode: number; json: () => any }) => {
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ denial: "ENTITLEMENT_REQUIRED", entitlement: "FEATURE_TRUST_CENTER" });
      };
      trust(
        await call(
          "POST",
          "/v1/trust/subprocessors",
          t.owner,
          {
            slug: `sp-${tag()}`,
            name: "Vendor",
            vendor: "Vendor Inc",
            purpose: "Hosting",
            region: "EU",
            dataCategories: ["METADATA"],
            changeSummary: "added",
          },
          ws(t.teamId),
        ),
      );
      trust(
        await call(
          "POST",
          "/v1/trust/status/incidents",
          t.owner,
          { title: "Outage", severity: "MINOR", componentKeys: ["API"] },
          ws(t.teamId),
        ),
      );
      trust(
        await call(
          "POST",
          `/v1/trust/status/incidents/${randomUUID()}/updates`,
          t.owner,
          { state: "RESOLVED", body: "fixed" },
          ws(t.teamId),
        ),
      );
      const start = new Date(Date.now() + DAY);
      trust(
        await call(
          "POST",
          "/v1/trust/status/maintenance",
          t.owner,
          {
            title: "Window",
            description: "planned",
            componentKeys: ["API"],
            startsAtUtc: start.toISOString(),
            endsAtUtc: new Date(start.getTime() + 3_600_000).toISOString(),
          },
          ws(t.teamId),
        ),
      );
      expect(await prisma.subprocessor.count({ where: { teamId: t.teamId } })).toBe(0);
      expect(await prisma.stepUpChallenge.count({ where: { initiatedByUserId: t.owner.id } })).toBe(0);
    });

    it("Trust Center authoring: the catalogue's default entitlement (every plan, Free included) is unchanged", async () => {
      const t = await tenant("FREE");
      const sp = await call(
        "POST",
        "/v1/trust/subprocessors",
        t.owner,
        {
          slug: `sp-${tag()}`,
          name: "Vendor",
          vendor: "Vendor Inc",
          purpose: "Hosting",
          region: "EU",
          dataCategories: ["METADATA"],
          changeSummary: "added",
        },
        ws(t.teamId),
      );
      expect(sp.statusCode, sp.body).toBe(201);
      const incident = await call("POST", "/v1/trust/status/incidents", t.owner, { title: "Outage", severity: "MINOR", componentKeys: ["API"] }, ws(t.teamId));
      expect(incident.statusCode, incident.body).toBe(401);
      expect(incident.json().error.code).toBe("STEP_UP_REQUIRED");
    });
  });
});
