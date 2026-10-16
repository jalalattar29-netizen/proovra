/**
 * PRODUCTION-IMAGE SMOKE of the independent Bitcoin verifier's wiring.
 *
 *   node scripts/release/smoke-worker-bitcoin-verifier.mjs <worker-image>
 *
 * Starts the REAL worker image exactly as docker-compose.prod.yml wires it —
 * NODE_ENV=production, the non-secret OTS_BITCOIN_* settings in the
 * environment, the RPC password ONLY as a read-only file at
 * /run/proovra/bitcoin-rpc/password owned by the image's own `app` user with
 * mode 0400 — against a Bitcoin Core JSON-RPC stand-in on a private Docker
 * network (scripts/release/fake-bitcoin-core.mjs), and requires:
 *
 *   - a node in Initial Block Download is NOT ready;
 *   - wrong chain, stale tip, header lag and an old node version are NOT ready;
 *   - a wrong password is BTC_RPC_UNAUTHORIZED; an unreadable password file
 *     and a password in the environment are MISCONFIGURED (fail closed);
 *   - only a node passing every check is ready (chain main);
 *   - disabled is disabled;
 *   - the password never appears in the smoke's output or in `docker inspect`.
 *
 * The password is generated here, per run; no real credential is needed or
 * exposed. Every container, volume and network it creates is removed.
 */
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const IMAGE = process.argv[2];
if (!IMAGE) {
  console.error("usage: smoke-worker-bitcoin-verifier.mjs <worker-image>");
  process.exit(2);
}
const FAKE_IMAGE = process.env.SMOKE_FAKE_NODE_IMAGE ?? "node:20.19.0-alpine";
const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = randomUUID().slice(0, 8);
const NET = `btc-smoke-net-${RUN}`;
const PASSWORD = randomBytes(24).toString("hex");
const WRONG_PASSWORD = randomBytes(24).toString("hex");
const RPC_USER = "proovra-verifier";
const created = { containers: [], volumes: [], networks: [] };

