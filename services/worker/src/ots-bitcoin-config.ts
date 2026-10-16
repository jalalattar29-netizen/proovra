/**
 * THE BITCOIN VERIFIER CONFIGURATION — worker-owned, validated, fail-closed.
 *
 * Live Bitcoin-chain verification of OpenTimestamps proofs is OFF unless
 * OTS_BITCOIN_VERIFY_ENABLED=true. When it is on, the RPC endpoint, user and
 * password are required and every bound is validated. A configuration that
 * fails validation never crashes the worker (capture, upload, TSA, reports and
 * packages keep running): it resolves to `misconfigured`, every check is
 * UNAVAILABLE, nothing is ever stated as verified, and the platform condition
 * `platform.bitcoin_verifier_unavailable` names the problem.
 *
 * THE PASSWORD never travels in a URL. It is read, in order, from the secrets
 * authority's hydrated bundle or a read-only worker-only secret file — and,
 * outside production only, the process environment. In production a password
 * in the environment is REFUSED: it would show in `docker inspect`, and the
 * compose file's only source for it is /run/proovra/bitcoin-rpc/password. It
 * is never logged, thrown, persisted or returned by any function here except
 * `rpcPassword()`, whose only caller is the RPC client.
 */
import { readFileSync } from "node:fs";

import { getCachedSecret } from "@proovra/shared-runtime";
import { OTS_CHAIN_POLICY_DEFAULTS, type OtsChainPolicy } from "@proovra/shared";
import { z } from "zod";

const BITCOIN_CHAINS = ["main", "test", "testnet4", "signet", "regtest"] as const;

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const intIn = (min: number, max: number, dflt: number) =>
  z.preprocess(
    (v) => {
      const b = blankToUndefined(v);
      if (b === undefined || b === null) return undefined;
      const n = Number(b);
      return Number.isFinite(n) ? n : b;
    },
    z.number().int().min(min).max(max).default(dflt),
  );

/** The variables, their types and bounds. Nothing here is a secret except the password. */
export const OtsBitcoinEnvSchema = z.object({
  OTS_BITCOIN_VERIFY_ENABLED: z.preprocess(blankToUndefined, z.enum(["true", "false"]).default("false")),
  OTS_BITCOIN_RPC_URL: z.preprocess(blankToUndefined, z.string().optional()),
  OTS_BITCOIN_RPC_USERNAME: z.preprocess(blankToUndefined, z.string().min(1).max(128).optional()),
  OTS_BITCOIN_EXPECTED_CHAIN: z.preprocess(blankToUndefined, z.enum(BITCOIN_CHAINS).default("main")),
  OTS_BITCOIN_RPC_TIMEOUT_MS: intIn(1_000, 30_000, 5_000),
  OTS_BITCOIN_MIN_CONFIRMATIONS: intIn(1, 100, OTS_CHAIN_POLICY_DEFAULTS.minConfirmations),
  OTS_BITCOIN_MAX_TIP_AGE_SECONDS: intIn(600, 86_400, OTS_CHAIN_POLICY_DEFAULTS.maxTipAgeSeconds),
  OTS_BITCOIN_MAX_HEADER_LAG: intIn(0, 144, OTS_CHAIN_POLICY_DEFAULTS.maxHeaderLag),
  OTS_BITCOIN_MIN_NODE_VERSION: intIn(1, 99_999_999, OTS_CHAIN_POLICY_DEFAULTS.minNodeVersion),
  OTS_BITCOIN_RPC_PASSWORD_FILE: z.preprocess(blankToUndefined, z.string().optional()),
});

export type OtsBitcoinVerifierConfig =
  | { kind: "disabled" }
  | { kind: "misconfigured"; reason: string }
  | {
      kind: "enabled";
      /** Origin + path only; never carries credentials. */
      rpcUrl: string;
      /** Host:port for operator-safe diagnostics (no scheme credentials). */
      rpcEndpointLabel: string;
      username: string;
      timeoutMs: number;
      policy: OtsChainPolicy;
      passwordFile: string | null;
      /** Outside production only: the password may come from the environment. */
      passwordFromEnvironmentAllowed: boolean;
    };

/** Bounded, credential-free reason for a refused configuration. */
function refuse(reason: string): OtsBitcoinVerifierConfig {
  return { kind: "misconfigured", reason: reason.slice(0, 200) };
}

/**
 * Validate the URL: http(s) only, no userinfo, no query or fragment. The
 * endpoint is an operator-owned private address; it is deliberately NOT run
 * through the public-URL SSRF validator, which refuses private ranges.
 */
export function validateRpcUrl(raw: string): { ok: true; url: string; label: string } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "OTS_BITCOIN_RPC_URL is not a URL" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: "OTS_BITCOIN_RPC_URL must be http or https" };
  if (u.username || u.password) return { ok: false, reason: "OTS_BITCOIN_RPC_URL must not contain credentials; use OTS_BITCOIN_RPC_USERNAME and the password secret" };
  if (u.search || u.hash) return { ok: false, reason: "OTS_BITCOIN_RPC_URL must not contain a query or fragment" };
  if (!u.hostname) return { ok: false, reason: "OTS_BITCOIN_RPC_URL has no host" };
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  return { ok: true, url: `${u.protocol}//${u.host}${u.pathname === "/" ? "/" : u.pathname}`, label: `${u.hostname}:${port}` };
}

export function resolveOtsBitcoinVerifierConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: { productionLike?: boolean } = {},
): OtsBitcoinVerifierConfig {
  const parsed = OtsBitcoinEnvSchema.safeParse(env);
  if (!parsed.success) {
    // Only the variable names, never their values.
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "OTS_BITCOIN_*")))].join(", ");
    // A flag that does not parse is not "on": the verifier stays off.
    if (String(env.OTS_BITCOIN_VERIFY_ENABLED ?? "").trim() !== "true") return { kind: "disabled" };
    return refuse(`invalid ${names}`);
  }
  const e = parsed.data;
  if (e.OTS_BITCOIN_VERIFY_ENABLED !== "true") return { kind: "disabled" };
  if (!e.OTS_BITCOIN_RPC_URL) return refuse("OTS_BITCOIN_RPC_URL is required when OTS_BITCOIN_VERIFY_ENABLED=true");
  const url = validateRpcUrl(e.OTS_BITCOIN_RPC_URL);
  if (!url.ok) return refuse(url.reason);
  if (!e.OTS_BITCOIN_RPC_USERNAME) return refuse("OTS_BITCOIN_RPC_USERNAME is required when OTS_BITCOIN_VERIFY_ENABLED=true");
  const productionLike = opts.productionLike ?? (env.NODE_ENV === "production");
  if (productionLike && e.OTS_BITCOIN_EXPECTED_CHAIN !== "main") {
    return refuse("OTS_BITCOIN_EXPECTED_CHAIN must be main in production");
  }
  const config: OtsBitcoinVerifierConfig = {
    kind: "enabled",
    rpcUrl: url.url,
    rpcEndpointLabel: url.label,
    username: e.OTS_BITCOIN_RPC_USERNAME,
    timeoutMs: e.OTS_BITCOIN_RPC_TIMEOUT_MS,
    policy: {
      expectedChain: e.OTS_BITCOIN_EXPECTED_CHAIN,
      minConfirmations: e.OTS_BITCOIN_MIN_CONFIRMATIONS,
      maxTipAgeSeconds: e.OTS_BITCOIN_MAX_TIP_AGE_SECONDS,
      maxHeaderLag: e.OTS_BITCOIN_MAX_HEADER_LAG,
      minNodeVersion: e.OTS_BITCOIN_MIN_NODE_VERSION,
      minVerificationProgress: OTS_CHAIN_POLICY_DEFAULTS.minVerificationProgress,
    },
    passwordFile: e.OTS_BITCOIN_RPC_PASSWORD_FILE ?? null,
    passwordFromEnvironmentAllowed: !productionLike,
  };
  if (productionLike && typeof env[OTS_BITCOIN_RPC_PASSWORD_SECRET] === "string" && env[OTS_BITCOIN_RPC_PASSWORD_SECRET] !== "") {
    return refuse(
      "OTS_BITCOIN_RPC_PASSWORD must not be an environment variable in production; mount it as OTS_BITCOIN_RPC_PASSWORD_FILE (/run/proovra/bitcoin-rpc/password) or use the secrets authority",
    );
  }
  if (!readRpcPassword(config, env)) {
    return refuse(
      productionLike
        ? "the Bitcoin RPC password is required when OTS_BITCOIN_VERIFY_ENABLED=true (secrets authority or OTS_BITCOIN_RPC_PASSWORD_FILE)"
        : "the Bitcoin RPC password is required when OTS_BITCOIN_VERIFY_ENABLED=true (secrets authority, OTS_BITCOIN_RPC_PASSWORD_FILE or OTS_BITCOIN_RPC_PASSWORD)",
    );
  }
  return config;
}

/** The secret name in the secrets authority bundle. */
export const OTS_BITCOIN_RPC_PASSWORD_SECRET = "OTS_BITCOIN_RPC_PASSWORD";

function readRpcPassword(config: Extract<OtsBitcoinVerifierConfig, { kind: "enabled" }>, env: NodeJS.ProcessEnv): string | null {
  const cached = getCachedSecret(OTS_BITCOIN_RPC_PASSWORD_SECRET);
  if (cached) return cached;
  if (config.passwordFile) {
    try {
      const v = readFileSync(config.passwordFile, "utf8").replace(/[\r\n]+$/, "");
      if (v) return v;
    } catch {
      /* fall through: the file is optional */
    }
  }
  if (!config.passwordFromEnvironmentAllowed) return null;
  const fromEnv = env[OTS_BITCOIN_RPC_PASSWORD_SECRET];
  return typeof fromEnv === "string" && fromEnv.length > 0 ? fromEnv : null;
}

/** The password, for the RPC client only. Read at call time so a rotated secret is used. */
export function rpcPassword(config: Extract<OtsBitcoinVerifierConfig, { kind: "enabled" }>, env: NodeJS.ProcessEnv = process.env): string {
  const v = readRpcPassword(config, env);
  if (!v) throw new Error("BTC_RPC_MISCONFIGURED: the Bitcoin RPC password is not available");
  return v;
}

/** Operator-safe description: never a URL with credentials, never the password. */
export function describeOtsBitcoinVerifierConfig(c: OtsBitcoinVerifierConfig): Record<string, unknown> {
  if (c.kind === "enabled") {
    return {
      enabled: true,
      endpoint: c.rpcEndpointLabel,
      expectedChain: c.policy.expectedChain,
      minConfirmations: c.policy.minConfirmations,
      maxTipAgeSeconds: c.policy.maxTipAgeSeconds,
      maxHeaderLag: c.policy.maxHeaderLag,
      minNodeVersion: c.policy.minNodeVersion,
      timeoutMs: c.timeoutMs,
    };
  }
  return c.kind === "misconfigured" ? { enabled: true, misconfigured: true, reason: c.reason } : { enabled: false };
}
