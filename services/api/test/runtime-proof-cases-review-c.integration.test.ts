/**
 * BATCH K4 (part C) — runtime proof for the workflow-instance, intake-link and
 * workflow-template mutations the UI sweep could not drive to their success
 * branch.
 *
 * Every action is proven three ways against a disposable PostgreSQL 16:
 *   1. the authorized SUCCESS branch, with the payload the product consumer
 *      sends, re-reading the exact row/column the action exists to change;
 *   2. the AUDIT record where the route writes one;
 *   3. an EXPECTED REFUSAL with its bounded status/code and no durable effect.
 *
 * Payloads come from the real consumers:
 *   - apps/web/app/(app)/intake-links/_lib/wizardState.ts          (buildCreateBody)
 *   - apps/web/app/(app)/workflows/[id]/page.tsx                   (performAction body)
 * Routes with no current web consumer (POST /v1/workflows/instances) take their
 * contract from the route's zod schema. The workspace template mutations were
 * retired to typed 410s on 2026-09-16; their block pins the tombstone.
 *
 * Step-up is satisfied exactly as step-up-totp-org-boundary.integration.test.ts
 * does: a verified authenticator factor, then the real start/check routes.
 * Each step-up actor has its own factor so no authenticator code is replayed.
 *
 * Fire-and-forget sinks (`void emitTenantAudit`) are read with `expect.poll` — a bounded wait for a write the product already
 * dispatched, never a retry of the action under test.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Prisma = (typeof import("../src/db.js"))["prisma"];

describe("K4-C — workflow instances, intake links, templates (live PostgreSQL 16)", () => {
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

  const auditRow = (action: string, resourceId: string) =>
    prisma.adminAuditLog.findFirst({
      where: { action, resourceId },
      orderBy: { createdAt: "desc" },
    });

  const pollAudit = (action: string, resourceId: string) =>
    expect.poll(
      () =>
        prisma.adminAuditLog.findFirst({
          where: { action, resourceId, outcome: "success" },
          orderBy: { createdAt: "desc" },
          select: { userId: true, workspaceId: true, outcome: true, resourceType: true },
        }),
      { timeout: 10_000, interval: 25 },
    );

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
  async function stepUp(
    token: string,
    userId: string,
    teamId: string,
    resourceKind: string,
    resourceId: string,
  ): Promise<string> {
    const start = await call({
      method: "POST",
      url: "/v1/identity-security/step-up/start",
      token,
      payload: { teamId, purpose: "SESSION_SANITY_CHECK", resourceKind, resourceId },
    });
    expect(start.statusCode, start.body).toBe(200);
    expect(start.json().method).toBe("TOTP");
    const challengeId = start.json().challenge.id as string;
    const code = totp.computeTotpCode(
      secrets.get(userId)!,
      totp.timeStep(Math.floor(Date.now() / 1000)),
    );
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
    process.env.WORKFLOW_INTAKE_LINKS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_TOKEN_SECRET =
      process.env.WORKFLOW_INTAKE_TOKEN_SECRET ?? "integration-only-intake-secret-k4-0123456789abcdef";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    totp = await import("../src/services/security/mfa-totp.js");

    // Organization A is an Enterprise customer: secure intake is included.
    // Organization B stays on the FREE default.
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
    // Step-up actors — an authenticator app each.
    await seedTotp(teamA.adminUserId);
    await seedTotp(teamA.ownerUserId);
    await seedTotp(teamA.memberUserId);
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  // ===========================================================================
  // Workflow instances (Phase 22, deprecated but live)
  // ===========================================================================
  describe("workflow instances", () => {
    const createBody = (teamId: string, title: string) => ({
      teamId,
      intakeMode: "AUTHENTICATED_STANDARD",
      actorRole: "OPERATOR",
      title,
      matterRef: "MAT-2026-041",
      steps: [
        { stepKey: "scene-photo", title: "Scene photo", required: true, orderIndex: 0, acceptedKinds: ["PHOTO"] },
        { stepKey: "statement", title: "Written statement", required: false, orderIndex: 1, acceptedKinds: ["DOCUMENT"] },
      ],
    });

    async function createInstance(title = `k4 wf ${tag()}`) {
      const a = h.fixtures.teamA;
      const res = await call({ method: "POST", url: "/v1/workflows/instances", token: a.memberToken, payload: createBody(a.teamId, title) });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().instance.id as string;
    }

    it("POST /v1/workflows/instances — a member creates a DRAFT instance with its step snapshot; audited", async () => {
      const a = h.fixtures.teamA;
      const title = `Claim intake ${tag()}`;
      const id = await createInstance(title);
      const row = await prisma.evidenceWorkflowInstance.findUniqueOrThrow({
        where: { id },
        include: { stepInstances: { orderBy: { orderIndex: "asc" } } },
      });
      expect(row).toMatchObject({
        teamId: a.teamId,
        status: "DRAFT",
        intakeMode: "AUTHENTICATED_STANDARD",
        actorRole: "OPERATOR",
        title,
        matterRef: "MAT-2026-041",
        createdByUserId: a.memberUserId,
      });
      expect(row.stepInstances.map((s) => [s.stepKey, s.required, s.status])).toEqual([
        ["scene-photo", true, "NOT_STARTED"],
        ["statement", false, "NOT_STARTED"],
      ]);
      expect(await auditRow("workflow.instance.create", id)).toMatchObject({
        userId: a.memberUserId,
        workspaceId: a.teamId,
        outcome: "success",
        resourceType: "evidence_workflow_instance",
      });
    });

    it("POST /v1/workflows/instances — another tenant is concealed 404 and an external role on an internal mode is refused; nothing written", async () => {
      const a = h.fixtures.teamA;
      const title = `Refused ${tag()}`;
      const foreign = await call({ method: "POST", url: "/v1/workflows/instances", token: h.fixtures.teamB.ownerToken, payload: createBody(a.teamId, title) });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json()).toEqual({ error: { code: "not_found" } });
      const badRole = await call({
        method: "POST",
        url: "/v1/workflows/instances",
        token: a.memberToken,
        payload: { ...createBody(a.teamId, title), actorRole: "EXTERNAL_CONTRIBUTOR" },
      });
      expect(badRole.statusCode).toBe(403);
      expect(badRole.json()).toEqual({ error: { code: "WORKFLOW_ACTOR_NOT_PERMITTED" } });
      expect(await prisma.evidenceWorkflowInstance.count({ where: { title } })).toBe(0);
    });

    it("POST /v1/workflows/instances/:id/steps/:stepKey/waive — refused without step-up and for another tenant; step unchanged", async () => {
      const a = h.fixtures.teamA;
      const id = await createInstance();
      const url = `/v1/workflows/instances/${id}/steps/scene-photo/waive`;
      const noStepUp = await call({ method: "POST", url, token: a.adminToken, payload: { teamId: a.teamId, reason: "Scene no longer accessible." } });
      expect(noStepUp.statusCode).toBe(401);
      expect(noStepUp.json().error.code).toBe("STEP_UP_REQUIRED");
      const foreign = await call({ method: "POST", url, token: h.fixtures.teamB.ownerToken, payload: { teamId: a.teamId, reason: "x" } });
      expect(foreign.statusCode).toBe(404);
      // A challenge approved for ANOTHER instance does not satisfy this one.
      const otherId = await createInstance();
      const wrongResource = await stepUp(a.memberToken, a.memberUserId, a.teamId, "evidence_workflow_step_instance", otherId);
      const mismatch = await call({
        method: "POST",
        url,
        token: a.memberToken,
        payload: { teamId: a.teamId, reason: "x" },
        headers: { "x-proovra-step-up-challenge-id": wrongResource },
      });
      expect(mismatch.statusCode).toBe(401);
      expect(mismatch.json().error.code).toBe("STEP_UP_REQUIRED");
      // Refused before consumption: the mismatched approval is not spent.
      expect((await prisma.stepUpChallenge.findUniqueOrThrow({ where: { id: wrongResource } })).status).toBe("APPROVED");
      const step = await prisma.evidenceWorkflowStepInstance.findFirstOrThrow({ where: { workflowInstanceId: id, stepKey: "scene-photo" } });
      expect(step.status).toBe("NOT_STARTED");
      expect(step.waiverReason).toBeNull();
    });

    it("POST /v1/workflows/instances/:id/steps/:stepKey/waive — the OWNER with an approved step-up waives the step; audited", async () => {
      const a = h.fixtures.teamA;
      const id = await createInstance();
      const challengeId = await stepUp(a.ownerToken, a.ownerUserId, a.teamId, "evidence_workflow_step_instance", id);
      const res = await call({
        method: "POST",
        url: `/v1/workflows/instances/${id}/steps/scene-photo/waive`,
        token: a.ownerToken,
        payload: { teamId: a.teamId, reason: "Scene no longer accessible." },
        headers: { "x-proovra-step-up-challenge-id": challengeId },
      });
      expect(res.statusCode, res.body).toBe(200);
      const step = await prisma.evidenceWorkflowStepInstance.findFirstOrThrow({ where: { workflowInstanceId: id, stepKey: "scene-photo" } });
      expect(step).toMatchObject({
        status: "WAIVED",
        waiverReason: "Scene no longer accessible.",
        completedByUserId: a.ownerUserId,
      });
      expect(await auditRow("workflow.step.waive", step.id)).toMatchObject({
        userId: a.ownerUserId,
        workspaceId: a.teamId,
        outcome: "success",
        resourceType: "evidence_workflow_step_instance",
      });
      // The challenge is spent — replaying it is refused and changes nothing.
      const replay = await call({
        method: "POST",
        url: `/v1/workflows/instances/${id}/steps/statement/waive`,
        token: a.ownerToken,
        payload: { teamId: a.teamId, reason: "replay" },
        headers: { "x-proovra-step-up-challenge-id": challengeId },
      });
      expect(replay.statusCode).toBe(401);
      expect(replay.json().error.code).toBe("STEP_UP_REQUIRED");
      expect(
        (await prisma.evidenceWorkflowStepInstance.findFirstOrThrow({ where: { workflowInstanceId: id, stepKey: "statement" } })).status,
      ).toBe("NOT_STARTED");
    });

    it("POST /v1/workflows/instances/:id/cancel — refused without step-up and for another tenant; status unchanged", async () => {
      const a = h.fixtures.teamA;
      const id = await createInstance();
      const url = `/v1/workflows/instances/${id}/cancel`;
      const noStepUp = await call({ method: "POST", url, token: a.adminToken, payload: { teamId: a.teamId } });
      expect(noStepUp.statusCode).toBe(401);
      expect(noStepUp.json().error.code).toBe("STEP_UP_REQUIRED");
      const foreign = await call({ method: "POST", url, token: h.fixtures.teamB.ownerToken, payload: { teamId: a.teamId } });
      expect(foreign.statusCode).toBe(404);
      const intoOwnTeam = await call({ method: "POST", url, token: h.fixtures.teamB.ownerToken, payload: { teamId: h.fixtures.teamB.teamId } });
      expect(intoOwnTeam.statusCode).toBe(401);
      expect((await prisma.evidenceWorkflowInstance.findUniqueOrThrow({ where: { id } })).status).toBe("DRAFT");
    });

    it("POST /v1/workflows/instances/:id/cancel — an ADMIN with an approved step-up cancels; status + closedAt re-read; audited", async () => {
      const a = h.fixtures.teamA;
      const id = await createInstance();
      const challengeId = await stepUp(a.adminToken, a.adminUserId, a.teamId, "evidence_workflow_instance", id);
      // workflows/[id]/page.tsx performAction("/cancel", {}) → { teamId }.
      const res = await call({
        method: "POST",
        url: `/v1/workflows/instances/${id}/cancel`,
        token: a.adminToken,
        payload: { teamId: a.teamId },
        headers: { "x-proovra-step-up-challenge-id": challengeId },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().instance.status).toBe("CANCELLED");
      const row = await prisma.evidenceWorkflowInstance.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe("CANCELLED");
      expect(row.closedAtUtc).toBeInstanceOf(Date);
      const audit = await auditRow("workflow.instance.transition.cancelled", id);
      expect(audit).toMatchObject({ userId: a.adminUserId, workspaceId: a.teamId, outcome: "success" });
      expect(audit?.metadata as Record<string, unknown>).toMatchObject({ from: "DRAFT", to: "CANCELLED" });
      const stepUpRow = await prisma.stepUpChallenge.findUniqueOrThrow({ where: { id: challengeId } });
      expect(stepUpRow.status).toBe("CANCELLED");
    });
  });

  // ===========================================================================
  // Workflow intake links
  // ===========================================================================
  describe("POST /v1/workflow/intake-links", () => {
    /** wizardState.ts buildCreateBody for a single-use "Copy link" request. */
    const wizardBody = (teamId: string, customerId: string) => ({
      teamId,
      workflowTemplateSlug: "general-evidence-record",
      intakeMode: "EXTERNAL_ONE_TIME",
      deliveryMethod: "MANUAL",
      intakeUrlBase: undefined,
      recipientLabel: "Claimant",
      customerId,
      recipientEmail: null,
      recipientPhone: null,
      maxUses: 1,
      maxFileCountPerSession: 10,
      allowedAcceptedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"],
      consentDisclosureText: null,
      expiresAtUtc: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
      idempotencyKey: randomUUID(),
      senderDisplayMode: "WORKSPACE",
      senderDisplayName: null,
      locationPolicy: "OPTIONAL",
    });

    it("a MEMBER creates a single-use link; the row, its snapshot and token hash re-read; audited", async () => {
      const a = h.fixtures.teamA;
      const customerId = `CUST-${tag()}`;
      const res = await call({ method: "POST", url: "/v1/workflow/intake-links", token: a.memberToken, payload: wizardBody(a.teamId, customerId) });
      expect(res.statusCode, res.body).toBe(201);
      const body = res.json();
      expect(body.delivery).toEqual({ method: "MANUAL", status: "skipped" });
      const linkId = body.link.id as string;
      const row = await prisma.workflowIntakeLink.findUniqueOrThrow({ where: { id: linkId } });
      expect(row).toMatchObject({
        teamId: a.teamId,
        workflowTemplateSlug: "general-evidence-record",
        intakeMode: "EXTERNAL_ONE_TIME",
        recipientLabel: "Claimant",
        customerId,
        maxUses: 1,
        usedCount: 0,
        maxFileCountPerSession: 10,
        senderDisplayMode: "WORKSPACE",
        locationPolicy: "OPTIONAL",
        createdByUserId: a.memberUserId,
      });
      expect(row.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(row.workflowTemplateSnapshot).toBeTruthy();
      expect(JSON.stringify(body)).not.toContain(row.tokenHash);
      await pollAudit("intake.link.created", linkId).toMatchObject({
        userId: a.memberUserId,
        workspaceId: a.teamId,
        outcome: "success",
        resourceType: "workflow_intake_link",
      });
    });

    it("a VIEWER, a FREE workspace and another tenant are refused; no link written", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const customerId = `REFUSED-${tag()}`;
      const viewer = await call({ method: "POST", url: "/v1/workflow/intake-links", token: a.viewerToken, payload: wizardBody(a.teamId, customerId) });
      expect([403, 404]).toContain(viewer.statusCode);
      expect(viewer.statusCode).toBe(403);
      const free = await call({ method: "POST", url: "/v1/workflow/intake-links", token: b.ownerToken, payload: wizardBody(b.teamId, customerId) });
      expect(free.statusCode).toBe(409);
      expect(free.json().error.code).toBe("INTAKE_NOT_INCLUDED");
      const foreign = await call({ method: "POST", url: "/v1/workflow/intake-links", token: b.ownerToken, payload: wizardBody(a.teamId, customerId) });
      expect(foreign.statusCode).toBe(404);
      expect(await prisma.workflowIntakeLink.count({ where: { customerId } })).toBe(0);
    });
  });

  // ===========================================================================
  // Workspace workflow templates — RETIRED 2026-09-16 (owner decision)
  //
  // Workspace-level template authoring is out of scope; templates are
  // platform-managed. POST /v1/workflow/templates, PATCH .../:id and
  // POST .../:id/archive are typed 410 tombstones. These cases used to prove an
  // ADMIN create; they now prove, against the live database, that no caller
  // can create, edit or archive a template, that an anonymous caller is still
  // refused 401, and that an existing (historical) workspace template row is
  // left exactly as it was and is still served by the GET list.
  // ===========================================================================
  describe("workspace workflow template authoring (retired)", () => {
    const templateBody = (teamId: string, slug: string) => ({
      teamId,
      slug,
      name: "Vehicle damage intake",
      description: "Photos of each panel plus the registration document.",
      planMode: "CHECKLIST_REQUIRED",
      locationRequirement: "recommended",
      intakeModes: ["AUTHENTICATED_STANDARD", "EXTERNAL_ONE_TIME"],
      steps: [
        { id: "panels", title: "Damaged panels", description: "One photo per panel.", purposeLabel: "Damage", required: true, acceptedKinds: ["PHOTO", "VIDEO"], minItems: 1 },
      ],
    });
    const expectRetired = (res: { statusCode: number; body: string; json: () => unknown }) => {
      expect(res.statusCode, res.body).toBe(410);
      expect(res.json()).toMatchObject({
        error: { code: "WORKFLOW_TEMPLATE_AUTHORING_RETIRED" },
        canonical: "/v1/workflow/templates",
      });
    };

    it("no caller can create a template; anonymous is 401; nothing is written", async () => {
      const a = h.fixtures.teamA;
      const slug = `retired-create-${tag()}`;
      const anonymous = await h.app.inject({
        method: "POST",
        url: "/v1/workflow/templates",
        headers: { "content-type": "application/json" },
        payload: templateBody(a.teamId, slug),
      });
      expect(anonymous.statusCode).toBe(401);
      for (const token of [a.adminToken, a.memberToken, h.fixtures.teamB.ownerToken]) {
        expectRetired(await call({ method: "POST", url: "/v1/workflow/templates", token, payload: templateBody(a.teamId, slug) }));
      }
      expect(await prisma.evidenceWorkflowTemplate.count({ where: { slug } })).toBe(0);
    });

    it("an existing workspace template cannot be edited or archived, and is still listed unchanged", async () => {
      const a = h.fixtures.teamA;
      const slug = `retired-existing-${tag()}`;
      const existing = await prisma.evidenceWorkflowTemplate.create({
        data: {
          teamId: a.teamId,
          slug,
          name: "Historical workspace template",
          planMode: "CHECKLIST_REQUIRED",
          locationRequirement: "recommended",
          intakeModes: ["AUTHENTICATED_STANDARD"],
          allowedRoles: [],
          stepsJson: templateBody(a.teamId, slug).steps,
          createdByUserId: a.adminUserId,
        },
      });
      try {
        expectRetired(
          await call({ method: "PATCH", url: `/v1/workflow/templates/${existing.id}`, token: a.adminToken, payload: { name: "Renamed" } }),
        );
        expectRetired(
          await call({ method: "POST", url: `/v1/workflow/templates/${existing.id}/archive`, token: a.adminToken }),
        );
        const after = await prisma.evidenceWorkflowTemplate.findUniqueOrThrow({ where: { id: existing.id } });
        expect(after).toMatchObject({ name: "Historical workspace template", version: 1, archived: false, status: "ACTIVE" });
        expect(after.updatedAt.getTime()).toBe(existing.updatedAt.getTime());

        const list = await call({ method: "GET", url: `/v1/workflow/templates?teamId=${a.teamId}`, token: a.memberToken });
        expect(list.statusCode).toBe(200);
        expect((list.json().templates as Array<{ slug: string }>).some((t) => t.slug === slug)).toBe(true);
      } finally {
        await prisma.evidenceWorkflowTemplate.delete({ where: { id: existing.id } });
      }
    });
  });
});
