/**
 * THE BITCOIN VERIFIER CONFIGURATION — fail-closed, credential-free.
 *
 * `resolveOtsBitcoinVerifierConfig` (src/ots-bitcoin-config.ts) is exercised
 * with explicit env objects only (never process.env). No doubles: the real
 * zod schema, the real URL validation and the real password-file read (a temp
 * file under os.tmpdir(), deleted after each test).
 *
 * The secrets-authority cache (@proovra/shared-runtime getCachedSecret) is
 * NOT hydrated in this process; the first test pins that, so the password
 * sources under test are exactly the file and the env object.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getCachedSecret } from "@proovra/shared-runtime";
import { afterEach, describe, expect, it } from "vitest";

import {
  OTS_BITCOIN_RPC_PASSWORD_SECRET,
  describeOtsBitcoinVerifierConfig,
  resolveOtsBitcoinVerifierConfig,
  rpcPassword,
  validateRpcUrl,
  type OtsBitcoinVerifierConfig,
} from "../src/ots-bitcoin-config.js";

const USER = "rpc-user-xq7";
const PASSWORD = "s3cr3t-PASSWORD-zz9";

const BASE = {
  OTS_BITCOIN_VERIFY_ENABLED: "true",
  OTS_BITCOIN_RPC_URL: "http://10.0.0.5:8332/",
  OTS_BITCOIN_RPC_USERNAME: USER,
  OTS_BITCOIN_RPC_PASSWORD: PASSWORD,
} as const;

const env = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({ ...BASE, ...over }) as NodeJS.ProcessEnv;
/** Production supplies the password ONLY as a mounted file (or the secrets authority). */
const prodEnv = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  env({ OTS_BITCOIN_RPC_PASSWORD: undefined, OTS_BITCOIN_RPC_PASSWORD_FILE: passwordFile(`${PASSWORD}
`), ...over });

function misconfigured(c: OtsBitcoinVerifierConfig): string {
  expect(c.kind).toBe("misconfigured");
  if (c.kind !== "misconfigured") throw new Error("unreachable");
  expect(c.reason).not.toContain(PASSWORD);
  expect(c.reason.length).toBeLessThanOrEqual(200);
  return c.reason;
}
function enabled(c: OtsBitcoinVerifierConfig): Extract<OtsBitcoinVerifierConfig, { kind: "enabled" }> {
  expect(c.kind).toBe("enabled");
  if (c.kind !== "enabled") throw new Error(`expected enabled, got ${JSON.stringify(c)}`);
  return c;
}

const tempDirs: string[] = [];
function passwordFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "proovra-btc-pw-"));
  tempDirs.push(dir);
  const file = join(dir, "rpc-password");
  writeFileSync(file, content, "utf8");
  return file;
}
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

it("the secrets-authority cache is not hydrated in this test process", () => {
  expect(getCachedSecret(OTS_BITCOIN_RPC_PASSWORD_SECRET)).toBeNull();
});

describe("the flag", () => {
  it("is off by default", () => {
    expect(resolveOtsBitcoinVerifierConfig({}, { productionLike: false })).toEqual({ kind: "disabled" });
    expect(resolveOtsBitcoinVerifierConfig({}, { productionLike: true })).toEqual({ kind: "disabled" });
  });
  it("\"false\" is off, even with everything else set", () => {
    expect(resolveOtsBitcoinVerifierConfig(env({ OTS_BITCOIN_VERIFY_ENABLED: "false" }), { productionLike: false }).kind).toBe("disabled");
  });
  it("a flag that is not exactly \"true\" is off and never throws", () => {
    for (const v of ["yes", "1", "TRUE", "on"]) {
      expect(() => resolveOtsBitcoinVerifierConfig(env({ OTS_BITCOIN_VERIFY_ENABLED: v }), { productionLike: false })).not.toThrow();
      expect(resolveOtsBitcoinVerifierConfig(env({ OTS_BITCOIN_VERIFY_ENABLED: v }), { productionLike: false }).kind).toBe("disabled");
    }
  });
  it("blank is off", () => {
    expect(resolveOtsBitcoinVerifierConfig(env({ OTS_BITCOIN_VERIFY_ENABLED: "  " }), { productionLike: false }).kind).toBe("disabled");
  });
});

