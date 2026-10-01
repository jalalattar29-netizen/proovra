// PHASE 12 — POINT 7 (2026-08-05): load configuration EXPLICITLY.
//
// This script used to inherit its environment as a side effect of importing
// `db.ts`, which opened with `import "dotenv/config"`. That implicit load was
// the root cause of the production-isolation incident, so it is gone and every
// entrypoint now asks for its configuration by name.
import "./env.js";

/**
 * Seed the `signing_keys` table with the public half of the evidence
 * signing key.
 *
 * Two providers are supported (mirrors `src/signing/signer.ts`):
 *
 *   1. `aws-kms` (production) — reads the public key from KMS
 *      `GetPublicKey` and persists it. Requires AWS_REGION, KMS_KEY_ID.
 *      Does NOT touch any local PEM material.
 *
 *   2. `local-pem` (development / new environments) — resolves a PEM
 *      public key from one of several sources and persists it. Required
 *      for `/v1/evidence/:id/review-workspace`, `/public/verify/:id`
 *      and the verification-package signature verification path to
 *      function. Without this row, every verify endpoint returns 404
 *      "Signing key not found".
 *
 * Provider selection is driven by `SIGNER_PROVIDER`. Defaults to
 * `local-pem` (matches `services/api/.env.example`).
 *
 * ----------------------------------------------------------------------
 * `local-pem` public-key resolution order (5 steps, first match wins):
 * ----------------------------------------------------------------------
 *
 *   1. `SIGNING_PUBLIC_KEY_PEM` — raw PEM content inline in the env.
 *      Preferred for CI / containerised deployments where mounting a
 *      file is awkward. Whitespace/EOL is normalised; the value must
 *      contain a `-----BEGIN PUBLIC KEY-----` header.
 *
 *   2. `SIGNING_PUBLIC_KEY_PATH` — file path, used EXACTLY (relative
 *      paths resolve from the working directory; `pnpm prisma:seed` runs
 *      from `services/api/`). Missing, not a regular file, unreadable or
 *      invalid is a SigningKeyConfigurationError naming the path. It is
 *      never rewritten and never replaced by the fixture: registering a
 *      public key other than the configured one makes the runtime signer
 *      refuse every signature (SIGNING_KEY_IDENTITY_CONFLICT).
 *
 *   3. Only when NO path is configured: the checked-in test fixture at
 *      `keys/signing-public.pem` (relative to either `services/api/` cwd
 *      or repo-root cwd). This is the dev baseline shipped in this
 *      repository.
 *
 *   4. **CI / non-production fallback only:** a deterministic TEST_ONLY
 *      Ed25519 public key constant compiled into this script. Used ONLY
 *      when `NODE_ENV !== "production"` AND no other source produced a
 *      key. Clearly marked TEST_ONLY in logs.
 *
 *   5. Production hard failure — when `NODE_ENV === "production"` (or
 *      `PROOVRA_ENV === "production"`) and steps 1-3 all fail, refuse
 *      to seed. No silent fallback is permitted in production.
 *
 * Safety:
 *   * Only the PUBLIC key is persisted. The private key never leaves the
 *     signer abstraction.
 *   * Idempotent — re-runs upsert the same row, clearing any
 *     `revoked_at`.
 *   * Refuses to seed unless the resolved material parses as a PEM
 *     SPKI public key and the algorithm is Ed25519.
 *   * No real production key material is ever embedded in source.
 *
 * Usage:
 *   pnpm --filter proovra-api prisma:seed
 *   # or, when iterating locally on the signer config:
 *   pnpm --filter proovra-api seed:key
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicKey } from "node:crypto";

import { KMSClient, GetPublicKeyCommand } from "@aws-sdk/client-kms";

import { prisma } from "./db.js";
import { registerSigningKey } from "./signing/key-registry.js";

type Provider = "aws-kms" | "local-pem";

/**
 * Deterministic TEST_ONLY Ed25519 public key. Identical bytes to the
 * committed dev fixture at `services/api/keys/signing-public.pem` —
 * embedded here so a clean-checkout `prisma:seed` succeeds even if the
 * fixture file is absent (e.g. a future change scrubs `keys/` from the
 * working tree).
 *
 *   * NEVER used when NODE_ENV === "production".
 *   * Holds NO private material — only the public half.
 *   * Used ONLY as a last-resort fallback to keep the
 *     `schema-reproducibility` clean-db-boot job deterministic.
 */
