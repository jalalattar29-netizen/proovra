/**
 * The secrets value-consistency check (scripts/secrets-consistency-check.mjs).
 *
 * Restoring Secrets Manager access is not neutral: a hydrated value outranks
 * the environment for every key read through `getSecret()`. The check says,
 * before the restart that would pick values up, which keys would change — and
 * must never print a value doing it. Its pure parts are proven here; the one
 * AWS call is not made (no credentials, no network in a test).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MIGRATED_SECRETS } from "../src/config/runtime-secrets.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "../scripts/secrets-consistency-check.mjs");

type Mod = {
  STORE_FIRST_KEYS: readonly string[];
  compareSecretBundle: (
    stored: Record<string, unknown>,
    env: Record<string, string | undefined>,
  ) => {
    named: { key: string; category: string }[];
    otherCounts: Record<string, number>;
    changesOnRestart: boolean;
  };
  classifyRefusal: (err: unknown) => {
    errorName: string;
    concernsKms: boolean;
    concernsGetSecretValue: boolean;
    explicitDeny: boolean;
    principalKind: string;
  };
  credentialChainCategory: (env: Record<string, string | undefined>, home?: string) => string;
};
const load = () => import(`file://${SCRIPT}`) as Promise<Mod>;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [p] : [];
  });
}

describe("the named-key list covers every store-first read", () => {
  it("includes MIGRATED_SECRETS and every literal getSecret/requireSecret/resolveRuntimeSecret name in the API", async () => {
    const { STORE_FIRST_KEYS } = await load();
    const literal = new Set<string>();
    for (const file of sourceFiles(resolve(HERE, "../src"))) {
      for (const m of readFileSync(file, "utf8").matchAll(
        /\b(?:getSecret|requireSecret|resolveRuntimeSecret)\(\s*"([A-Z0-9_]+)"/g,
      )) {
        literal.add(m[1]!);
      }
    }
    expect(literal.size).toBeGreaterThan(0);
    for (const key of [...MIGRATED_SECRETS, ...literal]) {
      expect(STORE_FIRST_KEYS, key).toContain(key);
    }
  });
});

describe("compareSecretBundle", () => {
  it("categorises each named key and counts the rest without naming them", async () => {
    const { compareSecretBundle } = await load();
    const result = compareSecretBundle(
      {
        AUTH_JWT_SECRET: "stored-jwt",
        STRIPE_SECRET_KEY: "same",
        RESEND_API_KEY: "only-in-store",
        UNLISTED_ONE: "x",
        UNLISTED_TWO: "y",
      },
      { AUTH_JWT_SECRET: "env-jwt", STRIPE_SECRET_KEY: "same", OPENAI_API_KEY: "env-only", UNLISTED_ONE: "x" },
    );
    const cat = Object.fromEntries(result.named.map((n) => [n.key, n.category]));
    expect(cat.AUTH_JWT_SECRET).toBe("DIFFERENT");
    expect(cat.STRIPE_SECRET_KEY).toBe("MATCH");
    expect(cat.RESEND_API_KEY).toBe("STORE_ONLY");
    expect(cat.OPENAI_API_KEY).toBe("ENV_ONLY");
    expect(cat.PAYPAL_SECRET).toBe("ABSENT");
    expect(result.otherCounts).toEqual({ MATCH: 1, DIFFERENT: 0, STORE_ONLY: 1 });
    expect(result.changesOnRestart).toBe(true);
    // Nothing returned carries a value or an unlisted key name.
    const serialised = JSON.stringify(result);
    for (const leaked of ["stored-jwt", "env-jwt", "only-in-store", "env-only", "UNLISTED_ONE", "UNLISTED_TWO"]) {
      expect(serialised).not.toContain(leaked);
    }
  });

  it("identical bundles change nothing on restart", async () => {
    const { compareSecretBundle } = await load();
    const result = compareSecretBundle({ AUTH_JWT_SECRET: "s" }, { AUTH_JWT_SECRET: "s" });
    expect(result.changesOnRestart).toBe(false);
  });
});

describe("classifyRefusal — bounded, never the message", () => {
  it("reports the error name and whether KMS is involved, without the ARN-bearing message", async () => {
    const { classifyRefusal } = await load();
    const message =
      "User: arn:aws:iam::123456789012:user/proovra is not authorized to perform: secretsmanager:GetSecretValue on resource: proovra/prod/app-secrets";
    const r = classifyRefusal(Object.assign(new Error(message), { name: "AccessDeniedException" }));
    expect(r).toEqual({
      errorName: "AccessDeniedException",
      concernsKms: false,
      concernsGetSecretValue: true,
      explicitDeny: false,
      principalKind: "iam_user",
    });
    expect(JSON.stringify(r)).not.toContain("123456789012");

    const kms = classifyRefusal(
      Object.assign(new Error("Access to KMS is not allowed"), { name: "AccessDeniedException" }),
    );
    expect(kms.concernsKms).toBe(true);
  });
});

describe("credentialChainCategory — names only, in the SDK chain's order", () => {
  it.each([
    [{ AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" }, "environment_static_keys"],
    [{ AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b", AWS_SESSION_TOKEN: "c" }, "environment_session_keys"],
    [{ AWS_PROFILE: "p" }, "shared_config_file"],
    [{ AWS_WEB_IDENTITY_TOKEN_FILE: "/t" }, "web_identity"],
    [{ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/x" }, "container_endpoint"],
    [{}, "instance_metadata_or_none"],
  ])("%j → %s", async (env, expected) => {
    const { credentialChainCategory } = await load();
    expect(credentialChainCategory(env, resolve(HERE, "no-such-home"))).toBe(expected);
  });
});

describe("the script never prints a value", () => {
  it("no output line interpolates a stored or environment value", () => {
    const src = readFileSync(SCRIPT, "utf8");
    const printed = [...src.matchAll(/console\.log\(([\s\S]*?)\);/g)].map((m) => m[1]!);
    expect(printed.length).toBeGreaterThan(0);
    for (const arg of printed) {
      expect(arg).not.toMatch(/stored\[|process\.env\[|secretString|\.message/);
    }
  });
});
