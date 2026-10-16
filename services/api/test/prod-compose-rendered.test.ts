/**
 * docker-compose.prod.yml, FULLY RENDERED — the configuration Docker would
 * actually start, not a regex over the YAML.
 *
 * The defect this pins: the independent Bitcoin verifier's settings sat in
 * proovra-api.environment (under a comment saying the API never receives
 * them) while the worker — the only code that reads them — got none, and the
 * password mount was the worker's. Rendering exposes that class of mistake
 * directly: which service ends up with which variables and mounts.
 *
 * The real compose file is rendered by the Compose CLI in a pinned docker:cli
 * image, with fixture files mounted at the REAL host paths it names
 * (/opt/proovra/app/.env, /opt/proovra/app/secrets/bitcoin-rpc/…), so the
 * absolute paths are exercised exactly as on the server. `docker compose
 * config` needs no daemon access to the services. Docker is REQUIRED: a
 * missing CLI fails this suite rather than skipping it.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../../..");
const COMPOSE_SOURCE = readFileSync(resolve(REPO, "infra/docker/docker-compose.prod.yml"), "utf8");
const COMPOSE_CLI_IMAGE = "docker:27.5.1-cli";
const PASSWORD_CANARY = "RPC-PASSWORD-CANARY-9f3b1c";
const VERIFIER_KEYS = [
  "OTS_BITCOIN_VERIFY_ENABLED",
  "OTS_BITCOIN_RPC_URL",
  "OTS_BITCOIN_RPC_USERNAME",
  "OTS_BITCOIN_RPC_PASSWORD_FILE",
  "OTS_BITCOIN_EXPECTED_CHAIN",
  "OTS_BITCOIN_RPC_TIMEOUT_MS",
  "OTS_BITCOIN_MIN_CONFIRMATIONS",
  "OTS_BITCOIN_MAX_TIP_AGE_SECONDS",
  "OTS_BITCOIN_MAX_HEADER_LAG",
  "OTS_BITCOIN_MIN_NODE_VERSION",
] as const;

const SHARED_ENV = [
  "DATABASE_URL=postgresql://render:render@db.invalid:5432/render",
  "SIGNER_PROVIDER=local-pem",
  "SIGNING_KEY_ID=render",
  "SIGNING_KEY_VERSION=1",
  "PACKAGE_SIGNING_KEY_ID=render-pkg",
  "PACKAGE_SIGNING_KEY_VERSION=1",
  "GHCR_OWNER=render-owner",
  "",
].join("\n");
const VERIFIER_ENV = [
  "OTS_BITCOIN_VERIFY_ENABLED=true",
  "OTS_BITCOIN_RPC_URL=http://bitcoin-node.invalid:8332",
  "OTS_BITCOIN_RPC_USERNAME=render-verifier",
  "OTS_BITCOIN_EXPECTED_CHAIN=main",
  "OTS_BITCOIN_RPC_TIMEOUT_MS=5000",
  "OTS_BITCOIN_MIN_CONFIRMATIONS=6",
  "OTS_BITCOIN_MAX_TIP_AGE_SECONDS=7200",
  "OTS_BITCOIN_MAX_HEADER_LAG=2",
  "OTS_BITCOIN_MIN_NODE_VERSION=270000",
  "",
].join("\n");

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

type Rendered = {
  code: number | null;
  stderr: string;
  raw: string;
  json: {
    services: Record<
      string,
      {
        image: string;
        environment?: Record<string, string>;
        volumes?: Array<{ source: string; target: string; read_only?: boolean }>;
      }
    >;
  } | null;
};

/** Render the real compose file with fixture host files at /opt/proovra/app. */
function render(opts: { sharedEnv?: string; verifierEnv?: string | null; imageTag?: string | null } = {}): Rendered {
  const app = mkdtempSync(join(tmpdir(), "compose-render-"));
  temps.push(app);
  writeFileSync(join(app, ".env"), opts.sharedEnv ?? SHARED_ENV);
  mkdirSync(join(app, "secrets", "bitcoin-rpc"), { recursive: true });
  if (opts.verifierEnv !== null) writeFileSync(join(app, "secrets", "bitcoin-rpc", "verifier.env"), opts.verifierEnv ?? VERIFIER_ENV);
  writeFileSync(join(app, "secrets", "bitcoin-rpc", "password"), PASSWORD_CANARY);
  const tag = opts.imageTag === undefined ? "sha-8c2f0af" : opts.imageTag;
  const r = spawnSync(
    "docker",
    [
      "run", "--rm",
      "-v", `${resolve(REPO, "infra")}:/repo/infra:ro`,
      "-v", `${app}:/opt/proovra/app:ro`,
      ...(tag === null ? [] : ["-e", `IMAGE_TAG=${tag}`]),
      "-w", "/repo/infra/docker",
      COMPOSE_CLI_IMAGE,
      "docker", "compose", "--env-file", "/opt/proovra/app/.env", "-f", "docker-compose.prod.yml", "config", "--format", "json",
    ],
    { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } },
  );
  if (r.error) throw new Error(`docker is required for this suite: ${r.error.message}`);
  let json: Rendered["json"] = null;
  try {
    json = r.status === 0 ? JSON.parse(r.stdout) : null;
  } catch {
    json = null;
  }
  return { code: r.status, stderr: r.stderr ?? "", raw: r.stdout ?? "", json };
}

