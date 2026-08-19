/**
 * PHASE 0 — THE AUDIT ENGINE MUST NOT MEASURE ITS OWN WRITES.
 *
 * WHAT WAS WRONG
 * ---------------------------------------------------------------------------
 * The Phase-0 change set is derived from `git status --porcelain`, and the
 * engine writes five artifacts into the very tree that status describes. So on
 * a CLEAN `HEAD` — a tree with no source change at all — the engine recorded
 * changed paths, and worse, the number depended on WHEN during the run git was
 * sampled:
 *
 *   `regenerate()`  samples once for the inventory   -> 0 artifacts written
 *                   and again inside `buildFacts()`  -> 3 artifacts written
 *   `engineCheck()` samples after the run            -> 5 artifacts written
 *
 * A quantity that is a function of write order rather than of the tree can
 * never equal what the next run recomputes. The staleness gate therefore fired
 * on EVERY run at EVERY commit, which is how a freshness gate stops carrying
 * information: the only way to see it pass was to leave the worktree dirty, and
 * committing the regenerated artifacts made them stale again immediately.
 *
 * THE FIX, AND WHAT THIS FILE HOLDS IT TO
 * ---------------------------------------------------------------------------
 * The engine's own declared outputs are held out of the change-set derivation,
 * so the change set is a pure function of the SOURCE tree. That is only safe if
 * three things stay true, and each has a test below:
 *
 *   1. the hold-out is EXACTLY the registry's declaration — not a prefix, not
 *      whatever happened to be dirty;
 *   2. real source drift is still detected, including under `audit-output/`
 *      where the hand-maintained findings-ledger rows live;
 *   3. two consecutive runs agree, and neither leaves a tracked file changed.
 *
 * (3) is the property that actually makes a commit pushable, and it is asserted
 * against the committed `HEAD` by running the supported command — never by
 * hand-editing an artifact or pinning an expected hash.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CANONICAL, DIAGNOSTICS, ENGINE_GENERATED_PATHS, REPO } from "../scripts/audit/engine/registry.mjs";
import { evaluateGovernance } from "../scripts/audit/engine/governance.mjs";

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 28 }) as string;

const AUDIT_TIMEOUT = 240_000;

function runAudit(): { code: number; out: string } {
  try {
    const out = execFileSync("node", ["services/api/scripts/audit/index.mjs"], {
      cwd: REPO,
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** Tracked files that differ from HEAD, as `git status --short` would show. */
const dirtyTracked = () =>
  git("status", "--porcelain")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("??"))
    .map((l) => l.slice(3).trim())
    .sort();

/** Registry paths are declared loosely (`string | string[]`); these are scalars. */
const p0 = (v: string | string[]): string => (Array.isArray(v) ? v[0] : v);

const facts = () =>
  JSON.parse(readFileSync(path.join(REPO, p0(CANONICAL.currentFacts.path)), "utf8"));

/** Byte state of every artifact a run writes. */
const artifactBytes = () =>
  ENGINE_GENERATED_PATHS.map(
    (rel) => rel + ":" + readFileSync(path.join(REPO, rel), "utf8"),
  );

/**
 * The run banner's working-tree change set. It is printed rather than
 * persisted because it describes the checkout, not the committed source.
 */
