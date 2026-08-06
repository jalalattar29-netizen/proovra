/**
 * PHASE 12 — POINT 8: the committed signing fixture must never sign in Production.
 *
 * `services/api/keys/signing-private.pem` is a real Ed25519 key that has been
 * tracked since the baseline commit. It is a DEV/TEST FIXTURE — the repository
 * says so in `seed-signing-key.ts` ("checked-in test fixture", "committed dev
 * fixture") and CI selects it explicitly — but three facts made it reachable
 * from a production process rather than merely present:
 *
 *   1. `SIGNER_PROVIDER` defaults to `local-pem`;
 *   2. `services/api/Dockerfile` copied `services/api/keys` into the build
 *      stage, and the runner stage copies all of `/app/services/api`, so the
 *      fixture shipped inside the production image;
 *   3. the only thing standing between that image and a real signature was an
 *      operator remembering to point `SIGNING_PRIVATE_KEY_PATH` somewhere else.
 *
 * A signature is the product's whole claim. One made with a key that is public
 * in a Git repository is not evidence of anything, and it is indistinguishable
 * — to a downstream verifier — from a genuine one. So the fixture is refused by
 * IDENTITY, not by configuration hygiene: the check is the SHA-256 of the
 * public half, which no rename, copy, remount, or inline-PEM route can evade.
 *
 * A public key fingerprint is not a secret; the private half is never read into
 * a message, a log, or an error. The guard reports only WHICH input was refused
 * and WHY.
 */
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

/**
 * SHA-256 over the DER SPKI encoding of the PUBLIC half of every key known to
 * be committed to this repository.
 *
 * Derived from the key, not from its filename: the same bytes supplied through
 * `SIGNING_PRIVATE_KEY_PEM`, copied to `/etc/secrets/prod.pem`, or baked into
 * an image under any name all produce this fingerprint and are all refused.
 */
export const COMMITTED_FIXTURE_PUBLIC_FINGERPRINTS: ReadonlySet<string> =
  new Set([
    // services/api/keys/signing-private.pem + signing-public.pem (Ed25519)
    "2da86cc26db85042d19a5964c917cf27d815dd68f31b215823ca20ea947b90e6",
  ]);

/** Paths that are the fixture by location, refused before any key is read. */
const FIXTURE_PATH_SUFFIXES = [
  "services/api/keys/signing-private.pem",
  "services/api/keys/signing-public.pem",
  "keys/signing-private.pem",
  "keys/signing-public.pem",
];

export class FixtureSigningKeyRefused extends Error {
  readonly code = "FIXTURE_SIGNING_KEY_REFUSED";

  constructor(reason: string) {
    super(
      `Refusing to sign in production with the repository's committed signing ` +
        `fixture: ${reason}. Configure a real signing key via ` +
        `SIGNER_PROVIDER=aws-kms (KMS_KEY_ID) or a mounted ` +
        `SIGNING_PRIVATE_KEY_PATH that is not the checked-in fixture.`,
    );
    this.name = "FixtureSigningKeyRefused";
  }
}

/** True when this process is running as Production. */
export function isProductionRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.NODE_ENV ?? "").trim().toLowerCase() === "production";
}

/** SHA-256 of the DER SPKI public half of a private or public PEM. */
export function publicFingerprintOfPem(pem: string | Buffer): string | null {
  const tryExport = (key: ReturnType<typeof createPublicKey>): string =>
    createHash("sha256")
      .update(key.export({ type: "spki", format: "der" }))
      .digest("hex");

  try {
    return tryExport(createPublicKey(createPrivateKey(pem)));
  } catch {
    /* not a private key — fall through */
  }
  try {
    return tryExport(createPublicKey(pem));
  } catch {
    // Unparseable input is not this guard's business to diagnose; the loader
    // that actually needs the key will fail with its own message. Returning
    // null here must NEVER be read as "safe" — see assertNotCommittedFixture,
    // which refuses an unreadable path in production rather than allowing it.
    return null;
  }
}

function looksLikeFixturePath(p: string): boolean {
  const norm = resolve(p).replace(/\\/g, "/");
  return (
    FIXTURE_PATH_SUFFIXES.some((s) => norm.endsWith(`/${s}`) || norm === s) ||
    basename(norm) === "signing-private.pem"
  );
}

/**
 * Refuse the committed fixture in Production.
 *
 * In development and test the fixture is a legitimate, explicitly selected
 * input and this is a no-op — that is what it exists for.
 */
export function assertNotCommittedFixture(input: {
  privateKeyPath?: string | undefined;
  privateKeyPem?: string | undefined;
  env?: NodeJS.ProcessEnv;
}): void {
  const env = input.env ?? process.env;
  if (!isProductionRuntime(env)) return;

  const { privateKeyPath, privateKeyPem } = input;

  if (!privateKeyPath?.trim() && !privateKeyPem?.trim()) {
    throw new FixtureSigningKeyRefused(
      "no signing key is configured, and production must not fall back to a default",
    );
  }

  if (privateKeyPem?.trim()) {
    const fp = publicFingerprintOfPem(privateKeyPem);
    if (fp && COMMITTED_FIXTURE_PUBLIC_FINGERPRINTS.has(fp)) {
      throw new FixtureSigningKeyRefused(
        "SIGNING_PRIVATE_KEY_PEM carries the committed fixture's public fingerprint",
      );
    }
  }

  if (privateKeyPath?.trim()) {
    const p = privateKeyPath.trim();
    if (looksLikeFixturePath(p)) {
      throw new FixtureSigningKeyRefused(
        "the configured signing key path is the checked-in fixture location",
      );
    }
    let pem: Buffer;
    try {
      pem = readFileSync(resolve(p));
    } catch {
      throw new FixtureSigningKeyRefused(
        "the configured signing key path could not be read, and production must fail closed",
      );
    }
    const fp = publicFingerprintOfPem(pem);
    if (fp && COMMITTED_FIXTURE_PUBLIC_FINGERPRINTS.has(fp)) {
      throw new FixtureSigningKeyRefused(
        "the configured signing key has the committed fixture's public fingerprint",
      );
    }
  }
}