describe("enabled requires URL, username and password", () => {
  it("a complete configuration is enabled with defaults", () => {
    const c = enabled(resolveOtsBitcoinVerifierConfig(env(), { productionLike: false }));
    expect(c.rpcUrl).toBe("http://10.0.0.5:8332/");
    expect(c.rpcEndpointLabel).toBe("10.0.0.5:8332");
    expect(c.username).toBe(USER);
    expect(c.timeoutMs).toBe(5_000);
    expect(c.policy.expectedChain).toBe("main");
    expect(c.passwordFile).toBeNull();
    expect(JSON.stringify(c)).not.toContain(PASSWORD);
  });
  it("missing URL → misconfigured", () => {
    expect(misconfigured(resolveOtsBitcoinVerifierConfig(env({ OTS_BITCOIN_RPC_URL: undefined }), { productionLike: false }))).toContain("OTS_BITCOIN_RPC_URL");
  });
  it("missing username → misconfigured", () => {
    expect(misconfigured(resolveOtsBitcoinVerifierConfig(env({ OTS_BITCOIN_RPC_USERNAME: "" }), { productionLike: false }))).toContain("OTS_BITCOIN_RPC_USERNAME");
  });
  it("missing password (no file, no env) → misconfigured", () => {
    expect(misconfigured(resolveOtsBitcoinVerifierConfig(env({ OTS_BITCOIN_RPC_PASSWORD: undefined }), { productionLike: false }))).toMatch(/password/i);
  });
});

describe("the RPC URL", () => {
  const refused: Array<[string, string]> = [
    ["userinfo", `http://${USER}:${PASSWORD}@10.0.0.5:8332/`],
    ["username only", "http://someone@10.0.0.5:8332/"],
    ["ftp:", "ftp://10.0.0.5/"],
    ["file:", "file:///etc/passwd"],
    ["query", "http://10.0.0.5:8332/?wallet=x"],
    ["fragment", "http://10.0.0.5:8332/#x"],
    ["not a URL", "not a url"],
  ];
  for (const [name, url] of refused) {
    it(`${name} → misconfigured, never throws, never echoes the value`, () => {
      expect(() => resolveOtsBitcoinVerifierConfig(env({ OTS_BITCOIN_RPC_URL: url }), { productionLike: false })).not.toThrow();
      const reason = misconfigured(resolveOtsBitcoinVerifierConfig(env({ OTS_BITCOIN_RPC_URL: url }), { productionLike: false }));
      expect(reason).toContain("OTS_BITCOIN_RPC_URL");
      expect(reason).not.toContain(url);
    });
  }

  it("validateRpcUrl labels host:port, defaulting 80 for http and 443 for https", () => {
    expect(validateRpcUrl("http://node.internal/")).toEqual({ ok: true, url: "http://node.internal/", label: "node.internal:80" });
    expect(validateRpcUrl("https://node.internal")).toEqual({ ok: true, url: "https://node.internal/", label: "node.internal:443" });
    expect(validateRpcUrl("http://node.internal:8332/")).toEqual({ ok: true, url: "http://node.internal:8332/", label: "node.internal:8332" });
    expect(validateRpcUrl(" http://node.internal:8332/rpc ")).toEqual({ ok: true, url: "http://node.internal:8332/rpc", label: "node.internal:8332" });
  });
});

describe("bounds", () => {
  const cases: Array<[string, string[], string[]]> = [
    ["OTS_BITCOIN_RPC_TIMEOUT_MS", ["999", "30001", "1500.5", "abc"], ["1000", "30000"]],
    ["OTS_BITCOIN_MIN_CONFIRMATIONS", ["0", "101", "2.5", "six"], ["1", "100"]],
    ["OTS_BITCOIN_MAX_TIP_AGE_SECONDS", ["599", "86401", "600.1"], ["600", "86400"]],
    ["OTS_BITCOIN_MAX_HEADER_LAG", ["-1", "145", "0.5"], ["0", "144"]],
  ];
  for (const [name, bad, good] of cases) {
    for (const v of bad) {
      it(`${name}=${v} → misconfigured naming the variable, never throws`, () => {
        expect(() => resolveOtsBitcoinVerifierConfig(env({ [name]: v }), { productionLike: false })).not.toThrow();
        const reason = misconfigured(resolveOtsBitcoinVerifierConfig(env({ [name]: v }), { productionLike: false }));
        expect(reason).toContain(name);
      });
    }
    for (const v of good) {
      it(`${name}=${v} is accepted`, () => {
        const c = enabled(resolveOtsBitcoinVerifierConfig(env({ [name]: v }), { productionLike: false }));
        const got = {
          OTS_BITCOIN_RPC_TIMEOUT_MS: c.timeoutMs,
          OTS_BITCOIN_MIN_CONFIRMATIONS: c.policy.minConfirmations,
          OTS_BITCOIN_MAX_TIP_AGE_SECONDS: c.policy.maxTipAgeSeconds,
          OTS_BITCOIN_MAX_HEADER_LAG: c.policy.maxHeaderLag,
        }[name];
        expect(got).toBe(Number(v));
      });
    }
  }

  it("a refused bound never puts the password in the reason", () => {
    const reason = misconfigured(resolveOtsBitcoinVerifierConfig(env({ OTS_BITCOIN_RPC_TIMEOUT_MS: "1", OTS_BITCOIN_MAX_HEADER_LAG: "999" }), { productionLike: false }));
    expect(reason).toContain("OTS_BITCOIN_RPC_TIMEOUT_MS");
    expect(reason).toContain("OTS_BITCOIN_MAX_HEADER_LAG");
    expect(reason).not.toContain(USER);
  });

  it("a password that equals a refused value's text is still never in the reason", () => {
    const reason = misconfigured(resolveOtsBitcoinVerifierConfig(env({ OTS_BITCOIN_EXPECTED_CHAIN: PASSWORD }), { productionLike: false }));
    expect(reason).toContain("OTS_BITCOIN_EXPECTED_CHAIN");
  });
});

