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
 *   2. `SIGNING_PUBLIC_KEY_PATH` — file path. Tried verbatim, then with
 *      `services/api/` stripped (handles the CI case where the workflow
 *      sets `SIGNING_PUBLIC_KEY_PATH=services/api/keys/signing-public.pem`
 *      but pnpm runs this script from `services/api/` cwd), then with
 *      `services/api/` prepended (handles repo-root cwd with a workspace-
 *      relative path).
 *
 *   3. Existing checked-in test fixture at `keys/signing-public.pem`
 *      (relative to either `services/api/` cwd or repo-root cwd). This
 *      is the dev baseline shipped in this repository.
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

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicKey } from "node:crypto";

import { KMSClient, GetPublicKeyCommand } from "@aws-sdk/client-kms";

import { prisma } from "./db.js";

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
 * Validate + canonicalise a PEM string. Throws if not a valid Ed25519
 * SPKI public key. The "where did this come from" context is folded
 * into the error so the operator knows which source failed.
 */
function validateAndCanonicalisePem(pem: string, sourceLabel: string): string {
  if (!pem.includes("BEGIN PUBLIC KEY")) {
    throw new Error(
      `${sourceLabel} does not look like a PEM public key — ` +
        `expected a "-----BEGIN PUBLIC KEY-----" header. Refusing to seed.`,
    );
  }

  const keyObject = createPublicKey({
    key: pem,
    format: "pem",
    type: "spki",
  });

  if (keyObject.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `${sourceLabel} is not an Ed25519 key ` +
        `(got asymmetricKeyType=${keyObject.asymmetricKeyType ?? "unknown"}). ` +
        `The runtime signer expects Ed25519.`,
    );
  }

  return keyObject.export({ format: "pem", type: "spki" }) as string;
}

/**
 * Try to read a PEM from disk. Returns `null` (not throwing) if the
 * file does not exist — callers chain multiple candidate paths.
 * Throws only if the file is present but unreadable.
 */
function tryReadPemFromPath(
  path: string,
  sourceLabel: string,
): { pem: string; absolutePath: string } | null {
  const abs = resolve(path);
  if (!existsSync(abs)) {
    return null;
  }

  let pem: string;
  try {
    pem = readFileSync(abs, "utf8");
  } catch (error) {
    throw new Error(
      `${sourceLabel} (resolved to "${abs}") exists but could not be read: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { pem, absolutePath: abs };
}

/**
 * Build the ordered list of candidate file paths to try, given an
 * (optional) env-supplied path. Order matters — first hit wins. The
 * list compensates for the fact that `pnpm prisma:seed` runs with
 * cwd=`services/api/` while CI workflow files often write paths as
 * `services/api/keys/...` (relative to the repo root).
 */
function buildCandidatePaths(envPath: string | undefined): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (p: string) => {
    if (!p) return;
    if (seen.has(p)) return;
    seen.add(p);
    candidates.push(p);
  };

  if (envPath && envPath.length > 0) {
    push(envPath);
    // `services/api/keys/foo.pem` ⇒ also try `keys/foo.pem`
    if (envPath.startsWith("services/api/")) {
      push(envPath.slice("services/api/".length));
    }
    // `keys/foo.pem` ⇒ also try `services/api/keys/foo.pem`
    if (!envPath.includes("services/api/") && !envPath.startsWith("/")) {
      push(`services/api/${envPath}`);
    }
  }

  // Default checked-in fixture locations.
  push("keys/signing-public.pem");
  push("services/api/keys/signing-public.pem");

  return candidates;
}

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

  // ── Step 2 + Step 3: file paths (env path + checked-in fixture) ─────
  const envPath = process.env.SIGNING_PUBLIC_KEY_PATH?.trim();
  const candidates = buildCandidatePaths(envPath);
  const attempts: string[] = [];

  for (const candidate of candidates) {
    const found = tryReadPemFromPath(
      candidate,
      `Public key path "${candidate}"`,
    );
    if (found) {
      const canonical = validateAndCanonicalisePem(
        found.pem,
        `File "${found.absolutePath}"`,
      );
      // Was this the env-supplied path or the fixture fallback?
      const isEnvPath =
        envPath !== undefined &&
        envPath.length > 0 &&
        (candidate === envPath ||
          candidate === envPath.replace(/^services\/api\//, "") ||
          candidate === `services/api/${envPath}`);
      return {
        pem: canonical,
        source: isEnvPath
          ? `env:SIGNING_PUBLIC_KEY_PATH (resolved to ${found.absolutePath})`
          : `fixture:${found.absolutePath}`,
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
  throw new Error(
    "Could not resolve a signing public key in production. Tried (in order):\n" +
      "  1. env SIGNING_PUBLIC_KEY_PEM — not set\n" +
      `  2. env SIGNING_PUBLIC_KEY_PATH (=${envPath ?? "unset"}) — not found at any candidate path\n` +
      `  3. Checked-in fixture (keys/signing-public.pem) — not found\n` +
      "Refusing to fall back to TEST_ONLY material because NODE_ENV=production. " +
      "Set SIGNING_PUBLIC_KEY_PEM (inline PEM) or SIGNING_PUBLIC_KEY_PATH (mounted file) " +
      "to a real Ed25519 public-key PEM, or set SIGNER_PROVIDER=aws-kms with KMS_KEY_ID. " +
      `Paths tried: [${attempts.join(", ")}]`,
  );
}

async function upsertSigningKeyRow(
  keyId: string,
  version: number,
  publicKeyPem: string,
): Promise<{ id: string; keyId: string; version: number }> {
  const saved = await prisma.signingKey.upsert({
    where: { keyId_version: { keyId, version } },
    update: { publicKeyPem, revokedAt: null },
    create: { keyId, version, publicKeyPem },
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