const envOf = (r: Rendered, svc: string) => r.json!.services[svc]!.environment ?? {};
const volumesOf = (r: Rendered, svc: string) => r.json!.services[svc]!.volumes ?? [];

describe("the rendered production compose: the Bitcoin verifier is worker-only", () => {
  const full = render();

  it("renders", () => {
    expect(full.code, full.stderr).toBe(0);
    expect(full.json).not.toBeNull();
  });

  it("the API has no OTS_BITCOIN_* variable, no password or password-file reference, and no Bitcoin mount", () => {
    const api = envOf(full, "proovra-api");
    expect(Object.keys(api).filter((k) => k.startsWith("OTS_BITCOIN_"))).toEqual([]);
    expect(JSON.stringify(api)).not.toMatch(/bitcoin-rpc|BITCOIN_RPC|password/i);
    expect(volumesOf(full, "proovra-api").filter((v) => /bitcoin/i.test(`${v.source}${v.target}`))).toEqual([]);
  });

  it("the worker has every verifier setting, from its worker-only file, and the password FILE path", () => {
    const worker = envOf(full, "proovra-worker");
    for (const k of VERIFIER_KEYS) expect(worker[k], k).toBeDefined();
    expect(worker.OTS_BITCOIN_VERIFY_ENABLED).toBe("true");
    expect(worker.OTS_BITCOIN_RPC_URL).toBe("http://bitcoin-node.invalid:8332");
    expect(worker.OTS_BITCOIN_RPC_USERNAME).toBe("render-verifier");
    expect(worker.OTS_BITCOIN_EXPECTED_CHAIN).toBe("main");
    expect(worker.OTS_BITCOIN_RPC_PASSWORD_FILE).toBe("/run/proovra/bitcoin-rpc/password");
  });

  it("the password directory is mounted into the worker only, read-only, at the path the setting names", () => {
    const mounts = volumesOf(full, "proovra-worker").filter((v) => v.target === "/run/proovra/bitcoin-rpc");
    expect(mounts).toEqual([
      expect.objectContaining({ source: "/opt/proovra/app/secrets/bitcoin-rpc", target: "/run/proovra/bitcoin-rpc", read_only: true }),
    ]);
  });

  it("no password value and no password variable appear anywhere in the rendered configuration", () => {
    expect(full.raw).not.toContain(PASSWORD_CANARY);
    for (const [name, svc] of Object.entries(full.json!.services)) {
      expect(Object.keys(svc.environment ?? {}), name).not.toContain("OTS_BITCOIN_RPC_PASSWORD");
    }
  });

  it("without the worker-only file the stack still renders, with verification off (no enable flag reaches anyone)", () => {
    const off = render({ verifierEnv: null });
    expect(off.code, off.stderr).toBe(0);
    expect(envOf(off, "proovra-worker").OTS_BITCOIN_VERIFY_ENABLED).toBeUndefined();
    expect(Object.keys(envOf(off, "proovra-api")).filter((k) => k.startsWith("OTS_BITCOIN_"))).toEqual([]);
  });

  it("WHY the guards exist: a verifier key put in the shared .env reaches the API through env_file", () => {
    // Compose injects every key of an env_file; the compose file alone cannot
    // stop this. The deploy script refuses such a shared .env and the API
    // refuses to start in production (deploy-prod-pull.contract.test.ts,
    // api-refuses-bitcoin-verifier-config.test.ts).
    const leaky = render({ sharedEnv: `${SHARED_ENV}OTS_BITCOIN_RPC_USERNAME=leaked-user\n` });
    expect(leaky.code, leaky.stderr).toBe(0);
    expect(envOf(leaky, "proovra-api").OTS_BITCOIN_RPC_USERNAME).toBe("leaked-user");
  });
});

describe("the rendered production compose: immutable images", () => {
  it("both services run exactly ${IMAGE_TAG} — the tag the invocation names", () => {
    const r = render({ imageTag: "sha-8c2f0af" });
    expect(r.json!.services["proovra-api"]!.image).toBe("ghcr.io/render-owner/proovra-api:sha-8c2f0af");
    expect(r.json!.services["proovra-worker"]!.image).toBe("ghcr.io/render-owner/proovra-worker:sha-8c2f0af");
  });

  it("an unset IMAGE_TAG is a hard compose error — there is no default, and no :latest fallback", () => {
    const r = render({ imageTag: null });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/IMAGE_TAG must be an immutable release identity/);
    // Comments explain the removed default; the configuration itself has none.
    const code = COMPOSE_SOURCE.split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    expect(code).not.toMatch(/IMAGE_TAG:-/);
    expect(code.replace(/:latest is not permitted/g, "")).not.toMatch(/:latest\b/);
  });
});