describe("expected chain", () => {
  it("productionLike requires main: signet refused, main accepted", () => {
    expect(misconfigured(resolveOtsBitcoinVerifierConfig(prodEnv({ OTS_BITCOIN_EXPECTED_CHAIN: "signet" }), { productionLike: true }))).toContain("OTS_BITCOIN_EXPECTED_CHAIN");
    expect(enabled(resolveOtsBitcoinVerifierConfig(prodEnv({ OTS_BITCOIN_EXPECTED_CHAIN: "main" }), { productionLike: true })).policy.expectedChain).toBe("main");
  });
  it("NODE_ENV=production in the env object counts as production-like", () => {
    misconfigured(resolveOtsBitcoinVerifierConfig(prodEnv({ NODE_ENV: "production", OTS_BITCOIN_EXPECTED_CHAIN: "signet" })));
    expect(enabled(resolveOtsBitcoinVerifierConfig(prodEnv({ NODE_ENV: "production" }))).policy.expectedChain).toBe("main");
  });
  it("non-production allows regtest", () => {
    expect(enabled(resolveOtsBitcoinVerifierConfig(env({ OTS_BITCOIN_EXPECTED_CHAIN: "regtest" }), { productionLike: false })).policy.expectedChain).toBe("regtest");
    expect(enabled(resolveOtsBitcoinVerifierConfig(env({ NODE_ENV: "test", OTS_BITCOIN_EXPECTED_CHAIN: "regtest" }))).policy.expectedChain).toBe("regtest");
  });
});

describe("the password source", () => {
  it("from the env object", () => {
    const e = env();
    const c = enabled(resolveOtsBitcoinVerifierConfig(e, { productionLike: false }));
    expect(rpcPassword(c, e)).toBe(PASSWORD);
  });

  it("from a file, without its trailing newline, preferred over env", () => {
    const file = passwordFile("file-PASSWORD-77\n");
    const e = env({ OTS_BITCOIN_RPC_PASSWORD_FILE: file });
    const c = enabled(resolveOtsBitcoinVerifierConfig(e, { productionLike: false }));
    expect(c.passwordFile).toBe(file);
    expect(rpcPassword(c, e)).toBe("file-PASSWORD-77");
  });

  it("from a file with CRLF and no env password", () => {
    const file = passwordFile("file-PASSWORD-77\r\n");
    const e = env({ OTS_BITCOIN_RPC_PASSWORD_FILE: file, OTS_BITCOIN_RPC_PASSWORD: undefined });
    const c = enabled(resolveOtsBitcoinVerifierConfig(e, { productionLike: false }));
    expect(rpcPassword(c, e)).toBe("file-PASSWORD-77");
  });

  it("a missing file falls back to env", () => {
    const dir = mkdtempSync(join(tmpdir(), "proovra-btc-pw-"));
    tempDirs.push(dir);
    const e = env({ OTS_BITCOIN_RPC_PASSWORD_FILE: join(dir, "absent") });
    const c = enabled(resolveOtsBitcoinVerifierConfig(e, { productionLike: false }));
    expect(rpcPassword(c, e)).toBe(PASSWORD);
  });

  it("an empty file falls back to env", () => {
    const e = env({ OTS_BITCOIN_RPC_PASSWORD_FILE: passwordFile("\n") });
    expect(rpcPassword(enabled(resolveOtsBitcoinVerifierConfig(e, { productionLike: false })), e)).toBe(PASSWORD);
  });

  it("neither file nor env → misconfigured", () => {
    const dir = mkdtempSync(join(tmpdir(), "proovra-btc-pw-"));
    tempDirs.push(dir);
    const e = env({ OTS_BITCOIN_RPC_PASSWORD_FILE: join(dir, "absent"), OTS_BITCOIN_RPC_PASSWORD: undefined });
    misconfigured(resolveOtsBitcoinVerifierConfig(e, { productionLike: false }));
  });

  it("rpcPassword throws a credential-free error when the password disappears (rotation gap)", () => {
    const c = enabled(resolveOtsBitcoinVerifierConfig(env(), { productionLike: false }));
    expect(() => rpcPassword(c, {})).toThrow(/BTC_RPC_MISCONFIGURED/);
  });
});

