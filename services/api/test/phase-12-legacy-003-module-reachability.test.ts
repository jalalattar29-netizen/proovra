/**
 * PHASE 12 — LEGACY-003 CLOSURE GATE + module-level STAYS-REMOVED contract.
 *
 * `verify-module-reachability.mjs` is the reachability AUTHORITY: it computes
 * the import graph from the real runtime entrypoints on every run and refuses
 * any unreachable production module that does not carry exactly one
 * disposition. Until this file existed, nothing executed it — no test, no
 * package script, no CI step. A gate nobody runs is a gate that is already
 * failing silently, so LEGACY-003 could not honestly be called closed while
 * its own verifier was unregistered.
 *
 * This suite calls `evaluate()` IN-PROCESS rather than spawning the script.
 * That is deliberate: a `spawnSync` of a Node CLI blocks the vitest worker, so
 * a per-test timeout cannot fire and a hung child looks like a hung suite.
 * Importing the exported evaluator has no such failure mode and asserts the
 * same computation the CLI prints.
 *
 * What this pins, beyond the three counters:
 *
 *   - The twenty-four modules removed to close LEGACY-003 STAY removed. Their
 *     rows are merged into `DISPOSITIONS`, so the verifier's "REMOVED but still
 *     on disk" refusal is the anti-resurrection contract — restoring any one of
 *     them without retiring its row fails here. This is the module-level
 *     analogue of `phase-12-dead-routes-removed.test.ts`, which pins routes.
 *
 *   - A REMOVED row for a file that is genuinely gone cannot be quietly
 *     downgraded into a weaker disposition, because every row is still
 *     structurally validated (valid class, substantive reason, CONNECTED needs
 *     execution proof, REGISTERED_CLI needs entrypoint/owner/input).
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DISPOSITIONS,
  EXECUTED_REMOVALS,
  evaluate,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore -- the verifier is an .mjs authority with no type declaration.
} from "../scripts/verify-module-reachability.mjs";

const REPO = resolve(__dirname, "../../..");

type Disposition = {
  disposition: "CONNECTED" | "REMOVED" | "REGISTERED_CLI" | "QUARANTINED";
  reason: string;
  proof?: string;
  entrypoint?: string;
  owner?: string;
  input?: string;
  removalCondition?: string;
};

const dispositions = DISPOSITIONS as Record<string, Disposition>;
const executedRemovals = EXECUTED_REMOVALS as Record<string, Disposition>;

describe("LEGACY-003 — module reachability closure", () => {
  // 120s, not the 5s default: `evaluate()` walks and classifies every module
  // in the service. Same reasoning as the duplicate-route guard — the work is
  // repository-scale, so the timeout has to be too, or CI reports a walk that
  // was merely slow as a reachability failure.
  it("the verifier passes with zero unclassified, zero connected-but-unreachable, zero removed-but-present", () => {
    const result = evaluate() as {
      ok: boolean;
      problems: string[];
      counters: Record<string, number>;
    };

    // Report the actual problems on failure rather than a bare boolean.
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);

    expect(result.counters.UnclassifiedUnreachableProductionModules).toBe(0);
    expect(result.counters.ConnectedButUnreachable).toBe(0);
    expect(result.counters.RemovedButPresent).toBe(0);
  }, 120_000);

  it("every unreachable production module carries exactly one disposition", () => {
    const result = evaluate() as { unreachable: string[] };
    for (const file of result.unreachable) {
      expect(
        dispositions[file],
        `${file} is unreachable with no disposition`,
      ).toBeDefined();
    }
  });

  it("the LEGACY-003 removals stay removed", () => {
    const removed = Object.keys(executedRemovals);

    // The closure removed twenty-four modules. If this number moves, the
    // manifest changed and the ledger row must change with it.
    expect(removed).toHaveLength(24);

    for (const file of removed) {
      expect(executedRemovals[file].disposition).toBe("REMOVED");
      expect(
        existsSync(resolve(REPO, file)),
        `${file} is dispositioned REMOVED but is back on disk`,
      ).toBe(false);
    }
  });

  it("every disposition states a substantive reason", () => {
    for (const [file, d] of Object.entries(dispositions)) {
      expect(d.reason.length, `${file} has no substantive reason`).toBeGreaterThan(40);
    }
  });
});