function docker(args, { allowFail = false } = {}) {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`docker ${args[0]} ${args[1] ?? ""} failed: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  }
  return { code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

function cleanup() {
  for (const c of created.containers) docker(["rm", "-f", c], { allowFail: true });
  for (const v of created.volumes) docker(["volume", "rm", "-f", v], { allowFail: true });
  for (const n of created.networks) docker(["network", "rm", n], { allowFail: true });
}

/** A secrets volume holding `password`, owned and moded as given. */
function secretsVolume(name, password, owner, mode) {
  const vol = `btc-smoke-${name}-${RUN}`;
  docker(["volume", "create", vol]);
  created.volumes.push(vol);
  docker([
    "run", "--rm", "-v", `${vol}:/s`, "-e", `PW=${password}`, "alpine:3.20",
    "sh", "-c", `printf '%s\\n' "$PW" > /s/password && chown ${owner} /s/password && chmod ${mode} /s/password`,
  ]);
  return vol;
}

function startFakeNode(scenario, secretsVol) {
  const name = `btc-smoke-node-${scenario}-${RUN}`;
  docker([
    "run", "-d", "--name", name, "--network", NET, "--network-alias", "bitcoin-node",
    "-v", `${HERE}:/fake:ro`, "-v", `${secretsVol}:/secrets:ro`,
    "-e", `FAKE_SCENARIO=${scenario}`, "-e", `FAKE_RPC_USER=${RPC_USER}`, "-e", "FAKE_PASSWORD_FILE=/secrets/password",
    FAKE_IMAGE, "node", "/fake/fake-bitcoin-core.mjs",
  ]);
  created.containers.push(name);
  for (let i = 0; i < 60; i += 1) {
    if (docker(["logs", name], { allowFail: true }).out.includes("listening")) return name;
    spawnSync(process.execPath, ["-e", "setTimeout(()=>{},250)"]);
  }
  throw new Error(`fake node ${scenario} never listened`);
}

/** Run the in-image smoke the way compose runs the worker; returns its JSON and the inspected env. */
function runWorker(label, { secretsVol, verifierEnv, extraEnv = [] }) {
  const name = `btc-smoke-worker-${label}-${RUN}`;
  const env = [
    "-e", "NODE_ENV=production",
    "-e", "PDF_ARTIFACT_SIGNATURE_OPT_OUT_ACK=true",
    "-e", "OTS_BITCOIN_RPC_PASSWORD_FILE=/run/proovra/bitcoin-rpc/password",
    ...Object.entries(verifierEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    ...extraEnv,
  ];
  const run = docker(
    ["run", "--name", name, "--network", NET, "-v", `${secretsVol}:/run/proovra/bitcoin-rpc:ro`, ...env, IMAGE,
      "node", "scripts/smoke-bitcoin-verifier.mjs"],
    { allowFail: true },
  );
  created.containers.push(name);
  const inspect = docker(["inspect", "--format", "{{json .Config.Env}}", name]).out;
  const line = run.out.split("\n").reverse().find((l) => l.startsWith("{"));
  if (!line) throw new Error(`${label}: the in-image smoke printed no result (exit ${run.code}): ${run.err.slice(0, 300)}`);
  return { result: JSON.parse(line), stdout: `${run.out}\n${run.err}`, inspectEnv: inspect };
}

const VERIFIER = {
  OTS_BITCOIN_VERIFY_ENABLED: "true",
  OTS_BITCOIN_RPC_URL: "http://bitcoin-node:8332",
  OTS_BITCOIN_RPC_USERNAME: RPC_USER,
  OTS_BITCOIN_EXPECTED_CHAIN: "main",
  OTS_BITCOIN_RPC_TIMEOUT_MS: "3000",
  OTS_BITCOIN_MIN_CONFIRMATIONS: "6",
  OTS_BITCOIN_MAX_TIP_AGE_SECONDS: "7200",
  OTS_BITCOIN_MAX_HEADER_LAG: "2",
  OTS_BITCOIN_MIN_NODE_VERSION: "270000",
};

const failures = [];
function expectCase(label, actual, want) {
  const ok = Object.entries(want).filter(([k]) => !k.startsWith("__")).every(([k, v]) => {
    const got = k.split(".").reduce((o, p) => (o == null ? o : o[p]), actual.result);
    return got === v;
  });
  const leaked =
    actual.stdout.includes(PASSWORD) || actual.stdout.includes(WRONG_PASSWORD) ||
    (want.__inspectMayCarryPassword ? false : actual.inspectEnv.includes(PASSWORD));
  const verdict = ok && !leaked ? "PASS" : "FAIL";
  console.log(`  ${label.padEnd(34)} ${verdict}  ready=${actual.result.readiness.ready} code=${actual.result.readiness.code ?? "-"} config=${actual.result.configKind}`);
  if (!ok) failures.push(`${label}: expected ${JSON.stringify(want)} got ${JSON.stringify(actual.result)}`);
  if (leaked) failures.push(`${label}: the password appeared in output or docker inspect`);
}

try {
  const uid = docker(["run", "--rm", "--entrypoint", "id", IMAGE, "-u"]).out;
  const gid = docker(["run", "--rm", "--entrypoint", "id", IMAGE, "-g"]).out;
  console.log(`worker image ${IMAGE} runs as uid ${uid} gid ${gid}`);
  docker(["network", "create", NET]);
  created.networks.push(NET);
  const goodVol = secretsVolume("good", PASSWORD, `${uid}:${gid}`, "0400");
  const wrongVol = secretsVolume("wrong", WRONG_PASSWORD, `${uid}:${gid}`, "0400");
  const rootOnlyVol = secretsVolume("rootonly", PASSWORD, "0:0", "0400");

  const scenarios = [
    ["ibd", { "readiness.ready": false, "readiness.code": "INITIAL_BLOCK_DOWNLOAD" }],
    ["wrong_chain", { "readiness.ready": false, "readiness.code": "WRONG_CHAIN" }],
    ["stale", { "readiness.ready": false, "readiness.code": "NODE_STALE" }],
    ["header_lag", { "readiness.ready": false, "readiness.code": "HEADER_LAG" }],
    ["old_version", { "readiness.ready": false, "readiness.code": "UNSUPPORTED_NODE_VERSION" }],
    ["ready", { "readiness.ready": true, "readiness.chain": "main", configKind: "enabled",
      passwordFile: "/run/proovra/bitcoin-rpc/password", passwordFromEnvironmentAllowed: false, passwordVariablePresent: false }],
  ];
  for (const [scenario, want] of scenarios) {
    const node = startFakeNode(scenario, goodVol);
    expectCase(`node ${scenario}`, runWorker(scenario, { secretsVol: goodVol, verifierEnv: VERIFIER }), want);
    if (scenario === "ready") {
      // Same ready node, wrong credentials / wiring: never ready.
      expectCase("wrong password file", runWorker("wrongpw", { secretsVol: wrongVol, verifierEnv: VERIFIER }),
        { "readiness.ready": false, "readiness.code": "BTC_RPC_UNAUTHORIZED" });
      expectCase("password file unreadable by app", runWorker("rootonly", { secretsVol: rootOnlyVol, verifierEnv: VERIFIER }),
        { configKind: "misconfigured", "readiness.ready": false, "readiness.code": "BTC_RPC_MISCONFIGURED" });
      expectCase("password in the environment", runWorker("envpw", {
        secretsVol: goodVol, verifierEnv: VERIFIER, extraEnv: ["-e", `OTS_BITCOIN_RPC_PASSWORD=${PASSWORD}`],
      }), { configKind: "misconfigured", "readiness.ready": false, "readiness.code": "BTC_RPC_MISCONFIGURED", __inspectMayCarryPassword: true });
      expectCase("signet expected in production", runWorker("signet", {
        secretsVol: goodVol, verifierEnv: { ...VERIFIER, OTS_BITCOIN_EXPECTED_CHAIN: "signet" },
      }), { configKind: "misconfigured", "readiness.ready": false });
    }
    docker(["rm", "-f", node], { allowFail: true });
  }
  expectCase("node unreachable", runWorker("unreachable", {
    secretsVol: goodVol, verifierEnv: { ...VERIFIER, OTS_BITCOIN_RPC_URL: "http://bitcoin-node-absent:8332" },
  }), { "readiness.ready": false, "readiness.code": "BTC_RPC_UNAVAILABLE" });
  expectCase("verification disabled", runWorker("disabled", {
    secretsVol: goodVol, verifierEnv: { OTS_BITCOIN_VERIFY_ENABLED: "false" },
  }), { configKind: "disabled", "readiness.enabled": false });
} catch (err) {
  failures.push(err instanceof Error ? err.message : String(err));
} finally {
  cleanup();
}

if (failures.length > 0) {
  console.error(`worker Bitcoin verifier smoke FAILED:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("worker Bitcoin verifier smoke: ok");