describe("describeOtsBitcoinVerifierConfig — operator-safe", () => {
  function assertClean(d: Record<string, unknown>): string {
    const text = JSON.stringify(d);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(USER);
    expect(text).not.toContain("http://");
    expect(text).not.toContain("https://");
    expect(text).not.toContain("@");
    return text;
  }

  it("enabled: endpoint label only", () => {
    const c = enabled(resolveOtsBitcoinVerifierConfig(env(), { productionLike: false }));
    const d = describeOtsBitcoinVerifierConfig(c);
    assertClean(d);
    expect(d).toMatchObject({ enabled: true, endpoint: "10.0.0.5:8332", expectedChain: "main", timeoutMs: 5_000 });
  });

  it("enabled with a password file: the file contents are not described", () => {
    const file = passwordFile(`${PASSWORD}\n`);
    const c = enabled(resolveOtsBitcoinVerifierConfig(env({ OTS_BITCOIN_RPC_PASSWORD_FILE: file, OTS_BITCOIN_RPC_PASSWORD: undefined }), { productionLike: false }));
    assertClean(describeOtsBitcoinVerifierConfig(c));
  });

  it("misconfigured (credentials in the URL): the reason never echoes them", () => {
    const c = resolveOtsBitcoinVerifierConfig(env({ OTS_BITCOIN_RPC_URL: `http://${USER}:${PASSWORD}@10.0.0.5:8332/` }), { productionLike: false });
    const d = describeOtsBitcoinVerifierConfig(c);
    assertClean(d);
    expect(d).toMatchObject({ enabled: true, misconfigured: true });
  });

  it("misconfigured (bound): clean", () => {
    assertClean(describeOtsBitcoinVerifierConfig(resolveOtsBitcoinVerifierConfig(env({ OTS_BITCOIN_MIN_CONFIRMATIONS: "0" }), { productionLike: false })));
  });

  it("disabled: just enabled=false", () => {
    expect(describeOtsBitcoinVerifierConfig(resolveOtsBitcoinVerifierConfig(env({ OTS_BITCOIN_VERIFY_ENABLED: "false" })))).toEqual({ enabled: false });
  });
});

describe("production: the password is a mounted file, never an environment variable", () => {
  it("a password in the environment is refused in production — even with a file present — and never echoed", () => {
    const withEnvOnly = misconfigured(resolveOtsBitcoinVerifierConfig(env({ NODE_ENV: "production" })));
    expect(withEnvOnly).toContain("must not be an environment variable in production");
    const withBoth = misconfigured(
      resolveOtsBitcoinVerifierConfig(prodEnv({ NODE_ENV: "production", OTS_BITCOIN_RPC_PASSWORD: PASSWORD })),
    );
    expect(withBoth).toContain("OTS_BITCOIN_RPC_PASSWORD_FILE");
  });

  it("the mounted file is accepted in production, and rpcPassword never falls back to the environment there", () => {
    const e = prodEnv({ NODE_ENV: "production" });
    const c = enabled(resolveOtsBitcoinVerifierConfig(e));
    expect(c.passwordFromEnvironmentAllowed).toBe(false);
    expect(rpcPassword(c, e)).toBe(PASSWORD);
    // The file disappears (rotated / unmounted) and someone sets the variable:
    // production does not read it — the check becomes BTC_RPC_MISCONFIGURED.
    const gone = { ...c, passwordFile: "/nonexistent/proovra/password" };
    expect(() => rpcPassword(gone, { ...e, OTS_BITCOIN_RPC_PASSWORD: PASSWORD })).toThrow(/BTC_RPC_MISCONFIGURED/);
  });

  it("an unreadable or empty password file in production is misconfigured, never enabled", () => {
    expect(misconfigured(resolveOtsBitcoinVerifierConfig(prodEnv({ NODE_ENV: "production", OTS_BITCOIN_RPC_PASSWORD_FILE: "/nonexistent/password" })))).toContain(
      "password is required",
    );
    expect(misconfigured(resolveOtsBitcoinVerifierConfig(prodEnv({ NODE_ENV: "production", OTS_BITCOIN_RPC_PASSWORD_FILE: passwordFile("") })))).toContain(
      "password is required",
    );
  });

  it("outside production the environment remains a development convenience", () => {
    const e = env({ NODE_ENV: "development" });
    const c = enabled(resolveOtsBitcoinVerifierConfig(e));
    expect(c.passwordFromEnvironmentAllowed).toBe(true);
    expect(rpcPassword(c, e)).toBe(PASSWORD);
  });
});
