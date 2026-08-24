/**
 * A PARTIAL TEST DOUBLE IS AN AMBIENT DEPENDENCY. (Part D of the corrective
 * pass, 2026-08-24.)
 *
 * WHAT HAPPENED
 * ---------------------------------------------------------------------------
 * `family-retention-destruction.integration.test.ts` reported 1055/1055 here
 * and 1053/1055 in CI. The two failures were the purge concurrency case and
 * the duplicate-execution case, and neither was a race, a timing problem or a
 * slower machine.
 *
 * The suite replaced the worker's storage module with a double that
 * implemented `deleteObject` and NOTHING ELSE. The canonical destruction
 * executor does not stop at deleting: it VERIFIES, through `objectExists`,
 * which the worker adapter serves from `headObject`. That call fell through
 * the double to the real S3 client, pointed at `http://127.0.0.1:59000` by the
 * test environment. A MinIO container happened to be running on that port on
 * this machine and answered; CI has no listener there, the connection failed,
 * the adapter re-threw (correctly — a failed check is not proof of absence),
 * and the executor treated "could not check" as "still there" (also correctly)
 * and refused to certify.
 *
 * So the production code was right in every branch. The proof was wrong, and
 * it was wrong in the specific way that makes a green local run meaningless:
 * its result depended on which containers happened to be up.
 *
 * WHAT THIS GATE DOES
 * ---------------------------------------------------------------------------
 * It reads the OPERATIONS the destruction storage port actually needs out of
 * the adapter source, then requires every suite that doubles a storage module
 * to cover all of them. A double that covers half the surface is rejected
 * before it can certify a tree that CI will fail — which is the defect class,
 * not the single instance.
 *
 * It deliberately derives the operation list rather than hard-coding it: if
 * the executor grows a third storage call tomorrow, this gate starts failing
 * every partial double on the next run instead of waiting for the next split
 * between local and CI.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const API_TEST_DIR = resolve(REPO_ROOT, "services/api/test");
const WORKER_TEST_DIR = resolve(REPO_ROOT, "services/worker/test");

const PORT_ADAPTERS = [
  "services/worker/src/governance/destruction-storage-port.ts",
  "services/api/src/services/governance/destruction-storage-port.ts",
];

/** Every file under a directory tree, or [] if the tree does not exist. */
function walk(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts") || full.endsWith(".mts")) out.push(full);
  }
  return out;
}

/**
 * The storage functions a destruction adapter imports from its host's storage
 * module. These are the calls a double MUST intercept; anything it misses
 * reaches a socket.
 */
function requiredStorageOperations(): string[] {
  const ops = new Set<string>();
  for (const rel of PORT_ADAPTERS) {
    let source: string;
    try {
      source = readFileSync(resolve(REPO_ROOT, rel), "utf8");
    } catch {
      continue; // Only one host's adapter has to exist for the rule to bind.
    }
    const importBlock = source.match(
      /import\s*\{([\s\S]*?)\}\s*from\s*"[^"]*storage\.js"/,
    );
    if (!importBlock) continue;
    for (const spec of importBlock[1].split(",")) {
      // `deleteObject as s3DeleteObject` → the ORIGINAL name is what a
      // `vi.mock` factory has to provide.
      const original = spec.trim().split(/\s+as\s+/)[0].trim();
      if (original) ops.add(original);
    }
  }
  return [...ops].sort();
}

const REQUIRED = requiredStorageOperations();

/**
 * A suite is IN SCOPE when it can reach the destruction executor.
 *
 * Plenty of suites double a storage module for an upload or a signing path and
 * never destroy anything; demanding they stub a delete they cannot call would
 * be noise, and a gate that cries wolf gets suppressed. These markers are the
 * ways a suite reaches the executor: the executor itself, either host's
 * adapter, the worker purge processor, or the destruction orchestrator.
 *
 * Matched on the IMPORT, not on a mention. Source-contract suites read the
 * executor's text with `readFileSync` and assert on it; naming a file is not
 * loading it, and such a suite cannot reach a socket no matter what its double
 * omits.
 */
const DESTRUCTION_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*)"[^"]*(?:evidence-destruction|destruction-storage-port|destruction-orchestrator|worker\/src\/processor)[^"]*"/;

/** Suites that replace a storage module AND can reach destruction. */
function suitesDoublingStorage(): Array<{ file: string; factory: string }> {
  const out: Array<{ file: string; factory: string }> = [];
  for (const file of [...walk(API_TEST_DIR), ...walk(WORKER_TEST_DIR)]) {
    const source = readFileSync(file, "utf8");
    if (!DESTRUCTION_IMPORT.test(source)) continue;
    const marker = /vi\.mock\(\s*"([^"]*storage\.js)"/g;
    let hit: RegExpExecArray | null;
    while ((hit = marker.exec(source)) !== null) {
      // The factory body runs to the end of the `vi.mock(...)` call. Taking a
      // generous window rather than balancing braces keeps this gate simple;
      // over-reading can only make it more permissive about WHERE the
      // operation is defined, never about whether it is defined at all.
      const factory = source.slice(hit.index, hit.index + 4000);
      out.push({ file: file.slice(REPO_ROOT.length + 1).replace(/\\/g, "/"), factory });
    }
  }
  return out;
}

describe("destruction storage doubles cover the whole port", () => {
  it("the required operations are derived from a real adapter, not assumed", () => {
    expect(
      REQUIRED.length,
      "no destruction storage adapter was readable — this gate would pass vacuously",
    ).toBeGreaterThan(0);
    // The two that mattered: the delete, and the verification behind it.
    expect(REQUIRED).toContain("deleteObject");
    expect(REQUIRED).toContain("headObject");
  });

  it("every suite that doubles storage implements each of them", () => {
    const doubles = suitesDoublingStorage();
    expect(
      doubles.length,
      "no storage doubles were found — the scanner is looking in the wrong place",
    ).toBeGreaterThan(0);

    const partial: string[] = [];
    for (const { file, factory } of doubles) {
      // A factory that intercepts NO destruction operation is doubling storage
      // for some other reason (uploads, signing) and is not this gate's
      // business. The defect is a factory that covers SOME of the port.
      const covered = REQUIRED.filter((op) =>
        new RegExp(`(^|[^\\w])${op}\\s*:`).test(factory),
      );
      if (covered.length === 0) continue;
      const missing = REQUIRED.filter((op) => !covered.includes(op));
      if (missing.length > 0) {
        partial.push(`${file} — doubles ${covered.join(", ")} but not ${missing.join(", ")}`);
      }
    }

    expect(
      partial,
      "a double that covers part of the destruction storage port lets the rest " +
        "reach a real socket, so the suite passes or fails on which containers " +
        "happen to be running",
    ).toEqual([]);
  });
});
