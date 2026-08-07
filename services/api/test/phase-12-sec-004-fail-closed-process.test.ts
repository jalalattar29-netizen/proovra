/**
 * PHASE 12 CORRECTIVE PASS §4 — "REQUIRED FAILS CLOSED" IN A REAL PROCESS.
 *
 * The parity suite proves the loader's decisions in-process and proves, by
 * parsing, that the Worker routes a hydration rejection into `shutdown(1)`.
 * Neither of those is the thing an operator actually depends on, which is:
 * when the declared authority is unavailable, does the PROCESS exit non-zero
 * before it does any work?
 *
 * So this spawns a real Node process that imports the BUILT shared-runtime —
 * the same artifact both services load — installs the recording provider, and
 * runs the real `initSecretsAuthority` in each mode. The exit code is the
 * assertion.
 *
 * Why the recording provider rather than the real AWS bootstrap
 * ---------------------------------------------------------------------------
 * A `required` run against the real provider would reach for AWS: DNS, the
 * credential chain, and (on a machine with no credentials) the link-local
 * metadata endpoint. This pass is required to reach nothing outside the
 * machine, and a proof that violated that to obtain itself would be worth
 * less than no proof. What is substituted is the transport only; the mode
 * resolution, the fail-closed branch, the process's own exit path, and the
 * absence of any network attempt are all real and all observed.
 *
 * The child is verified to have RUN before its output is believed — a spawn
 * that never started would otherwise look exactly like a spawn that produced
 * no forbidden output.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHARED_DIST = pathToFileURL(
  path.resolve(HERE, "../../../packages/shared-runtime/dist/index.js"),
).href;

let workdir: string;

/**
 * The child script. Prints a START marker before anything else so a process
 * that never ran is distinguishable from one that ran and said nothing.
 */
function childScript(mode: string, outcome: "granted" | "denied"): string {
  return `
process.stdout.write("CHILD_START\\n");
// The mode is declared INSIDE the child, not in its spawn environment.
//
// The runner exports NODE_OPTIONS=--import test-bootstrap.mjs, and a child
// inherits it — which is correct and deliberate: the safety bootstrap and the
// outbound guard must apply to anything this suite spawns. The bootstrap
// scrubs every credential-shaped variable by SUBSTRING, and "AWS_SECRETS_MODE"
// contains "SECRET", so a spawn-env declaration was erased before this script
// ran and every case silently resolved to "disabled". Declaring it here, after
// the bootstrap has already run, keeps the guard intact and makes the mode the
// child actually runs under unambiguous.
process.env.AWS_SECRETS_MODE = ${JSON.stringify(mode)};
process.env.AWS_SECRET_NAME = "proovra/test/bundle";
process.env.AWS_SECRETS_REGION = "eu-north-1";
const rt = await import(${JSON.stringify(SHARED_DIST)});
rt.setSecretsProvider(rt.recordingSecretsProvider);
rt.scriptSecretsProvider(
  ${outcome === "granted"
    ? '[{ kind: "secret", payload: { A: "1" } }]'
    : '[{ kind: "error", name: "AccessDeniedException" }]'}
);
const silent = { info: () => {}, warn: () => {} };
try {
  await rt.initSecretsAuthority(silent);
  process.stdout.write("HYDRATED " + JSON.stringify(rt.getSecretsHealth()) + "\\n");
  rt.stopSecretsAuthority();
  process.exit(0);
} catch (err) {
  process.stdout.write("FAILED_CLOSED " + String(err && err.message) + "\\n");
  process.exit(17);
}
`;
}

