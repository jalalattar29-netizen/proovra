import {
  createPublicKey,
  generateKeyPairSync,
  verify as cryptoVerify,
} from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  signPackageManifestDigest,
  validatePackageSignerAtStartup,
} from "../src/signing/package-signer.js";

const KEYS = [
  "NODE_ENV",
  "SIGNER_PROVIDER",
  "SIGNING_KEY_ID",
  "SIGNING_KEY_VERSION",
  "PACKAGE_SIGNING_KEY_ID",
  "PACKAGE_SIGNING_KEY_VERSION",
  "SIGNING_PRIVATE_KEY_PATH",
  "SIGNING_PUBLIC_KEY_PATH",
  "PACKAGE_SIGNING_PRIVATE_KEY_PATH",
  "PACKAGE_SIGNING_PUBLIC_KEY_PATH",
] as const;
const original = new Map(KEYS.map((key) => [key, process.env[key]]));

let dir: string;
let privatePath: string;
let publicPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "proovra-package-signer-"));
  const pair = generateKeyPairSync("ed25519");
  privatePath = join(dir, "prod-package-private.pem");
  publicPath = join(dir, "prod-package-public.pem");
  writeFileSync(
    privatePath,
    pair.privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  writeFileSync(
    publicPath,
    pair.publicKey.export({ type: "spki", format: "pem" }),
  );
});

afterEach(() => {
  for (const key of KEYS) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function configureLocalProductionSigner() {
  process.env.NODE_ENV = "production";
  process.env.SIGNER_PROVIDER = "local-pem";
  process.env.SIGNING_KEY_ID = "prod-test-key";
  process.env.SIGNING_KEY_VERSION = "7";
  process.env.PACKAGE_SIGNING_KEY_ID = "prod-test-package-key";
  process.env.PACKAGE_SIGNING_KEY_VERSION = "3";
  process.env.PACKAGE_SIGNING_PRIVATE_KEY_PATH = privatePath;
  process.env.PACKAGE_SIGNING_PUBLIC_KEY_PATH = publicPath;
}

describe("package signer startup boundary", () => {
  it("rejects the repository fixture in production before a job can sign", async () => {
    configureLocalProductionSigner();
    process.env.PACKAGE_SIGNING_PRIVATE_KEY_PATH = fileURLToPath(
      new URL("../../api/keys/signing-private.pem", import.meta.url),
    );
    process.env.PACKAGE_SIGNING_PUBLIC_KEY_PATH = fileURLToPath(
      new URL("../../api/keys/signing-public.pem", import.meta.url),
    );

    await expect(validatePackageSignerAtStartup()).rejects.toMatchObject({
      code: "FIXTURE_SIGNING_KEY_REFUSED",
    });
  });

  it("accepts a mounted production PEM pair and records its stable identity", async () => {
    configureLocalProductionSigner();

    await expect(validatePackageSignerAtStartup()).resolves.toEqual({
      provider: "local-pem",
      signingKeyId: "prod-test-package-key",
      signingKeyVersion: "3",
    });

    const digest = "a".repeat(64);
    const signed = await signPackageManifestDigest(digest);
    expect(signed).toMatchObject({
      provider: "local-pem",
      signingKeyId: "prod-test-package-key",
      signingKeyVersion: "3",
    });
    expect(
      cryptoVerify(
        null,
        Buffer.from(digest, "hex"),
        createPublicKey(signed.publicKeyPem),
        Buffer.from(signed.signatureBase64, "base64"),
      ),
    ).toBe(true);
    expect(signed).not.toHaveProperty("privateKeyPem");
  });

  it("rejects a public key that does not match the mounted private key", async () => {
    configureLocalProductionSigner();
    const other = generateKeyPairSync("ed25519");
    const otherPublic = join(dir, "other-public.pem");
    writeFileSync(
      otherPublic,
      other.publicKey.export({ type: "spki", format: "pem" }),
    );
    process.env.PACKAGE_SIGNING_PUBLIC_KEY_PATH = otherPublic;

    await expect(validatePackageSignerAtStartup()).rejects.toThrow(
      "private and public keys do not match",
    );
  });
});
