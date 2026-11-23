/**
 * Free-user audit (2026-11-14), workstream 3 — the server enforces what Pricing
 * sells, through the owners that already answer each question.
 *
 *   A2-01  automation webhooks and webhook-action rules ask FEATURE_WEBHOOKS
 *          (create, re-point, enable), as `/v1/integrations/webhooks` does;
 *          listing, renaming and disabling stay open.
 *   A2-04  the reviewer workspace's TEAM-tier writes ask the review ladder
 *          (`workspaceIncludesReviewCapability`): bulk → BULK_REVIEW_OPERATIONS,
 *          assign → REVIEW_ASSIGNMENTS, coding / QC / disagreement →
 *          REVIEW_TASKS_AND_QUEUES.
 *   A2-09  the retention fields of `PUT /v1/governance/policy` ask the
 *          Enterprise `retentionPolicy` feature; the free switches do not.
 *
 * Driven through the real routes against the harness database. Refusals are
 * checked for "nothing written"; every gate has a positive control on an
 * Enterprise workspace (ACTIVE contract), which must get PAST the gate (to the
 * step-up, or to the route's own answer) rather than be refused by it.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("free-user audit — plan gates match Pricing (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let createDestinationSecret: (typeof import("../src/services/automation/automation-webhook.service.js"))["createDestinationSecret"];
  const A = () => h.fixtures.teamA; // ORGANIZATION workspace, no plan: FREE
  const B = () => h.fixtures.teamB; // made Enterprise below
  const P = () => h.fixtures.personal; // Free personal workspace
  const tag = () => randomUUID().slice(0, 8);

  const call = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, token: string, payload?: unknown) =>
    h.app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(payload !== undefined ? { payload: payload as never } : {}),
    });

  // One origin per destination: (team, origin) is unique.
  let nextHost = 20;
  async function seedDestination(teamId: string, ownerUserId: string) {
    const secret = createDestinationSecret();
    const origin = `https://203.0.113.${nextHost++}`;
    return prisma.automationWebhookDestination.create({
      data: {
        teamId,
        name: `seeded ${tag()}`,
        url: `${origin}/seeded/${tag()}`,
        urlOrigin: origin,
        encryptedSecret: secret.storedEnvelope,
        secretFingerprint: secret.fingerprint,
        enabled: false,
        createdByUserId: ownerUserId,
        updatedByUserId: ownerUserId,
      } as never,
    });
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ createDestinationSecret } = await import("../src/services/automation/automation-webhook.service.js"));
    await prisma.team.update({ where: { id: B().teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } });
    const orgB = (await prisma.team.findUniqueOrThrow({ where: { id: B().teamId }, select: { organizationId: true } })).organizationId!;
    const { upsertEnterpriseContract } = await import("../src/services/organization/enterprise-contract.service.js");
    await upsertEnterpriseContract(prisma as never, { organizationId: orgB, status: "ACTIVE", activationState: "ACTIVATED", seatCount: 25 });
    await prisma.user.update({ where: { id: P().userId }, data: { currentWorkspaceId: P().teamId } });
    await prisma.user.update({ where: { id: B().ownerUserId }, data: { currentWorkspaceId: B().teamId } });
  }, 180_000);

  afterAll(async () => {
    if (prisma && h) {
      const where = { teamId: { in: [A().teamId, B().teamId, P().teamId] } };
      await prisma.automationRule.deleteMany({ where }).catch(() => undefined);
      await prisma.automationWebhookDestination.deleteMany({ where }).catch(() => undefined);
      await prisma.codingSchema.deleteMany({ where }).catch(() => undefined);
      await prisma.workspaceGovernancePolicy.deleteMany({ where }).catch(() => undefined);
      await prisma.stepUpChallenge.deleteMany({ where }).catch(() => undefined);
    }
    await h?.cleanup();
  });

  // ===========================================================================
  // A2-01
  // ===========================================================================
  describe("A2-01 — automation webhooks need FEATURE_WEBHOOKS", () => {
    it("a Free workspace owner cannot register, re-point or enable a destination; listing, renaming and disabling stay open", async () => {
      const created = await call("POST", "/v1/automation/webhooks", A().ownerToken, {
        teamId: A().teamId,
        name: "Receiver",
        url: "https://203.0.113.10/automation",
      });
      expect(created.statusCode, created.body).toBe(403);
      expect(created.json()).toMatchObject({ denial: "ENTITLEMENT_REQUIRED", key: "FEATURE_WEBHOOKS" });
      expect(await prisma.automationWebhookDestination.count({ where: { teamId: A().teamId } })).toBe(0);

      // A destination made before the gate (or before a downgrade).
      const existing = await seedDestination(A().teamId, A().ownerUserId);
      const enable = await call("POST", `/v1/automation/webhooks/${existing.id}/enable`, A().ownerToken, {});
      expect(enable.statusCode, enable.body).toBe(403);
      const repoint = await call("PATCH", `/v1/automation/webhooks/${existing.id}`, A().ownerToken, {
        url: "https://203.0.113.11/elsewhere",
      });
      expect(repoint.statusCode, repoint.body).toBe(403);
      const after = await prisma.automationWebhookDestination.findUniqueOrThrow({ where: { id: existing.id } });
      expect(after.enabled).toBe(false);
      expect(after.url).toBe(existing.url);

      const list = await call("GET", `/v1/automation/webhooks?teamId=${A().teamId}`, A().ownerToken);
      expect(list.statusCode, list.body).toBe(200);
      expect(list.body).toContain(existing.id);
      const rename = await call("PATCH", `/v1/automation/webhooks/${existing.id}`, A().ownerToken, { name: "Renamed" });
      expect(rename.statusCode, rename.body).toBe(200);
      const disable = await call("POST", `/v1/automation/webhooks/${existing.id}/disable`, A().ownerToken, {});
      expect(disable.statusCode, disable.body).toBe(200);
    });

    it("a Free workspace owner cannot create or enable a rule whose action is a webhook; other actions are unaffected", async () => {
      const destination = await seedDestination(A().teamId, A().ownerUserId);
      const base = {
        teamId: A().teamId,
        triggerType: "EVIDENCE_CREATED",
        conditionJson: {},
      };
      const webhookRule = await call("POST", "/v1/automation/rules", A().ownerToken, {
        ...base,
        name: `webhook ${tag()}`,
        actionType: "WEBHOOK_DELIVERY_INTERNAL_ONLY",
        actionConfigJson: { destinationId: destination.id, eventType: "automation.free" },
      });
      expect(webhookRule.statusCode, webhookRule.body).toBe(403);
      expect(webhookRule.json()).toMatchObject({ denial: "ENTITLEMENT_REQUIRED", key: "FEATURE_WEBHOOKS" });
      expect(await prisma.automationRule.count({ where: { teamId: A().teamId, actionType: "WEBHOOK_DELIVERY_INTERNAL_ONLY" } })).toBe(0);

      // A webhook rule saved before the gate is not switched on.
      const legacy = await prisma.automationRule.create({
        data: {
          teamId: A().teamId,
          name: `legacy ${tag()}`,
          enabled: false,
          triggerType: "EVIDENCE_CREATED",
          conditionJson: {},
          actionType: "WEBHOOK_DELIVERY_INTERNAL_ONLY",
          actionConfigJson: { destinationId: destination.id, eventType: "automation.legacy" },
          createdByUserId: A().ownerUserId,
          updatedByUserId: A().ownerUserId,
        } as never,
      });
      const enable = await call("POST", `/v1/automation/rules/${legacy.id}/enable`, A().ownerToken, {});
      expect(enable.statusCode, enable.body).toBe(403);
      expect((await prisma.automationRule.findUniqueOrThrow({ where: { id: legacy.id } })).enabled).toBe(false);

      // A rule that is not a webhook is not asked FEATURE_WEBHOOKS — but since
      // B7B-F06 (owner directive) every automation rule is the governance
      // capability FEATURE_GOVERNANCE_PLATFORM, which a Free workspace lacks.
      const label = await call("POST", "/v1/automation/rules", A().ownerToken, {
        ...base,
        name: `label ${tag()}`,
        actionType: "APPLY_LABEL",
        actionConfigJson: { label: "needs-review" },
      });
      expect(label.statusCode, label.body).toBe(403);
      expect(label.json()).toEqual({ denial: "ENTITLEMENT_REQUIRED", key: "FEATURE_GOVERNANCE_PLATFORM" });
    });

    it("control: an Enterprise workspace passes the gate (to the step-up) and creates a webhook rule", async () => {
      const created = await call("POST", "/v1/automation/webhooks", B().ownerToken, {
        teamId: B().teamId,
        name: "Receiver",
        url: "https://203.0.113.10/enterprise",
      });
      expect(created.statusCode, created.body).toBe(401);
      expect(created.json().error.code).toBe("STEP_UP_REQUIRED");
      const destination = await seedDestination(B().teamId, B().ownerUserId);
      const rule = await call("POST", "/v1/automation/rules", B().ownerToken, {
        teamId: B().teamId,
        name: `webhook ${tag()}`,
        triggerType: "EVIDENCE_CREATED",
        conditionJson: {},
        actionType: "WEBHOOK_DELIVERY_INTERNAL_ONLY",
        actionConfigJson: { destinationId: destination.id, eventType: "automation.enterprise" },
      });
      expect(rule.statusCode, rule.body).toBe(201);
      const enable = await call("POST", `/v1/automation/rules/${rule.json().id}/enable`, B().ownerToken, {});
      expect(enable.statusCode, enable.body).toBe(200);
    });
  });

  // ===========================================================================
  // A2-04
  // ===========================================================================
  describe("A2-04 — reviewer workspace TEAM-tier writes ask the review ladder", () => {
    const id = () => randomUUID();
    const writes = () => [
      { url: "/v1/reviewer/bulk/assign", body: { assigneeUserId: A().memberUserId, workflowIds: [id()] } },
      { url: "/v1/reviewer/bulk/decide", body: { verdict: "APPROVE", workflowIds: [id()] } },
      { url: "/v1/reviewer/bulk/code", body: { fieldSlug: "x", value: {}, workflowIds: [id()] } },
      { url: `/v1/reviewer/qc/samples/${id()}/assign`, body: { qcReviewerUserId: A().memberUserId } },
      { url: `/v1/reviewer/qc/samples/${id()}/verdict`, body: { verdict: "PASS" } },
      { url: `/v1/reviewer/work/${id()}/code`, body: { fieldId: id(), value: {} } },
      { url: `/v1/reviewer/work/${id()}/bind-schema`, body: { schemaId: id() } },
      { url: `/v1/reviewer/work/${id()}/disagree`, body: { originalDecisionId: id(), rationale: "no" } },
      { url: `/v1/reviewer/disagreements/${id()}/transition`, body: { to: "RESOLVED_UPHELD" } },
      { url: `/v1/coding/schemas/${id()}/archive`, body: {} },
      { url: "/v1/coding/schemas/seed-defaults", body: {} },
    ];

    it("a Free organization workspace's owner is refused every one, before anything is written", async () => {
      for (const w of writes()) {
        const res = await call("POST", `${w.url}?teamId=${A().teamId}`, A().ownerToken, w.body);
        expect(res.statusCode, `${w.url} ${res.body}`).toBe(403);
        expect(res.json(), w.url).toMatchObject({
          denial: "ENTITLEMENT_REQUIRED",
          entitlement: "REVIEWER_OPERATIONS",
          // PRO-R2-14 — plus the one review-capability shape.
          error: { code: "ENTITLEMENT_REQUIRED", reason: "reviewer_operations_not_included" },
        });
      }
      // seed-defaults installs schemas when admitted; refused, it installed none.
      expect(await prisma.codingSchema.count({ where: { teamId: A().teamId } })).toBe(0);
    });

    // TEAM-SPEC R2 (2026-11-23) — intentional change: reads of this surface
    // now need REVIEW_TASKS_AND_QUEUES too (they had no plan check). After a
    // downgrade the data is kept, never deleted, and is served again once the
    // workspace is Team-entitled; meanwhile reads answer the typed refusal.
    it("reads answer the typed entitlement refusal after a downgrade (data kept)", async () => {
      for (const url of ["/v1/coding/schemas", "/v1/reviewer/disagreements", "/v1/reviewer/qc/samples"]) {
        const res = await call("GET", `${url}?teamId=${A().teamId}`, A().ownerToken);
        expect(res.statusCode, `${url} ${res.body}`).toBe(403);
        expect(res.json().error, url).toMatchObject({ code: "ENTITLEMENT_REQUIRED", entitlement: "REVIEW_TASKS_AND_QUEUES" });
      }
    });

    it("control: an Enterprise workspace is not refused by the plan gate", async () => {
      const seeded = await call("POST", `/v1/coding/schemas/seed-defaults?teamId=${B().teamId}`, B().ownerToken, {});
      expect(seeded.statusCode, seeded.body).toBe(200);
      for (const w of writes()) {
        const body = JSON.parse(JSON.stringify(w.body).split(A().memberUserId).join(B().memberUserId));
        const res = await call("POST", `${w.url}?teamId=${B().teamId}`, B().ownerToken, body);
        expect(res.body, w.url).not.toContain("ENTITLEMENT_REQUIRED");
      }
    });
  });

  // ===========================================================================
  // A2-09
  // ===========================================================================
  describe("A2-09 — workspace retention settings are an Enterprise feature", () => {
    const put = async (token: string, patch: Record<string, unknown>) => {
      const read = await call("GET", "/v1/governance/policy", token);
      expect(read.statusCode, read.body).toBe(200);
      return call("PUT", "/v1/governance/policy", token, { expectedVersion: read.json().version, ...patch });
    };

    it("a Free personal owner cannot set a retention period or restrict deletion (refused before any step-up)", async () => {
      for (const patch of [{ defaultRetentionDays: 36500 }, { evidenceDeletionMode: "DISABLED" }, { evidenceDeletionMode: "ADMIN_ONLY" }]) {
        const res = await put(P().token, patch);
        expect(res.statusCode, `${JSON.stringify(patch)} ${res.body}`).toBe(402);
        expect(res.json().error.code).toBe("ENTERPRISE_FEATURE_REQUIRED");
      }
      expect(await prisma.workspaceGovernancePolicy.findUnique({ where: { teamId: P().teamId } })).toBeNull();
      expect(await prisma.stepUpChallenge.count({ where: { teamId: P().teamId } })).toBe(0);
    });

    it("the other switches, and returning retention to the default, stay a free control (they reach the step-up)", async () => {
      for (const patch of [{ requireReviewBeforeReport: true }, { defaultRetentionDays: null }, { evidenceDeletionMode: "ALLOWED" }]) {
        const res = await put(P().token, patch);
        expect(res.statusCode, `${JSON.stringify(patch)} ${res.body}`).toBe(401);
        expect(res.json().error.code).toBe("STEP_UP_REQUIRED");
      }
    });

    it("control: an Enterprise workspace passes the gate to the step-up", async () => {
      const res = await put(B().ownerToken, { defaultRetentionDays: 400, evidenceDeletionMode: "ADMIN_ONLY" });
      expect(res.statusCode, res.body).toBe(401);
      expect(res.json().error.code).toBe("STEP_UP_REQUIRED");
    });
  });
});
