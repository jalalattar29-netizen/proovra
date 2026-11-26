/**
 * Sentry alert audit (2026-11-26) — a dependency that fails AFTER readiness's
 * first database probe passed (the signer-identity lookup, a connection dropped
 * mid-evaluation) escaped as a raw 500 with the driver's message. It must answer
 * a bounded 503 — never a 200, never the driver's text — and the next probe must
 * read ready again once the dependency is back.
 */
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => {
  // A real key pair: the registered row and "KMS" hold the same public key, so a
  // healthy probe is genuinely ready (200), not merely "not registered".
  const { generateKeyPairSync } = process.getBuiltinModule("node:crypto") as typeof import("node:crypto");
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    signerFails: false,
    pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    der: publicKey.export({ type: "spki", format: "der" }),
  };
});

vi.mock("@aws-sdk/client-kms", () => ({
  KMSClient: class {
    async send() {
      return { PublicKey: new Uint8Array(H.der) };
    }
  },
  GetPublicKeyCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock("../src/config/index.js", async (orig) => ({
  ...(await orig<typeof import("../src/config/index.js")>()),
  collectStartupViolations: () => [],
}));
vi.mock("../src/services/timestamp/validate-tsa-token.js", async (orig) => ({
  ...(await orig<typeof import("../src/services/timestamp/validate-tsa-token.js")>()),
  isTsaProductionEnv: () => false,
}));
vi.mock("../src/runtime/runtime-readiness.js", async (orig) => ({
  ...(await orig<typeof import("../src/runtime/runtime-readiness.js")>()),
  checkRedis: async () => ({ id: "redis", status: "HEALTHY", reasonCode: "ok", detail: "", remediationHint: null, metadata: {} }),
  checkEvidenceStorage: async () => ({ id: "s3_object_lock", status: "HEALTHY", reasonCode: "ok", detail: "", remediationHint: null, metadata: {} }),
}));
vi.mock("../src/db.js", () => {
  const prisma = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "$queryRaw") return async () => [{ ok: 1 }];
        if (prop === "$queryRawUnsafe") return async (sql: string) => (String(sql).includes("indisunique") ? [{ ok: 1 }] : []);
        // The signer-identity lookup (signingKey.findUnique) is the step that runs
        // after the database probe; it fails the way it did on 2026-11-26.
        return {
          findUnique: async () => {
            if (H.signerFails) throw new Error("Cannot use a pool after calling end on the pool");
            return { revokedAt: null, publicKeyPem: H.pem, fingerprintSha256: null };
          },
          findMany: async () => [],
          findFirst: async () => null,
          count: async () => 0,
        };
      },
    },
  );
  return { prisma };
});
vi.mock("../src/middleware/auth.js", () => ({ requireAuth: async () => undefined }));

import { opsRoutes } from "../src/routes/ops.routes.js";

// The signer step only runs in production, for a KMS signer. Set per probe: the
// shared test setup restores the environment before every test.
const PRODUCTION_SIGNER_ENV = {
  NODE_ENV: "production",
  SIGNER_PROVIDER: "aws-kms",
  SIGNING_KEY_ID: "k",
  SIGNING_KEY_VERSION: "1",
  KMS_KEY_ID: "kms",
};

async function readyz() {
  const saved = Object.fromEntries(Object.keys(PRODUCTION_SIGNER_ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, PRODUCTION_SIGNER_ENV);
  try {
    return await probe();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function probe() {
  const app = Fastify();
  await app.register(opsRoutes);
  await app.ready();
  const res = await app.inject({ method: "GET", url: "/readyz" });
  await app.close();
  return { status: res.statusCode, body: res.body };
}

describe("/readyz — a late dependency failure is a bounded 503, and recovery reads ready", () => {
  it("ready while every dependency answers", async () => {
    H.signerFails = false;
    expect(await readyz()).toEqual({ status: 200, body: JSON.stringify({ status: "ok" }) });
  });

  it("the signer lookup failing after the database probe passed is 503 readiness_check_failed, without the driver's message", async () => {
    H.signerFails = true;
    const r = await readyz();
    expect(r.status).toBe(503);
    expect(JSON.parse(r.body)).toEqual({ status: "degraded", reason: "readiness_check_failed" });
    expect(r.body).not.toMatch(/pool|Cannot use/);
  });

  it("once the dependency is back the next probe is 200 again (nothing cached the failure)", async () => {
    H.signerFails = false;
    expect((await readyz()).status).toBe(200);
  });
});
