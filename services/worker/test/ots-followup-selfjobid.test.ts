/**
 * ET-OTS-01 guard — every follow-up the OTS upgrade processor schedules runs
 * INSIDE the job whose id is the canonical `ots-upgrade-<evidenceId>`, so every
 * `enqueueOtsUpgradeJob` call in the processor must pass `selfJobId`. Without it
 * the enqueue collapses onto the running job and the proof is never upgraded
 * (reproduced on real BullMQ in services/api/test/ots-upgrade-ladder.integration.test.ts).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const src = readFileSync(
  fileURLToPath(new URL("../src/ots-upgrade.processor.ts", import.meta.url)),
  "utf8",
);

describe("ET-OTS-01 — OTS follow-ups never collapse onto the running job", () => {
  it("every enqueueOtsUpgradeJob call in the processor passes selfJobId", () => {
    const calls = [...src.matchAll(/enqueueOtsUpgradeJob\(\s*evidenceId,\s*\{([\s\S]*?)\}\s*\)/g)].map((m) => m[1]!);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const body of calls) expect(body).toMatch(/selfJobId:\s*job\.id/);
  });
});
