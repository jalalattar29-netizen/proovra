/**
 * RC-CONTRACT-WRITER (BILLING-002, PROV-002, RT-003), RC-TERMINATION (PROV-009,
 * BILLING-005, PROV-010, BILLING-006), and PROV-003, PROV-006, PROV-007, PROV-008,
 * PROV-014, BILLING-007 — on real routes and a real PostgreSQL, from a customer
 * that went through provisioning and owner acceptance.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Prisma = import("@prisma/client").PrismaClient;
type Operator = import("./helpers/operator-step-up.js").Operator;

describe("the Enterprise contract and its lifecycle (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let fixtures: typeof import("./point7/product-fixtures.js");
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let steps: typeof import("./helpers/operator-step-up.js");
  let provisioning: typeof import("../src/services/enterprise-provisioning.service.js");
  let closure: typeof import("../src/services/organization/org-closure.service.js");
  let operator: Operator;
  let seededOperators = 0;
  const tag = () => randomUUID().slice(0, 8);
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  const deps = () => ({
    prisma: prisma as never,
    tag: `ctr-${tag()}`,
    mintToken: (userId: string, email: string) =>
      signJwt(
        { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
        process.env.AUTH_JWT_SECRET as string,
        3600,
      ),
  });

  beforeAll(async () => {
    process.env.WORKFLOW_INTAKE_LINKS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_TOKEN_SECRET =
      process.env.WORKFLOW_INTAKE_TOKEN_SECRET ?? "integration-only-intake-secret-0123456789abcdef";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as Prisma;
    fixtures = await import("./point7/product-fixtures.js");
    ({ signJwt } = await import("../src/services/jwt.js"));
    steps = await import("./helpers/operator-step-up.js");
    provisioning = await import("../src/services/enterprise-provisioning.service.js");
    closure = await import("../src/services/organization/org-closure.service.js");
    operator = await steps.seedOperator(h, deps(), prisma);
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  /** A customer the way the product makes one: provisioned, then accepted. */
  async function customer(seats = 10) {
    const d = deps();
    const owner = await fixtures.seedUser(d, "owner");
    const { result } = await provisioning.provisionEnterpriseCustomerIdempotent(
      {
        organizationName: `Customer ${tag()}`,
        ownerEmail: owner.email,
        seats,
        actorUserId: operator.userId,
        idempotencyKey: `ctr-${randomUUID()}`,
      },
      prisma,
    );
    const token = (result as { ownerInviteToken: string }).ownerInviteToken;
    const accepted = await h.app.inject({
      method: "POST",
      url: `/v1/org-invites/${token}/accept`,
      headers: bearer(owner.token),
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const body = accepted.json() as { organizationId: string; enterpriseWorkspaceId: string };
    return { orgId: body.organizationId, workspaceId: body.enterpriseWorkspaceId, owner };
  }

  async function operatorCall(
    method: "POST" | "PATCH",
    url: string,
    orgId: string,
    payload: Record<string, unknown> = {},
    resourceKind = "organization",
  ) {
    // A fresh operator per act: the TOTP replay guard spends one code per step.
    seededOperators += 1;
    const acting = await steps.seedOperator(h, deps(), prisma, `operator-${seededOperators}`);
    const challengeId = await steps.approvedStepUp(h, acting, "CAPABILITY_GRANT", resourceKind, orgId);
    return h.app.inject({
      method,
      url,
      headers: { ...bearer(acting.token), "x-proovra-step-up-challenge-id": challengeId },
      payload: { teamId: acting.stepUpTeamId, ...payload },
    });
  }

  const setTerms = (orgId: string, terms: Record<string, unknown>) =>
    operatorCall("PATCH", `/v1/admin/orgs/${orgId}/contract`, orgId, terms, "enterprise_contract");

  const contract = (orgId: string) => prisma.enterpriseContract.findUniqueOrThrow({ where: { organizationId: orgId } });

  describe("RC-CONTRACT-WRITER", () => {
    it("RT-003 / CT-10 — a freshly provisioned ACTIVE contract creates a Collaboration Team with no SQL, at the catalogue defaults", async () => {
      const t = await customer();
      expect(await contract(t.orgId)).toMatchObject({ collaborationTeamsMax: null, collaborationTeamMembersMax: null });
      const created = await h.app.inject({
        method: "POST",
        url: "/v1/collaboration-teams",
        headers: bearer(t.owner.token),
        payload: { name: `Team ${tag()}` },
      });
      expect(created.statusCode, created.body).toBeLessThan(300);
      const { resolveWorkspaceCollaborationLimits } = await import("../src/services/billing/workspace-seats.service.js");
      await expect(resolveWorkspaceCollaborationLimits(t.workspaceId, prisma)).resolves.toMatchObject({
        maxCollaborationTeamsPerWorkspace: 1000,
        maxAcceptedMembersPerCollaborationTeam: 500,
      });
    });

    it("CT-10 — a stated figure wins over the default, and a non-ACTIVE contract has no capacity at all", async () => {
      const t = await customer();
      expect((await setTerms(t.orgId, { collaborationTeamsMax: 3, collaborationTeamMembersMax: 7 })).statusCode).toBe(200);
      const { resolveWorkspaceCollaborationLimits } = await import("../src/services/billing/workspace-seats.service.js");
      await expect(resolveWorkspaceCollaborationLimits(t.workspaceId, prisma)).resolves.toMatchObject({
        maxCollaborationTeamsPerWorkspace: 3,
        maxAcceptedMembersPerCollaborationTeam: 7,
      });
      await prisma.enterpriseContract.update({ where: { organizationId: t.orgId }, data: { status: "SUSPENDED" } });
      await expect(resolveWorkspaceCollaborationLimits(t.workspaceId, prisma)).resolves.toMatchObject({
        maxCollaborationTeamsPerWorkspace: 0,
        maxAcceptedMembersPerCollaborationTeam: 0,
      });
    });

    it("BILLING-002 — an operator states each term through the product, it is enforced, and the change is audited", async () => {
      const t = await customer();
      const { resolveEntitlement } = await import("../src/services/packaging/entitlement.service.js");
      expect(await resolveEntitlement({ prisma, teamId: t.workspaceId, key: "FEATURE_LEGAL_HOLD" })).toMatchObject({ value: false });

      const endsAtUtc = new Date(Date.now() + 365 * 86_400_000).toISOString();
      const res = await setTerms(t.orgId, {
        seatCount: 25,
        storageGb: 2048,
        evidenceRecordsPerMonth: 1000,
        aiOperationsPerMonth: 500,
        legalHoldEnabled: true,
        reviewerOperationsEnabled: false,
        assignmentRequiresTeamPlacement: true,
        endsAtUtc,
        planVersion: "ent-2026",
        billingCustomerRef: "cust-1",
        billingSubscriptionRef: "sub-1",
        externalContractRef: "crm-1",
        region: "eu",
      });
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json() as { changed: string[] }).changed).toEqual(expect.arrayContaining(["seatCount", "legalHoldEnabled"]));

      expect(await contract(t.orgId)).toMatchObject({
        seatCount: 25,
        storageGb: 2048,
        evidenceRecordsPerMonth: 1000,
        aiOperationsPerMonth: 500,
        legalHoldEnabled: true,
        reviewerOperationsEnabled: false,
        assignmentRequiresTeamPlacement: true,
        planVersion: "ent-2026",
        billingCustomerRef: "cust-1",
        billingSubscriptionRef: "sub-1",
        externalContractRef: "crm-1",
        region: "eu",
      });
      expect((await prisma.team.findUniqueOrThrow({ where: { id: t.workspaceId } })).includedSeats).toBe(25);
      expect(await resolveEntitlement({ prisma, teamId: t.workspaceId, key: "FEATURE_LEGAL_HOLD" })).toMatchObject({ value: true });
      const { resolveWorkspaceSeatState } = await import("../src/services/billing/workspace-seats.service.js");
      expect((await resolveWorkspaceSeatState(t.workspaceId, prisma)).limit).toBe(25);

      const event = await prisma.organizationAuditEvent.findFirstOrThrow({
        where: { organizationId: t.orgId, eventType: "ENTERPRISE_CONTRACT_TERMS_UPDATED" },
      });
      expect((event.metadata as { changed: { seatCount: { from: number; to: number } } }).changed.seatCount).toEqual({ from: 10, to: 25 });
      expect(
        await prisma.adminAuditLog.count({ where: { action: "ENTERPRISE_CONTRACT_TERMS_UPDATED", organizationId: t.orgId } }),
      ).toBe(1);
    });

    it("a term is validated and cleared back to silence: zero refused, null means the published default, an end before the start refused", async () => {
      const t = await customer();
      for (const bad of [{ aiOperationsPerMonth: 0 }, { seatCount: 0 }, { collaborationTeamsMax: -1 }, { seatCount: null }, { unknownTerm: 1 }]) {
        const refused = await setTerms(t.orgId, bad);
        expect(refused.statusCode, JSON.stringify(bad)).toBe(400);
      }
      expect((await setTerms(t.orgId, { aiOperationsPerMonth: 5 })).statusCode).toBe(200);
      expect((await setTerms(t.orgId, { aiOperationsPerMonth: null })).statusCode).toBe(200);
      expect((await contract(t.orgId)).aiOperationsPerMonth).toBeNull();

      const reversed = await setTerms(t.orgId, {
        effectiveAtUtc: new Date().toISOString(),
        endsAtUtc: new Date(Date.now() - 86_400_000).toISOString(),
      });
      expect(reversed.statusCode).toBe(400);
      expect(reversed.json()).toMatchObject({ error: { code: "INVALID_CONTRACT_TERM" } });
    });

    it("a customer owner cannot write contract terms, and an operator needs a step-up", async () => {
      const t = await customer();
      const owner = await h.app.inject({
        method: "PATCH",
        url: `/v1/admin/orgs/${t.orgId}/contract`,
        headers: bearer(t.owner.token),
        payload: { teamId: t.workspaceId, legalHoldEnabled: true },
      });
      expect(owner.statusCode, owner.body).toBe(403);
      const noStepUp = await h.app.inject({
        method: "PATCH",
        url: `/v1/admin/orgs/${t.orgId}/contract`,
        headers: bearer(operator.token),
        payload: { teamId: operator.stepUpTeamId, legalHoldEnabled: true },
      });
      expect(noStepUp.statusCode, noStepUp.body).toBe(401);
      expect((await contract(t.orgId)).legalHoldEnabled).toBeNull();
    });

    it("provisioning states the sold terms with the customer, and the reference stays on the contract", async () => {
      const email = `terms-${tag()}@customer.test`;
      const { result } = await provisioning.provisionEnterpriseCustomerIdempotent(
        {
          organizationName: `Customer ${tag()}`,
          ownerEmail: email,
          seats: 40,
          actorUserId: operator.userId,
          idempotencyKey: `ctr-${randomUUID()}`,
          region: "eu",
          externalContractRef: "crm-77",
          terms: { legalHoldEnabled: true, collaborationTeamsMax: 12 },
        },
        prisma,
      );
      expect(await contract((result as { organizationId: string }).organizationId)).toMatchObject({
        seatCount: 40,
        region: "eu",
        externalContractRef: "crm-77",
        legalHoldEnabled: true,
        collaborationTeamsMax: 12,
        status: "PENDING_ACTIVATION",
      });
    });
  });

  describe("RC-TERMINATION", () => {
    const terminate = (orgId: string, effectiveAtUtc?: Date) =>
      operatorCall("POST", `/v1/admin/orgs/${orgId}/terminate`, orgId, {
        reason: "non-payment: invoice 4471",
        ...(effectiveAtUtc ? { effectiveAtUtc: effectiveAtUtc.toISOString() } : {}),
      });
    const future = () => new Date(Date.now() + 30 * 86_400_000);

    it("PROV-009 / BILLING-005 — schedule, withdraw, resume: the contract returns ACTIVE with its seats and terms", async () => {
      const t = await customer(12);
      expect((await setTerms(t.orgId, { legalHoldEnabled: true })).statusCode).toBe(200);
      expect((await terminate(t.orgId, future())).statusCode).toBe(202);
      expect(await contract(t.orgId)).toMatchObject({ status: "SUSPENDED", statusBeforeTermination: "ACTIVE" });

      const cancel = await operatorCall("POST", `/v1/admin/orgs/${t.orgId}/terminate/cancel`, t.orgId);
      expect(cancel.statusCode, cancel.body).toBe(200);
      // Withdrawing never silently restores access: an operator resumes it.
      expect(await contract(t.orgId)).toMatchObject({ status: "SUSPENDED" });

      const resumed = await operatorCall("POST", `/v1/admin/orgs/${t.orgId}/resume`, t.orgId);
      expect(resumed.statusCode, resumed.body).toBe(200);
      expect(resumed.json()).toMatchObject({ contractReinstatedTo: "ACTIVE" });
      expect(await contract(t.orgId)).toMatchObject({
        status: "ACTIVE",
        seatCount: 12,
        legalHoldEnabled: true,
        statusBeforeTermination: null,
        terminationReason: null,
      });
    });

    it("PROV-009 — resume does not reach past a termination still scheduled", async () => {
      const t = await customer();
      expect((await terminate(t.orgId, future())).statusCode).toBe(202);
      const resumed = await operatorCall("POST", `/v1/admin/orgs/${t.orgId}/resume`, t.orgId);
      expect(resumed.statusCode, resumed.body).toBe(409);
      expect(resumed.json()).toMatchObject({ error: { code: "TERMINATION_SCHEDULED" } });
      expect((await contract(t.orgId)).status).toBe("SUSPENDED");
    });

    it("control: resume of a healthy organization still answers ORG_NOT_SUSPENDED", async () => {
      const t = await customer();
      const resumed = await operatorCall("POST", `/v1/admin/orgs/${t.orgId}/resume`, t.orgId);
      expect(resumed.statusCode, resumed.body).toBe(409);
      expect(resumed.json()).toMatchObject({ error: { code: "ORG_NOT_SUSPENDED" } });
    });

    it("PROV-010 / BILLING-006 — a plan grant refuses a TERMINATED or SUSPENDED contract, and writes nothing", async () => {
      const t = await customer(7);
      expect((await terminate(t.orgId, future())).statusCode).toBe(202);
      const grant = () =>
        operatorCall("PATCH", `/v1/admin/orgs/${t.orgId}/plan`, t.orgId, { plan: "ENTERPRISE" });

      const suspended = await grant();
      expect(suspended.statusCode, suspended.body).toBe(409);
      expect(suspended.json()).toMatchObject({ error: { code: "CONTRACT_NOT_GRANTABLE" } });
      expect(await contract(t.orgId)).toMatchObject({ status: "SUSPENDED", seatCount: 7 });

      await prisma.enterpriseContract.update({ where: { organizationId: t.orgId }, data: { status: "TERMINATED" } });
      expect((await grant()).statusCode).toBe(409);
      expect(await contract(t.orgId)).toMatchObject({ status: "TERMINATED", seatCount: 7 });
    });

    it("PROV-010 — no plan grant on a pending-owner organization, an archived one, or a contract with no stated seats", async () => {
      const email = `pending-${tag()}@customer.test`;
      const { result } = await provisioning.provisionEnterpriseCustomerIdempotent(
        {
          organizationName: `Pending ${tag()}`,
          ownerEmail: email,
          seats: 5,
          actorUserId: operator.userId,
          idempotencyKey: `ctr-${randomUUID()}`,
        },
        prisma,
      );
      const pendingOrg = (result as { organizationId: string }).organizationId;
      const noWorkspace = await operatorCall("PATCH", `/v1/admin/orgs/${pendingOrg}/plan`, pendingOrg, { plan: "ENTERPRISE" });
      expect(noWorkspace.statusCode, noWorkspace.body).toBe(409);
      expect(noWorkspace.json()).toMatchObject({ error: { code: "ORG_HAS_NO_WORKSPACES" } });
      expect(await contract(pendingOrg)).toMatchObject({ status: "PENDING_ACTIVATION" });

      const t = await customer();
      await prisma.enterpriseContract.update({ where: { organizationId: t.orgId }, data: { seatCount: null } });
      const noSeats = await operatorCall("PATCH", `/v1/admin/orgs/${t.orgId}/plan`, t.orgId, { plan: "ENTERPRISE" });
      expect(noSeats.statusCode, noSeats.body).toBe(400);
      expect(noSeats.json()).toMatchObject({ error: { code: "SEATS_REQUIRED" } });

      await prisma.organization.update({ where: { id: t.orgId }, data: { status: "ARCHIVED" } });
      const archived = await operatorCall("PATCH", `/v1/admin/orgs/${t.orgId}/plan`, t.orgId, { plan: "ENTERPRISE", seats: 9 });
      expect(archived.statusCode, archived.body).toBe(409);
      expect((await contract(t.orgId)).seatCount).toBeNull();
    });

    it("control: a plan grant on a healthy organization keeps the contracted seats and touches no closed workspace", async () => {
      const t = await customer(30);
      const closed = await prisma.team.create({
        data: {
          name: `closed-${tag()}`,
          ownerUserId: t.owner.userId,
          billingOwnerUserId: t.owner.userId,
          organizationId: t.orgId,
          workspaceKind: "ORGANIZATION",
          billingPlan: "FREE",
          billingStatus: "INACTIVE",
          closedAtUtc: new Date(),
        },
        select: { id: true },
      });
      const res = await operatorCall("PATCH", `/v1/admin/orgs/${t.orgId}/plan`, t.orgId, { plan: "ENTERPRISE" });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ seats: 30, workspacesUpdated: 1 });
      expect(await prisma.team.findUniqueOrThrow({ where: { id: closed.id } })).toMatchObject({
        billingPlan: "FREE",
        billingStatus: "INACTIVE",
      });
    });

    it("PROV-003 — the owner cannot cancel an operator's termination, and does not read the operator's note", async () => {
      const t = await customer();
      expect((await terminate(t.orgId, future())).statusCode).toBe(202);

      const seen = await h.app.inject({ method: "GET", url: `/v1/orgs/${t.orgId}/closure`, headers: bearer(t.owner.token) });
      expect(seen.statusCode, seen.body).toBe(200);
      const body = seen.json() as { request: { id: string; reason: string | null; kind: string } };
      expect(body.request).toMatchObject({ kind: "CONTRACT_TERMINATION", reason: null });
      expect(seen.body).not.toContain("invoice 4471");

      const cancel = await h.app.inject({
        method: "POST",
        url: `/v1/orgs/${t.orgId}/closure/${body.request.id}/cancel`,
        headers: bearer(t.owner.token),
      });
      expect(cancel.statusCode, cancel.body).toBe(409);
      expect(cancel.json()).toMatchObject({ error: { code: "TERMINATION_OPERATOR_CONTROLLED" } });
      expect(
        await prisma.organizationClosureRequest.findUniqueOrThrow({ where: { id: body.request.id } }),
      ).toMatchObject({ status: "SCHEDULED" });

      // Nor can a second closure open beside it, even while it waits as BLOCKED.
      await prisma.organizationClosureRequest.update({ where: { id: body.request.id }, data: { status: "BLOCKED" } });
      const again = await h.app.inject({
        method: "POST",
        url: `/v1/orgs/${t.orgId}/closure`,
        headers: bearer(t.owner.token),
        payload: { confirmation: "close this organization", stepUp: { method: "password", currentPassword: "x" } },
      });
      expect(again.statusCode, again.body).not.toBe(200);
    });

    it("PROV-008 — a termination blocked by a legal hold waits, and runs on the next tick after the hold is released", async () => {
      const t = await customer();
      expect((await setTerms(t.orgId, { legalHoldEnabled: true })).statusCode).toBe(200);
      const hold = await prisma.evidenceLegalHold.create({
        data: {
          teamId: t.workspaceId,
          status: "ACTIVE",
          placedByUserId: t.owner.userId,
          title: "Matter",
          scope: "WORKSPACE",
        } as never,
        select: { id: true },
      });
      expect((await terminate(t.orgId, new Date(Date.now() - 1000))).statusCode).toBe(202);

      await closure.processOrganizationClosures(new Date());
      const row = await prisma.organizationClosureRequest.findFirstOrThrow({ where: { organizationId: t.orgId } });
      expect(row.status).toBe("BLOCKED");
      const blockedEvents = () =>
        prisma.adminAuditLog.count({ where: { action: "identity.organization_closure_blocked", organizationId: t.orgId } });
      const once = await blockedEvents();

      // Still held: nothing moves, and no new audit row every tick.
      await closure.processOrganizationClosures(new Date());
      expect((await prisma.organizationClosureRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("BLOCKED");
      expect(await blockedEvents()).toBe(once);
      expect((await contract(t.orgId)).status).toBe("SUSPENDED");

      await prisma.evidenceLegalHold.update({ where: { id: hold.id }, data: { status: "RELEASED" } });
      await closure.processOrganizationClosures(new Date());
      expect((await prisma.organizationClosureRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("COMPLETED");
      expect(await contract(t.orgId)).toMatchObject({ status: "TERMINATED", statusBeforeTermination: null });
      expect(await prisma.organization.findUniqueOrThrow({ where: { id: t.orgId } })).toMatchObject({ status: "ARCHIVED" });
    });

    it("PROV-014 — someone who has left no longer blocks closure, and a contract-managed owner is told where closure lives", async () => {
      const t = await customer();
      const gone = await fixtures.seedUser(deps(), "gone");
      await prisma.organizationMembership.create({
        data: { organizationId: t.orgId, userId: gone.userId, role: "ORG_MEMBER", status: "REVOKED", revokedAtUtc: new Date() },
      });
      const { evaluateOrganizationClosurePreflight } = await import(
        "../src/services/identity/account-lifecycle-preflight.service.js"
      );
      const { blockers } = await evaluateOrganizationClosurePreflight(t.orgId, t.owner.userId);
      expect(blockers.map((b) => b.code)).not.toContain("ORG_MEMBERS_ACTIVE");

      const seen = await h.app.inject({ method: "GET", url: `/v1/orgs/${t.orgId}/closure`, headers: bearer(t.owner.token) });
      expect(seen.json()).toMatchObject({ contractManaged: true });
    });
  });

  describe("BILLING-007", () => {
    it("a contract that stopped being ACTIVE takes no new evidence and spends no AI, and its cap does not vanish", async () => {
      const t = await customer();
      expect((await setTerms(t.orgId, { evidenceRecordsPerMonth: 1000, aiOperationsPerMonth: 100 })).statusCode).toBe(200);
      await prisma.enterpriseContract.update({ where: { organizationId: t.orgId }, data: { status: "SUSPENDED" } });
      const { resolveEffectiveContractAiCap, resolveEnterpriseContractLimits } = await import(
        "../src/services/billing/enterprise-contract-limits.js"
      );
      const { resolveEnterpriseContract } = await import("../src/services/organization/enterprise-contract.service.js");
      const limits = resolveEnterpriseContractLimits(await resolveEnterpriseContract(t.orgId, prisma));
      expect(resolveEffectiveContractAiCap({ plan: "ENTERPRISE", contract: limits })).toBe(0);

      const created = await h.app.inject({
        method: "POST",
        url: "/v1/evidence",
        headers: bearer(t.owner.token),
        payload: { type: "PHOTO", mimeType: "image/png", originalFileName: "a.png", teamId: t.workspaceId },
      });
      expect(created.statusCode, created.body).toBeGreaterThanOrEqual(400);
      expect(created.body).toContain("ENTERPRISE_CONTRACT_REQUIRED");
    });

    it("every AI spend path asks the contract: copilots and embeddings stop, in both hosts, and resume", async () => {
      const t = await customer();
      expect((await setTerms(t.orgId, { aiOperationsPerMonth: 100 })).statusCode).toBe(200);
      const { workspaceIncludesAiOperations } = await import("../src/services/billing-enforcement.service.js");
      const { workspaceContractWithheld } = await import("../../worker/src/workspace-billing.js");
      const { decideAiPolicy } = await import("../src/services/ai/workspace-ai-policy.service.js");

      expect(await workspaceIncludesAiOperations(t.workspaceId)).toBe(true);
      expect(await workspaceContractWithheld(t.workspaceId)).toBe(false);

      await prisma.enterpriseContract.update({ where: { organizationId: t.orgId }, data: { status: "SUSPENDED" } });
      expect(await workspaceIncludesAiOperations(t.workspaceId)).toBe(false);
      expect(await workspaceContractWithheld(t.workspaceId)).toBe(true);

      // A plan answer of false is the policy's denial, whatever the workspace set.
      const decision = decideAiPolicy({
        policy: {
          aiEnabled: true,
          reviewerCopilotEnabled: true,
          caseCopilotEnabled: true,
          semanticSearchEnabled: true,
          embeddingsAllowed: true,
        } as never,
        feature: "REVIEWER_COPILOT",
        dataClass: "METADATA",
        globalAiEnabled: true,
        providerConfigured: true,
        planAllowed: false,
      });
      expect(decision.allowed).toBe(false);

      await prisma.enterpriseContract.update({ where: { organizationId: t.orgId }, data: { status: "ACTIVE" } });
      expect(await workspaceIncludesAiOperations(t.workspaceId)).toBe(true);
    });

    it("the routes that spend pass the plan answer to the policy", () => {
      for (const file of [
        "src/routes/ai-evidence.routes.ts",
        "src/routes/ai-case.routes.ts",
        "src/routes/ai-reviewer.routes.ts",
        "src/routes/search.routes.ts",
        "src/services/intelligence/semantic.service.ts",
      ]) {
        expect(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), file).toMatch(
          /planAllowed: await workspaceIncludesAiOperations\(/,
        );
      }
    });
  });

  describe("PROV-006", () => {
    it("a failure after the customer committed cannot duplicate it: a retry of the key replays", async () => {
      const key = `ctr-${randomUUID()}`;
      const input = {
        organizationName: `Once ${tag()}`,
        ownerEmail: `once-${tag()}@customer.test`,
        seats: 5,
        actorUserId: operator.userId,
        idempotencyKey: key,
      };
      // The audit row is written after the commit. Its failure used to mark the
      // request FAILED, and the retry built a second customer.
      const failing = new Proxy(prisma, {
        get(target, prop, receiver) {
          if (prop === "adminAuditLog") throw new Error("audit store unavailable");
          return Reflect.get(target, prop, receiver);
        },
      });
      await provisioning.provisionEnterpriseCustomerIdempotent(input, failing).catch(() => null);
      const replay = await provisioning.provisionEnterpriseCustomerIdempotent(input, prisma);
      expect(replay.idempotentReplay).toBe(true);
      expect(await prisma.organization.count({ where: { name: input.organizationName } })).toBe(1);
      expect(await prisma.enterpriseProvisioningRequest.findUniqueOrThrow({ where: { idempotencyKey: key } })).toMatchObject({
        status: "COMPLETED",
      });
    });
  });

  describe("PROV-007", () => {
    async function intakeLink(t: { workspaceId: string; owner: { token: string } }) {
      const res = await h.app.inject({
        method: "POST",
        url: "/v1/workflow/intake-links",
        headers: bearer(t.owner.token),
        payload: {
          teamId: t.workspaceId,
          workflowTemplateSlug: "compliance-audit",
          intakeMode: "EXTERNAL_REUSABLE",
          recipientLabel: "PROV-007",
          expiresAtUtc: new Date(Date.now() + 3_600_000).toISOString(),
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      return (res.json() as { rawToken: string }).rawToken;
    }
    const open = (token: string) => h.app.inject({ method: "GET", url: `/v1/external-intake/${encodeURIComponent(token)}` });

    it("a suspended organization's link opens nothing, an issued session stops, and resuming brings it back", async () => {
      const t = await customer();
      const token = await intakeLink(t);
      const before = await open(token);
      expect(before.statusCode, before.body).toBe(200);
      const sessionId = (before.json() as { session: { id: string } }).session.id;

      expect((await operatorCall("POST", `/v1/admin/orgs/${t.orgId}/suspend`, t.orgId, { reason: "abuse" })).statusCode).toBe(200);

      const refused = await open(token);
      expect(refused.statusCode, refused.body).toBe(410);
      expect(refused.json()).toMatchObject({ error: { code: "WORKSPACE_NOT_OPERATING" } });
      const sessions = await prisma.workflowIntakeSession.count({ where: { intakeLinkId: (await prisma.workflowIntakeLink.findFirstOrThrow({ where: { teamId: t.workspaceId } })).id } });

      const part = await h.app.inject({
        method: "POST",
        url: `/v1/external-intake/${encodeURIComponent(token)}/sessions/${sessionId}/parts`,
        // A whole, valid part: the refusal has to be the suspension, not the body.
        payload: { partIndex: 0, mimeType: "image/png", sizeBytes: 16, checksumSha256Base64: Buffer.alloc(32, 7).toString("base64") },
      });
      expect(part.statusCode, part.body).toBe(410);
      const submit = await h.app.inject({
        method: "POST",
        url: `/v1/external-intake/${encodeURIComponent(token)}/sessions/${sessionId}/submit`,
        payload: {},
      });
      expect(submit.statusCode, submit.body).toBe(410);
      expect(await prisma.evidence.count({ where: { teamId: t.workspaceId } })).toBe(0);
      expect(sessions).toBe(1);

      expect((await operatorCall("POST", `/v1/admin/orgs/${t.orgId}/resume`, t.orgId)).statusCode).toBe(200);
      expect((await open(token)).statusCode).toBe(200);
    });

    it("closing a workspace revokes its live links, so its public channel ends with it", async () => {
      const t = await customer();
      const token = await intakeLink(t);
      await closure.executeOrganizationClosure({ organizationId: t.orgId, requestedByUserId: t.owner.userId });
      expect(await prisma.workflowIntakeLink.findFirstOrThrow({ where: { teamId: t.workspaceId } })).toMatchObject({
        status: "REVOKED",
        revokedReason: "workspace_closed",
      });
      expect((await open(token)).statusCode).toBeGreaterThanOrEqual(400);
    });
  });
});
