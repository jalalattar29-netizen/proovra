/**
 * Independent forward audit closure — Wave E (F-39, F-41), and the operator
 * safety report (F-08 / F-39 / F-41).
 *
 * F-41: development-only surfaces (persona login + dev billing behind
 *       devAuthEnabled; the E2E auth bypass + rate-limit reset behind
 *       shouldBypassAuthRateLimit) were gated on the string NODE_ENV !==
 *       "production"; a staging or undeclared deployment exposed them. The
 *       object-lock bootstraps did not treat an AMBIGUOUS classification as
 *       production-shaped.
 * F-39: the committed signing fixture (its private half is public) was
 *       registered by the seed in any deployment with no key path, refused
 *       only at signing time and only on NODE_ENV=production. It is now refused
 *       outside an explicit development / test environment: at the seed, in the
 *       registry (registration and use), at the signing guard, and at API
 *       startup.
 *
 * Expected values are literals; environments are passed explicitly.
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  assertNotCommittedFixture,
  assertNotCommittedFixtureKey,
  committedFixtureKeyAllowed,
  FixtureSigningKeyRefused,
  publicFingerprintOfPem,
  registerSigningKey,
  assertSignatureVerifiesWithRegisteredKey,
} from "@proovra/shared-runtime";

import { devAuthEnabled } from "../src/dev/dev-login.js";
import { shouldBypassAuthRateLimit } from "../src/services/auth-test-bypass.js";
import { assertEvidenceSignerConfigurationAtStartup } from "../src/signing/signer.js";
import { buildDeploymentSafetyReport, readCommittedFixtureRegistration } from "../src/ops/deployment-safety.js";
import { isProductionShapedEnv } from "../../worker/src/object-lock-bootstrap.js";
import { isProductionShapedEnv as apiIsProductionShapedEnv } from "../src/bootstrap/object-lock-verification.js";

const FIXTURE_PRIVATE = resolve(__dirname, "../keys/signing-private.pem");
const FIXTURE_PUBLIC = resolve(__dirname, "../keys/signing-public.pem");
const FIXTURE_PUBLIC_PEM = readFileSync(FIXTURE_PUBLIC, "utf8");

const STAGING = { PROOVRA_ENV: "staging", NODE_ENV: "development" };
const UNDECLARED = {};
const TEST_ENV = { NODE_ENV: "test" };
const DEV_DECLARED = { PROOVRA_ENV: "development" };

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});
const withEnv = (env: Record<string, string>) => {
  for (const k of ["NODE_ENV", "PROOVRA_ENV", "APP_ENV", "DEPLOY_ENV", "DEV_AUTH_ENABLED", "E2E_AUTH_BYPASS_SECRET"]) delete process.env[k];
  Object.assign(process.env, env);
};

describe("F-41 — development surfaces need an EXPLICIT development or test environment", () => {
  it("dev login is refused in staging and when nothing is declared, even when opted in", () => {
    for (const env of [STAGING, UNDECLARED, { PROOVRA_ENV: "production" }, { PROOVRA_ENV: "dev", NODE_ENV: "production" }]) {
      withEnv({ ...env, DEV_AUTH_ENABLED: "true" } as Record<string, string>);
      expect(devAuthEnabled(), JSON.stringify(env)).toBe(false);
    }
  });

  it("dev login is allowed in a declared development or test environment when opted in, and only then", () => {
    withEnv({ ...DEV_DECLARED, DEV_AUTH_ENABLED: "true" });
    expect(devAuthEnabled()).toBe(true);
    withEnv({ ...TEST_ENV, DEV_AUTH_ENABLED: "true" });
    expect(devAuthEnabled()).toBe(true);
    withEnv({ ...DEV_DECLARED });
    expect(devAuthEnabled()).toBe(false);
  });

  it("the E2E bypass (and the rate-limit reset behind it) is refused in staging", () => {
    const secret = "x".repeat(40);
    withEnv({ ...STAGING, E2E_AUTH_BYPASS_SECRET: secret });
    expect(shouldBypassAuthRateLimit({ headers: { "x-e2e-auth-bypass": secret } } as never)).toBe(false);
    withEnv({ ...TEST_ENV, E2E_AUTH_BYPASS_SECRET: secret });
    expect(shouldBypassAuthRateLimit({ headers: { "x-e2e-auth-bypass": secret } } as never)).toBe(true);
  });

  it("an AMBIGUOUS classification is production-shaped for the Object Lock bootstrap", () => {
    for (const check of [isProductionShapedEnv, apiIsProductionShapedEnv]) {
      withEnv({ PROOVRA_ENV: "staging", APP_ENV: "development" });
      expect(check()).toBe(true);
      withEnv({ PROOVRA_ENV: "prdo" });
      expect(check()).toBe(true);
      withEnv({ PROOVRA_ENV: "development" });
      expect(check()).toBe(false);
    }
  });
});

describe("F-39 — the committed signing fixture outside development / test", () => {
  let dir: string;
  let otherPrivatePath: string;
  let otherPublicPem: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "afc-e-"));
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    otherPrivatePath = join(dir, "operator-key.pem");
    writeFileSync(otherPrivatePath, privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    otherPublicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    // The fixture's bytes under an innocent name: refused by fingerprint.
    writeFileSync(join(dir, "renamed.pem"), readFileSync(FIXTURE_PRIVATE));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("is allowed only in an explicit development or test environment", () => {
    expect(committedFixtureKeyAllowed(TEST_ENV)).toBe(true);
    expect(committedFixtureKeyAllowed(DEV_DECLARED)).toBe(true);
    expect(committedFixtureKeyAllowed(STAGING)).toBe(false);
    expect(committedFixtureKeyAllowed(UNDECLARED)).toBe(false);
    expect(committedFixtureKeyAllowed({ PROOVRA_ENV: "test", NODE_ENV: "production" })).toBe(false);
  });

  it("the signing guard refuses it in staging (it only refused NODE_ENV=production)", () => {
    expect(() => assertNotCommittedFixture({ privateKeyPath: FIXTURE_PRIVATE, env: STAGING })).toThrow(FixtureSigningKeyRefused);
    expect(() => assertNotCommittedFixture({ privateKeyPath: join(dir, "renamed.pem"), env: UNDECLARED })).toThrow(/public fingerprint/);
    expect(() => assertNotCommittedFixture({ privateKeyPath: FIXTURE_PRIVATE, env: TEST_ENV })).not.toThrow();
    expect(() => assertNotCommittedFixture({ privateKeyPath: otherPrivatePath, env: STAGING })).not.toThrow();
  });

  it("the API refuses to START with it outside development / test", () => {
    expect(() => assertEvidenceSignerConfigurationAtStartup({ ...STAGING, SIGNING_PRIVATE_KEY_PATH: FIXTURE_PRIVATE })).toThrow(FixtureSigningKeyRefused);
    expect(() => assertEvidenceSignerConfigurationAtStartup({ PROOVRA_ENV: "production" })).toThrow(/no signing key is configured/);
    expect(() => assertEvidenceSignerConfigurationAtStartup({ ...STAGING, SIGNING_PRIVATE_KEY_PATH: otherPrivatePath })).not.toThrow();
    expect(() => assertEvidenceSignerConfigurationAtStartup({ PROOVRA_ENV: "production", SIGNER_PROVIDER: "aws-kms" })).not.toThrow();
    expect(() => assertEvidenceSignerConfigurationAtStartup({ ...TEST_ENV, SIGNING_PRIVATE_KEY_PATH: FIXTURE_PRIVATE })).not.toThrow();
  });

  it("the registry refuses to REGISTER it outside development / test", async () => {
    const calls: string[] = [];
    const client = {
      signingKey: {
        findUnique: async () => {
          calls.push("findUnique");
          return null;
        },
        create: async () => {
          calls.push("create");
          return {};
        },
      },
    };
    withEnv(STAGING);
    await expect(
      registerSigningKey(client as never, { keyId: "k", version: 1, publicKeyPem: FIXTURE_PUBLIC_PEM, purpose: "EVIDENCE_SIGNATURE" }),
    ).rejects.toMatchObject({ code: "SIGNING_KEY_COMMITTED_FIXTURE" });
    expect(calls).toEqual([]);
    withEnv(TEST_ENV);
    await expect(
      registerSigningKey(client as never, { keyId: "k", version: 1, publicKeyPem: FIXTURE_PUBLIC_PEM, purpose: "EVIDENCE_SIGNATURE" }),
    ).resolves.toMatchObject({ outcome: "created" });
    withEnv(STAGING);
    await expect(
      registerSigningKey(client as never, { keyId: "k", version: 2, publicKeyPem: otherPublicPem, purpose: "EVIDENCE_SIGNATURE" }),
    ).resolves.toMatchObject({ outcome: "created" });
  });

  it("the registry refuses to SIGN with a fixture row registered before the check existed", async () => {
    const client = { signingKey: { findUnique: async () => ({ publicKeyPem: FIXTURE_PUBLIC_PEM, revokedAt: null }) } };
    withEnv(STAGING);
    await expect(
      assertSignatureVerifiesWithRegisteredKey(client as never, {
        keyId: "k",
        version: 1,
        messageHex: "00",
        signatureBase64: "AA==",
        purpose: "EVIDENCE_SIGNATURE",
      }),
    ).rejects.toMatchObject({ code: "SIGNING_KEY_COMMITTED_FIXTURE" });
    expect(() => assertNotCommittedFixtureKey(publicFingerprintOfPem(otherPublicPem)!, STAGING)).not.toThrow();
  });

  it("the seed never falls back to the fixture or the TEST_ONLY constant in staging", async () => {
    withEnv(STAGING);
    delete process.env.SIGNING_PUBLIC_KEY_PEM;
    delete process.env.SIGNING_PUBLIC_KEY_PATH;
    const mod = await import("../src/seed-signing-key.js");
    expect(() => mod.resolvePublicKeyPemFromLocalPem()).toThrow(mod.SigningKeyConfigurationError);
    withEnv(TEST_ENV);
    expect(mod.resolvePublicKeyPemFromLocalPem().source).toMatch(/^fixture:|^TEST_ONLY/);
  });
});

describe("the operator safety report prints only booleans and enums", () => {
  const unsafeStaging = {
    PROOVRA_ENV: "staging",
    SIGNING_PRIVATE_KEY_PATH: FIXTURE_PRIVATE,
    SIGNING_PUBLIC_KEY_PATH: FIXTURE_PUBLIC,
    DEV_AUTH_ENABLED: "true",
    E2E_AUTH_BYPASS_SECRET: "s".repeat(48),
    API_TRUST_PROXY_MODE: "cidr",
    API_TRUSTED_PROXY_CIDRS: "not-a-cidr",
  };

  it("names every unsafe fact in a deployment", () => {
    const r = buildDeploymentSafetyReport(unsafeStaging, { committedFixtureRegistered: true, committedFixtureActive: true });
    expect(r.environment).toMatchObject({ kind: "staging", ambiguous: false, basis: "DECLARED", developmentSurfacesAllowed: false });
    expect(r.signing).toMatchObject({ provider: "local-pem", evidencePrivateKeyAtFixtureLocation: true, evidencePublicKey: "COMMITTED_FIXTURE" });
    // Requested, but NOT live: the gates refuse them in staging.
    expect(r.developmentSurfaces).toEqual({ devAuthRequested: true, devAuthLive: false, e2eBypassSecretConfigured: true, e2eBypassLive: false });
    expect(r.verdict).toBe("UNSAFE");
    expect(r.unsafeReasons).toEqual(["PROXY_TRUST_INVALID", "SIGNING_KEY_IS_COMMITTED_FIXTURE", "COMMITTED_FIXTURE_REGISTERED_ACTIVE"]);
  });

  it("never prints a value, path, CIDR, secret or fingerprint", () => {
    const out = JSON.stringify(buildDeploymentSafetyReport(unsafeStaging, null));
    for (const forbidden of ["signing-private", "signing-public", "keys", "not-a-cidr", "s".repeat(48), "2da86cc2", "staging-host"]) {
      expect(out).not.toContain(forbidden);
    }
    const values = JSON.parse(out, (_k, v) => v);
    const leaves: unknown[] = [];
    const walk = (v: unknown) => (v && typeof v === "object" ? Object.values(v).forEach(walk) : leaves.push(v));
    walk(values);
    for (const leaf of leaves) {
      expect(leaf === null || typeof leaf === "boolean" || typeof leaf === "number" || /^[A-Za-z_-]+$/.test(String(leaf)), String(leaf)).toBe(true);
    }
  });

  it("a declared, safe production configuration is SAFE; a development machine is NOT_A_DEPLOYMENT", () => {
    const pub = join(mkdtempSync(join(tmpdir(), "afc-e-pub-")), "pub.pem");
    writeFileSync(pub, generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString());
    const safe = buildDeploymentSafetyReport(
      {
        PROOVRA_ENV: "production",
        API_TRUST_PROXY_MODE: "hop",
        API_TRUSTED_PROXY_HOPS: "1",
        SIGNING_PRIVATE_KEY_PATH: "/run/secrets/evidence-signing.pem",
        SIGNING_PUBLIC_KEY_PATH: pub,
        S3_OBJECT_LOCK_ENABLED: "true",
        S3_OBJECT_LOCK_MODE: "COMPLIANCE",
      },
      { committedFixtureRegistered: false, committedFixtureActive: false },
    );
    expect(safe.unsafeReasons).toEqual([]);
    expect(safe.verdict).toBe("SAFE");
    expect(buildDeploymentSafetyReport({ NODE_ENV: "development" }).verdict).toBe("NOT_A_DEPLOYMENT");
    expect(buildDeploymentSafetyReport({ NODE_ENV: "production" }).unsafeReasons).toContain("ENVIRONMENT_NOT_DECLARED");
  });

  it("reads the registry as two booleans, by fingerprint", async () => {
    const rows = [
      { publicKeyPem: FIXTURE_PUBLIC_PEM, revokedAt: new Date() },
      { publicKeyPem: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString(), revokedAt: null },
    ];
    expect(await readCommittedFixtureRegistration({ signingKey: { findMany: async () => rows } } as never)).toEqual({
      committedFixtureRegistered: true,
      committedFixtureActive: false,
    });
  });
});

describe("closure — F-08 undeclared environments, F-41 sibling gates, R-3", () => {
  it("F-08: an undeclared environment is a deployment the report calls UNSAFE (never NOT_A_DEPLOYMENT)", () => {
    const r = buildDeploymentSafetyReport({ API_TRUST_PROXY_MODE: "off" });
    expect(r.environment).toMatchObject({ kind: null, basis: "UNKNOWN", deployedInfrastructureRequired: true });
    expect(r.verdict).toBe("UNSAFE");
    expect(r.unsafeReasons).toContain("ENVIRONMENT_NOT_DECLARED");
  });

  it("R-3: an inline committed-fixture private key is reported (by its public fingerprint, nothing printed)", () => {
    const r = buildDeploymentSafetyReport({ PROOVRA_ENV: "production", SIGNING_PRIVATE_KEY_PEM: readFileSync(FIXTURE_PRIVATE, "utf8") });
    expect(r.signing.evidenceInlinePrivateKey).toBe("COMMITTED_FIXTURE");
    expect(r.unsafeReasons).toContain("SIGNING_KEY_IS_COMMITTED_FIXTURE");
    expect(JSON.stringify(r)).not.toMatch(/PRIVATE KEY|BEGIN/);
  });

  it("F-41: the cron, MFA, signed-delivery and loopback-CORS fallbacks are refused in staging", async () => {
    const { isTrustedWebOrigin } = await import("../src/http/cors-origin-policy.js");
    expect(isTrustedWebOrigin("http://localhost:3000", { PROOVRA_ENV: "staging" })).toBe(false);
    expect(isTrustedWebOrigin("http://localhost:3000", { NODE_ENV: "development" })).toBe(true);
    // Signed delivery: no secret configured → refused in staging (a public
    // constant signed it), allowed in development.
    const delivery = await import("../src/services/exchange/signed-delivery.service.js");
    const sign = () => delivery.signPackageManifest({ packageId: "p", payloadHash: "a".repeat(64), ttlSeconds: 60 } as never);
    withEnv({ PROOVRA_ENV: "staging" });
    delete process.env.WEBHOOK_SIGNING_SECRET;
    await expect(sign()).rejects.toBeInstanceOf(delivery.ExchangeSigningSecretMissingError);
    withEnv({ PROOVRA_ENV: "development" });
    await expect(sign()).resolves.toBeTruthy();
    // MFA secret sealing: no KEK → refused in staging (a public constant derived it).
    const mfa = await import("../src/services/security/mfa-secret-storage.js");
    withEnv({ PROOVRA_ENV: "staging" });
    delete process.env.MFA_SECRET_KEK_BASE64;
    expect(() => mfa.sealSecret(Buffer.from("totp-seed"))).toThrow(/MFA_SECRET_KEK_BASE64 is required outside development \/ test/);
    // Cron routes: no secret configured → 503, never the workspace-admin fallback.
    const cron = await import("../src/middleware/cron-secret.js");
    for (const k of Object.keys(process.env)) if (/CRON|SECRET/.test(k) && !/E2E/.test(k)) delete process.env[k];
    const reply = { statusCode: 0, body: null as unknown, code(n: number) { this.statusCode = n; return this; }, send(b: unknown) { this.body = b; return this; } };
    const allowed = await cron.requireNotificationCronSecret({ headers: {} } as never, reply as never);
    expect(allowed).toBe(false);
    expect(reply.statusCode).toBe(503);
    expect(reply.body).toMatchObject({ error: { code: "CONFIGURATION_ERROR" } });
  });
});

describe("closure re-audit — secret material and undeclared deployments", () => {
  it("a staging or undeclared deployment never uses the deterministic hash-secret fallback", async () => {
    const config = await import("../src/config/index.js");
    for (const env of [{ PROOVRA_ENV: "staging" }, {}]) {
      withEnv(env as Record<string, string>);
      delete process.env.IDENTITY_SECURITY_HASH_SECRET;
      expect(() => config.resolveSecret("IDENTITY_SECURITY_HASH_SECRET"), JSON.stringify(env)).toThrow(/outside development \/ test/);
      expect(config.collectStartupViolations().map((v) => v.envName)).toContain("IDENTITY_SECURITY_HASH_SECRET");
    }
    withEnv({ PROOVRA_ENV: "development" });
    delete process.env.IDENTITY_SECURITY_HASH_SECRET;
    expect(typeof config.resolveSecret("IDENTITY_SECURITY_HASH_SECRET")).toBe("string");
  });

  it("an undeclared environment is production-shaped for both Object Lock bootstraps", () => {
    for (const check of [isProductionShapedEnv, apiIsProductionShapedEnv]) {
      withEnv({});
      expect(check()).toBe(true);
      withEnv({ PROOVRA_ENV: "staging" });
      expect(check()).toBe(false);
    }
  });
});
