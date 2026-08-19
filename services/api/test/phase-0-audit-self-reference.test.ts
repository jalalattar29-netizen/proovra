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

      const second = runAudit();
      expect(second.out, "second run must pass").toContain("AuditEngineIntegrity = PASS");
      expect(second.code).toBe(0);
      expect(dirtyTracked(), "second run must not dirty the tree").toEqual([]);
      const secondFacts = facts();

      // Identical output apart from the two fields that are metadata about the
      // RUN rather than measurements of the tree.
      const stable = (f: Record<string, unknown>) => {
        const c = JSON.parse(JSON.stringify(f));
        delete c.generatedAtUtc;
        delete c.sourceRevision;
        return c;
      };
      expect(stable(secondFacts)).toEqual(stable(firstFacts));

      // A clean tree really does mean zero changed SOURCE paths — the number
      // that used to read 3 purely because of the engine's own writes.
      expect(firstFacts.phase0.changedPaths).toBe(0);
      expect(firstFacts.phase0.undeclaredSelfGeneratedExclusions).toBe(0);
      expect(firstFacts.phase0.selfGeneratedPathsDeclared).toBe(ENGINE_GENERATED_PATHS.length);
    },
    AUDIT_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// 3. Real source drift is still detected
// ---------------------------------------------------------------------------

describe("phase-0 self-reference — real drift still registers", () => {
  it(
    "a production-source change appears in the change set",
    () => {
      if (dirtyTracked().length > 0) {
        console.warn("SKIPPED: worktree not clean; this mutates and restores a tracked file.");
        return;
      }

      // A real production runtime file, temporarily modified and restored. The
      // engine must notice — that is the coverage the exclusion must not cost.
      const victim = "apps/web/app/(app)/evidence/[id]/page.tsx";
      const abs = path.join(REPO, victim);
      const original = readFileSync(abs, "utf8");
      try {
        writeFileSync(abs, `${original}\n// phase-0 drift probe\n`);
        runAudit();
        const f = facts();
        expect(f.phase0.changedPaths).toBeGreaterThan(0);
        expect(f.phase0.modifiedPaths).toBeGreaterThan(0);
        // And it is attributed to the production runtime, not swallowed.
        expect(f.phase0.productionRuntimeFilesModifiedByPhase0).toBeGreaterThan(0);
      } finally {
        writeFileSync(abs, original);
        // Put the generated artifacts back the way the committed tree has them.
        runAudit();
      }
      expect(dirtyTracked(), "the probe must leave the tree exactly as it found it").toEqual([]);
    },
    AUDIT_TIMEOUT * 2,
  );

  it(
    "a change to the hand-maintained findings-ledger rows still registers",
    () => {
      if (dirtyTracked().length > 0) {
        console.warn("SKIPPED: worktree not clean; this mutates and restores a tracked file.");
        return;
      }

      // `audit-output/current/ledger/rows.json` sits under the same prefix as
      // the engine's own outputs but is a governance SOURCE. A prefix-based
      // exclusion would have hidden this.
      const abs = path.join(REPO, p0(CANONICAL.findingsLedger.rows));
      const original = readFileSync(abs, "utf8");
      try {
        writeFileSync(abs, `${original}\n`);
        runAudit();
        expect(facts().phase0.changedPaths).toBeGreaterThan(0);
      } finally {
        writeFileSync(abs, original);
        runAudit();
      }
      expect(dirtyTracked()).toEqual([]);
    },
    AUDIT_TIMEOUT * 2,
  );
});
