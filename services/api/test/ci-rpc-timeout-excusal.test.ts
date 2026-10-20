/**
 * AUD-50 (2026-10-20) — the CI rule that excuses a non-zero vitest exit as the
 * known RPC timeout, run for real (bash) against representative logs.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../scripts/ci/vitest-rpc-timeout-excusal.sh", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "excusal-"));
const decide = (log: string) => {
  const f = join(dir, `${Math.random().toString(36).slice(2)}.log`);
  writeFileSync(f, log);
  const r = spawnSync("bash", [SCRIPT, f], { encoding: "utf8" });
  return { status: r.status, out: r.stdout.trim() };
};
const SUMMARY = " Test Files  724 passed (724)\n      Tests  22999 passed | 1 skipped (23000)\n     Errors  2 errors\n";
const HEADER = "⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯";
const TIMEOUT = 'Error: [vitest-worker]: Timeout calling "onTaskUpdate"';

describe("AUD-50 vitest RPC-timeout excusal", () => {
  it("excuses only the known timeout, one block per caught error", () => {
    const log = `⎯⎯⎯ Unhandled Errors ⎯⎯⎯\nVitest caught 2 unhandled errors during the test run.\n${HEADER}\n${TIMEOUT}\n ❯ x\n${HEADER}\n${TIMEOUT}\n${SUMMARY}`;
    expect(decide(log).status).toBe(0);
  });

  it("does NOT excuse a real error hidden behind a repeated signature line (the old rule did)", () => {
    const log = `Vitest caught 2 unhandled errors during the test run.\n${HEADER}\n${TIMEOUT}\n   note: retried Timeout calling "onTaskUpdate"\n⎯⎯⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯⎯⎯⎯\nTypeError: Cannot read properties of undefined (reading 'id')\n${SUMMARY}`;
    const d = decide(log);
    expect(d.status).toBe(1);
    // The rule it replaced, for the record: line counting excused this log.
    const known = (log.match(/Timeout calling "onTaskUpdate"/g) ?? []).length;
    expect(known).toBeGreaterThanOrEqual(2);
  });

  it("does not excuse a failed test, or a run with no summary", () => {
    expect(decide(`Vitest caught 1 unhandled errors during the test run.\n${HEADER}\n${TIMEOUT}\n Test Files  1 failed | 723 passed (724)\n`).status).toBe(1);
    expect(decide(`Vitest caught 1 unhandled errors during the test run.\n${HEADER}\n${TIMEOUT}\n`).status).toBe(1);
  });

  it("does not excuse more blocks than vitest says it caught", () => {
    const log = `Vitest caught 1 unhandled errors during the test run.\n${HEADER}\n${TIMEOUT}\n${HEADER}\n${TIMEOUT}\n${SUMMARY}`;
    expect(decide(log).status).toBe(1);
  });

  it("ci.yml decides through this script, not an inline line count", () => {
    const ci = readFileSync(fileURLToPath(new URL("../../../.github/workflows/ci.yml", import.meta.url)), "utf8");
    expect(ci).toContain("scripts/ci/vitest-rpc-timeout-excusal.sh /tmp/api-test.log");
    expect(ci).not.toMatch(/\[ "\$known" -ge "\$caught" \]/);
  });
});
