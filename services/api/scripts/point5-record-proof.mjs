/**
 * Regenerate the canonical Point-5 proof artifact — explicitly.
 *
 *   pnpm --filter proovra-api run test:integration:record-point5-proof
 *
 * `docs/architecture/point5-family-proven-cases.json` is the tracked record of
 * which family state-machine cases EXECUTED. An ordinary integration run writes
 * its records to `.p7tmp/` and never touches it (test/setup/tracked-tree-guard
 * fails a run that does). This command is the one writer of the tracked file:
 *
 *   1. it finds every suite that records proof (`recordSuiteProof(`),
 *   2. removes the old artifact, so nothing from an earlier run survives —
 *      the gate requires every record to name ONE run,
 *   3. runs exactly those suites in ONE integration run with
 *      `POINT5_PROOF_OUT` naming the tracked path.
 *
 * Run it on a clean tree, then commit the artifact with the change that
 * altered the suites.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT = "../../docs/architecture/point5-family-proven-cases.json";

function suitesRecordingProof(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) found.push(...suitesRecordingProof(abs));
    else if (name.endsWith(".integration.test.ts") && readFileSync(abs, "utf8").includes("recordSuiteProof(")) {
      found.push(relative(API_ROOT, abs).split("\\").join("/"));
    }
  }
  return found.sort();
}

const suites = suitesRecordingProof(join(API_ROOT, "test"));
if (suites.length === 0) {
  console.error("point5-record-proof: no suite records proof — refusing to write an empty artifact");
  process.exit(1);
}
rmSync(resolve(API_ROOT, ARTIFACT), { force: true });
console.log(`point5-record-proof: ${suites.length} suites → ${ARTIFACT}`);
// The child is the integration project itself: vitest.integration.config.ts
// preloads test/setup/test-bootstrap.mjs through NODE_OPTIONS (the Point-7
// safe-environment authority), which scrubs credentials and pins every
// service to loopback before any suite imports the application. Nothing here
// widens that; it only names where the proof is written.
const run = spawnSync("npx", ["vitest", "run", "--config", "vitest.integration.config.ts", ...suites], {
  cwd: API_ROOT,
  stdio: "inherit",
  env: { ...process.env, POINT5_PROOF_OUT: ARTIFACT },
  shell: process.platform === "win32",
});
process.exit(run.status ?? 1);
