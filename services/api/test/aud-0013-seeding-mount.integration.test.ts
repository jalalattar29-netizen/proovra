// Database acquisition: bootIntegrationHarness() (the ONE canonical helper).
/**
 * AUD-0013 — THE REAL SERVER, NOT ITS SOURCE TEXT (live PostgreSQL 16).
 *
 * Production answered GET /v1/ops/seed/reviewer-ops with 401, not 404: the
 * seeding surface was mounted because OPERATIONAL_SEEDING_ENABLED was on, while
 * every write there was refused SEEDING_PROD_GUARDED. The candidate mounts it
 * in production only with the explicit OPERATIONAL_SEEDING_ALLOW_PRODUCTION
 * opt-in. Here `buildServer()` itself is built under each environment and the
 * route is asked for anonymously: absent → 404, mounted → 401.
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("AUD-0013 — seeding routes on the built server", () => {
  let harness: IntegrationHarness;
  // Production refuses the committed signing fixture at startup; a throwaway key of this run stands in.
  const keyDir = mkdtempSync(join(tmpdir(), "aud0013-"));
  const keyPath = join(keyDir, "signing.pem");
  writeFileSync(keyPath, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));
  const PRODUCTION = {
    NODE_ENV: "production",
    API_TRUST_PROXY_MODE: "off",
    SIGNING_PRIVATE_KEY_PATH: keyPath,
    SIGNING_PRIVATE_KEY_PEM: "",
    // The production configuration the API requires to start (non-secret values).
    S3_OBJECT_LOCK_ENABLED: "true",
    S3_BUCKET: process.env.P7_LOCK_BUCKET ?? "point7-lock-bucket",
    S3_OBJECT_LOCK_MODE: "COMPLIANCE",
    PDF_SIGNING_ENABLED: "false",
    PDF_ARTIFACT_SIGNATURE_OPT_OUT_ACK: "true",
    APP_BASE_URL: "https://app.example.test",
    WEBAUTHN_RP_ID: "example.test",
    WEBAUTHN_ORIGINS: "https://app.example.test",
  };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
  }, 900_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await harness?.cleanup();
    rmSync(keyDir, { recursive: true, force: true });
  });

  async function probe(env: Record<string, string | undefined>): Promise<number> {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v as string);
    const { buildServer } = await import("../src/server.js");
    const app = await buildServer();
    try {
      await app.ready();
      const res = await app.inject({ method: "GET", url: "/v1/ops/seed/reviewer-ops" });
      return res.statusCode;
    } finally {
      await app.close();
      vi.unstubAllEnvs();
    }
  }

  it("production with ENABLED alone: not mounted (404)", async () => {
    expect(
      await probe({ ...PRODUCTION, OPERATIONAL_SEEDING_ENABLED: "true", OPERATIONAL_SEEDING_ALLOW_PRODUCTION: "" }),
    ).toBe(404);
  }, 300_000);

  it("production default (nothing enabled): not mounted (404)", async () => {
    expect(await probe({ ...PRODUCTION, OPERATIONAL_SEEDING_ENABLED: "", OPERATIONAL_SEEDING_ALLOW_PRODUCTION: "" })).toBe(404);
  }, 300_000);

  it("production with the explicit opt-in: mounted, and still behind authentication (401)", async () => {
    expect(
      await probe({ ...PRODUCTION, OPERATIONAL_SEEDING_ENABLED: "true", OPERATIONAL_SEEDING_ALLOW_PRODUCTION: "true" }),
    ).toBe(401);
  }, 300_000);

  it("control: enabled outside production is mounted (401)", async () => {
    expect(await probe({ NODE_ENV: "test", OPERATIONAL_SEEDING_ENABLED: "true", OPERATIONAL_SEEDING_ALLOW_PRODUCTION: "" })).toBe(401);
  }, 300_000);
});
