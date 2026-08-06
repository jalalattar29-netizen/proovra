/**
 * PHASE 12 — POINT 7: record the browser layer's proof.
 *
 * The specs append the scenarios they proved to `.p7tmp/browser-proven.jsonl`
 * — only after their assertions pass — and the recorder in the API workspace
 * turns them into records in the shared artifact, using the SAME
 * `recordScenarioProof` the server suites use. See that script for why this is
 * a subprocess rather than an import.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export default async function globalTeardown(): Promise<void> {
  const runIdFile = resolve(process.cwd(), ".p7tmp/run-id.txt");
  const runId = existsSync(runIdFile)
    ? readFileSync(runIdFile, "utf8").trim()
    : process.env.POINT7_RUN_ID;
  if (!runId) {
    throw new Error(
      "point7: no run id for the browser matrix — proof cannot be attributed.",
    );
  }
  execFileSync("pnpm", ["exec", "tsx", "test/point7/record-browser-proof.ts"], {
    cwd: resolve(process.cwd(), "services/api"),
    encoding: "utf8",
    shell: true,
    stdio: "inherit",
    env: {
      ...process.env,
      POINT7_RUN_ID: runId,
      // POINT 7 CORRECTIVE PASS — the browser run's own outbound ledger, so
      // the recorded proof carries what the BROWSER reached rather than what
      // the recorder process happened to.
      P7_BROWSER_NETWORK_LEDGER: ".p7tmp/browser-network.jsonl",
    },
  });
}
