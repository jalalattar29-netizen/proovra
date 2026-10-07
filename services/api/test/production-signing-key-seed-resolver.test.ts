/**
 * Production regression test — signing-key seed public-key resolver.
 *
 * Pins the 5-step public-key resolution order in
 * `services/api/src/seed-signing-key.ts` so the
 * `schema-reproducibility` clean-db-boot CI job stays green and the
 * security invariants don't drift.
 *
 * ─── BACKGROUND ────────────────────────────────────────────────────────
 *
 * The CI `schema-reproducibility` job sets
 * `SIGNING_PUBLIC_KEY_PATH=services/api/keys/signing-public.pem` and
 * runs `pnpm prisma:seed` from `working-directory: services/api`. Per
 * pnpm convention, scripts execute with cwd=`services/api/`, so the
 * env path resolves to `services/api/services/api/keys/signing-public.pem`
 * → ENOENT. Before this fix the seed failed with
 *   `Could not read local signing public key from
 *    "services/api/keys/signing-public.pem". ENOENT.`
 *
 * The resolver now compensates by trying multiple path variants and
 * falling back through 5 ordered sources (env PEM → env path → fixture
 * → TEST_ONLY constant → production hard failure).
 *
 * ─── SAFETY INVARIANTS PINNED ──────────────────────────────────────────
 *
 *   1. `SIGNING_PUBLIC_KEY_PEM` env wins over `SIGNING_PUBLIC_KEY_PATH`.
 *   2. `SIGNING_PUBLIC_KEY_PATH`, when set, is used EXACTLY (relative to
 *      the working directory). A missing / non-file / unreadable / invalid
 *      path is a SigningKeyConfigurationError — never rewritten, never
 *      replaced by the fixture (that registered a key the signer did not
 *      hold: SIGNING_KEY_IDENTITY_CONFLICT). The CI workflows now pass a
 *      path that exists from their seed step's working directory.
 *   3. Only when NO env source is configured, the checked-in dev fixture
 *      (`keys/signing-public.pem`) is used.
 *   4. When even the fixture is missing (clean-checkout scenario),
 *      the TEST_ONLY built-in constant is used — but ONLY when
 *      NODE_ENV !== "production". The CI job runs with
 *      NODE_ENV=development, so this branch is the safety net.
 *   5. When NODE_ENV=production AND every source above fails, the
 *      resolver throws — NO silent fallback in production.
 *   6. The `aws-kms` provider never touches local PEM material.
 *   7. The committed `services/api/keys/*.pem` files are TINY (≤200
 *      bytes each), single-commit history, and the public key has the
 *      Ed25519 SPKI shape — these are dev fixtures, not real production
 *      keys. This test guards against an accidental future commit of
 *      real key material by enforcing a tight size ceiling.
 *
 * Style: source-contract — read the file and assert structural
 * invariants. No DB. No process boot. No flakiness.
 */

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../../..");
const SEED_FILE = resolve(REPO_ROOT, "services/api/src/seed-signing-key.ts");
const PUBLIC_KEY_FIXTURE = resolve(
  REPO_ROOT,
  "services/api/keys/signing-public.pem",
);
const PRIVATE_KEY_FIXTURE = resolve(
  REPO_ROOT,
  "services/api/keys/signing-private.pem",
);
const SEED_SRC = readFileSync(SEED_FILE, "utf8");

