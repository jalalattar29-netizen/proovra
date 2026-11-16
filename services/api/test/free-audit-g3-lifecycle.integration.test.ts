/* eslint-disable @typescript-eslint/no-explicit-any -- JSON response bodies and mocked payloads of many shapes. */
/**
 * FREE-USER AUDIT 0ea0 — GROUP API-G3-LIFECYCLE (live PostgreSQL + Redis + MinIO).
 *
 * Standing credentials, lifecycle transitions and closure. Expiry of a
 * member's access window (policy A2-26) is kept DISTINCT from demotion,
 * removal, suspension and closure: every block that ends a credential on one
 * of those transitions also proves that an expired creator's credential keeps
 * working. Every refusal has a positive control on the same rows.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import type { FixtureDeps, SeededUser } from "./point7/product-fixtures.js";

type Res = { statusCode: number; body: string };
type Prisma = (typeof import("../src/db.js"))["prisma"];

const DAY = 24 * 60 * 60 * 1000;

describe("free-audit 0ea0 — API-G3-LIFECYCLE (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let fx: typeof import("./point7/product-fixtures.js");
  let deps: FixtureDeps;
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let rbac: typeof import("../src/services/identity/rbac.service.js");
  let keys: typeof import("../src/services/integrations/api-keys.service.js");
  let intake: typeof import("../src/services/workflow-intake-link.service.js");
  let closure: typeof import("../src/services/workspace/workspace-closure.service.js");
  let wsLifecycle: typeof import("../src/services/workspace/workspace-lifecycle.service.js");
  let outbox: typeof import("../src/services/automation/automation-outbox.service.js");
  let deliveryRuntime: typeof import("../src/services/automation/automation-delivery-runtime.service.js");
  let lifecycleWebhooks: typeof import("../src/services/packaging/webhooks/webhook-platform.service.js");
  let dispatcher: typeof import("../src/services/intake-link-delivery-dispatcher.service.js");
  let redactionProjection: typeof import("../src/services/redaction/verify-redaction-projection.service.js");
  let destruction: typeof import("../src/services/lifecycle/destruction-governance.service.js");
  let clearRates: () => Promise<unknown>;
  let closedAccountProviderId: typeof import("../src/services/identity/account-closed.js").closedAccountProviderId;
  let ip = 1;
  const A = () => h.fixtures.teamA;
  const B = () => h.fixtures.teamB;

  const call = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, token: string | null, payload?: unknown, extra: Record<string, string> = {}): Promise<Res> =>
    h.app.inject({
      method,
      url,
      remoteAddress: `198.51.100.${(ip++ % 250) + 1}`,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
        ...extra,
      },
      ...(payload !== undefined ? { payload: payload as never } : {}),
    }) as unknown as Promise<Res>;
  const json = (r: Res) => JSON.parse(r.body) as Record<string, any>;

  /** A real user with current terms, a member of team A with this role. */
  async function member(
    label: string,
    role: "ADMIN" | "MEMBER" | "VIEWER",
    accessExpiresAtUtc?: Date,
  ): Promise<SeededUser & { memberId: string }> {
    const u = await fx.seedUser(deps, label);
    const m = await prisma.teamMember.create({
      data: { teamId: A().teamId, userId: u.userId, role, status: "ACTIVE", ...(accessExpiresAtUtc ? { accessExpiresAtUtc } : {}) },
      select: { id: true },
    });
    return { ...u, memberId: m.id };
  }

  const mintKey = async (creatorUserId: string) =>
    (
      await keys.createApiCredential({
        teamId: A().teamId,
        name: `g3 ${randomUUID().slice(0, 6)}`,
        scopes: ["integration.evidence.read"],
        actorUserId: creatorUserId,
      })
    ) as { credential: { id: string }; rawKey: string };
  const useKey = (rawKey: string) => call("GET", "/v1/integrations/api/evidence", null, undefined, { authorization: `Bearer ${rawKey}` });
  const keyRow = (id: string) => prisma.apiCredential.findUniqueOrThrow({ where: { id }, select: { status: true, revokedReason: true } });

  const mintLink = async (creatorUserId: string, teamId = A().teamId, extra: Record<string, unknown> = {}) =>
    (await intake.createWorkflowIntakeLink(
      {
        teamId,
        workflowTemplateSlug: "general-evidence-record",
        intakeMode: "EXTERNAL_REUSABLE",
        recipientLabel: "g3",
        maxUses: 5,
        expiresAtUtc: new Date(Date.now() + DAY),
        ...extra,
      } as never,
      { actorUserId: creatorUserId },
    )) as unknown as { link: { id: string }; rawToken: string };
  const openLink = (rawToken: string) => call("GET", `/v1/external-intake/${encodeURIComponent(rawToken)}`, null);
  const linkRow = (id: string) => prisma.workflowIntakeLink.findUniqueOrThrow({ where: { id }, select: { status: true, revokedReason: true } });

  beforeAll(async () => {
    process.env.MESSAGING_TRANSPORT = "recording";
    process.env.INTEGRATIONS_ENABLED = "true";
    process.env.API_KEY_SECRET = process.env.API_KEY_SECRET ?? "cd".repeat(32);
    process.env.EVIDENCE_REQUESTS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_LINKS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_TOKEN_SECRET =
      process.env.WORKFLOW_INTAKE_TOKEN_SECRET ?? "g3-lifecycle-throwaway-intake-hmac-0123456789abcdef";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    fx = await import("./point7/product-fixtures.js");
    ({ signJwt } = await import("../src/services/jwt.js"));
    rbac = await import("../src/services/identity/rbac.service.js");
    keys = await import("../src/services/integrations/api-keys.service.js");
    intake = await import("../src/services/workflow-intake-link.service.js");
    closure = await import("../src/services/workspace/workspace-closure.service.js");
    wsLifecycle = await import("../src/services/workspace/workspace-lifecycle.service.js");
    outbox = await import("../src/services/automation/automation-outbox.service.js");
    deliveryRuntime = await import("../src/services/automation/automation-delivery-runtime.service.js");
    lifecycleWebhooks = await import("../src/services/packaging/webhooks/webhook-platform.service.js");
    dispatcher = await import("../src/services/intake-link-delivery-dispatcher.service.js");
    redactionProjection = await import("../src/services/redaction/verify-redaction-projection.service.js");
    destruction = await import("../src/services/lifecycle/destruction-governance.service.js");
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    ({ closedAccountProviderId } = await import("../src/services/identity/account-closed.js"));
    const { upsertEntitlementGrant } = await import("../src/services/packaging/entitlement.service.js");
    deps = {
      prisma: prisma as never,
      tag: `g3-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) } as never,
          process.env.AUTH_JWT_SECRET!,
          3600,
        ),
    };
    // Team A includes secure intake, keys and webhooks; team B stays FREE.
    await prisma.team.update({ where: { id: A().teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } });
    await upsertEntitlementGrant({
      teamId: A().teamId,
      key: "INTEGRATION_API_KEYS_MAX",
      value: 1000,
      kind: "LIMIT",
      source: "CUSTOM",
      grantedByUserId: A().ownerUserId,
    } as never);
  }, 300_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  // ---------------------------------------------------------------------------
  // B3A-F-002 — an API key answers to its creator's CURRENT authority.
  // ---------------------------------------------------------------------------
  describe("B3A-F-002 — API keys after a demotion", () => {
    it("a demotion made on ANY path stops the key at its next use (401, revoked creator_lost_authority); a colleague's key keeps working", async () => {
      const creator = await member("key-demoted", "ADMIN");
      const control = await member("key-control", "ADMIN");
      const k = await mintKey(creator.userId);
      const other = await mintKey(control.userId);
      expect((await useKey(k.rawKey)).statusCode).toBe(200);
      // The directory lowers the role (no changeMemberRole leg runs).
      await prisma.teamMember.update({ where: { id: creator.memberId }, data: { role: "VIEWER" } });
      const refused = await useKey(k.rawKey);
      expect(refused.statusCode, refused.body).toBe(401);
      expect(json(refused).error.reason).toBe("creator_lost_authority");
      expect(await keyRow(k.credential.id)).toMatchObject({ status: "REVOKED", revokedReason: "creator_lost_authority" });
      // A promotion back does not revive it (revocation is permanent).
      await prisma.teamMember.update({ where: { id: creator.memberId }, data: { role: "ADMIN" } });
      expect((await useKey(k.rawKey)).statusCode).toBe(401);
      expect((await useKey(other.rawKey)).statusCode).toBe(200);
    });

    it("changeMemberRole ends the key at the role change; A2-26: an EXPIRED creator's key keeps working", async () => {
      const demoted = await member("key-role", "ADMIN");
      const k = await mintKey(demoted.userId);
      await rbac.changeMemberRole({ teamId: A().teamId, teamMemberId: demoted.memberId, actorUserId: A().ownerUserId, newRole: "VIEWER" });
      expect(await keyRow(k.credential.id)).toMatchObject({ status: "REVOKED", revokedReason: "creator_lost_authority" });

      const expired = await member("key-expired", "ADMIN");
      const e = await mintKey(expired.userId);
      await prisma.teamMember.update({ where: { id: expired.memberId }, data: { accessExpiresAtUtc: new Date(Date.now() - DAY) } });
      const res = await useKey(e.rawKey);
      expect(res.statusCode, res.body).toBe(200);
      expect((await keyRow(e.credential.id)).status).toBe("ACTIVE");
    });
  });

  // ---------------------------------------------------------------------------
  // B3B-F-106 — an intake link answers to its creator's CURRENT authority.
  // ---------------------------------------------------------------------------
  describe("B3B-F-106 — intake links after a demotion", () => {
    it("a creator demoted to VIEWER on any path: the link refuses at its next use and is revoked creator_lost_authority", async () => {
      const creator = await member("link-demoted", "MEMBER");
      const link = await mintLink(creator.userId);
      expect((await openLink(link.rawToken)).statusCode).toBe(200);
      await prisma.teamMember.update({ where: { id: creator.memberId }, data: { role: "VIEWER" } });
      const refused = await openLink(link.rawToken);
      expect(refused.statusCode, refused.body).not.toBe(200);
      expect(await linkRow(link.link.id)).toMatchObject({ status: "REVOKED", revokedReason: "creator_lost_authority" });
    });

    it("changeMemberRole MEMBER -> VIEWER revokes their direct and request-bound links; a role that keeps the permission keeps them; A2-26: expiry does not", async () => {
      const demoted = await member("link-role", "MEMBER");
      const direct = await mintLink(demoted.userId);
      const bound = await mintLink(demoted.userId);
      await prisma.evidenceRequest.create({
        data: {
          teamId: A().teamId,
          requestType: "ADDITIONAL_EVIDENCE",
          title: "g3 bound",
          instructions: "g3",
          priority: "NORMAL",
          recipientMode: "EXTERNAL_CONTRIBUTOR",
          status: "SENT",
          requestedByUserId: demoted.userId,
          intakeLinkId: bound.link.id,
        } as never,
      });
      const kept = await member("link-kept", "MEMBER");
      const keptLink = await mintLink(kept.userId);
      await rbac.changeMemberRole({ teamId: A().teamId, teamMemberId: kept.memberId, actorUserId: A().ownerUserId, newRole: "ADMIN" });
      expect((await linkRow(keptLink.link.id)).status).toBe("ACTIVE");

      await rbac.changeMemberRole({ teamId: A().teamId, teamMemberId: demoted.memberId, actorUserId: A().ownerUserId, newRole: "VIEWER" });
      expect(await linkRow(direct.link.id)).toMatchObject({ status: "REVOKED", revokedReason: "creator_lost_authority" });
      expect(await linkRow(bound.link.id)).toMatchObject({ status: "REVOKED", revokedReason: "creator_lost_authority" });

      const expired = await member("link-expired", "MEMBER");
      const e = await mintLink(expired.userId);
      await prisma.teamMember.update({ where: { id: expired.memberId }, data: { accessExpiresAtUtc: new Date(Date.now() - DAY) } });
      expect((await openLink(e.rawToken)).statusCode).toBe(200);
      expect((await linkRow(e.link.id)).status).toBe("ACTIVE");
    });
  });

  // ---------------------------------------------------------------------------
  // B7B-F09 — removal / suspension end the webhooks a member created.
  // ---------------------------------------------------------------------------
  describe("B7B-F09 — webhooks of a removed or suspended creator", () => {
    async function webhooksOf(userId: string) {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          teamId: A().teamId,
          url: "https://hooks.example.com/g3",
          status: "ACTIVE",
          secretCiphertext: "x",
          secretPrefix: "whsec_g3",
          createdByUserId: userId,
        },
        select: { id: true },
      });
      const destination = await prisma.automationWebhookDestination.create({
        data: {
          teamId: A().teamId,
          name: "g3",
          url: `https://${randomUUID().slice(0, 8)}.example.com/hook`,
          urlOrigin: `https://${randomUUID()}.example.com`,
          encryptedSecret: "x",
          secretFingerprint: "x",
          enabled: true,
          createdByUserId: userId,
          updatedByUserId: userId,
        },
        select: { id: true },
      });
      const lifecycle = await prisma.lifecycleWebhookEndpoint.create({
        data: { teamId: A().teamId, url: "https://hooks.example.com/life", secret: "s", subscribedEvents: [], createdByUserId: userId },
        select: { id: true },
      });
      return { endpoint: endpoint.id, destination: destination.id, lifecycle: lifecycle.id };
    }
    const state = async (ids: { endpoint: string; destination: string; lifecycle: string }) => ({
      endpoint: (await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ids.endpoint } })).status,
      destination: (await prisma.automationWebhookDestination.findUniqueOrThrow({ where: { id: ids.destination } })).enabled,
      lifecycle: (await prisma.lifecycleWebhookEndpoint.findUniqueOrThrow({ where: { id: ids.lifecycle } })).state,
    });
    const ended = { endpoint: "DISABLED", destination: false, lifecycle: "DEACTIVATED" };
    const live = { endpoint: "ACTIVE", destination: true, lifecycle: "ACTIVE" };

    it("removal and suspension disable them; a colleague's and an expired creator's stay live (A2-26)", async () => {
      const removed = await member("hook-removed", "ADMIN");
      const suspended = await member("hook-suspended", "ADMIN");
      const expired = await member("hook-expired", "ADMIN");
      const control = await member("hook-control", "ADMIN");
      const r = await webhooksOf(removed.userId);
      const s = await webhooksOf(suspended.userId);
      const e = await webhooksOf(expired.userId);
      const c = await webhooksOf(control.userId);
      await rbac.revokeMember({ teamId: A().teamId, teamMemberId: removed.memberId, actorUserId: A().ownerUserId });
      await rbac.suspendMember({ teamId: A().teamId, teamMemberId: suspended.memberId, actorUserId: A().ownerUserId });
      await prisma.teamMember.update({ where: { id: expired.memberId }, data: { accessExpiresAtUtc: new Date(Date.now() - DAY) } });
      expect(await state(r)).toEqual(ended);
      expect(await state(s)).toEqual(ended);
      expect(await state(e)).toEqual(live);
      expect(await state(c)).toEqual(live);
    });
  });

  // ---------------------------------------------------------------------------
  // B7B-F02 — closure / suspension stop every webhook system and automation.
  // ---------------------------------------------------------------------------
  describe("B7B-F02 — closure and suspension stop automation and lifecycle webhooks", () => {
    async function automationFixture(teamId: string, userId: string) {
      const rule = await prisma.automationRule.create({
        data: {
          teamId,
          name: "g3 rule",
          enabled: true,
          triggerType: "EVIDENCE_CREATED",
          actionType: "WEBHOOK_DELIVERY_INTERNAL_ONLY",
          createdByUserId: userId,
          updatedByUserId: userId,
        },
        select: { id: true },
      });
      const destination = await prisma.automationWebhookDestination.create({
        data: {
          teamId,
          name: "g3",
          url: "https://hooks.example.com/auto",
          urlOrigin: `https://${randomUUID()}.example.com`,
          encryptedSecret: "x",
          secretFingerprint: "x",
          enabled: true,
          createdByUserId: userId,
          updatedByUserId: userId,
        },
        select: { id: true },
      });
      const lifecycle = await prisma.lifecycleWebhookEndpoint.create({
        data: { teamId, url: "https://hooks.example.com/life", secret: "s", subscribedEvents: ["EVIDENCE_CREATED"], createdByUserId: userId },
        select: { id: true },
      });
      return { rule: rule.id, destination: destination.id, lifecycle: lifecycle.id };
    }

    it("workspace closure disables rules, destinations and lifecycle endpoints; a closed workspace queues and sends nothing", async () => {
      const org = await fx.seedOrganizationTenant(deps, { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" });
      const f = await automationFixture(org.workspaceId, org.owner.userId);
      await prisma.$transaction(async (tx) => {
        await closure.closeWorkspacesTx(tx, { teamIds: [org.workspaceId], actorUserId: org.owner.userId, reason: "g3 closure" });
      });
      expect((await prisma.automationRule.findUniqueOrThrow({ where: { id: f.rule } })).enabled).toBe(false);
      expect((await prisma.automationWebhookDestination.findUniqueOrThrow({ where: { id: f.destination } })).enabled).toBe(false);
      expect((await prisma.lifecycleWebhookEndpoint.findUniqueOrThrow({ where: { id: f.lifecycle } })).state).toBe("DEACTIVATED");

      // A rule and endpoint left (or turned back) on still deliver nothing for a closed workspace.
      await prisma.automationRule.update({ where: { id: f.rule }, data: { enabled: true } });
      await prisma.automationWebhookDestination.update({ where: { id: f.destination }, data: { enabled: true } });
      await prisma.lifecycleWebhookEndpoint.update({ where: { id: f.lifecycle }, data: { state: "ACTIVE" } });
      const enq = await outbox.enqueueAutomationTrigger(prisma as never, {
        teamId: org.workspaceId,
        triggerType: "EVIDENCE_CREATED",
        targetType: "evidence",
        targetId: randomUUID(),
      });
      expect(enq.enqueued).toBe(0);
      const emitted = await lifecycleWebhooks.emitWebhookEvent({
        prisma: prisma as never,
        teamId: org.workspaceId,
        eventKind: "EVIDENCE_CREATED" as never,
        payload: { g3: true },
      });
      expect(emitted.deliveryIds).toHaveLength(0);
      // A delivery queued before the closure is skipped, never POSTed.
      const run = await prisma.automationRun.create({
        data: {
          teamId: org.workspaceId,
          ruleId: f.rule,
          triggerType: "EVIDENCE_CREATED",
          targetType: "evidence",
          targetId: randomUUID(),
          idempotencyKey: `g3-${randomUUID()}`,
          actionIdempotencyKey: `g3-${randomUUID()}`,
        },
        select: { id: true },
      });
      const delivery = await prisma.automationWebhookDelivery.create({
        data: { teamId: org.workspaceId, runId: run.id, destinationId: f.destination, idempotencyKey: `g3-${randomUUID()}` },
        select: { id: true },
      });
      const outcome = await deliveryRuntime.processDelivery({ deliveryId: delivery.id, prisma: prisma as never });
      expect(outcome).toMatchObject({ status: "SKIPPED", reason: "workspace_not_operating" });

      // Positive control: an open workspace's rule is enqueued.
      const open = await fx.seedOrganizationTenant(deps, { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" });
      await automationFixture(open.workspaceId, open.owner.userId);
      const ok = await outbox.enqueueAutomationTrigger(prisma as never, {
        teamId: open.workspaceId,
        triggerType: "EVIDENCE_CREATED",
        targetType: "evidence",
        targetId: randomUUID(),
      });
      expect(ok.enqueued).toBe(1);
      const okEmit = await lifecycleWebhooks.emitWebhookEvent({
        prisma: prisma as never,
        teamId: open.workspaceId,
        eventKind: "EVIDENCE_CREATED" as never,
        payload: { g3: true },
      });
      expect(okEmit.deliveryIds).toHaveLength(1);
    });

    it("workspace suspension disables automation destinations and lifecycle endpoints, and resume leaves them off", async () => {
      const org = await fx.seedOrganizationTenant(deps, { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" });
      const f = await automationFixture(org.workspaceId, org.owner.userId);
      await wsLifecycle.suspendOrganizationWorkspace({ teamId: org.workspaceId, actorUserId: org.owner.userId });
      expect((await prisma.automationWebhookDestination.findUniqueOrThrow({ where: { id: f.destination } })).enabled).toBe(false);
      expect((await prisma.lifecycleWebhookEndpoint.findUniqueOrThrow({ where: { id: f.lifecycle } })).state).toBe("DEACTIVATED");
      await wsLifecycle.resumeOrganizationWorkspace({ teamId: org.workspaceId, actorUserId: org.owner.userId });
      expect((await prisma.automationWebhookDestination.findUniqueOrThrow({ where: { id: f.destination } })).enabled).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // B5B-F-500 — D-07: Verify survives closure with MINIMAL disclosure.
  // ---------------------------------------------------------------------------
  describe("B5B-F-500 / B5B-F-201 — public Verify after closure, and a quarantined redacted copy", () => {
    let record: { id: string; ref: string; ownerUserId: string };

    beforeAll(async () => {
      await prisma.team.update({ where: { id: A().teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } as never });
      const owner = await member("verify-owner", "MEMBER");
      const created = await call("POST", "/v1/evidence", owner.token, {
        type: "DOCUMENT",
        mimeType: "text/plain",
        teamId: A().teamId,
        deviceTimeIso: "2026-10-01T09:41:07.123+02:00",
        gps: { lat: 48.137154, lng: 11.576124, accuracyMeters: 7 },
      });
      expect(created.statusCode, created.body).toBe(201);
      const id = json(created).id as string;
      const body = Buffer.from(`g3-closure-part ${randomUUID()}`);
      const part = await call("POST", `/v1/evidence/${id}/parts`, owner.token, {
        partIndex: 0,
        mimeType: "text/plain",
        originalFileName: "g3-secret-name.txt",
        sizeBytes: body.length,
      });
      expect(part.statusCode, part.body).toBe(201);
      const put = await fetch(json(part).upload.putUrl as string, { method: "PUT", body, headers: { "content-type": "text/plain" } });
      expect(put.status).toBe(200);
      const done = await call("POST", `/v1/evidence/${id}/complete`, owner.token, {});
      expect(done.statusCode, done.body).toBe(200);
      await prisma.evidence.update({
        where: { id },
        data: { verificationDisclosureMode: "CONTENT_PREVIEW", showRecordedLocation: true } as never,
      });
      const row = await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { verificationRef: true } });
      record = { id, ref: row.verificationRef!, ownerUserId: owner.userId };
    }, 120_000);

    const verify = async () => {
      await clearRates();
      return call("GET", `/public/verify/${encodeURIComponent(record.ref)}`, null);
    };

    it("the owner's account closed: the page stays available and answers VERIFICATION_ONLY with no location", async () => {
      const before = await verify();
      expect(before.statusCode, before.body).toBe(200);
      expect(json(before).disclosure.mode).toBe("CONTENT_PREVIEW");
      expect(json(before).disclosure.recordedLocation).toBe(true);
      const prior = await prisma.user.findUniqueOrThrow({ where: { id: record.ownerUserId }, select: { providerUserId: true } });
      await prisma.user.update({ where: { id: record.ownerUserId }, data: { providerUserId: closedAccountProviderId(record.ownerUserId) } });
      try {
        const after = await verify();
        expect(after.statusCode, after.body).toBe(200);
        const b = json(after);
        expect(b.disclosure.mode).toBe("VERIFICATION_ONLY");
        expect(b.disclosure.recordedLocation).toBe(false);
        expect(b.disclosure.originalDownload).toBe(false);
        expect(b.captureContext ?? null).toBeNull();
        expect(after.body).not.toContain("g3-secret-name");
      } finally {
        await prisma.user.update({ where: { id: record.ownerUserId }, data: { providerUserId: prior.providerUserId } });
      }
      // The record's own policy row is untouched (narrowed at read).
      expect((await prisma.evidence.findUniqueOrThrow({ where: { id: record.id }, select: { verificationDisclosureMode: true } as never })) as never).toMatchObject({ verificationDisclosureMode: "CONTENT_PREVIEW" });
    });

    it("the workspace closed: VERIFICATION_ONLY too", async () => {
      await prisma.team.update({ where: { id: A().teamId }, data: { closedAtUtc: new Date() } });
      try {
        const after = await verify();
        expect(after.statusCode, after.body).toBe(200);
        expect(json(after).disclosure.mode).toBe("VERIFICATION_ONLY");
        expect(json(after).disclosure.recordedLocation).toBe(false);
      } finally {
        await prisma.team.update({ where: { id: A().teamId }, data: { closedAtUtc: null } });
      }
    });

    it("B5B-F-201: a quarantined published redacted copy is not reported as published; a READY one is", async () => {
      const project = await prisma.redactionProject.create({
        data: { teamId: A().teamId, evidenceId: record.id, createdByUserId: A().ownerUserId, artifactKind: "IMAGE" } as never,
        select: { id: true },
      });
      const version = await prisma.redactionVersion.create({
        data: { projectId: project.id, teamId: A().teamId, versionOrdinal: 1, authoredByUserId: A().ownerUserId, state: "PUBLISHED", publishedAtUtc: new Date() } as never,
        select: { id: true },
      });
      const derivative = await prisma.redactionDerivative.create({
        data: { versionId: version.id, teamId: A().teamId, kind: "IMAGE", state: "READY" } as never,
        select: { id: true },
      });
      const ready = await redactionProjection.projectVerifyRedaction({ teamId: A().teamId, evidenceId: record.id }, prisma as never);
      expect(ready?.hasPublishedDerivative).toBe(true);
      await prisma.redactionDerivative.update({ where: { id: derivative.id }, data: { state: "QUARANTINED" } as never });
      const quarantined = await redactionProjection.projectVerifyRedaction({ teamId: A().teamId, evidenceId: record.id }, prisma as never);
      expect(quarantined?.hasPublishedDerivative).toBe(false);
      expect(quarantined?.publishedVersionOrdinal ?? null).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Low / Info rows.
  // ---------------------------------------------------------------------------
  describe("Low and Info rows", () => {
    it("B3B-F-101: a FREE workspace's resend is refused 409 INTAKE_NOT_INCLUDED before any message row", async () => {
      const link = await mintLink(B().ownerUserId, B().teamId, { recipientEmail: "g3-resend@test.proovra.local" });
      const res = await call("POST", `/v1/workflow/intake-links/${link.link.id}/send`, B().ownerToken, {
        channel: "EMAIL",
        rawToken: link.rawToken,
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(json(res).error.code).toBe("INTAKE_NOT_INCLUDED");
      expect(await prisma.communicationMessage.count({ where: { relatedIntakeLinkId: link.link.id } })).toBe(0);
    });

    it("B3B-F-102: two concurrent sends with one nonce make one provider attempt", async () => {
      const link = await mintLink(A().ownerUserId, A().teamId, { recipientEmail: "g3-dup@test.proovra.local" });
      const send = () =>
        dispatcher.dispatchIntakeLinkDelivery({
          teamId: A().teamId,
          intakeLinkId: link.link.id,
          rawToken: link.rawToken,
          channel: "EMAIL",
          actorUserId: A().ownerUserId,
          workspaceName: "g3",
          idempotencyKey: "g3-same-nonce",
        });
      const [a, b] = await Promise.all([send(), send()]);
      expect([a, b].filter((r) => !r.deduped)).toHaveLength(1);
      expect(await prisma.communicationMessage.count({ where: { relatedIntakeLinkId: link.link.id } })).toBe(1);
    });

    it("B3B-F-108: a lapsed shared workspace's evidence-request create answers 402 COMMERCIAL_LIFECYCLE_RESTRICTED", async () => {
      const org = await fx.seedOrganizationTenant(deps, { billingPlan: "TEAM", billingStatus: "ACTIVE" });
      await prisma.subscription.create({
        data: {
          userId: org.owner.userId,
          teamId: org.workspaceId,
          provider: "STRIPE",
          providerSubId: `sub_g3_${randomUUID().slice(0, 12)}`,
          status: "PAST_DUE",
          plan: "TEAM",
          currentPeriodEnd: new Date(Date.now() - 8 * DAY),
        } as never,
      });
      const res = await call("POST", "/v1/evidence-requests", org.owner.token, {
        teamId: org.workspaceId,
        requestType: "ADDITIONAL_EVIDENCE",
        title: "g3 lapsed",
        instructions: "Please photograph the panel.",
        priority: "NORMAL",
        dueAtUtc: new Date(Date.now() + 2 * DAY).toISOString(),
        recipientMode: "EXTERNAL_CONTRIBUTOR",
        recipientLabel: "Claimant",
        recipientEmail: "claimant@test.proovra.local",
        createIntakeLink: false,
        deliverables: [{ title: "Primary", description: "", required: true, acceptedKinds: ["PHOTO"], minCount: 1, locationRequirement: "optional", captureAfterRequest: false, sortOrder: 0 }],
      });
      expect(res.statusCode, res.body).toBe(402);
      expect(json(res).error.code).toBe("COMMERCIAL_LIFECYCLE_RESTRICTED");
    });

    it("B7B-F07: a FREE owner hears the key limit (429) before any step-up challenge", async () => {
      const res = await call("POST", "/v1/integrations/api-keys", B().ownerToken, {
        teamId: B().teamId,
        name: "g3 free key",
        scopes: ["integration.evidence.read"],
      });
      expect(res.statusCode, res.body).toBe(429);
      expect(json(res).error.code).toBe("api_key_limit_reached");
      expect(await prisma.stepUpChallenge.count({ where: { initiatedByUserId: B().ownerUserId, purpose: "INTEGRATION_API_KEY_CREATE" } })).toBe(0);
    });

    it("B7B-F05: an unentitled workspace cannot re-enable or test a legacy webhook; editing it still works", async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          teamId: B().teamId,
          url: "https://hooks.example.com/legacy",
          status: "DISABLED",
          secretCiphertext: "x",
          secretPrefix: "whsec_g3",
          createdByUserId: B().ownerUserId,
        },
        select: { id: true },
      });
      const enable = await call("PUT", `/v1/integrations/webhooks/${endpoint.id}`, B().ownerToken, { teamId: B().teamId, status: "ACTIVE" });
      expect(enable.statusCode, enable.body).toBe(403);
      expect(json(enable).denial).toBe("ENTITLEMENT_REQUIRED");
      const test = await call("POST", `/v1/integrations/webhooks/${endpoint.id}/test`, B().ownerToken, { teamId: B().teamId });
      expect(test.statusCode, test.body).toBe(403);
      expect(json(test).denial).toBe("ENTITLEMENT_REQUIRED");
      const edit = await call("PUT", `/v1/integrations/webhooks/${endpoint.id}`, B().ownerToken, { teamId: B().teamId, description: "renamed" });
      expect(edit.statusCode, edit.body).toBe(200);
      expect((await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } })).status).toBe("DISABLED");
    });

    it("B5B-F-306: a reject racing a final approval cannot flip the decided request", async () => {
      const request = await prisma.destructionRequest.create({
        data: {
          teamId: A().teamId,
          state: "REQUESTED",
          evidenceIds: [],
          reason: "g3 race",
          requestedByUserId: A().ownerUserId,
          approverUserIds: [],
        } as never,
        select: { id: true },
      });
      let signal!: () => void;
      const locked = new Promise<void>((resolve) => (signal = resolve));
      // The approval transaction: holds the request lock and decides APPROVED.
      const approval = prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${request.id}))`;
        await tx.destructionRequest.update({ where: { id: request.id }, data: { state: "APPROVED" } });
        signal();
        await new Promise((r) => setTimeout(r, 750));
      });
      await locked;
      const rejected = await destruction.rejectDestructionRequest({
        prisma: prisma as never,
        teamId: A().teamId,
        requestId: request.id,
        rejectorUserId: A().adminUserId,
        reason: "g3",
      });
      await approval;
      expect(rejected.ok).toBe(false);
      expect((await prisma.destructionRequest.findUniqueOrThrow({ where: { id: request.id } })).state).toBe("APPROVED");
    });
  });
});
