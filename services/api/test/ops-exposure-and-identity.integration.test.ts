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

  it("CRYPTO-004: a KMS identity missing from signing_keys, revoked, or not the KMS key is named; the matching one passes", async () => {
    const { signerIdentityIssue, KMS_PUBLIC_KEY_CACHE_TTL_MS } = await import("../src/services/operations/signer-identity-readiness.js");
    const { generateKeyPairSync } = await import("node:crypto");
    const spki = () => generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    const registeredPem = spki();
    const otherPem = spki();
    const keyId = `kms-${randomUUID().slice(0, 8)}`;
    const kmsKeyId = `alias/readiness-${randomUUID().slice(0, 8)}`;
    // The stand-in for GetPublicKey: what KMS says the key behind KMS_KEY_ID is.
    let kmsHolds: string | Error = registeredPem;
    let kmsCalls = 0;
    const readKmsPublicKeyPem = async (id: string) => {
      kmsCalls += 1;
      expect(id).toBe(kmsKeyId);
      if (kmsHolds instanceof Error) throw kmsHolds;
      return kmsHolds;
    };
    let nowMs = Date.now();
    const issue = (env: NodeJS.ProcessEnv) => signerIdentityIssue(prisma as never, env, { readKmsPublicKeyPem, nowMs });
    const env = { SIGNER_PROVIDER: "aws_kms", SIGNING_KEY_ID: keyId, SIGNING_KEY_VERSION: "1", KMS_KEY_ID: kmsKeyId } as NodeJS.ProcessEnv;
    expect(await issue(env)).toBe("signer_identity_not_registered");
    expect(await issue({ ...env, SIGNER_PROVIDER: "aws-kms" })).toBe("signer_identity_not_registered");
    expect(await issue({ ...env, SIGNING_KEY_VERSION: "" })).toBe("signer_identity_not_configured");
    expect(await issue({ ...env, KMS_KEY_ID: "" })).toBe("signer_identity_not_configured");

    // KMS unreachable: the comparison cannot be made, so the instance is not ready.
    const row = await prisma.signingKey.create({
      data: { keyId, version: 1, purpose: "EVIDENCE_SIGNATURE", publicKeyPem: registeredPem.trim() },
      select: { id: true },
    });
    kmsHolds = new Error("kms unreachable");
    expect(await issue(env)).toBe("signer_public_key_unavailable");
    // The registered key IS the KMS key: ready. Positive control.
    kmsHolds = registeredPem;
    expect(await issue(env)).toBeNull();
    // Cached: the next probes do not call KMS until the cache ages out.
    const calls = kmsCalls;
    kmsHolds = otherPem;
    expect(await issue(env)).toBeNull();
    expect(kmsCalls).toBe(calls);
    // The key behind KMS_KEY_ID changed under the same identity: refused by name.
    nowMs += KMS_PUBLIC_KEY_CACHE_TTL_MS + 1;
    expect(await issue(env)).toBe("signer_identity_key_mismatch");
    expect(kmsCalls).toBe(calls + 1);

    kmsHolds = registeredPem;
    nowMs += KMS_PUBLIC_KEY_CACHE_TTL_MS + 1;
    expect(await issue(env)).toBeNull();
    await prisma.signingKey.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
    expect(await issue(env)).toBe("signer_identity_revoked");
    // A local PEM registers itself on first use, so it is not refused here.
    expect(await issue({ SIGNER_PROVIDER: "local-pem" })).toBeNull();
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
