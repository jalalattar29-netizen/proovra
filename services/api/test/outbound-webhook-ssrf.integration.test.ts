/**
 * PRO-061 / BILLING-02, PRO-062 / BILLING-03, PRO-064 / BILLING-05,
 * PRO-067 / BILLING-08 and WEBHOOK-STEPUP — the three webhook stacks against
 * live PostgreSQL.
 *
 * Reproductions (all were accepted and delivered before the shared policy):
 *   - lifecycle: `https://169.254.169.254/...`, `https://localhost./x`,
 *     `https://[::1]/x` stored ACTIVE and fetched by the worker, which also
 *     followed redirects and returned the receiver's body to the tenant;
 *   - integration: `https://localhost./hook` and `https://0.0.0.1/hook`
 *     stored ACTIVE and delivered, with no recheck at send;
 *   - automation: `https://[::ffff:127.0.0.1]/hook` accepted at create;
 *   - lifecycle ceiling: limit 1, three creates all 201.
 *
 * Endpoint rows written before the fix are seeded directly, in the shape the
 * old create wrote them, because that is exactly the data a deployed database
 * holds. The HTTP boundary is a RECORDING client; nothing leaves the process
 * and no DNS query is made (every URL is a literal or is refused before
 * resolution).
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("outbound webhook policy — three stacks (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let totp: typeof import("../src/services/security/mfa-totp.js");
  let dispatcher: typeof import("../../worker/src/webhook-dispatcher.js");
  const secrets = new Map<string, Buffer>();
  const STEP = "x-proovra-step-up-challenge-id";
  const savedEnv: Record<string, string | undefined> = {};

  const call = (opts: {
    method: "GET" | "POST";
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

  async function stepUp(input: {
    token: string;
    userId: string;
    teamId: string;
    purpose: string;
    resourceKind: string;
    resourceId: string;
  }): Promise<string> {
    const started = await call({
      method: "POST",
      url: "/v1/identity-security/step-up/start",
      token: input.token,
      payload: {
        teamId: input.teamId,
        purpose: input.purpose,
        resourceKind: input.resourceKind,
        resourceId: input.resourceId,
      },
    });
    expect(started.statusCode, started.body).toBe(200);
    const challengeId = (started.json() as { challenge: { id: string } }).challenge.id;
    // Each authenticator time step is accepted once; this suite performs more
    // step-ups than one window holds, so the last-used marker is reset first.
    await prisma.mfaFactor.updateMany({
      where: { userId: input.userId, kind: "TOTP" },
      data: { lastUsedAt: null },
    });
    const code = totp.computeTotpCode(
      secrets.get(input.userId)!,
      totp.timeStep(Math.floor(Date.now() / 1000)),
    );
    const checked = await call({
      method: "POST",
      url: "/v1/identity-security/step-up/check",
      token: input.token,
      payload: { teamId: input.teamId, challengeId, code },
    });
    expect(checked.statusCode, checked.body).toBe(200);
    return challengeId;
  }

  const lifecycleStepUp = () => {
    const { teamA } = h.fixtures;
    return stepUp({
      token: teamA.ownerToken,
      userId: teamA.ownerUserId,
      teamId: teamA.teamId,
      purpose: "INTEGRATION_WEBHOOK_CREATE",
      resourceKind: "team",
      resourceId: teamA.teamId,
    });
  };

  async function setEndpointLimit(teamId: string, value: number): Promise<void> {
    const { upsertEntitlementGrant } = await import("../src/services/packaging/entitlement.service.js");
    await upsertEntitlementGrant({
      teamId,
      key: "INTEGRATION_WEBHOOK_ENDPOINTS_MAX",
      value,
      kind: "LIMIT",
      source: "CUSTOM",
      grantedByUserId: h.fixtures.teamA.ownerUserId,
    });
  }

  beforeAll(async () => {
    for (const k of ["INTEGRATIONS_ENABLED", "API_KEY_SECRET", "WEBHOOK_ALLOW_PRIVATE_NETWORKS"]) {
      savedEnv[k] = process.env[k];
    }
    process.env.INTEGRATIONS_ENABLED = "true";
    process.env.API_KEY_SECRET = "cd".repeat(32);
    delete process.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS;

    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    await import("../src/register-shared-runtime.js");
    totp = await import("../src/services/security/mfa-totp.js");
    dispatcher = await import("../../worker/src/webhook-dispatcher.js");
    const { teamA, teamB } = h.fixtures;
    await prisma.user.update({ where: { id: teamA.ownerUserId }, data: { currentWorkspaceId: teamA.teamId } });
    await prisma.user.update({ where: { id: teamB.ownerUserId }, data: { currentWorkspaceId: teamB.teamId } });
    await seedTotp(teamA.ownerUserId);

    // FEATURE_WEBHOOKS is written by the operator path (BILLING-01), never
    // self-granted.
    const { upsertEntitlementGrant } = await import("../src/services/packaging/entitlement.service.js");
    await upsertEntitlementGrant({
      teamId: teamA.teamId,
      key: "FEATURE_WEBHOOKS",
      value: true,
      kind: "FEATURE",
      source: "CUSTOM",
      grantedByUserId: teamA.ownerUserId,
    });
  }, 180_000);

  afterAll(async () => {
    if (prisma && h) {
      const where = { teamId: { in: [h.fixtures.teamA.teamId, h.fixtures.teamB.teamId] } };
      await prisma.lifecycleWebhookDelivery.deleteMany({ where }).catch(() => undefined);
      await prisma.lifecycleWebhookEndpoint.deleteMany({ where }).catch(() => undefined);
      await prisma.integrationWebhookDelivery.deleteMany({ where }).catch(() => undefined);
      await prisma.webhookEndpoint.deleteMany({ where }).catch(() => undefined);
      await prisma.automationWebhookDestination.deleteMany({ where }).catch(() => undefined);
      await prisma.entitlementGrant.deleteMany({ where }).catch(() => undefined);
      await prisma.stepUpChallenge.deleteMany({ where }).catch(() => undefined);
    }
    await h?.cleanup();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // ===========================================================================
  // Lifecycle webhooks (PRO-061, PRO-062, WEBHOOK-STEPUP)
  // ===========================================================================

  describe("lifecycle webhooks", () => {
    it("create asks for a step-up, refuses the metadata address and admits a public one", async () => {
      const { teamA } = h.fixtures;
      await setEndpointLimit(teamA.teamId, 10);
      const before = await prisma.lifecycleWebhookEndpoint.count({ where: { teamId: teamA.teamId } });
      const payload = { url: "https://203.0.113.10/hook", subscribedEvents: ["EVIDENCE_CREATED"] };

      const bare = await call({ method: "POST", url: "/v1/integrations/webhooks/endpoints", token: teamA.ownerToken, payload });
      expect(bare.statusCode, bare.body).toBe(401);
      expect(bare.body).toContain("STEP_UP_REQUIRED");

      const metadata = await call({
        method: "POST",
        url: "/v1/integrations/webhooks/endpoints",
        token: teamA.ownerToken,
        payload: { ...payload, url: "https://169.254.169.254/latest/meta-data/" },
        headers: { [STEP]: await lifecycleStepUp() },
      });
      expect(metadata.statusCode, metadata.body).toBe(400);
      expect(metadata.body).toContain("WEBHOOK_ENDPOINT_URL_INVALID");
      expect(await prisma.lifecycleWebhookEndpoint.count({ where: { teamId: teamA.teamId } })).toBe(before);

      const ok = await call({
        method: "POST",
        url: "/v1/integrations/webhooks/endpoints",
        token: teamA.ownerToken,
        payload,
        headers: { [STEP]: await lifecycleStepUp() },
      });
      expect(ok.statusCode, ok.body).toBe(201);
      expect(await prisma.lifecycleWebhookEndpoint.count({ where: { teamId: teamA.teamId } })).toBe(before + 1);
    });

    it("the endpoint ceiling is a live count: N = limit succeeds, N + 1 is refused, deactivating frees a place", async () => {
      const { teamA } = h.fixtures;
      const active = await prisma.lifecycleWebhookEndpoint.count({ where: { teamId: teamA.teamId, state: "ACTIVE" } });
      await setEndpointLimit(teamA.teamId, active + 1);
      const create = async () =>
        call({
          method: "POST",
          url: "/v1/integrations/webhooks/endpoints",
          token: teamA.ownerToken,
          payload: { url: `https://203.0.113.10/hook/${randomUUID()}`, subscribedEvents: ["EVIDENCE_CREATED"] },
          headers: { [STEP]: await lifecycleStepUp() },
        });
      const first = await create();
      expect(first.statusCode, first.body).toBe(201);
      const over = await create();
      expect(over.statusCode, over.body).toBe(429);
      expect(over.json()).toEqual({ denial: "LIMIT_EXCEEDED", key: "INTEGRATION_WEBHOOK_ENDPOINTS_MAX" });
      expect(await prisma.lifecycleWebhookEndpoint.count({ where: { teamId: teamA.teamId, state: "ACTIVE" } })).toBe(active + 1);

      const { endpointId } = first.json() as { endpointId: string };
      const off = await call({
        method: "POST",
        url: `/v1/integrations/webhooks/endpoints/${endpointId}/deactivate`,
        token: teamA.ownerToken,
        payload: {},
      });
      expect(off.statusCode, off.body).toBe(200);
      const again = await create();
      expect(again.statusCode, again.body).toBe(201);
    });

    it("concurrent creates at the boundary admit exactly one", async () => {
      const { teamA } = h.fixtures;
      const { createWebhookEndpoint, WebhookEndpointLimitError } = await import(
        "../src/services/packaging/webhooks/webhook-platform.service.js"
      );
      const active = await prisma.lifecycleWebhookEndpoint.count({ where: { teamId: teamA.teamId, state: "ACTIVE" } });
      await setEndpointLimit(teamA.teamId, active + 1);
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          createWebhookEndpoint({
            prisma: prisma as never,
            teamId: teamA.teamId,
            url: `https://203.0.113.10/race/${randomUUID()}`,
            subscribedEvents: ["EVIDENCE_CREATED"],
            createdByUserId: teamA.ownerUserId,
          }),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(refused).toHaveLength(5);
      for (const r of refused) expect(r.reason).toBeInstanceOf(WebhookEndpointLimitError);
      expect(await prisma.lifecycleWebhookEndpoint.count({ where: { teamId: teamA.teamId, state: "ACTIVE" } })).toBe(active + 1);
    });

    it("the worker refuses stored bypass rows at send, fetches the public one once, keeps no body, does not retry a redirect", async () => {
      const { teamA } = h.fixtures;
      const bad = [
        "https://169.254.169.254/latest/meta-data/",
        "https://localhost./x",
        "https://[::1]/x",
        "https://127.0.0.1:9/x",
        "https://10.0.0.5/internal",
        "https://[::ffff:7f00:1]/x",
      ];
      const seed = async (url: string) => {
        const ep = await prisma.lifecycleWebhookEndpoint.create({
          data: {
            teamId: teamA.teamId,
            url,
            secret: Buffer.from(randomUUID()).toString("base64"),
            subscribedEvents: ["EVIDENCE_CREATED"],
            state: "ACTIVE",
            createdByUserId: teamA.ownerUserId,
          },
          select: { id: true, url: true },
        });
        const d = await prisma.lifecycleWebhookDelivery.create({
          data: {
            teamId: teamA.teamId,
            endpointId: ep.id,
            eventKind: "EVIDENCE_CREATED",
            payload: { evidenceId: randomUUID() },
            signature: "",
            state: "PENDING",
          },
          select: { id: true },
        });
        return { url: ep.url, deliveryId: d.id };
      };
      const refusedRows = await Promise.all(bad.map(seed));
      const good = await seed(`https://203.0.113.10/ok/${randomUUID()}`);
      const redirecting = await seed(`https://203.0.113.10/redirect/${randomUUID()}`);

      const calls: string[] = [];
      await dispatcher.runWebhookDispatcherTick({
        fetcher: (async (url: string) => {
          calls.push(url);
          return url.includes("/redirect/")
            ? { status: 302, text: async () => "Location: http://169.254.169.254/" }
            : { status: 200, text: async () => "ami-id: i-0123 (what the worker reached)" };
        }) as never,
      });

      for (const row of refusedRows) {
        expect(calls, row.url).not.toContain(row.url);
        const d = await prisma.lifecycleWebhookDelivery.findUniqueOrThrow({ where: { id: row.deliveryId } });
        expect(d.state, row.url).toBe("FAILED");
        expect(d.responseStatus).toBeNull();
      }
      expect(calls.filter((u) => u === good.url)).toHaveLength(1);
      const delivered = await prisma.lifecycleWebhookDelivery.findUniqueOrThrow({ where: { id: good.deliveryId } });
      expect(delivered.state).toBe("DELIVERED");
      expect(delivered.responseStatus).toBe(200);
      expect(delivered.responseBodyPreview).toBeNull();

      const redirected = await prisma.lifecycleWebhookDelivery.findUniqueOrThrow({ where: { id: redirecting.deliveryId } });
      expect(redirected.state).toBe("FAILED");
      expect(redirected.responseStatus).toBe(302);
      expect(calls.filter((u) => u === redirecting.url)).toHaveLength(1);

      // A row written before the fix that still holds a body is not echoed.
      await prisma.lifecycleWebhookDelivery.update({
        where: { id: good.deliveryId },
        data: { responseBodyPreview: "legacy body from an internal host" },
      });
      const list = await call({
        method: "GET",
        url: "/v1/integrations/webhooks/lifecycle-deliveries",
        token: teamA.ownerToken,
      });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.body).not.toContain("legacy body from an internal host");
      expect(list.body).not.toContain("ami-id");
      const rows = (list.json() as { deliveries: Array<{ id: string; responseBodyExcerpt: unknown }> }).deliveries;
      expect(rows.find((r) => r.id === good.deliveryId)?.responseBodyExcerpt).toBeNull();
    });
  });

  // ===========================================================================
  // Integration webhooks (PRO-067)
  // ===========================================================================

  describe("integration webhooks", () => {
    it("create refuses localhost. and 0.0.0.1 behind a valid step-up; a stored bypass row is refused at send", async () => {
      const { teamA } = h.fixtures;
      for (const url of ["https://localhost./hook", "https://0.0.0.1/hook"]) {
        const challenge = await stepUp({
          token: teamA.ownerToken,
          userId: teamA.ownerUserId,
          teamId: teamA.teamId,
          purpose: "INTEGRATION_WEBHOOK_CREATE",
          resourceKind: "team",
          resourceId: teamA.teamId,
        });
        const res = await call({
          method: "POST",
          url: "/v1/integrations/webhooks",
          token: teamA.ownerToken,
          payload: { teamId: teamA.teamId, url },
          headers: { [STEP]: challenge },
        });
        expect(res.statusCode, `${url} ${res.body}`).toBe(400);
        expect(res.json()).toMatchObject({ error: { code: "invalid_url", details: { reason: "private_network_blocked" } } });
      }
      expect(await prisma.webhookEndpoint.count({ where: { teamId: teamA.teamId } })).toBe(0);

      const { createWebhookEndpoint } = await import("../src/services/integrations/webhooks.service.js");
      const goodEp = await createWebhookEndpoint({
        teamId: teamA.teamId,
        url: `https://203.0.113.10/integration/${randomUUID()}`,
        eventTypes: [],
        actorUserId: teamA.ownerUserId,
      });
      // The exact rows the old create stored for the reproduction.
      const legacy: string[] = [];
      for (const url of ["https://localhost./hook", "https://0.0.0.1/hook"]) {
        const seeded = await createWebhookEndpoint({
          teamId: teamA.teamId,
          url: `https://203.0.113.10/placeholder/${randomUUID()}`,
          eventTypes: [],
          actorUserId: teamA.ownerUserId,
        });
        await prisma.webhookEndpoint.update({ where: { id: seeded.endpoint.id }, data: { url } });
        legacy.push(seeded.endpoint.id);
      }

      const { __setWebhookHttpClientForTests, emitWebhookEvent } = await import(
        "../src/services/integrations/webhook-dispatcher.js"
      );
      const sent: string[] = [];
      const restore = __setWebhookHttpClientForTests(async (req) => {
        sent.push(req.url);
        return { status: 200, bodyPreview: "internal answer", errorMessage: null };
      });
      try {
        const result = await emitWebhookEvent(
          { teamId: teamA.teamId, eventType: "evidence.created", payload: { evidenceId: randomUUID() } },
          prisma as never,
        );
        expect(result.enqueued).toBe(3);
        expect(result.delivered).toBe(1);
        expect(result.failedPermanent).toBe(2);
      } finally {
        restore();
      }
      expect(sent).toEqual([goodEp.endpoint.url]);
      for (const id of legacy) {
        const d = await prisma.integrationWebhookDelivery.findFirstOrThrow({ where: { endpointId: id } });
        expect(d.status).toBe("FAILED");
        expect(d.errorMessage).toMatch(/^destination_refused:/);
      }
      // The deliveries route never returns a receiver's body.
      const list = await call({
        method: "GET",
        url: `/v1/integrations/webhooks/${goodEp.endpoint.id}/deliveries?teamId=${teamA.teamId}`,
        token: teamA.ownerToken,
      });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.body).not.toContain("internal answer");
      const stored = await prisma.integrationWebhookDelivery.findFirstOrThrow({ where: { endpointId: goodEp.endpoint.id } });
      expect(stored.status).toBe("SENT");
      expect(stored.responseBodyPreview).toBeNull();
    });
  });

  // ===========================================================================
  // Automation webhooks (PRO-064, WEBHOOK-STEPUP)
  // ===========================================================================

  describe("automation webhooks", () => {
    it("the IPv4-mapped hex form is refused at create; a public destination needs a step-up", async () => {
      const { teamA } = h.fixtures;
      const base = { teamId: teamA.teamId, name: "Receiver" };
      for (const url of [
        "https://[::ffff:127.0.0.1]/hook",
        "https://[::ffff:169.254.169.254]/hook",
        "https://[::]/hook",
        "https://[64:ff9b::a9fe:a9fe]/hook",
      ]) {
        const res = await call({ method: "POST", url: "/v1/automation/webhooks", token: teamA.ownerToken, payload: { ...base, url } });
        expect(res.statusCode, `${url} ${res.body}`).toBe(400);
        expect(res.json().error.code).toBe("url_rejected");
      }
      expect(await prisma.automationWebhookDestination.count({ where: { teamId: teamA.teamId } })).toBe(0);

      const publicUrl = { ...base, url: "https://203.0.113.10/automation" };
      const bare = await call({ method: "POST", url: "/v1/automation/webhooks", token: teamA.ownerToken, payload: publicUrl });
      expect(bare.statusCode, bare.body).toBe(401);
      expect(await prisma.automationWebhookDestination.count({ where: { teamId: teamA.teamId } })).toBe(0);
      const challenge = await stepUp({
        token: teamA.ownerToken,
        userId: teamA.ownerUserId,
        teamId: teamA.teamId,
        purpose: "INTEGRATION_WEBHOOK_CREATE",
        resourceKind: "team",
        resourceId: teamA.teamId,
      });
      const created = await call({
        method: "POST",
        url: "/v1/automation/webhooks",
        token: teamA.ownerToken,
        payload: publicUrl,
        headers: { [STEP]: challenge },
      });
      expect(created.statusCode, created.body).toBe(201);
      const id = (created.json() as { id: string }).id;

      // Rotation reveals a new secret: refused without a step-up.
      const rotateBare = await call({ method: "POST", url: `/v1/automation/webhooks/${id}/rotate-secret`, token: teamA.ownerToken, payload: {} });
      expect(rotateBare.statusCode, rotateBare.body).toBe(401);
      const before = await prisma.automationWebhookDestination.findUniqueOrThrow({ where: { id } });
      const rotate = await call({
        method: "POST",
        url: `/v1/automation/webhooks/${id}/rotate-secret`,
        token: teamA.ownerToken,
        payload: {},
        headers: {
          [STEP]: await stepUp({
            token: teamA.ownerToken,
            userId: teamA.ownerUserId,
            teamId: teamA.teamId,
            purpose: "INTEGRATION_WEBHOOK_SECRET_ROTATE",
            resourceKind: "automation_webhook_destination",
            resourceId: id,
          }),
        },
      });
      expect(rotate.statusCode, rotate.body).toBe(200);
      const after = await prisma.automationWebhookDestination.findUniqueOrThrow({ where: { id } });
      expect(after.secretFingerprint).not.toBe(before.secretFingerprint);
    });
  });
});