function bannerChangeSet(out: string): Record<string, number | string | null> {
  const start = out.indexOf("=== RUN ===");
  const json = out.slice(out.indexOf("{", start));
  let depth = 0;
  let end = -1;
  for (let i = 0; i < json.length; i += 1) {
    if (json[i] === "{") depth += 1;
    else if (json[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  return JSON.parse(json.slice(0, end)).workingTreeChangeSet;
}

// ---------------------------------------------------------------------------
// 1. The hold-out is exactly the declaration
// ---------------------------------------------------------------------------

describe("phase-0 self-reference — the hold-out is bounded by the registry", () => {
  it("declares exactly the five artifacts a run writes", () => {
    expect([...ENGINE_GENERATED_PATHS].sort()).toEqual(
      [
        CANONICAL.governanceInventory.path,
        CANONICAL.currentFacts.path,
        CANONICAL.currentReport.path,
        CANONICAL.capabilityMap.path,
        ...DIAGNOSTICS.map((d: { path: string }) => d.path),
      ].sort(),
    );
  });

  it("does NOT hold out the whole audit-output prefix", () => {
    // The findings-ledger rows live under `audit-output/` and are a
    // hand-maintained governance SOURCE. Excluding them by prefix would have
    // been the easy fix and would have blinded the gate to real drift.
    const held = new Set<string>(ENGINE_GENERATED_PATHS);
    expect(held.has(p0(CANONICAL.findingsLedger.rows))).toBe(false);
    for (const derived of CANONICAL.findingsLedger.derived) expect(held.has(derived)).toBe(false);
  });

  it("holds out nothing outside audit-output/ and the generated capability map", () => {
    for (const p of ENGINE_GENERATED_PATHS) {
      expect(
        p.startsWith("audit-output/") || p === CANONICAL.capabilityMap.path,
        `${p} is not an engine output location`,
      ).toBe(true);
    }
    // No production, test, config or migration path may be in the set.
    for (const p of ENGINE_GENERATED_PATHS) {
      expect(/^(apps|packages|services\/(api|worker)\/src|prisma)\//.test(p)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Determinism, and a clean tree, from the committed HEAD
// ---------------------------------------------------------------------------

describe("phase-0 self-reference — deterministic and non-dirtying", () => {
  it(
    "passes twice from a clean tree and changes no tracked file",
    () => {
      // The property under test only exists on a clean tree; on a dirty one the
      // engine is SUPPOSED to report the difference. Skipping rather than
      // asserting keeps this honest during local development instead of turning
      // the developer's own edits into a failure of the audit engine.
      const before = dirtyTracked();
      if (before.length > 0) {
        console.warn(
          `SKIPPED: worktree carries ${before.length} tracked change(s); this asserts the committed HEAD.`,
        );
        return;
      }

      const first = runAudit();
      expect(first.out, "first run must pass").toContain("AuditEngineIntegrity = PASS");
      expect(first.code).toBe(0);
      expect(dirtyTracked(), "first run must not dirty the tree").toEqual([]);
      const firstFacts = facts();
      const afterFirst = artifactBytes();

      const second = runAudit();
      expect(second.out, "second run must pass").toContain("AuditEngineIntegrity = PASS");
      expect(second.code).toBe(0);
      expect(dirtyTracked(), "second run must not dirty the tree").toEqual([]);
      const secondFacts = facts();
      const afterSecond = artifactBytes();

      // Byte-identical, with nothing normalised away. Nothing volatile is
      // persisted any more, so the comparison can be exact.
      expect(secondFacts).toEqual(firstFacts);
      expect(afterSecond).toEqual(afterFirst);

      // A clean tree really does mean zero changed SOURCE paths — the number
      // that used to read 3 purely because of the engine's own writes.
      expect(bannerChangeSet(first.out).changedPaths).toBe(0);
      expect(bannerChangeSet(second.out).changedPaths).toBe(0);

      // The persisted facts carry only source-derived Phase-0 values.
      expect(firstFacts.phase0.undeclaredSelfGeneratedExclusions).toBe(0);
      expect(firstFacts.phase0.selfGeneratedPathsDeclared).toBe(ENGINE_GENERATED_PATHS.length);
      // Run metadata may not be persisted at all: an artifact recording the
      // revision it belongs to can never be current.
      expect(firstFacts.sourceRevision).toBeUndefined();
      expect(firstFacts.generatedAtUtc).toBeUndefined();
      expect(firstFacts.phase0.changedPaths).toBeUndefined();
    },
    AUDIT_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// 3. Real source drift is still detected
// ---------------------------------------------------------------------------

/**
 * These drive `evaluateGovernance()` directly rather than the whole command.
 *
 * The change set is what the exclusion touches, and it is derived in that one
 * function; spawning the full audit to observe it cost ~80s per assertion and
 * pushed this file past four minutes, which timed out vitest's worker RPC and
 * failed the suite while every test in it passed. It also WRITES the artifacts,
 * so each probe needed a second run purely to put them back. Evaluating
 * governance reads the tree and writes nothing, so the probe restores the file
 * and the tree is exactly as it was found.
 */
describe("phase-0 self-reference — real drift still registers", () => {
  /** The live change set, derived the same way every Phase-0 gate derives it. */
  function liveChangeSet() {
    const g = evaluateGovernance() as unknown as {
      phase0ExitCounters: Record<string, number>;
      phase0ChangeSet: { entries: Array<{ path: string; status: string; class: string | null }> };
    };
    return { counters: g.phase0ExitCounters, entries: g.phase0ChangeSet.entries };
  }

  /** Mutates a tracked file, evaluates, and always restores it. */
  function withDrift<T>(rel: string, mutate: (original: string) => string, assert: (cs: ReturnType<typeof liveChangeSet>) => T) {
    if (dirtyTracked().length > 0) {
      console.warn("SKIPPED: worktree not clean; this mutates and restores a tracked file.");
      return;
    }
    const abs = path.join(REPO, rel);
    const original = readFileSync(abs, "utf8");
    try {
      writeFileSync(abs, mutate(original));
      assert(liveChangeSet());
    } finally {
      writeFileSync(abs, original);
    }
    expect(dirtyTracked(), "the probe must leave the tree exactly as it found it").toEqual([]);
  }

  it("a production-source change appears in the change set", () => {
    // A real production runtime file. The engine must notice — that is the
    // coverage the self-generated hold-out must not cost.
    const victim = "apps/web/app/(app)/evidence/[id]/page.tsx";
    withDrift(
      victim,
      (original) => `${original}\n// phase-0 drift probe\n`,
      ({ counters, entries }) => {
        expect(counters.phase0ChangedPaths).toBeGreaterThan(0);
        expect(counters.phase0ModifiedPaths).toBeGreaterThan(0);
        const entry = entries.find((e) => e.path === victim);
        expect(entry, `${victim} must be in the change set`).toBeDefined();
        expect(entry!.status).toBe("MODIFIED");
        expect(entry!.class).toBe("PRODUCTION_RUNTIME");
        // ATTRIBUTION must NOT fire. The safety counter asks a narrower
        // question than "did this file change": it counts production runtime
        // files whose ADDED lines carry a Phase-0 authorship marker. An
        // unrelated edit is detected and classified but is not Phase-0's work,
        // and a counter that rose here would report a false positive.
        expect(counters.productionRuntimeFilesModifiedByPhase0).toBe(0);
      },
    );
  });

  it("a change to the hand-maintained findings-ledger rows still registers", () => {
    // `audit-output/current/ledger/rows.json` sits under the SAME prefix as the
    // engine's own outputs but is a governance SOURCE. A prefix-based exclusion
    // would have hidden this, which is why the hold-out is a path list.
    const rows = p0(CANONICAL.findingsLedger.rows);
    withDrift(
      rows,
      (original) => `${original}\n`,
      ({ counters, entries }) => {
        expect(counters.phase0ChangedPaths).toBeGreaterThan(0);
        expect(entries.some((e) => e.path === rows)).toBe(true);
      },
    );
  });

  it("the engine's own outputs are the ONLY paths the change set omits", () => {
    if (dirtyTracked().length > 0) {
      console.warn("SKIPPED: worktree not clean.");
      return;
    }
    // Dirty one declared output and one ordinary file at the same time. The
    // first must vanish from the change set; the second must not.
    const held = p0(CANONICAL.currentReport.path);
    const ordinary = "apps/web/app/(app)/evidence/[id]/page.tsx";
    const heldAbs = path.join(REPO, held);
    const ordAbs = path.join(REPO, ordinary);
    const heldOriginal = readFileSync(heldAbs, "utf8");
    const ordOriginal = readFileSync(ordAbs, "utf8");
    try {
      writeFileSync(heldAbs, `${heldOriginal}\n<!-- probe -->\n`);
      writeFileSync(ordAbs, `${ordOriginal}\n// probe\n`);
      const { entries } = liveChangeSet();
      expect(entries.some((e) => e.path === held), `${held} must be held out`).toBe(false);
      expect(entries.some((e) => e.path === ordinary), `${ordinary} must be measured`).toBe(true);
    } finally {
      writeFileSync(heldAbs, heldOriginal);
      writeFileSync(ordAbs, ordOriginal);
    }
    expect(dirtyTracked()).toEqual([]);
  });
});
