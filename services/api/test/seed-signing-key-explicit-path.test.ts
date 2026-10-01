/**
 * SIGNING-KEY SEED — AN EXPLICIT PATH IS USED EXACTLY, OR THE SEED REFUSES.
 *
 * The resolver used to rewrite an explicit SIGNING_PUBLIC_KEY_PATH and, when
 * nothing matched, register the checked-in fixture key instead. In the CI
 * full stack that registered a public key the API's private key did not
 * match, and every signature failed (SIGNING_KEY_IDENTITY_CONFLICT → 500 on
 * POST /v1/evidence/:id/complete).
 *
 * Behavioural, against real files in a temp directory. Every failure must name
 * the path and must never carry key material.
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

type SeedModule = typeof import("../src/seed-signing-key.js");

const ENV_KEYS = ["SIGNING_PUBLIC_KEY_PEM", "SIGNING_PUBLIC_KEY_PATH", "NODE_ENV", "PROOVRA_ENV"] as const;
const saved: Record<string, string | undefined> = {};

let dir: string;
let mod: SeedModule;

/** The base64 body of a PEM — the material no message may contain. */
function bodyOf(pem: string): string {
  return pem
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("-----"))
    .join("");
}

/** Every 24-char window of the material — a partial leak is still a leak. */
function expectNoMaterial(text: string, pem: string) {
  const body = bodyOf(pem);
  // The messages may name the EXPECTED header ("-----BEGIN PUBLIC KEY-----");
  // they may never carry the file's own armour or any of its body.
  expect(text).not.toContain("PRIVATE KEY");
  for (let i = 0; i + 24 <= body.length; i += 12) expect(text).not.toContain(body.slice(i, i + 24));
}

function failureOf(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the resolver to refuse");
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "seed-key-"));
  mod = await import("../src/seed-signing-key.js");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

for (const k of ENV_KEYS) saved[k] = process.env[k];
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

function configure(path: string | undefined) {
  delete process.env.SIGNING_PUBLIC_KEY_PEM;
  delete process.env.PROOVRA_ENV;
  process.env.NODE_ENV = "development";
  if (path === undefined) delete process.env.SIGNING_PUBLIC_KEY_PATH;
  else process.env.SIGNING_PUBLIC_KEY_PATH = path;
}

describe("seed-signing-key — explicit SIGNING_PUBLIC_KEY_PATH", () => {
  it("a valid explicit path loads EXACTLY that key (not the fixture)", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ type: "spki", format: "pem" }) as string;
    const file = join(dir, "own-public.pem");
    writeFileSync(file, pem);
    configure(file);

    const result = mod.resolvePublicKeyPemFromLocalPem();
    expect(result.source).toBe(`env:SIGNING_PUBLIC_KEY_PATH (resolved to ${resolve(file)})`);
    expect(result.isTestOnlyFallback).toBe(false);
    expect(result.pem.trim()).toBe(pem.trim());
  });

  it("an explicit path that does not exist fails, naming the path — no fixture substitution", () => {
    const missing = join(dir, "absent", "public.pem");
    configure(missing);
    const error = failureOf(() => mod.resolvePublicKeyPemFromLocalPem());
    expect(error).toBeInstanceOf(mod.SigningKeyConfigurationError);
    expect(error.message).toContain(resolve(missing));
    expect(error.message).toMatch(/does not exist/);
    expect(error.message).toMatch(/never substitutes a fixture/);
  });

  it("an explicit path that is a directory fails as 'not a regular file'", () => {
    const sub = join(dir, "a-directory.pem");
    mkdirSync(sub);
    configure(sub);
    const error = failureOf(() => mod.resolvePublicKeyPemFromLocalPem());
    expect(error).toBeInstanceOf(mod.SigningKeyConfigurationError);
    expect(error.message).toContain(resolve(sub));
    expect(error.message).toMatch(/not a regular file/);
  });

  it("an explicit path the process cannot read fails with the OS code, naming the path", async () => {
    const file = join(dir, "unreadable.pem");
    writeFileSync(file, "placeholder");
    configure(file);
    // Permission bits are not portable (Windows; root), so the read itself is
    // made to fail exactly as the OS reports EACCES, for this one path only.
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const real = await importOriginal<typeof import("node:fs")>();
      return {
        ...real,
        readFileSync: ((p: Parameters<typeof real.readFileSync>[0], ...rest: unknown[]) => {
          if (resolve(String(p)) === resolve(file)) {
            throw Object.assign(new Error(`EACCES: permission denied, open '${file}'`), { code: "EACCES" });
          }
          return (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
        }) as typeof real.readFileSync,
      };
    });
    try {
      const fresh: SeedModule = await import("../src/seed-signing-key.js");
      const error = failureOf(() => fresh.resolvePublicKeyPemFromLocalPem());
      expect(error.name).toBe("SigningKeyConfigurationError");
      expect(error.message).toContain(resolve(file));
      expect(error.message).toMatch(/could not be read \(EACCES\)/);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("an explicit path holding the wrong material fails without echoing any of it", () => {
    // A PRIVATE key where the public one belongs, and an RSA public key: both
    // refused, and neither message carries a byte of the material.
    const { privateKey } = generateKeyPairSync("ed25519");
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const privFile = join(dir, "is-private.pem");
    writeFileSync(privFile, privatePem);
    configure(privFile);
    const e1 = failureOf(() => mod.resolvePublicKeyPemFromLocalPem());
    expect(e1).toBeInstanceOf(mod.SigningKeyConfigurationError);
    expect(e1.message).toContain(resolve(privFile));
    expectNoMaterial(`${e1.message}\n${e1.stack ?? ""}`, privatePem);

    const { publicKey: rsa } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPem = rsa.export({ type: "spki", format: "pem" }) as string;
    const rsaFile = join(dir, "rsa-public.pem");
    writeFileSync(rsaFile, rsaPem);
    configure(rsaFile);
    const e2 = failureOf(() => mod.resolvePublicKeyPemFromLocalPem());
    expect(e2.message).toMatch(/not an Ed25519 key/);
    expectNoMaterial(`${e2.message}\n${e2.stack ?? ""}`, rsaPem);

    // A corrupt body inside a valid header: the parser's own message is not
    // forwarded either.
    const { publicKey } = generateKeyPairSync("ed25519");
    const good = publicKey.export({ type: "spki", format: "pem" }) as string;
    const corrupt = good.replace(/\n([A-Za-z0-9+/]{8})/, "\n!!!!!!!!");
    const corruptFile = join(dir, "corrupt.pem");
    writeFileSync(corruptFile, corrupt);
    configure(corruptFile);
    const e3 = failureOf(() => mod.resolvePublicKeyPemFromLocalPem());
    expect(e3.message).toContain(resolve(corruptFile));
    expectNoMaterial(`${e3.message}\n${e3.stack ?? ""}`, corrupt);
  });

  it("with NO path configured, the checked-in fixture is the fallback", () => {
    configure(undefined);
    // The suite runs from services/api/, like `pnpm prisma:seed`.
    const result = mod.resolvePublicKeyPemFromLocalPem();
    expect(result.source).toBe(`fixture:${resolve("keys/signing-public.pem")}`);
    expect(result.isTestOnlyFallback).toBe(false);
  });
});
