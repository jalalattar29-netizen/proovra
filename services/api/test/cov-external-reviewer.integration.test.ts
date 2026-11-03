/**
 * THE EXTERNAL REVIEWER, END TO END, THROUGH THE ROUTES THE PRODUCT USES.
 *
 * The audit never established a portal session: the grants route answered 500, and
 * the invitations route the UI uses was not run. This suite runs that route with a
 * real step-up, reveals and delivers the token, exchanges it at `/v1/portal/auth`,
 * then reads and works the portal: dashboard, workflow view, comments, decisions,
 * activity. It ends with revocation and the live session. It is also the API proof
 * for `/portal/[token]/work/[workflowId]` and the four portal-session GET routes the
 * tenant sweep never exercised.
 *
 * Own workflow, a sibling workflow in the same workspace, another tenant's workflow.
 * Email is the recording provider; no message leaves the machine.
 */
import { createHash, randomUUID } from "node:crypto";

import { PutObjectCommand } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { coverageKit, type CoverageKit, type Injected, type Person } from "./support/coverage-actors.js";
import { customerKit, type Customer } from "./support/coverage-customer.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";

type Prisma = import("@prisma/client").PrismaClient;

describe("external reviewer through the real invitation flow (live PostgreSQL + Redis)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let kit: CoverageKit;
  let stepUp: ReturnType<typeof createStepUpCeremony>;
  let a: Customer;
  let b: Customer;
  let member: Person;
  let evidence: string;
  let sibling: string;
  let workflow: string;
  let siblingWorkflow: string;
  let foreignWorkflow: string;

  const owner = () => ({ token: a.owner.token });
  const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

  async function record(c: Customer, title: string) {
    return (
      await prisma.evidence.create({
        data: { title, type: "PHOTO", status: "SIGNED", teamId: c.workspaceId, organizationId: c.orgId, ownerUserId: c.owner.userId } as never,
        select: { id: true },
      })
    ).id;
  }

  /** The workflow a member opens on a record, through the route the Evidence page calls. */
  async function workflowOn(c: Customer, evidenceId: string) {
    const res = await kit.call("PATCH", `/v1/evidence/${evidenceId}/reviewer-workflow`, { token: c.owner.token }, { priority: "HIGH" });
    expect(res.statusCode, res.body).toBe(200);
    return (await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { evidenceId } })).id;
  }

  async function invite(c: Customer, scope: Record<string, unknown>, over: Record<string, unknown> = {}) {
    const header = await stepUp.approvedHeader({
      token: c.owner.token,
      userId: c.owner.userId,
      teamId: c.workspaceId,
      purpose: "EXTERNAL_REVIEW_GRANT_ISSUE",
      resourceKind: "external_review_grant",
      resourceId: (scope.evidenceId ?? scope.caseId ?? scope.packageId) as string,
    });
    const reviewerEmail = `reviewer-${kit.tag()}@test.proovra.local`;
    const res = await kit.call(
      "POST",
      "/v1/external-review/invitations",
      { token: c.owner.token },
      { reviewerEmail, role: "EXTERNAL_REVIEWER", scope, expiresAtUtc: days(7), ...over },
      header,
    );
    return { res, reviewerEmail };
  }

  async function invited(c: Customer, scope: Record<string, unknown>, over: Record<string, unknown> = {}) {
    const { res, reviewerEmail } = await invite(c, scope, over);
    expect(res.statusCode, res.body).toBe(201);
    return { grantId: res.json().grantId as string, rawToken: res.json().rawToken as string, reviewerEmail };
  }

  const portal = (method: string, url: string, token: string, sessionId?: string, payload?: unknown) =>
    h.app.inject({
      method: method as never,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(sessionId ? { "x-portal-session": sessionId } : {}),
      },
      ...(payload === undefined ? {} : { payload: payload as never }),
    }) as unknown as Promise<Injected>;

  async function signIn(rawToken: string) {
    const res = (await h.app.inject({
      method: "POST",
      url: "/v1/portal/auth",
      payload: { token: rawToken },
    })) as unknown as Injected;
    expect(res.statusCode, res.body).toBe(200);
    return res.json().sessionId as string;
  }

  const activity = (grantId: string, code: string) =>
    prisma.externalReviewActivity.count({ where: { grantId, code } });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as Prisma;
    kit = await coverageKit(h);
    stepUp = createStepUpCeremony({ prisma, inject: h.app.inject.bind(h.app) as never });
    const customers = await customerKit(h, prisma);
    a = await customers.customer();
    b = await customers.customer();
    member = await kit.person(a.workspaceId, "MEMBER");
    evidence = await record(a, `E1 ${kit.tag()}`);
    sibling = await record(a, `E2 ${kit.tag()}`);
    workflow = await workflowOn(a, evidence);
    siblingWorkflow = await workflowOn(a, sibling);
    foreignWorkflow = await workflowOn(b, await record(b, `B ${kit.tag()}`));
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  describe("issuing the invitation", () => {
    it("a member without the tier, and no step-up, issue nothing; a foreign record is refused", async () => {
      const before = await prisma.externalReviewGrant.count({ where: { teamId: a.workspaceId } });
      const asMember = await kit.call("POST", "/v1/external-review/invitations", member, {
        reviewerEmail: "x@test.proovra.local",
        role: "EXTERNAL_REVIEWER",
        scope: { kind: "EVIDENCE", evidenceId: evidence },
        expiresAtUtc: days(7),
      });
      expect(asMember.statusCode, asMember.body).toBe(403);
      const noStepUp = await kit.call("POST", "/v1/external-review/invitations", owner(), {
        reviewerEmail: "x@test.proovra.local",
        role: "EXTERNAL_REVIEWER",
        scope: { kind: "EVIDENCE", evidenceId: evidence },
        expiresAtUtc: days(7),
      });
      expect(noStepUp.statusCode, noStepUp.body).toBe(401);
      const foreign = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: foreignWorkflow } });
      const { res } = await invite(a, { kind: "EVIDENCE", evidenceId: foreign.evidenceId });
      expect(res.statusCode, res.body).toBe(409);
      expect(await prisma.externalReviewGrant.count({ where: { teamId: a.workspaceId } })).toBe(before);
    });

    it("POSITIVE: the invitation writes the grant, its role row, the activity and the tenant audit; the token is not stored", async () => {
      const g = await invited(a, { kind: "EVIDENCE", evidenceId: evidence });
      expect(await prisma.externalReviewGrant.findUniqueOrThrow({ where: { id: g.grantId } })).toMatchObject({
        teamId: a.workspaceId,
        state: "INVITED",
        scopeKind: "EVIDENCE",
        evidenceId: evidence,
        invitedByUserId: a.owner.userId,
      });
      expect(await prisma.externalReviewerRoleAssignment.count({ where: { id: g.grantId } })).toBe(1);
      expect(await activity(g.grantId, "GRANT_ISSUED")).toBe(1);
      expect(await prisma.adminAuditLog.count({ where: { resourceId: g.grantId } })).toBeGreaterThanOrEqual(1);
      const row = await prisma.externalReviewGrant.findUniqueOrThrow({ where: { id: g.grantId } });
      expect(JSON.stringify(row)).not.toContain(g.rawToken);
    });

    it("delivery and reveal: the email goes to the reviewer, and reveal retires the token it replaces", async () => {
      const g = await invited(a, { kind: "EVIDENCE", evidenceId: evidence });
      const sent = await kit.call("POST", `/v1/external-review/invitations/${g.grantId}/send-email`, owner(), {});
      expect(sent.statusCode, sent.body).toBe(200);
      const delivery = await kit.call("GET", `/v1/external-review/invitations/${g.grantId}/delivery`, owner());
      expect(delivery.statusCode, delivery.body).toBe(200);
      expect(delivery.json().deliveries[0]).toMatchObject({ recipientEmail: g.reviewerEmail });

      // Another tenant's owner cannot deliver or reveal it.
      const foreignSend = await kit.call("POST", `/v1/external-review/invitations/${g.grantId}/send-email`, { token: b.owner.token }, {});
      expect(foreignSend.statusCode, foreignSend.body).toBe(404);

      const reason = "The reviewer never received the mail.";
      const header = await stepUp.approvedHeader({
        token: a.owner.token,
        userId: a.owner.userId,
        teamId: a.workspaceId,
        purpose: "EXTERNAL_REVIEW_GRANT_ISSUE",
        resourceKind: "external_review_grant_reveal",
        resourceId: g.grantId,
      });
      const revealed = await kit.call("POST", `/v1/external-review/invitations/${g.grantId}/reveal-token`, owner(), { reason }, header);
      expect(revealed.statusCode, revealed.body).toBe(200);
      const fresh = revealed.json().rawToken as string;
      expect(fresh).not.toBe(g.rawToken);
      const old = await h.app.inject({ method: "POST", url: "/v1/portal/auth", payload: { token: g.rawToken } });
      expect(old.statusCode, old.body).toBe(401);
      await signIn(fresh);
    });
  });

  describe("a live portal session", () => {
    let g: { grantId: string; rawToken: string; reviewerEmail: string };
    let session: string;

    beforeAll(async () => {
      g = await invited(a, { kind: "EVIDENCE", evidenceId: evidence });
      session = await signIn(g.rawToken);
    });

    it("POSITIVE: sign-in accepts the invitation, and the dashboard lists exactly the granted workflow", async () => {
      expect((await prisma.externalReviewGrant.findUniqueOrThrow({ where: { id: g.grantId } })).state).toBe("ACTIVE");
      expect(await activity(g.grantId, "LOGIN")).toBe(1);
      const res = await portal("GET", "/v1/portal/dashboard", g.rawToken, session);
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json().portal;
      expect(body.reviewer.email).toBe(g.reviewerEmail);
      expect(body.assigned.map((w: { workflowId: string }) => w.workflowId)).toEqual([workflow]);
      expect(res.body).not.toContain(siblingWorkflow);
      expect(res.body).not.toContain(a.owner.email);
    });

    it("POSITIVE: view, comment and decision land on the workflow, with rows and activity", async () => {
      const view = await portal("POST", `/v1/portal/work/${workflow}/view`, g.rawToken, session);
      expect(view.statusCode, view.body).toBe(200);
      expect(await activity(g.grantId, "REVIEW_OPENED")).toBe(1);

      const comment = await portal("POST", `/v1/portal/work/${workflow}/comments`, g.rawToken, session, { body: "Corner of the frame is cut." });
      expect(comment.statusCode, comment.body).toBe(201);
      const commentId = comment.json().commentId as string;
      expect(await prisma.externalReviewComment.findUniqueOrThrow({ where: { id: commentId } })).toMatchObject({
        teamId: a.workspaceId,
        grantId: g.grantId,
        workflowId: workflow,
        authorEmail: g.reviewerEmail,
      });
      expect(await activity(g.grantId, "COMMENT_POSTED")).toBe(1);
      const list = await portal("GET", `/v1/portal/work/${workflow}/comments`, g.rawToken, session);
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json().comments.map((c: { id: string }) => c.id)).toContain(commentId);

      const decided = await portal("POST", `/v1/portal/work/${workflow}/decision`, g.rawToken, session, {
        verdict: "REJECT",
        rationale: "The chain does not cover the handover.",
      });
      expect(decided.statusCode, decided.body).toBe(200);
      expect(decided.json()).toMatchObject({ replaced: false });
      const again = await portal("POST", `/v1/portal/work/${workflow}/decision`, g.rawToken, session, { verdict: "APPROVE" });
      expect(again.json()).toMatchObject({ replaced: true });
      const rows = await prisma.externalReviewDecision.findMany({ where: { grantId: g.grantId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ verdict: "APPROVE", workflowId: workflow, reviewerEmail: g.reviewerEmail });
      const read = await portal("GET", `/v1/portal/work/${workflow}/decisions`, g.rawToken, session);
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json().decisions).toEqual([expect.objectContaining({ verdict: "APPROVE", workflowId: workflow })]);
      expect(read.body).not.toContain(g.reviewerEmail);
      expect(await activity(g.grantId, "DECISION_SUBMITTED")).toBe(2);

      // A review decision is not forensic custody (owner decision 2026-10-24); it
      // is in the tenant audit, under the workspace, naming the verdict.
      const audit = await prisma.adminAuditLog.findMany({
        where: { action: "external_review.decision.submitted", resourceId: rows[0]!.id },
      });
      expect(audit).toHaveLength(2);
      expect(await prisma.custodyEvent.count({ where: { evidenceId: evidence, eventType: "REVIEW_DECISION_RECORDED" as never } })).toBe(0);

      const dash = await portal("GET", "/v1/portal/dashboard", g.rawToken, session);
      expect(dash.json().portal.completedCount).toBe(1);
      const log = await portal("GET", "/v1/portal/activity", g.rawToken, session);
      expect(log.statusCode, log.body).toBe(200);
      expect(log.json().activity.map((row: { code: string }) => row.code)).toEqual(
        expect.arrayContaining(["LOGIN", "REVIEW_OPENED", "COMMENT_POSTED", "DECISION_SUBMITTED"]),
      );
    });

    it("the grant reaches no sibling workflow of the workspace and no workflow of another tenant", async () => {
      for (const target of [siblingWorkflow, foreignWorkflow, randomUUID()]) {
        for (const [method, url, payload] of [
          ["GET", `/v1/portal/work/${target}/comments`, undefined],
          ["GET", `/v1/portal/work/${target}/decisions`, undefined],
          ["POST", `/v1/portal/work/${target}/comments`, { body: "reach" }],
          ["POST", `/v1/portal/work/${target}/decision`, { verdict: "APPROVE" }],
          ["POST", `/v1/portal/work/${target}/view`, undefined],
        ] as const) {
          const res = await portal(method, url, g.rawToken, session, payload);
          expect(res.statusCode, `${method} ${url} ${res.body}`).toBe(403);
          expect(res.json()).toEqual({ denial: "OUT_OF_SCOPE" });
        }
      }
      expect(await prisma.externalReviewComment.count({ where: { workflowId: { in: [siblingWorkflow, foreignWorkflow] } } })).toBe(0);
      expect(await prisma.externalReviewDecision.count({ where: { workflowId: { in: [siblingWorkflow, foreignWorkflow] } } })).toBe(0);
    });

    it("a reply cannot hang off a comment on a workflow the grant does not reach", async () => {
      const other = await invited(a, { kind: "EVIDENCE", evidenceId: sibling });
      const otherSession = await signIn(other.rawToken);
      const theirs = await portal("POST", `/v1/portal/work/${siblingWorkflow}/comments`, other.rawToken, otherSession, { body: "Sibling note." });
      expect(theirs.statusCode, theirs.body).toBe(201);
      const reply = await portal("POST", `/v1/portal/work/${workflow}/comments`, g.rawToken, session, {
        body: "Replying across workflows.",
        parentCommentId: theirs.json().commentId,
      });
      expect(reply.statusCode, reply.body).toBe(409);
      expect(reply.json()).toEqual({ denial: "OUT_OF_SCOPE" });
    });

    it("one reviewer does not read another reviewer's address in a shared thread", async () => {
      const second = await invited(a, { kind: "EVIDENCE", evidenceId: evidence });
      const secondSession = await signIn(second.rawToken);
      const res = await portal("GET", `/v1/portal/work/${workflow}/comments`, second.rawToken, secondSession);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().comments.length).toBeGreaterThan(0);
      expect(res.body).not.toContain(g.reviewerEmail);
      const own = await portal("GET", `/v1/portal/work/${workflow}/comments`, g.rawToken, session);
      expect(own.body).toContain(g.reviewerEmail);
      // Nor a decision of the other reviewer.
      const decisions = await portal("GET", `/v1/portal/work/${workflow}/decisions`, second.rawToken, secondSession);
      expect(decisions.json().decisions).toEqual([]);
    });

    it("a role without the capability is refused on its own workflow", async () => {
      const observer = await invited(a, { kind: "EVIDENCE", evidenceId: evidence }, { role: "EXTERNAL_OBSERVER" });
      const s = await signIn(observer.rawToken);
      expect((await portal("GET", `/v1/portal/work/${workflow}/comments`, observer.rawToken, s)).statusCode).toBe(200);
      const comment = await portal("POST", `/v1/portal/work/${workflow}/comments`, observer.rawToken, s, { body: "x" });
      expect(comment.statusCode, comment.body).toBe(403);
      expect(comment.json()).toEqual({ denial: "NOT_PERMITTED" });
      const decide = await portal("POST", `/v1/portal/work/${workflow}/decision`, observer.rawToken, s, { verdict: "APPROVE" });
      expect(decide.statusCode, decide.body).toBe(403);
    });

    it("a member's session, an API-shaped bearer and a forged session id are not a portal session", async () => {
      for (const url of ["/v1/portal/dashboard", "/v1/portal/activity", `/v1/portal/work/${workflow}/comments`, `/v1/portal/work/${workflow}/decisions`]) {
        const asMember = await portal("GET", url, a.owner.token);
        expect(asMember.statusCode, asMember.body).toBe(401);
        expect(asMember.body).not.toContain(workflow);
        const anon = (await h.app.inject({ method: "GET", url })) as unknown as Injected;
        expect(anon.statusCode, anon.body).toBe(401);
      }
      const forged = await portal("GET", "/v1/portal/dashboard", g.rawToken, "0".repeat(32));
      expect(forged.statusCode).toBe(401);
      expect(forged.json()).toEqual({ denial: "SESSION_ENDED" });
    });
  });

  describe("a case-scoped grant", () => {
    it("reaches the workflows of its case, and not a record also held in a restricted case", async () => {
      const openCase = await prisma.case.create({
        data: { name: `Open ${kit.tag()}`, teamId: a.workspaceId, ownerUserId: a.owner.userId } as never,
        select: { id: true },
      });
      const restricted = await prisma.case.create({
        data: { name: `Closed ${kit.tag()}`, teamId: a.workspaceId, ownerUserId: a.owner.userId, restrictedAtUtc: new Date() } as never,
        select: { id: true },
      });
      const plain = await record(a, `plain ${kit.tag()}`);
      const shared = await record(a, `shared ${kit.tag()}`);
      const link = (caseId: string, evidenceId: string) =>
        prisma.caseEvidenceLink.create({ data: { caseId, evidenceId, teamId: a.workspaceId } as never });
      await link(openCase.id, plain);
      await link(openCase.id, shared);
      await link(restricted.id, shared);
      const plainWorkflow = await workflowOn(a, plain);
      const sharedWorkflow = await workflowOn(a, shared);

      const g = await invited(a, { kind: "CASE", caseId: openCase.id });
      const s = await signIn(g.rawToken);
      const dash = await portal("GET", "/v1/portal/dashboard", g.rawToken, s);
      expect(dash.json().portal.assigned.map((w: { workflowId: string }) => w.workflowId)).toEqual([plainWorkflow]);
      expect((await portal("GET", `/v1/portal/work/${plainWorkflow}/comments`, g.rawToken, s)).statusCode).toBe(200);

      // What the dashboard does not list, the workflow routes do not open.
      for (const [method, url, payload] of [
        ["GET", `/v1/portal/work/${sharedWorkflow}/comments`, undefined],
        ["POST", `/v1/portal/work/${sharedWorkflow}/comments`, { body: "x" }],
        ["POST", `/v1/portal/work/${sharedWorkflow}/decision`, { verdict: "APPROVE" }],
      ] as const) {
        const res = await portal(method, url, g.rawToken, s, payload);
        expect(res.statusCode, `${url} ${res.body}`).toBe(403);
        expect(res.json()).toEqual({ denial: "OUT_OF_SCOPE" });
      }
    });
  });

  describe("ending access", () => {
    it("revoking the invitation ends the live session at once; the token answers TOKEN_REVOKED; audit and activity are written", async () => {
      const g = await invited(a, { kind: "EVIDENCE", evidenceId: evidence });
      const session = await signIn(g.rawToken);
      expect((await portal("GET", "/v1/portal/dashboard", g.rawToken, session)).statusCode).toBe(200);

      // Another tenant's owner cannot revoke it, and a member has no tier.
      const foreign = await kit.call("POST", `/v1/external-review/invitations/${g.grantId}/revoke`, { token: b.owner.token }, {});
      expect(foreign.statusCode, foreign.body).toBeGreaterThanOrEqual(400);
      const byMember = await kit.call("POST", `/v1/external-review/invitations/${g.grantId}/revoke`, member, {});
      expect(byMember.statusCode, byMember.body).toBe(403);
      expect((await portal("GET", "/v1/portal/dashboard", g.rawToken, session)).statusCode).toBe(200);

      const done = await kit.call("POST", `/v1/external-review/invitations/${g.grantId}/revoke`, owner(), {});
      expect(done.statusCode, done.body).toBe(200);
      for (const [method, url, payload] of [
        ["GET", "/v1/portal/dashboard", undefined],
        ["GET", "/v1/portal/activity", undefined],
        ["GET", `/v1/portal/work/${workflow}/comments`, undefined],
        ["POST", `/v1/portal/work/${workflow}/comments`, { body: "after revoke" }],
        ["POST", `/v1/portal/work/${workflow}/decision`, { verdict: "APPROVE" }],
      ] as const) {
        const res = await portal(method, url, g.rawToken, session, payload);
        expect(res.statusCode, `${url} ${res.body}`).toBe(401);
        expect(res.json()).toEqual({ denial: "TOKEN_REVOKED" });
      }
      const again = await h.app.inject({ method: "POST", url: "/v1/portal/auth", payload: { token: g.rawToken } });
      expect(again.statusCode).toBe(401);
      expect(again.json()).toEqual({ denial: "TOKEN_REVOKED" });

      expect((await prisma.externalReviewGrant.findUniqueOrThrow({ where: { id: g.grantId } })).state).toBe("REVOKED");
      expect(await activity(g.grantId, "GRANT_REVOKED")).toBe(1);
      expect(await prisma.adminAuditLog.count({ where: { resourceId: g.grantId, action: { contains: "revok" } } })).toBe(1);
      expect(await prisma.externalReviewComment.count({ where: { grantId: g.grantId } })).toBe(0);
    });

    it("an expired grant ends the live session the same way", async () => {
      const g = await invited(a, { kind: "EVIDENCE", evidenceId: evidence });
      const session = await signIn(g.rawToken);
      await prisma.externalReviewGrant.update({
        where: { id: g.grantId },
        data: { createdAtUtc: new Date(Date.now() - 86_400_000), expiresAtUtc: new Date(Date.now() - 1000) },
      });
      for (const url of ["/v1/portal/dashboard", `/v1/portal/work/${workflow}/comments`]) {
        const res = await portal("GET", url, g.rawToken, session);
        expect(res.statusCode, res.body).toBe(401);
        expect(res.json()).toEqual({ denial: "TOKEN_EXPIRED" });
      }
    });

    it("ending the sessions keeps the invitation, and the operator who did it is on record", async () => {
      const g = await invited(a, { kind: "EVIDENCE", evidenceId: evidence });
      const session = await signIn(g.rawToken);
      const res = await kit.call("POST", `/v1/external-review/invitations/${g.grantId}/sessions/revoke`, owner(), {});
      expect(res.statusCode, res.body).toBe(200);
      expect((await portal("GET", "/v1/portal/dashboard", g.rawToken, session)).statusCode).toBe(401);
      expect((await prisma.externalReviewGrant.findUniqueOrThrow({ where: { id: g.grantId } })).state).toBe("ACTIVE");
      expect(await activity(g.grantId, "PORTAL_SESSION_REVOKED")).toBe(1);
      expect(
        await prisma.adminAuditLog.count({ where: { action: "external_review.sessions.revoked", resourceId: g.grantId, userId: a.owner.userId } }),
      ).toBe(1);
    });
  });

  describe("the file behind a review", () => {
    const pkg = (id: string, raw: string, session?: string) =>
      portal("GET", `/v1/portal/work/${id}/verification-package`, raw, session);

    /** A record with a published disclosure package, at a real object. */
    async function recordWithPackage(c: Customer) {
      const { s3 } = await import("../src/storage.js");
      const bucket = process.env.S3_BUCKET as string;
      const id = await record(c, `pkg ${kit.tag()}`);
      await prisma.evidence.update({ where: { id }, data: { type: "DOCUMENT", status: "REPORTED", signedAtUtc: new Date() } as never });
      const key = `verification/${id}/external.zip`;
      const body = Buffer.from(`package ${randomUUID()}`);
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
      await prisma.report.create({
        data: { evidenceId: id, version: 1, storageBucket: "b", storageKey: `reports/${id}/v1.pdf`, generatedAtUtc: new Date(), sizeBytes: 1_000n },
      });
      await prisma.verificationPackage.create({
        data: {
          evidenceId: id,
          version: 1,
          storageBucket: bucket,
          storageKey: key,
          generatedAtUtc: new Date(),
          sizeBytes: BigInt(body.length),
          reportVersion: 1,
          disclosureProfile: "EXTERNAL_DISCLOSURE",
          packageSha256: createHash("sha256").update(body).digest("hex"),
        } as never,
      });
      return id;
    }

    it("POSITIVE: a grant that allows the download gets the file, and custody records it", async () => {
      const id = await recordWithPackage(a);
      const wf = await workflowOn(a, id);
      const g = await invited(a, { kind: "EVIDENCE", evidenceId: id }, { allowPackageDownload: true });
      const session = await signIn(g.rawToken);
      const before = await prisma.custodyEvent.count({ where: { evidenceId: id, eventType: "DOWNLOAD_AUTHORIZED" as never } });
      const res = await pkg(wf, g.rawToken, session);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ disclosureProfile: "EXTERNAL_DISCLOSURE" });
      expect(await prisma.custodyEvent.count({ where: { evidenceId: id, eventType: "DOWNLOAD_AUTHORIZED" as never } })).toBe(before + 1);
    });

    it("a grant without the download is refused with its reason; custody records nothing", async () => {
      const id = await recordWithPackage(a);
      const wf = await workflowOn(a, id);
      const g = await invited(a, { kind: "EVIDENCE", evidenceId: id }, { allowPackageDownload: false });
      const session = await signIn(g.rawToken);
      const before = await prisma.custodyEvent.count({ where: { evidenceId: id } });
      const res = await pkg(wf, g.rawToken, session);
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error.code).toBe("package_download_not_granted");
      expect(await prisma.custodyEvent.count({ where: { evidenceId: id } })).toBe(before);
    });

    it("a workflow outside the grant, another tenant's among them, is out of scope; no session gets nothing", async () => {
      const id = await recordWithPackage(a);
      const g = await invited(a, { kind: "EVIDENCE", evidenceId: id }, { allowPackageDownload: true });
      const session = await signIn(g.rawToken);
      for (const wf of [siblingWorkflow, foreignWorkflow]) {
        const res = await pkg(wf, g.rawToken, session);
        expect(res.statusCode, res.body).toBe(403);
        expect(res.json().denial).toBe("OUT_OF_SCOPE");
      }
      const anonymous = await kit.call("GET", `/v1/portal/work/${workflow}/verification-package`, null);
      expect(anonymous.statusCode, anonymous.body).toBe(401);
    });
  });
});