const TEST_ONLY_FALLBACK_PUBLIC_KEY_PEM = [
  "-----BEGIN PUBLIC KEY-----",
  "MCowBQYDK2VwAyEA/UfMOaB2P6DQswf0pwfDSz7uuak3f4ms/VTuboRYTGs=",
  "-----END PUBLIC KEY-----",
  "",
].join("\n");

function readProvider(): Provider {
  const raw = (process.env.SIGNER_PROVIDER ?? "local-pem").trim().toLowerCase();
  return raw === "aws-kms" ? "aws-kms" : "local-pem";
}

function isProductionEnv(): boolean {
  const node = (process.env.NODE_ENV ?? "").trim().toLowerCase();
  const proovra = (process.env.PROOVRA_ENV ?? "").trim().toLowerCase();
  return node === "production" || proovra === "production";
}

function must(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

function mustInt(name: string): number {
  const raw = must(name);
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be an integer`);
  }

  return parsed;
}

function derToPemSpki(der: Uint8Array): string {
  const keyObject = createPublicKey({
    key: Buffer.from(der),
    format: "der",
    type: "spki",
  });

  return keyObject.export({
    format: "pem",
    type: "spki",
  }) as string;
}

async function resolvePublicKeyPemFromKms(): Promise<string> {
  const region = must("AWS_REGION");
  const kmsKeyId = must("KMS_KEY_ID");
  const kms = new KMSClient({ region });

  const response = await kms.send(
    new GetPublicKeyCommand({
      KeyId: kmsKeyId,
    }),
  );

  if (!response.PublicKey || response.PublicKey.length === 0) {
    throw new Error("KMS GetPublicKey returned no public key");
  }

  if (response.KeySpec !== "ECC_NIST_EDWARDS25519") {
    throw new Error(
      `Unexpected KMS key spec: ${response.KeySpec ?? "unknown"}`,
    );
  }

  if (response.KeyUsage !== "SIGN_VERIFY") {
    throw new Error(
      `Unexpected KMS key usage: ${response.KeyUsage ?? "unknown"}`,
    );
  }

  return derToPemSpki(response.PublicKey);
}

/**
 * A signing-key configuration the seed refuses. Its message names the
 * variable and the path — never any key material.
 */
export class SigningKeyConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SigningKeyConfigurationError";
  }
}

/**
 * Validate + canonicalise a PEM string. Throws if not a valid Ed25519
 * SPKI public key. The "where did this come from" context is folded
 * into the error so the operator knows which source failed. The error
 * never quotes the material itself (nor the parser's message about it).
 */
function validateAndCanonicalisePem(pem: string, sourceLabel: string): string {
  if (!pem.includes("BEGIN PUBLIC KEY")) {
    throw new SigningKeyConfigurationError(
      `${sourceLabel} does not look like a PEM public key — ` +
        `expected a "-----BEGIN PUBLIC KEY-----" header. Refusing to seed.`,
    );
  }

  let keyObject: ReturnType<typeof createPublicKey>;
  try {
    keyObject = createPublicKey({ key: pem, format: "pem", type: "spki" });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    throw new SigningKeyConfigurationError(
      `${sourceLabel} is not a parseable SPKI public key` +
        `${typeof code === "string" ? ` (${code})` : ""}. Refusing to seed.`,
    );
  }

  if (keyObject.asymmetricKeyType !== "ed25519") {
    throw new SigningKeyConfigurationError(
      `${sourceLabel} is not an Ed25519 key ` +
        `(got asymmetricKeyType=${keyObject.asymmetricKeyType ?? "unknown"}). ` +
        `The runtime signer expects Ed25519.`,
    );
  }

  return keyObject.export({ format: "pem", type: "spki" }) as string;
}

/**
 * Read the file an operator NAMED in SIGNING_PUBLIC_KEY_PATH — that exact
 * path (relative paths resolve from the process's working directory), and
 * nothing else. Missing, not a regular file, or unreadable is a configuration
 * error: substituting another key here would register a public key the
 * runtime's private key does not match (the signer then refuses every
 * signature — SIGNING_KEY_IDENTITY_CONFLICT — which is how the full-stack CI
 * smoke failed when this used to fall back to the checked-in fixture).
 */
function readExplicitPublicKeyPath(envPath: string): { pem: string; absolutePath: string; label: string } {
  const abs = resolve(envPath);
  const label = `SIGNING_PUBLIC_KEY_PATH="${envPath}" (resolved to "${abs}")`;
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(abs);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    throw new SigningKeyConfigurationError(
      `${label} does not exist${typeof code === "string" && code !== "ENOENT" ? ` (${code})` : ""}. ` +
        "An explicitly configured key path is used exactly; the seed never substitutes a fixture. " +
        "Fix the path (relative paths resolve from the working directory) or unset the variable.",
    );
  }
  if (!stat.isFile()) {
    throw new SigningKeyConfigurationError(`${label} is not a regular file. Refusing to seed.`);
  }
  let pem: string;
  try {
    pem = readFileSync(abs, "utf8");
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    throw new SigningKeyConfigurationError(
      `${label} could not be read${typeof code === "string" ? ` (${code})` : ""}. Refusing to seed.`,
    );
  }
  return { pem, absolutePath: abs, label };
}

/**
 * Try to read a checked-in FIXTURE. Returns `null` (not throwing) if the
 * file does not exist — the fixture locations are tried in turn, and only
 * when no key path was configured at all.
 */
function tryReadFixturePem(path: string): { pem: string; absolutePath: string } | null {
  const abs = resolve(path);
  if (!existsSync(abs)) {
    return null;
  }

  let pem: string;
  try {
    pem = readFileSync(abs, "utf8");
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    throw new SigningKeyConfigurationError(
      `Fixture public key "${abs}" exists but could not be read${typeof code === "string" ? ` (${code})` : ""}.`,
    );
  }

  return { pem, absolutePath: abs };
}

/** Checked-in fixture locations, for `services/api/` cwd and repo-root cwd. */
const FIXTURE_PUBLIC_KEY_PATHS = ["keys/signing-public.pem", "services/api/keys/signing-public.pem"] as const;

interface ResolvedPublicKey {
  pem: string;
  /** Short human label describing which step in the order matched. */
  source: string;
  /** True when the TEST_ONLY constant was used. */
  isTestOnlyFallback: boolean;
}

export function resolvePublicKeyPemFromLocalPem(): ResolvedPublicKey {
  // ── Step 1: SIGNING_PUBLIC_KEY_PEM (inline PEM in env) ──────────────
  const inlinePem = process.env.SIGNING_PUBLIC_KEY_PEM?.trim();
  if (inlinePem && inlinePem.length > 0) {
    const canonical = validateAndCanonicalisePem(
      inlinePem,
      'env "SIGNING_PUBLIC_KEY_PEM"',
    );
    return {
      pem: canonical,
      source: "env:SIGNING_PUBLIC_KEY_PEM",
      isTestOnlyFallback: false,
    };
  }

  // ── Step 2: SIGNING_PUBLIC_KEY_PATH — EXACTLY that file, or fail ─────
  const envPath = process.env.SIGNING_PUBLIC_KEY_PATH?.trim();
  if (envPath && envPath.length > 0) {
    const found = readExplicitPublicKeyPath(envPath);
    return {
      pem: validateAndCanonicalisePem(found.pem, found.label),
      source: `env:SIGNING_PUBLIC_KEY_PATH (resolved to ${found.absolutePath})`,
      isTestOnlyFallback: false,
    };
  }

  // ── Step 3: no path configured — the checked-in fixture ──────────────
  const attempts: string[] = [];
  for (const candidate of FIXTURE_PUBLIC_KEY_PATHS) {
    const found = tryReadFixturePem(candidate);
    if (found) {
      return {
        pem: validateAndCanonicalisePem(found.pem, `Fixture "${found.absolutePath}"`),
        source: `fixture:${found.absolutePath}`,
        isTestOnlyFallback: false,
      };
    }
    attempts.push(resolve(candidate));
  }

  // ── Step 4: CI / non-production TEST_ONLY constant fallback ─────────
  if (!isProductionEnv()) {
    const canonical = validateAndCanonicalisePem(
      TEST_ONLY_FALLBACK_PUBLIC_KEY_PEM,
      "TEST_ONLY built-in fallback",
    );
    return {
      pem: canonical,
      source: "TEST_ONLY-built-in-fallback (non-production only)",
      isTestOnlyFallback: true,
    };
  }

  // ── Step 5: production hard failure ─────────────────────────────────
  throw new SigningKeyConfigurationError(
    "Could not resolve a signing public key in production. Tried (in order):\n" +
      "  1. env SIGNING_PUBLIC_KEY_PEM — not set\n" +
      "  2. env SIGNING_PUBLIC_KEY_PATH — not set\n" +
      `  3. Checked-in fixture (keys/signing-public.pem) — not found\n` +
      "Refusing to fall back to TEST_ONLY material because NODE_ENV=production. " +
      "Set SIGNING_PUBLIC_KEY_PEM (inline PEM) or SIGNING_PUBLIC_KEY_PATH (mounted file) " +
      "to a real Ed25519 public-key PEM, or set SIGNER_PROVIDER=aws-kms with KMS_KEY_ID. " +
      `Paths tried: [${attempts.join(", ")}]`,
  );
}

/**
 * UC-TRUST-003 — INSERT-ONLY. The seed never replaces the public key of an
 * existing (keyId, version) — that would silently invalidate every signature
 * made with it — and never clears a revocation. Re-running it with the same key
 * is a no-op; with a different key it fails (rotate with a new version).
 */
async function upsertSigningKeyRow(
  keyId: string,
  version: number,
  publicKeyPem: string,
): Promise<{ id: string; keyId: string; version: number }> {
  await registerSigningKey(prisma, { keyId, version, publicKeyPem });
  const saved = await prisma.signingKey.findUniqueOrThrow({
    where: { keyId_version: { keyId, version } },
    select: { id: true, keyId: true, version: true },
  });
  return { id: saved.id, keyId: saved.keyId, version: saved.version };
}

async function main() {
  const provider = readProvider();
  const signingKeyId = must("SIGNING_KEY_ID");
  const signingKeyVersion = mustInt("SIGNING_KEY_VERSION");

  let publicKeyPem: string;
  let providerLabel: string;

  if (provider === "aws-kms") {
    publicKeyPem = await resolvePublicKeyPemFromKms();
    providerLabel = `aws-kms (region=${process.env.AWS_REGION ?? "?"}, keyId=${
      process.env.KMS_KEY_ID ?? "?"
    })`;
  } else {
    const resolved = resolvePublicKeyPemFromLocalPem();
    publicKeyPem = resolved.pem;
    providerLabel = `local-pem (${resolved.source})`;
    if (resolved.isTestOnlyFallback) {
      // eslint-disable-next-line no-console
      console.warn(
        "[seed-signing-key] WARNING: using TEST_ONLY built-in fallback " +
          "public key. This is acceptable for CI / dev but MUST NOT be used " +
          "in production. Verify NODE_ENV is not set to 'production'.",
      );
    }
  }

  const evidenceKey = await upsertSigningKeyRow(
    signingKeyId,
    signingKeyVersion,
    publicKeyPem,
  );
  // eslint-disable-next-line no-console
  console.log(`Evidence signing public key saved (${providerLabel})`, evidenceKey);

  // Also seed the package signing key row if env vars are set and the
  // pair differs from the evidence signing key. The verification
  // package worker uses an independent (keyId, version) pair, even
  // when the underlying key material is currently shared.
  const packageKeyId = process.env.PACKAGE_SIGNING_KEY_ID?.trim();
  const packageKeyVersionRaw = process.env.PACKAGE_SIGNING_KEY_VERSION?.trim();
  if (
    packageKeyId &&
    packageKeyVersionRaw &&
    !(packageKeyId === signingKeyId && packageKeyVersionRaw === String(signingKeyVersion))
  ) {
    const packageKeyVersion = Number.parseInt(packageKeyVersionRaw, 10);
    if (Number.isFinite(packageKeyVersion)) {
      // Package signing key currently shares the same key material as
      // evidence signing in the local-pem dev profile. If you split
      // the package key onto its own KMS key in production, resolve a
      // distinct PEM from PACKAGE_SIGNING_PUBLIC_KEY_PATH here.
      const packageKey = await upsertSigningKeyRow(
        packageKeyId,
        packageKeyVersion,
        publicKeyPem,
      );
      // eslint-disable-next-line no-console
      console.log("Package signing public key saved (mirrors evidence key)", packageKey);
    }
  }
}

// Run main() ONLY when this file is invoked directly as a script
// (`tsx src/seed-signing-key.ts`). Exporting
// `resolvePublicKeyPemFromLocalPem` for the regression test means the
// module CAN now be imported by tests; guard `main()` so a unit-test
// import does not connect to Prisma.
const isDirectInvocation = (() => {
  try {
    const invokedPath = process.argv[1] ?? "";
    return (
      invokedPath.endsWith("seed-signing-key.ts") ||
      invokedPath.endsWith("seed-signing-key.js")
    );
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  main()
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error("Failed to seed signing key");
      // eslint-disable-next-line no-console
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
