/**
 * PHASE 12 — POINT 8: the committed signing fixture must be unreachable from Production.
 *
 * `services/api/keys/signing-private.pem` is a real Ed25519 private key tracked
 * since the baseline commit. It is a documented dev/test fixture, and that is a
 * legitimate thing to have — but three facts made it REACHABLE rather than
 * merely present: `SIGNER_PROVIDER` defaults to `local-pem`, the API Dockerfile
 * copied `services/api/keys` into a stage the runner then copied wholesale, and
 * nothing refused it at the moment of signing.
 *
 * A signature made with a key that is public in a Git repository is
 * indistinguishable, to a downstream verifier, from a genuine one. These tests
 * pin the refusal by KEY IDENTITY — the SHA-256 of the public half — so no
 * rename, copy, remount or inline-PEM route can evade it, and pin that the
 * fixture still works where it is supposed to.
 *
 * No private key material is read into an assertion, a message, or a log.
 */
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  assertNotCommittedFixture,
  COMMITTED_FIXTURE_PUBLIC_FINGERPRINTS,
  FixtureSigningKeyRefused,
  publicFingerprintOfPem,
} from "@proovra/shared-runtime";
import { afterEach, describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../../..");
const FIXTURE = resolve(REPO, "services/api/keys/signing-private.pem");
const PROD = { NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv;
const DEV = { NODE_ENV: "development" } as unknown as NodeJS.ProcessEnv;

const tmps: string[] = [];
afterEach(() => {
  while (tmps.length) {
    const d = tmps.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

/** A distinct, explicitly configured key that is NOT the fixture. */
function freshKeyFile(): { dir: string; path: string; pem: string } {
  const dir = mkdtempSync(join(tmpdir(), "p8-signing-"));
  tmps.push(dir);
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const path = join(dir, "operator-supplied.pem");
  writeFileSync(path, pem);
  return { dir, path, pem };
}

describe("PHASE 12 POINT 8 — committed signing fixture reachability", () => {
  it("the fixture is present and IS the key the guard knows by fingerprint", () => {
    expect(existsSync(FIXTURE)).toBe(true);
    const fp = publicFingerprintOfPem(readFileSync(FIXTURE));
    expect(fp).not.toBeNull();
    expect(COMMITTED_FIXTURE_PUBLIC_FINGERPRINTS.has(fp!)).toBe(true);
  });

  // 1. test/dev may use the fixture when explicitly selected — that is its job.
  it("DEV/TEST may use the fixture when it is explicitly selected", () => {
    expect(() =>
      assertNotCommittedFixture({ privateKeyPath: FIXTURE, env: DEV }),
    ).not.toThrow();
  });

  // 2. Production with NO signing configuration refuses — no silent default.
  it("PRODUCTION with no signing configuration refuses (fails closed)", () => {
    expect(() => assertNotCommittedFixture({ env: PROD })).toThrow(FixtureSigningKeyRefused);
    expect(() => assertNotCommittedFixture({ privateKeyPath: "", env: PROD })).toThrow(
      /no signing key is configured/i,
    );
  });

  // 3. Production pointed AT the fixture path refuses.
  it("PRODUCTION pointed at the fixture PATH refuses", () => {
    expect(() =>
      assertNotCommittedFixture({ privateKeyPath: FIXTURE, env: PROD }),
    ).toThrow(FixtureSigningKeyRefused);

    // …and by the relative form CI uses, too.
    expect(() =>
      assertNotCommittedFixture({ privateKeyPath: "keys/signing-private.pem", env: PROD }),
    ).toThrow(FixtureSigningKeyRefused);
  });

  // 4. Production given the same BYTES under another name / inline refuses by fingerprint.
  it("PRODUCTION given the fixture's bytes under a different name refuses by FINGERPRINT", () => {
    const dir = mkdtempSync(join(tmpdir(), "p8-signing-"));
    tmps.push(dir);
    const renamed = join(dir, "prod-signing.pem"); // innocent name, fixture bytes
    writeFileSync(renamed, readFileSync(FIXTURE));

    expect(() => assertNotCommittedFixture({ privateKeyPath: renamed, env: PROD })).toThrow(
      /public fingerprint/i,
    );

    // Same bytes supplied inline instead of by path.
    expect(() =>
      assertNotCommittedFixture({ privateKeyPem: readFileSync(FIXTURE, "utf8"), env: PROD }),
    ).toThrow(/public fingerprint/i);
  });

  // 5. A distinct, explicitly configured key passes — the guard is not "refuse everything".
  it("PRODUCTION with a distinct operator-supplied key is ACCEPTED", () => {
    const k = freshKeyFile();

    expect(() => assertNotCommittedFixture({ privateKeyPath: k.path, env: PROD })).not.toThrow();
    expect(() => assertNotCommittedFixture({ privateKeyPem: k.pem, env: PROD })).not.toThrow();

    // And it is genuinely a different key.
    expect(COMMITTED_FIXTURE_PUBLIC_FINGERPRINTS.has(publicFingerprintOfPem(k.pem)!)).toBe(false);
  });

  it("PRODUCTION with an unreadable configured path fails CLOSED, not open", () => {
    expect(() =>
      assertNotCommittedFixture({ privateKeyPath: join(tmpdir(), "p8-does-not-exist.pem"), env: PROD }),
    ).toThrow(FixtureSigningKeyRefused);
  });

  // 6. No path secret or key material in any error the guard produces.
  it("emits no key material and no file contents in its refusals", () => {
    const fixturePem = readFileSync(FIXTURE, "utf8");
    const body = fixturePem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");

    const messages: string[] = [];
    for (const input of [
      { env: PROD },
      { privateKeyPath: FIXTURE, env: PROD },
      { privateKeyPem: fixturePem, env: PROD },
      { privateKeyPath: "keys/signing-private.pem", env: PROD },
    ]) {
      try {
        assertNotCommittedFixture(input as never);
        throw new Error("expected a refusal");
      } catch (e) {
        messages.push(e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e));
      }
    }

    for (const m of messages) {
      expect(m).not.toContain(body);
      expect(m).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
      // No base64 run long enough to be key material.
      //
      // FILESYSTEM PATHS ARE REMOVED FIRST, and that is a correction rather
      // than a loosening. `[A-Za-z0-9+/]` includes the POSIX separator, so a
      // long absolute path is indistinguishable from base64 to this pattern:
      // on the CI runner the stack traces carry
      // `/home/runner/work/proovra/proovra/services/api/...`, which is
      // forty-plus characters of exactly that class and matched. On Windows
      // the same stack reads `D:\digital-witness\...`, where the drive colon
      // and backslashes break every run — so the assertion passed locally and
      // could not pass on Linux.
      //
      // A path is not key material. Removing path-shaped runs keeps the
      // property this test exists to hold — that no key bytes reach an error
      // message — while dropping a false positive that was only ever about
      // where the checkout happens to live.
      const withoutPaths = m
        .replace(/(?:\/[A-Za-z0-9._@+-]+)+\/?/g, "<path>")
        .replace(/[A-Za-z]:\\[^\s)]*/g, "<path>");
      expect(withoutPaths).not.toMatch(/[A-Za-z0-9+/]{40,}={0,2}/);
    }
  });
});

describe("PHASE 12 POINT 8 — the fixture cannot ride into a production image", () => {
  const dockerfile = readFileSync(resolve(REPO, "services/api/Dockerfile"), "utf8");

  it("the API Dockerfile does not copy services/api/keys into any stage", () => {
    const copies = dockerfile
      .split("\n")
      .filter((l) => /^\s*COPY\b/.test(l) && /keys/.test(l) && !/^\s*#/.test(l));

    expect(copies).toEqual([]);
  });

  it("the worker Dockerfile does not copy a signing key either", () => {
    const worker = readFileSync(resolve(REPO, "services/worker/Dockerfile"), "utf8");
    const copies = worker
      .split("\n")
      .filter((l) => /^\s*COPY\b/.test(l) && /(keys|\.pem)/.test(l) && !/^\s*#/.test(l));

    expect(copies).toEqual([]);
  });
});
