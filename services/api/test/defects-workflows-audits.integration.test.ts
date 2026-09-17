/**
 * DEFECTS D48 + D52 (2026-09-17) — workflow-instance authority and the missing
 * audit rows, proven through the REAL routes against a disposable
 * PostgreSQL 16.
 *
 * D48 — every /v1/workflows/instances/* route was gated on
 *   `identity.member.read`, which VIEWER holds, so a read-only VIEWER could
 *   create, submit, approve and cancel a workflow instance (and, with any
 *   approved step-up of their own, waive a required step). The one mutation
 *   the product still calls (the detail page's legacy step waive) now needs
 *   the reviewer-ops write capability (`evidence_request.review`); the seven
 *   consumer-less mutations are typed 410 tombstones; the reads need the
 *   reviewer-ops read baseline (`evidence.read`).
 *
 * D52 — coding-value writes (single, bulk code, bulk decide), SIU saved-view
 *   create/rename/share/update/delete and reviewer-ops saved-view
 *   create/delete wrote no adminAuditLog row. Each is proven by re-reading
 *   adminAuditLog after the real request. The reviewer disagreement filing
 *   (part of the same assignment) was ALREADY audited by
 *   reviewer-disagreement.service.ts — proven here as a verification.
 *
 * Step-up follows step-up-totp-org-boundary.integration.test.ts: a verified
 * authenticator factor per actor, then the real start/check routes.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Prisma = (typeof import("../src/db.js"))["prisma"];

describe("D48 + D52 — workflow instances and audit rows (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let totp: typeof import("../src/services/security/mfa-totp.js");
  const secrets = new Map<string, Buffer>();

  const call = (opts: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    url: string;
    token: string;
    payload?: unknown;
    headers?: Record<string, string>;
  }) =>
    h.app.inject({
      method: opts.method,
      url: opts.url,
      headers: {
        authorization: `Bearer ${opts.token}`,
        ...(opts.payload !== undefined ? { "content-type": "application/json" } : {}),
        ...(opts.headers ?? {}),
      },
      ...(opts.payload !== undefined ? { payload: opts.payload as never } : {}),
    });

  const tag = () => randomUUID().slice(0, 8);

  const auditRows = (action: string, resourceId: string) =>
    prisma.adminAuditLog.findMany({
      where: { action, resourceId },
      orderBy: { createdAt: "asc" },
    });

  async function seedTotp(userId: string): Promise<void> {
    const { sealSecret } = await import("../src/services/security/mfa-secret-storage.js");
    const secret = totp.generateTotpSecretBytes();
    const sealed = sealSecret(secret);
    const now = new Date();
    await prisma.mfaFactor.create({
      data: {
        userId,
        kind: "TOTP",
        status: "ACTIVE",
        label: "Authenticator",
        secretCiphertext: Buffer.from(sealed.ciphertext),
        secretIv: Buffer.from(sealed.iv),
        secretAuthTag: Buffer.from(sealed.authTag),
        secretKekId: sealed.kekId,
        verifiedAtUtc: now,
        enrolledAt: now,
      },
    });
    secrets.set(userId, secret);
  }

  /** Real start + check routes; returns the APPROVED challenge id. */
  async function stepUp(token: string, userId: string, teamId: string, resourceId: string): Promise<string> {
    const start = await call({
      method: "POST",
      url: "/v1/identity-security/step-up/start",
      token,
      payload: {
        teamId,
        purpose: "SESSION_SANITY_CHECK",
        resourceKind: "evidence_workflow_step_instance",
        resourceId,
      },
    });
    expect(start.statusCode, start.body).toBe(200);
    const challengeId = start.json().challenge.id as string;
    const code = totp.computeTotpCode(secrets.get(userId)!, totp.timeStep(Math.floor(Date.now() / 1000)));
    const check = await call({
      method: "POST",
      url: "/v1/identity-security/step-up/check",
      token,
      payload: { teamId, challengeId, code },
    });
    expect(check.statusCode, check.body).toBe(200);
    expect(check.json().status).toBe("approved");
    return challengeId;
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    totp = await import("../src/services/security/mfa-totp.js");

    // Organization A is an Enterprise customer: reviewer operations are
    // included, so the reviewer-workspace and reviewer-ops routes reach
    // their handlers.
    const { teamA } = h.fixtures;
    const orgA = (
      await prisma.team.findUniqueOrThrow({ where: { id: teamA.teamId }, select: { organizationId: true } })
    ).organizationId;
    await prisma.team.update({
      where: { id: teamA.teamId },
      data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" },
    });
    const { upsertEnterpriseContract } = await import(
      "../src/services/organization/enterprise-contract.service.js"
    );
    await upsertEnterpriseContract(prisma as never, {
      organizationId: orgA,
      status: "ACTIVE",
      activationState: "ACTIVATED",
      seatCount: 25,
    });
    await seedTotp(teamA.memberUserId);
    await seedTotp(teamA.viewerUserId);
  }, 900_000);

  // One authenticator code per 30-second step: let each step-up reuse the
  // factor without tripping the replay guard.
  beforeEach(async () => {
    if (prisma) {
      await prisma.mfaFactor.updateMany({
        where: { userId: { in: [h.fixtures.teamA.memberUserId, h.fixtures.teamA.viewerUserId] } },
        data: { lastUsedAt: null },
      });
    }
  });

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  // ===========================================================================
  // D48 — workflow instances
  // ===========================================================================
  describe("D48 — /v1/workflows/instances/*", () => {
    /**
     * Seeds a DRAFT Phase 22 instance with its step snapshot directly (create is
     * retired and its engine function was removed, 2026-09-17).
     */
    async function seedInstance(title = `d48 wf ${tag()}`) {
      const a = h.fixtures.teamA;
      const row = await prisma.evidenceWorkflowInstance.create({
        data: {
          teamId: a.teamId,
          status: "DRAFT",
          intakeMode: "AUTHENTICATED_STANDARD",
          actorRole: "OPERATOR",
          title,
          createdByUserId: a.ownerUserId,
          stepInstances: {
            create: [
              { stepKey: "scene-photo", title: "Scene photo", required: true, orderIndex: 0, status: "NOT_STARTED", acceptedKindsJson: ["PHOTO"] },
              { stepKey: "statement", title: "Written statement", required: false, orderIndex: 1, status: "NOT_STARTED", acceptedKindsJson: ["DOCUMENT"] },
            ],
          },
        },
        select: { id: true },
      });
      return row.id;
    }

    const createBody = (teamId: string, title: string) => ({
      teamId,
      intakeMode: "AUTHENTICATED_STANDARD",
      actorRole: "OPERATOR",
      title,
      steps: [{ stepKey: "scene-photo", title: "Scene photo", required: true, orderIndex: 0 }],
    });

    it("D48 a VIEWER cannot create or transition a workflow instance; nothing written", async () => {
      const a = h.fixtures.teamA;
      const id = await seedInstance();
      const title = `viewer-created ${tag()}`;

      const created = await call({
        method: "POST",
        url: "/v1/workflows/instances",
        token: a.viewerToken,
        payload: createBody(a.teamId, title),
      });
      expect(created.statusCode, created.body).toBe(410);
      expect(created.json().error.code).toBe("WORKFLOW_INSTANCE_MUTATION_RETIRED");
      expect(await prisma.evidenceWorkflowInstance.count({ where: { title } })).toBe(0);

      for (const action of ["submit", "approve", "request-changes", "cancel"]) {
        const res = await call({
          method: "POST",
          url: `/v1/workflows/instances/${id}/${action}`,
          token: a.viewerToken,
          payload: { teamId: a.teamId },
        });
        expect(res.statusCode, `${action}: ${res.body}`).toBe(410);
      }
      const assign = await call({
        method: "POST",
        url: `/v1/workflows/instances/${id}/assign-reviewer`,
        token: a.viewerToken,
        payload: { teamId: a.teamId, reviewerUserId: a.viewerUserId },
      });
      expect(assign.statusCode, assign.body).toBe(410);

      const row = await prisma.evidenceWorkflowInstance.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ status: "DRAFT", assignedReviewerUserId: null, submittedAtUtc: null });
      expect(
        await prisma.adminAuditLog.count({
          where: { userId: a.viewerUserId, action: { startsWith: "workflow." } },
        }),
      ).toBe(0);
    });

    it("D48 a VIEWER cannot waive a required step — even holding an approved step-up; step unchanged", async () => {
      const a = h.fixtures.teamA;
      const id = await seedInstance();
      const url = `/v1/workflows/instances/${id}/steps/scene-photo/waive`;
      // A VIEWER who completes a step-up of their own is still refused on
      // PERMISSION: step-up proves who you are, not what you may do.
      const challengeId = await stepUp(a.viewerToken, a.viewerUserId, a.teamId, id);
      const elevated = await call({
        method: "POST",
        url,
        token: a.viewerToken,
        payload: { teamId: a.teamId, reason: "Viewer waive." },
        headers: { "x-proovra-step-up-challenge-id": challengeId },
      });
      expect(elevated.statusCode, elevated.body).toBe(403);
      expect(elevated.json()).toEqual({ error: { code: "permission_denied", reason: "permission_not_granted" } });
      // Without step-up the refusal is the same — the VIEWER is not invited to
      // verify for an action they can never take.
      const bare = await call({ method: "POST", url, token: a.viewerToken, payload: { teamId: a.teamId, reason: "Viewer waive." } });
      expect(bare.statusCode, bare.body).toBe(403);
      expect(bare.json().error.code).toBe("permission_denied");

      const steps = await prisma.evidenceWorkflowStepInstance.findMany({
        where: { workflowInstanceId: id },
        orderBy: { orderIndex: "asc" },
      });
      expect(steps.map((s) => [s.stepKey, s.status, s.waiverReason])).toEqual([
        ["scene-photo", "NOT_STARTED", null],
        ["statement", "NOT_STARTED", null],
      ]);
      expect(
        await prisma.adminAuditLog.count({
          where: { userId: a.viewerUserId, action: "workflow.step.waive" },
        }),
      ).toBe(0);
    });

    it("D48 a reviewer (DB MEMBER) with an approved step-up waives the step; audited", async () => {
      const a = h.fixtures.teamA;
      const id = await seedInstance();
      const url = `/v1/workflows/instances/${id}/steps/scene-photo/waive`;
      const bare = await call({ method: "POST", url, token: a.memberToken, payload: { teamId: a.teamId, reason: "Scene no longer accessible." } });
      expect(bare.statusCode).toBe(401);
      expect(bare.json().error.code).toBe("STEP_UP_REQUIRED");

      const challengeId = await stepUp(a.memberToken, a.memberUserId, a.teamId, id);
      const res = await call({
        method: "POST",
        url,
        token: a.memberToken,
        payload: { teamId: a.teamId, reason: "Scene no longer accessible." },
        headers: { "x-proovra-step-up-challenge-id": challengeId },
      });
      expect(res.statusCode, res.body).toBe(200);
      const step = await prisma.evidenceWorkflowStepInstance.findFirstOrThrow({
        where: { workflowInstanceId: id, stepKey: "scene-photo" },
      });
      expect(step).toMatchObject({
        status: "WAIVED",
        waiverReason: "Scene no longer accessible.",
        completedByUserId: a.memberUserId,
      });
      expect(await auditRows("workflow.step.waive", step.id)).toEqual([
        expect.objectContaining({
          userId: a.memberUserId,
          workspaceId: a.teamId,
          outcome: "success",
          resourceType: "evidence_workflow_step_instance",
        }),
      ]);
    });

    it("D48 the OWNER is also answered 410 by every retired mutation, and nothing changes", async () => {
      const a = h.fixtures.teamA;
      const id = await seedInstance();
      const cases: Array<[string, Record<string, unknown>, string]> = [
        ["submit", { teamId: a.teamId }, "/v1/reviewer-ops/reviews/:workflowId/start"],
        ["approve", { teamId: a.teamId }, "/v1/reviewer-ops/reviews/:workflowId/approve"],
        ["request-changes", { teamId: a.teamId }, "/v1/reviewer-ops/reviews/:workflowId/request-info"],
        ["cancel", { teamId: a.teamId }, "/v1/reviewer-ops/reviews/:workflowId/reject"],
        ["assign-reviewer", { teamId: a.teamId, reviewerUserId: a.memberUserId }, "/v1/reviewer-ops/reviews/:workflowId/assign"],
        [
          "steps/scene-photo/map-evidence",
          { teamId: a.teamId, evidenceId: randomUUID() },
          "/v1/reviewer-ops/workspace/:workflowId",
        ],
      ];
      for (const [path, payload, canonical] of cases) {
        const res = await call({ method: "POST", url: `/v1/workflows/instances/${id}/${path}`, token: a.ownerToken, payload });
        expect(res.statusCode, `${path}: ${res.body}`).toBe(410);
        expect(res.json()).toMatchObject({
          error: { code: "WORKFLOW_INSTANCE_MUTATION_RETIRED" },
          canonical,
        });
      }
      const created = await call({
        method: "POST",
        url: "/v1/workflows/instances",
        token: a.ownerToken,
        payload: createBody(a.teamId, `owner ${tag()}`),
      });
      expect(created.statusCode).toBe(410);
      expect(created.json().canonical).toBe("/v1/reviewer-ops/queue");

      const row = await prisma.evidenceWorkflowInstance.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ status: "DRAFT", assignedReviewerUserId: null, submittedAtUtc: null, closedAtUtc: null });
      expect(await prisma.evidenceWorkflowInstanceEvidence.count({ where: { workflowInstanceId: id } })).toBe(0);
      expect(
        await prisma.adminAuditLog.count({
          where: { resourceId: id, action: { startsWith: "workflow.instance.transition" } },
        }),
      ).toBe(0);
    });

    it("D48 reads stay available to members (VIEWER included) and conceal the instance from another tenant", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const id = await seedInstance();
      const qs = `?teamId=${a.teamId}`;
      for (const token of [a.viewerToken, a.memberToken, a.ownerToken]) {
        const detail = await call({ method: "GET", url: `/v1/workflows/instances/${id}${qs}`, token });
        expect(detail.statusCode, detail.body).toBe(200);
        expect(detail.json().instance.id).toBe(id);
        const timeline = await call({ method: "GET", url: `/v1/workflows/instances/${id}/timeline${qs}`, token });
        expect(timeline.statusCode, timeline.body).toBe(200);
        const policy = await call({ method: "GET", url: `/v1/workflows/instances/${id}/export-policy${qs}`, token });
        expect(policy.statusCode, policy.body).toBe(200);
        const list = await call({ method: "GET", url: `/v1/workflows/instances${qs}`, token });
        expect(list.statusCode, list.body).toBe(200);
        expect((list.json().instances as Array<{ id: string }>).some((r) => r.id === id)).toBe(true);
      }
      const foreign = await call({ method: "GET", url: `/v1/workflows/instances/${id}${qs}`, token: b.ownerToken });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json()).toEqual({ error: { code: "not_found" } });
      const foreignWaive = await call({
        method: "POST",
        url: `/v1/workflows/instances/${id}/steps/scene-photo/waive`,
        token: b.ownerToken,
        payload: { teamId: a.teamId, reason: "x" },
      });
      expect(foreignWaive.statusCode).toBe(404);
      expect(foreignWaive.json()).toEqual({ error: { code: "not_found" } });
    });
  });

  // ===========================================================================
  // D52 — reviewer coding values
  // ===========================================================================
  describe("D52 — reviewer coding values", () => {
    const schemaBody = (slug: string) => ({
      slug,
      label: "Claims photo coding",
      category: "INSURANCE_REVIEW",
      fields: [
        { slug: "damage-summary", label: "Damage summary", fieldType: "TEXT", required: true, orderIndex: 0 },
        { slug: "estimate", label: "Estimate", fieldType: "NUMERIC", required: false, orderIndex: 1, options: { min: 0 } },
        { slug: "verdict", label: "Verdict", fieldType: "REVIEWER_VERDICT", required: false, orderIndex: 2 },
      ],
    });

    async function publishedSchema() {
      const a = h.fixtures.teamA;
      const created = await call({
        method: "POST",
        url: `/v1/coding/schemas?teamId=${a.teamId}`,
        token: a.ownerToken,
        payload: schemaBody(`d52-${tag()}`),
      });
      expect(created.statusCode, created.body).toBe(201);
      const schemaId = created.json().schemaId as string;
      const { publishSchema } = await import("../src/services/reviewer-workspace/coding-schema.service.js");
      expect(await publishSchema({ teamId: a.teamId, schemaId })).toMatchObject({ ok: true });
      const fields = await prisma.codingField.findMany({ where: { schemaId }, orderBy: { orderIndex: "asc" } });
      return { schemaId, fields };
    }

    async function boundWorkflow(schemaId: string | null) {
      const a = h.fixtures.teamA;
      const team = await prisma.team.findUniqueOrThrow({ where: { id: a.teamId }, select: { organizationId: true } });
      const evidence = await prisma.evidence.create({
        data: {
          title: `d52 evidence ${tag()}`,
          type: "PHOTO",
          status: "SIGNED",
          mimeType: "image/jpeg",
          teamId: a.teamId,
          organizationId: team.organizationId,
          ownerUserId: a.ownerUserId,
        },
        select: { id: true },
      });
      const wf = await prisma.evidenceReviewWorkflow.create({
        data: { evidenceId: evidence.id, teamId: a.teamId, workspaceType: "TEAM" },
        select: { id: true },
      });
      if (schemaId) {
        const res = await call({
          method: "POST",
          url: `/v1/reviewer/work/${wf.id}/bind-schema?teamId=${a.teamId}`,
          token: a.adminToken,
          payload: { schemaId },
        });
        expect(res.statusCode, res.body).toBe(200);
      }
      return wf.id;
    }

    const SECRET_TEXT = "Dent on the rear door near the fuel cap";

    it("D52 a single coding write records a tenant audit row without the coded value; a refused write records a denial", async () => {
      const a = h.fixtures.teamA;
      const { schemaId, fields } = await publishedSchema();
      const workflowId = await boundWorkflow(schemaId);
      const summary = fields.find((f) => f.slug === "damage-summary")!;
      const estimate = fields.find((f) => f.slug === "estimate")!;
      const url = `/v1/reviewer/work/${workflowId}/code?teamId=${a.teamId}`;

      const ok = await call({
        method: "POST",
        url,
        token: a.memberToken,
        payload: { fieldId: summary.id, value: { text: SECRET_TEXT }, rationale: "Visible in frame 2." },
      });
      expect(ok.statusCode, ok.body).toBe(200);
      const codingValueId = ok.json().codingValueId as string;
      const rows = await auditRows("reviewer.code.write", codingValueId);
      expect(rows).toEqual([
        expect.objectContaining({
          userId: a.memberUserId,
          workspaceId: a.teamId,
          outcome: "success",
          resourceType: "coding_value",
          resourceId: codingValueId,
        }),
      ]);
      expect(rows[0]!.metadata).toMatchObject({ workflowId, fieldId: summary.id });
      const serialised = JSON.stringify(rows[0]);
      expect(serialised).not.toContain("Dent on the rear door");
      expect(serialised).not.toContain("Visible in frame 2");

      const refused = await call({
        method: "POST",
        url,
        token: a.memberToken,
        payload: { fieldId: estimate.id, value: { number: -5 } },
      });
      expect(refused.statusCode).toBe(409);
      const denied = await auditRows("reviewer.code.write", workflowId);
      expect(denied).toEqual([
        expect.objectContaining({
          userId: a.memberUserId,
          workspaceId: a.teamId,
          outcome: "denied",
          resourceType: "evidence_review_workflow",
          reasonCode: "FIELD_VALIDATION_FAILED",
        }),
      ]);
      expect(denied[0]!.metadata).toMatchObject({ denialReason: "FIELD_VALIDATION_FAILED", fieldId: estimate.id });
    });

    it("D52 bulk code and bulk decide record one audit row per workflow, without the value or verdict", async () => {
      const a = h.fixtures.teamA;
      const { schemaId } = await publishedSchema();
      const w1 = await boundWorkflow(schemaId);
      const w2 = await boundWorkflow(schemaId);
      const unbound = await boundWorkflow(null);

      const code = await call({
        method: "POST",
        url: `/v1/reviewer/bulk/code?teamId=${a.teamId}`,
        token: a.adminToken,
        payload: { fieldSlug: "estimate", value: { number: 987654 }, workflowIds: [w1, w2, unbound] },
      });
      expect(code.statusCode, code.body).toBe(200);
      expect(code.json().succeeded).toBe(2);
      for (const w of [w1, w2]) {
        const rows = await auditRows("reviewer.code.bulk_write", w);
        expect(rows).toEqual([
          expect.objectContaining({
            userId: a.adminUserId,
            workspaceId: a.teamId,
            outcome: "success",
            resourceType: "evidence_review_workflow",
          }),
        ]);
        expect(rows[0]!.metadata).toMatchObject({ workflowId: w, fieldSlug: "estimate", bulk: true });
        expect(JSON.stringify(rows[0])).not.toContain("987654");
      }
      expect(await auditRows("reviewer.code.bulk_write", unbound)).toEqual([
        expect.objectContaining({ outcome: "denied", reasonCode: "SCHEMA_NOT_FOUND", userId: a.adminUserId }),
      ]);

      const decide = await call({
        method: "POST",
        url: `/v1/reviewer/bulk/decide?teamId=${a.teamId}`,
        token: a.adminToken,
        payload: { verdict: "ESCALATE", rationale: "Needs a second look at the invoice", workflowIds: [w1] },
      });
      expect(decide.statusCode, decide.body).toBe(200);
      expect(decide.json().succeeded).toBe(1);
      const decided = await auditRows("reviewer.code.bulk_decide", w1);
      expect(decided).toEqual([
        expect.objectContaining({ userId: a.adminUserId, workspaceId: a.teamId, outcome: "success" }),
      ]);
      const text = JSON.stringify(decided[0]);
      expect(text).not.toContain("ESCALATE");
      expect(text).not.toContain("second look");
    });

    it("D52 (verify) filing a disagreement was already audited by the disagreement service", async () => {
      const a = h.fixtures.teamA;
      const workflowId = await boundWorkflow(null);
      const decision = await prisma.workflowReviewDecision.create({
        data: {
          workflowId,
          teamId: a.teamId,
          stage: "FIRST",
          reviewerUserId: a.adminUserId,
          decision: "APPROVE",
          rationale: "Looks consistent.",
        },
        select: { id: true },
      });
      const res = await call({
        method: "POST",
        url: `/v1/reviewer/work/${workflowId}/disagree?teamId=${a.teamId}`,
        token: a.memberToken,
        payload: { originalDecisionId: decision.id, rationale: "The timestamp overlay is cropped." },
      });
      expect(res.statusCode, res.body).toBe(201);
      const disagreementId = res.json().disagreementId as string;
      const rows = await auditRows("reviewer.disagreement.filed", disagreementId);
      expect(rows).toEqual([
        expect.objectContaining({
          userId: a.memberUserId,
          workspaceId: a.teamId,
          outcome: "success",
          resourceType: "reviewer_disagreement",
        }),
      ]);
      expect(JSON.stringify(rows[0])).not.toContain("timestamp overlay");
    });
  });

  // ===========================================================================
  // D52 — SIU saved views
  // ===========================================================================
  describe("D52 — SIU saved views", () => {
    it("D52 SIU saved view create, rename, share, update and delete each record an audit row", async () => {
      const a = h.fixtures.teamA;
      const name = `SIU private ${tag()}`;
      const created = await call({
        method: "POST",
        url: "/v1/siu/saved-views",
        token: a.memberToken,
        payload: {
          teamId: a.teamId,
          name,
          filter: { investigationStatus: ["review"] },
          sort: { key: "updatedAtUtc", direction: "desc" },
          visibility: "private",
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json().view.id as string;
      const orgA = (await prisma.team.findUniqueOrThrow({ where: { id: a.teamId } })).organizationId;
      const expectRow = async (action: string, extra: Record<string, unknown> = {}) => {
        const rows = await auditRows(action, id);
        expect(rows, action).toEqual([
          expect.objectContaining({
            userId: a.memberUserId,
            workspaceId: a.teamId,
            organizationId: orgA,
            outcome: "success",
            resourceType: "siu_saved_view",
            ...extra,
          }),
        ]);
        expect(JSON.stringify(rows[0])).not.toContain("SIU private");
        return rows[0]!;
      };
      await expectRow("siu.saved_view.create", { resultingState: "private" });

      const url = `/v1/siu/saved-views/${id}?teamId=${a.teamId}`;
      const renamed = await call({ method: "PATCH", url, token: a.memberToken, payload: { name: "SIU renamed" } });
      expect(renamed.statusCode, renamed.body).toBe(200);
      await expectRow("siu.saved_view.rename");

      const shared = await call({ method: "PATCH", url, token: a.memberToken, payload: { visibility: "team" } });
      expect(shared.statusCode, shared.body).toBe(200);
      await expectRow("siu.saved_view.share", { previousState: "private", resultingState: "team" });

      const updated = await call({
        method: "PATCH",
        url,
        token: a.memberToken,
        payload: { filter: { investigationStatus: ["review"], requireOpenFollowUps: true } },
      });
      expect(updated.statusCode, updated.body).toBe(200);
      const update = await expectRow("siu.saved_view.update");
      expect(update.metadata).toMatchObject({ changedFields: ["filter"] });
      // The rename and share did not also produce an "update" row, and the
      // filter change did not produce another rename/share row.
      expect(await auditRows("siu.saved_view.rename", id)).toHaveLength(1);
      expect(await auditRows("siu.saved_view.share", id)).toHaveLength(1);

      const deleted = await call({ method: "DELETE", url, token: a.memberToken });
      expect(deleted.statusCode, deleted.body).toBe(200);
      await expectRow("siu.saved_view.delete", { previousState: "team" });
    });

    it("D52 a refused SIU saved-view change writes no audit row", async () => {
      const a = h.fixtures.teamA;
      const created = await call({
        method: "POST",
        url: "/v1/siu/saved-views",
        token: a.memberToken,
        payload: {
          teamId: a.teamId,
          name: `SIU team ${tag()}`,
          filter: {},
          sort: { key: "updatedAtUtc", direction: "desc" },
          visibility: "team",
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json().view.id as string;
      const url = `/v1/siu/saved-views/${id}?teamId=${a.teamId}`;
      const viewer = await call({ method: "PATCH", url, token: a.viewerToken, payload: { name: "Hijacked" } });
      expect(viewer.statusCode).toBe(404);
      const viewerDelete = await call({ method: "DELETE", url, token: a.viewerToken });
      expect(viewerDelete.statusCode).toBe(404);
      expect(
        await prisma.adminAuditLog.count({ where: { resourceId: id, userId: a.viewerUserId } }),
      ).toBe(0);
    });
  });

  // ===========================================================================
  // D52 — reviewer-ops saved queue views
  // ===========================================================================
  describe("D52 — reviewer-ops saved views", () => {
    it("D52 reviewer-ops saved view create and delete each record an audit row", async () => {
      const a = h.fixtures.teamA;
      const name = `Queue ${tag()}`;
      const created = await call({
        method: "POST",
        url: "/v1/reviewer-ops/saved-views",
        token: a.memberToken,
        payload: { teamId: a.teamId, name, visibility: "TEAM", filter: { teamId: a.teamId } },
      });
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json().view.id as string;
      const createdRows = await auditRows("reviewer.saved_view.create", id);
      expect(createdRows).toEqual([
        expect.objectContaining({
          userId: a.memberUserId,
          workspaceId: a.teamId,
          outcome: "success",
          resourceType: "reviewer_ops_saved_view",
          resultingState: "TEAM",
        }),
      ]);
      expect(JSON.stringify(createdRows[0])).not.toContain(name);

      // A VIEWER's refused delete writes nothing.
      const viewer = await call({
        method: "DELETE",
        url: `/v1/reviewer-ops/saved-views/${id}?teamId=${a.teamId}`,
        token: a.viewerToken,
      });
      expect(viewer.statusCode).toBe(404);
      expect(await auditRows("reviewer.saved_view.delete", id)).toEqual([]);

      const deleted = await call({
        method: "DELETE",
        url: `/v1/reviewer-ops/saved-views/${id}?teamId=${a.teamId}`,
        token: a.adminToken,
      });
      expect(deleted.statusCode, deleted.body).toBe(204);
      expect(await auditRows("reviewer.saved_view.delete", id)).toEqual([
        expect.objectContaining({
          userId: a.adminUserId,
          workspaceId: a.teamId,
          outcome: "success",
          resourceType: "reviewer_ops_saved_view",
          previousState: "TEAM",
        }),
      ]);
    });
  });
});
