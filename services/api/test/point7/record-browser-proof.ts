/**
 * PHASE 12 — POINT 7: write the BROWSER-layer records into the proof artifact.
 *
 * Playwright runs each spec in its own worker process, so the in-memory
 * proven-set the vitest suites use cannot survive to the end of a run. The
 * specs therefore append `{suite, id}` lines to `.p7tmp/browser-proven.jsonl`
 * — AFTER their assertions pass — and this script, run once from the Playwright
 * global teardown, turns them into the same kind of record the server suites
 * write: bound to the suite's bytes, to the run, and to the production
 * authority digest.
 *
 * It runs as a SUBPROCESS in this workspace rather than as an import from the
 * teardown, because `services/api` is an ESM package and the repository root
 * is not; Playwright's transform straddles that boundary and emits CommonJS
 * into an ESM scope. A subprocess with the right working directory is the
 * honest fix — the alternative was a second copy of the manifest on the
 * browser side, which is the duplicate registry this whole point exists to
 * prevent.
 *
 * It cannot forge credit: it records only ids the specs actually appended, and
 * only ids the manifest requires at the BROWSER layer. The gate independently
 * re-hashes each suite file and re-derives the build id.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { recordScenarioProof, repoRoot } from "./scenario-manifest.js";

const root = repoRoot();
const source = resolve(root, ".p7tmp/browser-proven.jsonl");

if (!existsSync(source)) {
  throw new Error(
    `point7: no browser proof at ${source}. The matrix produced nothing, so ` +
      "there is no BROWSER credit to record.",
  );
}

const bySuite = new Map<string, string[]>();
for (const line of readFileSync(source, "utf8").split(/\r?\n/)) {
  if (!line.trim()) continue;
  const { suite, id } = JSON.parse(line) as { suite: string; id: string };
  const list = bySuite.get(suite) ?? [];
  list.push(id);
  bySuite.set(suite, list);
}

/**
 * The BROWSER run's outbound ledger.
 *
 * Read from the file the Playwright route guard appended to, not from this
 * recorder process — the recorder made no browser requests, so its own socket
 * ledger would say nothing about what the pages reached.
 */
function browserIsolation() {
  const denied = new Set<string>();
  const allowed = new Set<string>();
  const rel = process.env.P7_BROWSER_NETWORK_LEDGER;
  const path = rel ? resolve(root, rel) : "";
  if (path && existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { outcome: string; host: string };
        (entry.outcome === "DENIED" ? denied : allowed).add(entry.host);
      } catch {
        /* a malformed line is not evidence either way */
      }
    }
  }
  return {
    deniedHosts: [...denied].sort(),
    allowedHosts: [...allowed].sort(),
    // The browser holds no server-side observability transport; the API it
    // drove is the process that does, and that process's ledger is recorded
    // by the SERVER suites.
    observabilityErrorEvents: 0,
    recordingTransport: true,
  };
}

const isolation = browserIsolation();

for (const [suite, scenarios] of bySuite) {
  recordScenarioProof({
    suiteRelPath: suite,
    layer: "BROWSER",
    scenarios,
    root,
    isolation,
  });
  // eslint-disable-next-line no-console
  console.log(
    `point7: recorded ${new Set(scenarios).size} browser scenarios for ${suite}`,
  );
}