function runChild(
  mode: string,
  outcome: "granted" | "denied",
): { status: number | null; stdout: string; stderr: string } {
  const file = path.join(workdir, `child-${mode}-${outcome}.mjs`);
  writeFileSync(file, childScript(mode, outcome), "utf8");
  const r = spawnSync(process.execPath, [file], {
    encoding: "utf8",
    // A generous but BOUNDED deadline. `spawnSync` blocks the worker thread,
    // so the runner's own per-test timeout cannot fire while it waits — the
    // bound has to live here.
    timeout: 60_000,
    // The child inherits the runner's environment INCLUDING the safety
    // bootstrap and the outbound guard. The mode is declared inside the script
    // itself — see `childScript` for why.
    env: { ...process.env },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("§4 — a real process fails closed when its required authority is unavailable", () => {
  beforeAll(() => {
    workdir = mkdtempSync(path.join(tmpdir(), "p12-sec004-"));
  });
  afterAll(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it("required + refused → the process exits non-zero and hydrates nothing", () => {
    const r = runChild("required", "denied");
    // The child RAN. Without this, every assertion below would be satisfied by
    // a process that failed to start.
    expect(r.stdout, `child did not start. stderr:\n${r.stderr}`).toContain(
      "CHILD_START",
    );
    expect(r.stdout).toContain("FAILED_CLOSED");
    expect(r.stdout).toContain("aws_secrets.required_authority_unavailable:access_denied");
    expect(
      r.status,
      "a required authority that refused must not leave a serving process",
    ).toBe(17);
    expect(r.stdout).not.toContain("HYDRATED");
  }, 120_000);

  it("required + granted → the process hydrates and exits zero", () => {
    const r = runChild("required", "granted");
    expect(r.stdout, `child did not start. stderr:\n${r.stderr}`).toContain(
      "CHILD_START",
    );
    expect(r.stdout).toContain("HYDRATED");
    expect(r.status).toBe(0);
    const line = r.stdout.split("\n").find((l) => l.startsWith("HYDRATED"))!;
    const health = JSON.parse(line.slice("HYDRATED ".length)) as {
      mode: string;
      awsConnected: boolean;
      degraded: boolean;
      cachedKeyCount: number;
    };
    expect(health.mode).toBe("required");
    expect(health.awsConnected).toBe(true);
    expect(health.degraded).toBe(false);
    expect(health.cachedKeyCount).toBe(1);
  }, 120_000);

  it("optional + refused → the process still boots, and says it is degraded", () => {
    const r = runChild("optional", "denied");
    expect(r.stdout, `child did not start. stderr:\n${r.stderr}`).toContain(
      "CHILD_START",
    );
    expect(r.status, "optional declares env an acceptable fallback").toBe(0);
    const line = r.stdout.split("\n").find((l) => l.startsWith("HYDRATED"))!;
    const health = JSON.parse(line.slice("HYDRATED ".length)) as {
      degraded: boolean;
      refreshSuspended: boolean;
      lastErrorCode: string;
    };
    expect(health.degraded, "…and reports the fallback honestly").toBe(true);
    expect(health.refreshSuspended).toBe(true);
    expect(health.lastErrorCode).toBe("access_denied");
  }, 120_000);

  it("disabled → the process never loads the AWS SDK at all", () => {
    const file = path.join(workdir, "child-disabled-probe.mjs");
    writeFileSync(
      file,
      `
process.stdout.write("CHILD_START\\n");
const rt = await import(${JSON.stringify(SHARED_DIST)});
const silent = { info: () => {}, warn: () => {} };
await rt.initSecretsAuthority(silent);
// The SDK is imported lazily inside the provider. In disabled mode the
// provider is never called, so the module must be absent from the loaded set.
const seen = (process.moduleLoadList ?? []).join(",");
process.stdout.write("SDK_LOADED " + String(seen.includes("secrets-manager")) + "\\n");
process.stdout.write("HEALTH " + JSON.stringify(rt.getSecretsHealth()) + "\\n");
process.exit(0);
`,
      "utf8",
    );
    const r = spawnSync(process.execPath, [file], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env },
    });
    expect(r.stdout, `child did not start. stderr:\n${r.stderr}`).toContain(
      "CHILD_START",
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("SDK_LOADED false");
    const line = r.stdout.split("\n").find((l) => l.startsWith("HEALTH"))!;
    const health = JSON.parse(line.slice("HEALTH ".length)) as {
      mode: string;
      awsEnabled: boolean;
    };
    expect(health.mode).toBe("disabled");
    expect(health.awsEnabled).toBe(false);
  }, 120_000);
});
