/**
 * PHASE 12 CORRECTIVE PASS §4 — SEC-004: ONE SECRETS AUTHORITY, PROVEN.
 *
 * The finding was a SPLIT, not a bug in the loader: the API initialised a
 * secrets loader that lived in `services/api`, and the Worker initialised
 * nothing, because it could not import another service's private module. Two
 * processes of one deployment could therefore resolve their secrets from
 * different stores, and the one that could not be `required` is the one that
 * signs documents and sends mail.
 *
 * What this file proves, and how
 * ---------------------------------------------------------------------------
 *   (a) STRUCTURE — there is exactly ONE implementation. The API module is a
 *       re-export with no logic, both services import the shared symbol, and
 *       neither bootstrap installs a provider override.
 *   (b) BEHAVIOUR — all nine bootstrap outcomes, driven through the REAL
 *       loader against the local RECORDING provider. The mode handling,
 *       fail-closed path, suspension rule, backoff and readiness projection
 *       are the production ones; only the transport is scripted, at the seam
 *       the production code already has.
 *   (c) PARITY — the readiness document both services publish is the SAME
 *       document, from the same function, and the Worker exposes it.
 *
 * No AWS client is constructed and no network call is attempted anywhere in
 * this file. That is not incidental — "test/local mode never contacts AWS" is
 * one of the properties under test, and it is asserted directly.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getSecretsHealth,
  initSecretsAuthority,
  recordedSecretsCalls,
  recordingSecretsProvider,
  refreshSecretsAuthority,
  resetSecretsAuthority,
  resetRecordingSecretsProvider,
  scriptSecretsProvider,
  setSecretsProvider,
  stopSecretsAuthority,
  getCachedSecret,
  assertSecretsAuthorityReady,
} from "@proovra/shared-runtime";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const read = (rel: string): string => readFileSync(path.join(REPO, rel), "utf8");

const silent = { info: () => {}, warn: () => {} };

const SHARED_IMPL =
  "packages/shared-runtime/src/config/secrets-authority.ts";
const API_SHIM = "services/api/src/config/secrets-manager.ts";

describe("§4 (a) — exactly one implementation", () => {
  it("the API module is a re-export and contains no loader logic", () => {
    const src = read(API_SHIM);
    // Nothing that could constitute a second implementation.
    expect(src).not.toMatch(/GetSecretValueCommand/);
    expect(src).not.toMatch(/SecretsManagerClient/);
    expect(src).not.toMatch(/setInterval\(/);
    expect(src).not.toMatch(/JSON\.parse\(/);
    // Every non-comment, non-blank statement is an export-from.
    const statements = src
      .split("\n")
      .map((l) => l.trim())
      .filter(
        (l) =>
          l.length > 0 &&
          !l.startsWith("*") &&
          !l.startsWith("/*") &&
          !l.startsWith("//"),
      )
      .join("\n");
    const withoutExports = statements.replace(
      /export (type )?\{[\s\S]*?\} from "@proovra\/shared-runtime";/g,
      "",
    );
    expect(
      withoutExports.replace(/\s/g, ""),
      "the API module must contain nothing but re-exports",
    ).toBe("");
  });

  it("both services import the SHARED symbol, not a local loader", () => {
    expect(read("services/worker/src/index.ts")).toMatch(
      /import \{ initSecretsAuthority \} from "@proovra\/shared-runtime"/,
    );
    // The API keeps the historical name; it resolves to the same function.
    expect(read("services/api/src/server.ts")).toMatch(
      /import \{ initSecretsManager \} from "\.\/config\/secrets-manager\.js"/,
    );
  });

  it("no service bootstrap installs a provider override", () => {
    // The seam exists for the harness. A service that reached for it would be
    // choosing its own transport, which is how one authority becomes two.
    for (const f of [
      "services/api/src/server.ts",
      "services/worker/src/index.ts",
      "services/api/src/config/secrets-manager.ts",
    ]) {
      // A CALL, not a mention: the API shim legitimately re-exports the name,
      // and forbidding the name would have forced the shim to hide it —
      // pushing the harness toward a second, unnamed seam.
      expect(read(f), `${f} must not install a secrets provider`).not.toMatch(
        /setSecretsProvider\(/,
      );
    }
  });

  it("the AWS SDK is imported lazily, so a disabled process never loads it", () => {
    const src = read(SHARED_IMPL);
    // No top-level import of the SDK…
    expect(src).not.toMatch(
      /^import .*@aws-sdk\/client-secrets-manager/m,
    );
    // …only a dynamic one, inside the provider.
    expect(src).toMatch(/await import\(\s*\n?\s*"@aws-sdk\/client-secrets-manager"/);
  });
});

describe("§4 (b) — nine bootstrap outcomes against the recording provider", () => {
  const saved: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined): void => {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };

  beforeEach(() => {
    resetSecretsAuthority();
    resetRecordingSecretsProvider();
    setSecretsProvider(recordingSecretsProvider);
    setEnv("AWS_SECRETS_ENABLED", undefined);
    setEnv("AWS_SECRETS_MODE", undefined);
    setEnv("AWS_SECRET_NAME", "proovra/test/bundle");
    setEnv("AWS_SECRETS_REGION", "eu-north-1");
  });

  afterEach(() => {
    stopSecretsAuthority();
    resetSecretsAuthority();
    resetRecordingSecretsProvider();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const k of Object.keys(saved)) delete saved[k];
  });

  it("1 — disabled: the provider is never called and env is the authority", async () => {
    setEnv("AWS_SECRETS_MODE", "disabled");
    await initSecretsAuthority(silent);
    const h = getSecretsHealth();
    expect(h.mode).toBe("disabled");
    expect(h.awsEnabled).toBe(false);
    expect(h.degraded).toBe(false);
    expect(h.secretName).toBeNull();
    expect(
      recordedSecretsCalls(),
      "a disabled process must not reach for the store at all",
    ).toEqual([]);
    expect(getCachedSecret("ANYTHING")).toBeNull();
  });

  it("2 — optional, success: the store is the source and nothing is degraded", async () => {
    setEnv("AWS_SECRETS_MODE", "optional");
    scriptSecretsProvider([
      { kind: "secret", payload: { AUTH_JWT_SECRET: "from-store", OTHER: "x" } },
    ]);
    await initSecretsAuthority(silent);
    const h = getSecretsHealth();
    expect(h.mode).toBe("optional");
    expect(h.awsConnected).toBe(true);
    expect(h.fallbackMode).toBe("aws_primary");
    expect(h.degraded).toBe(false);
    expect(h.cachedKeyCount).toBe(2);
    expect(getCachedSecret("AUTH_JWT_SECRET")).toBe("from-store");
    // The readiness document names the bundle, never a key inside it.
    expect(JSON.stringify(h)).not.toContain("AUTH_JWT_SECRET");
    expect(JSON.stringify(h)).not.toContain("from-store");
  });

  it("3 — optional, access_denied: boots degraded and stops asking", async () => {
    setEnv("AWS_SECRETS_MODE", "optional");
    scriptSecretsProvider([{ kind: "error", name: "AccessDeniedException" }]);
    await initSecretsAuthority(silent);
    const h = getSecretsHealth();
    expect(h.lastErrorCode).toBe("access_denied");
    expect(h.degraded, "an optional authority that failed reports degraded").toBe(true);
    expect(h.refreshSuspended, "an IAM refusal must suspend the loop").toBe(true);

    // The load-bearing assertion: a refresh after suspension performs NO call.
    const before = recordedSecretsCalls().length;
    await refreshSecretsAuthority(silent);
    expect(
      recordedSecretsCalls().length,
      "a suspended loop must not repeat an unauthorized call",
    ).toBe(before);
  });

  it("4 — required, success: the store is the authority and boot proceeds", async () => {
    setEnv("AWS_SECRETS_MODE", "required");
    scriptSecretsProvider([{ kind: "secret", payload: { A: "1" } }]);
    await initSecretsAuthority(silent);
    const h = getSecretsHealth();
    expect(h.mode).toBe("required");
    expect(h.awsConnected).toBe(true);
    expect(h.degraded).toBe(false);
  });

  it("5 — required, access_denied: startup fails CLOSED with a bounded code", async () => {
    setEnv("AWS_SECRETS_MODE", "required");
    scriptSecretsProvider([{ kind: "error", name: "AccessDeniedException" }]);
    await expect(initSecretsAuthority(silent)).rejects.toThrow(
      /aws_secrets\.required_authority_unavailable:access_denied/,
    );
    // The message carries a bounded code and nothing else — no ARN, no
    // endpoint, no region-qualified resource path, no value.
    await expect(initSecretsAuthority(silent)).rejects.not.toThrow(/arn:|https?:/);
  });

  it("6 — malformed payload: decode is classified, never half-applied", async () => {
    setEnv("AWS_SECRETS_MODE", "optional");
    scriptSecretsProvider([{ kind: "raw", secretString: "{not json" }]);
    await initSecretsAuthority(silent);
    const h = getSecretsHealth();
    expect(h.lastErrorCode).toBe("decode");
    expect(h.cacheLoaded, "a payload that did not parse loads nothing").toBe(false);
    expect(h.cachedKeyCount).toBe(0);
    expect(h.degraded).toBe(true);
  });

  it("7 — transient failure then success, with no cache lost in between", async () => {
    setEnv("AWS_SECRETS_MODE", "optional");
    scriptSecretsProvider([
      { kind: "secret", payload: { A: "first" } },
      { kind: "error", name: "TimeoutError" },
      { kind: "secret", payload: { A: "second" } },
    ]);
    await initSecretsAuthority(silent);
    expect(getCachedSecret("A")).toBe("first");

    await refreshSecretsAuthority(silent);
    expect(getSecretsHealth().lastErrorCode).toBe("network");
    expect(
      getCachedSecret("A"),
      "a transient failure must not discard values the authority already gave",
    ).toBe("first");
    expect(getSecretsHealth().fallbackMode).toBe("env_fallback_after_failure");
    expect(
      getSecretsHealth().refreshSuspended,
      "a transient failure must NOT suspend the loop",
    ).toBe(false);

    await refreshSecretsAuthority(silent);
    expect(getCachedSecret("A")).toBe("second");
    expect(getSecretsHealth().degraded).toBe(false);
  });

  it("8 — refresh replaces the bundle atomically, never key by key", async () => {
    setEnv("AWS_SECRETS_MODE", "optional");
    scriptSecretsProvider([
      { kind: "secret", payload: { A: "1", B: "2" } },
      { kind: "secret", payload: { A: "9" } },
    ]);
    await initSecretsAuthority(silent);
    expect(getCachedSecret("B")).toBe("2");
    await refreshSecretsAuthority(silent);
    expect(getCachedSecret("A")).toBe("9");
    expect(
      getCachedSecret("B"),
      "a per-key merge would leave half the process on the old authority",
    ).toBeNull();
    expect(getSecretsHealth().cachedKeyCount).toBe(1);
  });

  it("9 — shutdown stops the loop and a read before hydration is refused", async () => {
    setEnv("AWS_SECRETS_MODE", "optional");
    scriptSecretsProvider([{ kind: "secret", payload: { A: "1" } }]);
    await initSecretsAuthority(silent);
    stopSecretsAuthority();
    // Idempotent.
    expect(() => stopSecretsAuthority()).not.toThrow();

    resetSecretsAuthority();
    expect(
      () => assertSecretsAuthorityReady(),
      "reading before hydration must be an explicit error, not an empty cache",
    ).toThrow(/read_before_hydration/);
  });

  it("the legacy AWS_SECRETS_ENABLED mapping is explicit and reported", async () => {
    setEnv("AWS_SECRETS_MODE", undefined);
    setEnv("AWS_SECRETS_ENABLED", "true");
    scriptSecretsProvider([{ kind: "secret", payload: { A: "1" } }]);
    await initSecretsAuthority(silent);
    const h = getSecretsHealth();
    expect(h.mode, "true maps to optional — unchanged meaning on upgrade").toBe(
      "optional",
    );
    expect(
      h.usingLegacyEnabledVariable,
      "a deployment still on the legacy switch must be visible, not inferred",
    ).toBe(true);
  });

  it("an unrecognised mode is refused rather than guessed", async () => {
    setEnv("AWS_SECRETS_MODE", "requried");
    await expect(initSecretsAuthority(silent)).rejects.toThrow(
      /aws_secrets\.invalid_mode:requried/,
    );
  });
});

describe("§4 (c) — API and Worker publish the SAME readiness contract", () => {
  it("both readiness surfaces call the shared getSecretsHealth", () => {
    expect(read("services/api/src/routes/runtime-secrets-health.routes.ts")).toMatch(
      /getSecretsHealth/,
    );
    const workerHealth = read("services/worker/src/health.ts");
    expect(workerHealth).toMatch(
      /import \{ getSecretsHealth \} from "@proovra\/shared-runtime"/,
    );
    expect(
      workerHealth,
      "the Worker must expose the same document, or parity is unverifiable in a running deployment",
    ).toMatch(/\/health\/secrets/);
  });

  it("the Worker hydrates BEFORE it starts serving or scheduling", () => {
    const src = read("services/worker/src/index.ts");
    const initAt = src.indexOf("initSecretsAuthority(logger)");
    const healthAt = src.indexOf("startHealthServer()");
    expect(initAt, "the Worker must call the shared authority").toBeGreaterThan(-1);
    expect(
      initAt,
      "hydration must precede the health server and every scheduler",
    ).toBeLessThan(healthAt);
    // …and a rejection must take the process down rather than degrade it.
    expect(src).toMatch(/void shutdown\(1\);/);
  });

  it("the readiness document carries no secret name and no secret value", () => {
    // A structural statement about the type, checked against the source so a
    // future field cannot quietly add one.
    const src = read(SHARED_IMPL);
    const typeBlock = /export type SecretsHealth = \{[\s\S]*?\n\};/.exec(src);
    expect(typeBlock).toBeTruthy();
    // Comments stripped first: the block's own doc line says "NEVER the
    // values", which is the promise, not a field. Asserting over prose would
    // be asserting about the wrong thing.
    const fields = typeBlock![0].replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(fields).not.toMatch(/\bvalues\b|\bcachedKeys\b|\bkeyNames\b|\bsecretValue/);
    expect(fields).toMatch(/cachedKeyCount/);
  });
});
