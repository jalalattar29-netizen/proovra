/**
 * OPS-008 / AUTHZ-010 / OPS-015 / CRYPTO-004 / OPS-019 — what an operational
 * endpoint gives away with no token, and what a running deployment can prove about
 * itself. Real routes against a real database.
 */
import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("Operational exposure and identity (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  const saved = { ...process.env };

  const restore = (...keys: string[]) => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
  }, 180_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  afterEach(() => {
    restore("METRICS_SCRAPE_TOKEN", "NODE_ENV", "PROOVRA_DEPLOYMENT_ENV", "SIGNER_PROVIDER", "SIGNING_KEY_ID", "SIGNING_KEY_VERSION", "APP_RELEASE_SHA");
  });

  const metrics = (authorization?: string) =>
    h.app.inject({ method: "GET", url: "/metrics", headers: authorization ? { authorization } : {} });

  it("OPS-008 keeps the scrape contract: with a token set, the token is required", async () => {
    process.env.METRICS_SCRAPE_TOKEN = "scrape-token-0123456789";
    expect((await metrics()).statusCode).toBe(401);
    expect((await metrics("Bearer wrong-token-0123456789")).statusCode).toBe(401);
    const ok = await metrics("Bearer scrape-token-0123456789");
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toContain("version=0.0.4");
  });

  it("OPS-008: with no token, a deployed environment serves no counters", async () => {
    delete process.env.METRICS_SCRAPE_TOKEN;
    const { developmentSurfacesAllowed } = await import("@proovra/shared-runtime");
    const env = process.env as Record<string, string | undefined>;
    const before = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      expect(developmentSurfacesAllowed()).toBe(false);
      const res = await metrics();
      expect(res.statusCode).toBe(503);
      expect(res.body).toContain("METRICS_SCRAPE_TOKEN_NOT_CONFIGURED");
      expect(res.body).not.toContain("# TYPE");
    } finally {
      env.NODE_ENV = before;
    }
    // The positive control: a declared test environment still reads it.
    expect((await metrics()).statusCode).toBe(200);
  });

  it("CRYPTO-004: a KMS identity missing from signing_keys, or revoked, is named; a registered one passes", async () => {
    const { signerIdentityIssue } = await import("../src/services/operations/signer-identity-readiness.js");
    const keyId = `kms-${randomUUID().slice(0, 8)}`;
    const env = { SIGNER_PROVIDER: "aws_kms", SIGNING_KEY_ID: keyId, SIGNING_KEY_VERSION: "1" } as NodeJS.ProcessEnv;
    expect(await signerIdentityIssue(prisma as never, env)).toBe("signer_identity_not_registered");
    expect(await signerIdentityIssue(prisma as never, { ...env, SIGNER_PROVIDER: "aws-kms" })).toBe("signer_identity_not_registered");
    expect(await signerIdentityIssue(prisma as never, { ...env, SIGNING_KEY_VERSION: "" })).toBe("signer_identity_not_configured");
    const row = await prisma.signingKey.create({
      data: { keyId, version: 1, purpose: "EVIDENCE_SIGNATURE", publicKeyPem: "test" },
      select: { id: true },
    });
    expect(await signerIdentityIssue(prisma as never, env)).toBeNull();
    await prisma.signingKey.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
    expect(await signerIdentityIssue(prisma as never, env)).toBe("signer_identity_revoked");
    // A local PEM registers itself on first use, so it is not refused here.
    expect(await signerIdentityIssue(prisma as never, { SIGNER_PROVIDER: "local-pem" })).toBeNull();
  });

  it("OPS-015: the release record names the API's build and each live worker's, and says when they differ", async () => {
    const { readReleaseIdentity } = await import("../src/services/operations/release-identity.service.js");
    const sha = "a".repeat(40);
    process.env.APP_RELEASE_SHA = sha;
    await prisma.workerLease.deleteMany({});
    await prisma.workerLease.create({
      data: { workerId: "w-current", workerKind: "WORKER" as never, state: "LIVE" as never, buildRevision: sha, queueSubscriptions: [] } as never,
    });
    await prisma.workerLease.create({
      data: {
        workerId: "w-stopped",
        workerKind: "WORKER" as never,
        state: "STOPPED" as never,
        buildRevision: "b".repeat(40),
        stoppedAtUtc: new Date(),
        queueSubscriptions: [],
      } as never,
    });
    const aligned = await readReleaseIdentity(prisma as never);
    expect(aligned.api.revision).toBe(sha);
    expect(aligned.workers.map((w) => w.workerId)).toEqual(["w-current"]);
    expect(aligned.aligned).toBe(true);

    await prisma.workerLease.update({ where: { workerId: "w-current" }, data: { buildRevision: "c".repeat(40) } });
    expect((await readReleaseIdentity(prisma as never)).aligned).toBe(false);
    await prisma.workerLease.deleteMany({});
    expect((await readReleaseIdentity(prisma as never)).aligned).toBe(false);
  });

  it("OPS-020: an eviction policy that loses jobs is named, against the real Redis and from a server's report", async () => {
    const { evictionPolicyFromInfo } = await import("../src/runtime/runtime-readiness.js");
    expect(evictionPolicyFromInfo("# Memory\r\nused_memory:1\r\nmaxmemory_policy:allkeys-lru\r\n")).toBe("allkeys-lru");
    expect(evictionPolicyFromInfo("# Memory\r\nused_memory:1\r\n")).toBeNull();
    const { default: IORedis } = await import("ioredis");
    const redis = new IORedis(process.env.REDIS_URL!, { lazyConnect: true });
    await redis.connect();
    expect(evictionPolicyFromInfo(await redis.info("memory"))).toBe("noeviction");
    redis.disconnect();
  });

  it("OPS-015: the release route is closed to a workspace owner", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/admin/platform/release",
      headers: { authorization: `Bearer ${h.fixtures.teamA.ownerToken}` },
    });
    expect([401, 403, 404]).toContain(res.statusCode);
    expect(res.body).not.toContain("revision");
  });
});