describe("signing-key seed — 5-step public-key resolver", () => {
  // ── Group A: structural — the function and its 5 steps exist ────────

  it("(A1) exports resolvePublicKeyPemFromLocalPem for test reach-in", () => {
    expect(SEED_SRC).toMatch(
      /export\s+function\s+resolvePublicKeyPemFromLocalPem/,
    );
  });

  it("(A2) Step 1 — reads SIGNING_PUBLIC_KEY_PEM env first", () => {
    expect(SEED_SRC).toMatch(/process\.env\.SIGNING_PUBLIC_KEY_PEM/);
    // The PEM env check must appear in source BEFORE the PATH check —
    // otherwise priority order is wrong.
    const pemIdx = SEED_SRC.indexOf("SIGNING_PUBLIC_KEY_PEM");
    const pathIdx = SEED_SRC.indexOf("SIGNING_PUBLIC_KEY_PATH");
    expect(pemIdx).toBeGreaterThan(0);
    expect(pathIdx).toBeGreaterThan(pemIdx);
  });

  it("(A3) Step 2 — an explicit SIGNING_PUBLIC_KEY_PATH is used exactly, never rewritten", () => {
    // The old resolver rewrote the configured path (stripping/prepending
    // services/api/) and then fell through to the checked-in fixture — which
    // registered a key the runtime signer did not hold. Both are gone.
    expect(SEED_SRC).toMatch(/readExplicitPublicKeyPath/);
    expect(SEED_SRC).not.toMatch(/buildCandidatePaths/);
    expect(SEED_SRC).not.toMatch(/startsWith\(["']services\/api\/["']\)/);
  });

  it("(A4) Step 3 — checked-in fixture is in the candidate list", () => {
    expect(SEED_SRC).toMatch(/keys\/signing-public\.pem/);
  });

  it("(A5) Step 4 — TEST_ONLY constant fallback is non-production-gated", () => {
    expect(SEED_SRC).toMatch(/TEST_ONLY_FALLBACK_PUBLIC_KEY_PEM/);
    expect(SEED_SRC).toMatch(/isProductionEnv/);
    // The fallback must be guarded by !isProductionEnv().
    expect(SEED_SRC).toMatch(/if\s*\(\s*!isProductionEnv\(\)\s*\)/);
  });

  it("(A6) Step 5 — production hard-fails with a loud error", () => {
    expect(SEED_SRC).toMatch(/Could not resolve a signing public key in production/);
    expect(SEED_SRC).toMatch(/Refusing to fall back to TEST_ONLY material/);
  });

  // ── Group B: KMS branch is unchanged and skips local PEM ────────────

  it("(B1) aws-kms provider does not call the local-PEM resolver", () => {
    // Find the `if (provider === "aws-kms")` block. Inside it, neither
    // SIGNING_PUBLIC_KEY_PATH nor SIGNING_PUBLIC_KEY_PEM nor
    // resolvePublicKeyPemFromLocalPem may be called.
    const kmsBlockMatch = SEED_SRC.match(
      /if\s*\(\s*provider\s*===\s*["']aws-kms["']\s*\)\s*\{([\s\S]*?)\n\s*\}\s*else\b/,
    );
    expect(kmsBlockMatch).toBeTruthy();
    const kmsBlock = kmsBlockMatch![1];
    expect(kmsBlock).not.toMatch(/SIGNING_PUBLIC_KEY_PATH/);
    expect(kmsBlock).not.toMatch(/SIGNING_PUBLIC_KEY_PEM/);
    expect(kmsBlock).not.toMatch(/resolvePublicKeyPemFromLocalPem/);
    expect(kmsBlock).toMatch(/resolvePublicKeyPemFromKms/);
  });

  it("(B2) aws-kms branch still requires AWS_REGION + KMS_KEY_ID", () => {
    expect(SEED_SRC).toMatch(/must\(["']AWS_REGION["']\)/);
    expect(SEED_SRC).toMatch(/must\(["']KMS_KEY_ID["']\)/);
    expect(SEED_SRC).toMatch(/ECC_NIST_EDWARDS25519/);
    expect(SEED_SRC).toMatch(/SIGN_VERIFY/);
  });

  // ── Group C: security — no real key material accidentally committed ─

  it("(C1) committed public-key fixture is tiny (≤ 200 bytes) and Ed25519 SPKI shape", () => {
    const stat = statSync(PUBLIC_KEY_FIXTURE);
    expect(stat.size).toBeLessThanOrEqual(200);
    const pem = readFileSync(PUBLIC_KEY_FIXTURE, "utf8");
    expect(pem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(pem).toMatch(/-----END PUBLIC KEY-----\s*$/);
    // Ed25519 SPKI PEM is exactly one body line (44 base64 chars). A real
    // RSA-2048 / EC-P256 / RSA-4096 key would be much longer. Holding the
    // body to <= 80 chars catches accidental commit of a non-test key.
    const body = pem.replace(/-----[^-]+-----/g, "").trim();
    expect(body.length).toBeLessThanOrEqual(80);
  });

  it("(C2) committed private-key fixture is tiny (≤ 200 bytes) — dev fixture, not prod", () => {
    const stat = statSync(PRIVATE_KEY_FIXTURE);
    expect(stat.size).toBeLessThanOrEqual(200);
    // Note: we do NOT inspect the body of the private key. The size
    // ceiling alone catches the accidental-real-key case (a real
    // PKCS#8-wrapped RSA-2048 private key would be ~1.7 KB).
  });

  it("(C3) source does NOT embed any private-key PEM material", () => {
    // The source may reference public PEM strings but must never contain
    // a private-key header. This is the no-real-keys-committed guard
    // for the seed file itself.
    expect(SEED_SRC).not.toMatch(/-----BEGIN (?:RSA |EC |)PRIVATE KEY-----/);
    expect(SEED_SRC).not.toMatch(/-----BEGIN ENCRYPTED PRIVATE KEY-----/);
  });

  it("(C4) TEST_ONLY constant is clearly marked AND public-only", () => {
    // The fallback const must be labelled TEST_ONLY in the identifier
    // so future readers can't miss the boundary.
    expect(SEED_SRC).toMatch(/TEST_ONLY_FALLBACK_PUBLIC_KEY_PEM\s*=/);
    // It must be a PUBLIC key, not a private one.
    const constMatch = SEED_SRC.match(
      /TEST_ONLY_FALLBACK_PUBLIC_KEY_PEM\s*=\s*\[([\s\S]*?)\]\.join/,
    );
    expect(constMatch).toBeTruthy();
    expect(constMatch![1]).toMatch(/BEGIN PUBLIC KEY/);
    expect(constMatch![1]).not.toMatch(/PRIVATE KEY/);
  });

  // ── Group D: idempotency + safety unchanged from the prior version ──

  it("(D1) row write is idempotent WITHOUT rewriting identity or clearing a revocation", () => {
    // UC-TRUST-003 — the seed used to upsert public_key_pem and set revokedAt: null, so a
    // re-run could replace the key under old signatures and un-revoke it. It now registers
    // through the key registry (create if absent; same key = no-op; different key = refused),
    // and the signing_keys triggers refuse identity changes at the database.
    // Every row goes through the registry with an explicit purpose (the seal key is
    // PACKAGE_SEAL — behaviourally proven in signing-key-identity.integration.test.ts).
    expect(SEED_SRC).toMatch(/registerSigningKey\(db, \{ keyId, version, publicKeyPem, purpose \}\)/);
    expect(SEED_SRC).toMatch(/"PACKAGE_SEAL",\s*\)/);
    expect(SEED_SRC).not.toMatch(/\.signingKey\.upsert/);
    expect(SEED_SRC).not.toMatch(/revokedAt:\s*null/);
  });

  it("(D2) PEM validator still enforces Ed25519 algorithm", () => {
    expect(SEED_SRC).toMatch(/asymmetricKeyType\s*!==\s*["']ed25519["']/);
  });

  it("(D3) test imports of the module do not boot Prisma", () => {
    // Required so this very test file can import the resolver without a
    // DB connection. The script must guard main() behind a direct-
    // invocation check.
    expect(SEED_SRC).toMatch(/isDirectInvocation/);
    expect(SEED_SRC).toMatch(/if\s*\(\s*isDirectInvocation\s*\)/);
  });

  // ── Group E: behavioural — call the resolver and assert outcomes ────

  it("(E1) returns env PEM when SIGNING_PUBLIC_KEY_PEM is set", async () => {
    const fixturePem = readFileSync(PUBLIC_KEY_FIXTURE, "utf8");
    const prev = { ...process.env };
    try {
      delete process.env.SIGNING_PUBLIC_KEY_PATH;
      delete process.env.NODE_ENV;
      process.env.SIGNING_PUBLIC_KEY_PEM = fixturePem;
      const mod = await import("../src/seed-signing-key.js");
      const result = mod.resolvePublicKeyPemFromLocalPem();
      expect(result.source).toBe("env:SIGNING_PUBLIC_KEY_PEM");
      expect(result.isTestOnlyFallback).toBe(false);
      expect(result.pem).toMatch(/BEGIN PUBLIC KEY/);
    } finally {
      process.env = prev;
    }
  });

  it("(E2) reads exactly the file SIGNING_PUBLIC_KEY_PATH names (relative to the working directory)", async () => {
    const prev = { ...process.env };
    try {
      delete process.env.SIGNING_PUBLIC_KEY_PEM;
      // The test runs from services/api/, like `pnpm prisma:seed`.
      process.env.SIGNING_PUBLIC_KEY_PATH = "keys/signing-public.pem";
      const mod = await import("../src/seed-signing-key.js");
      const result = mod.resolvePublicKeyPemFromLocalPem();
      expect(result.source).toBe(`env:SIGNING_PUBLIC_KEY_PATH (resolved to ${PUBLIC_KEY_FIXTURE})`);
      expect(result.isTestOnlyFallback).toBe(false);
      expect(result.pem).toMatch(/BEGIN PUBLIC KEY/);
    } finally {
      process.env = prev;
    }
  });

  it("(E3) a repo-root-relative path under services/api cwd is REFUSED, not rewritten (the old CI value)", async () => {
    const prev = { ...process.env };
    try {
      delete process.env.SIGNING_PUBLIC_KEY_PEM;
      process.env.SIGNING_PUBLIC_KEY_PATH = "services/api/keys/signing-public.pem";
      process.env.NODE_ENV = "development";
      const mod = await import("../src/seed-signing-key.js");
      expect(() => mod.resolvePublicKeyPemFromLocalPem()).toThrow(mod.SigningKeyConfigurationError);
    } finally {
      process.env = prev;
    }
  });

  it("(E4) an explicit path that does not exist fails in production too — never the fixture", async () => {
    const prev = { ...process.env };
    try {
      delete process.env.SIGNING_PUBLIC_KEY_PEM;
      process.env.SIGNING_PUBLIC_KEY_PATH = "no/such/path/in/prod.pem";
      process.env.NODE_ENV = "production";
      delete process.env.PROOVRA_ENV;
      const mod = await import("../src/seed-signing-key.js");
      expect(() => mod.resolvePublicKeyPemFromLocalPem()).toThrow(/no\/such\/path\/in\/prod\.pem.*does not exist/);
    } finally {
      process.env = prev;
    }
  });
});
