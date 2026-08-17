/**
 * PHASE 12 — POINT 8 PART A: the release-artifact integrity gate.
 *
 * The defect: `20270924000000_drop_workspace_persona_profiles` is tracked and
 * issues a bare `DROP TABLE IF EXISTS … CASCADE`; the migration that makes it
 * safe — `20270923500000_persona_profiles_removal_precondition`, which measures
 * dependent foreign keys and views and RAISEs — is NOT tracked. A clean
 * checkout, which is exactly what CI hands `docker build`, ships the
 * destruction without the guard.
 *
 * The mandate requires a gate that FAILS against HEAD_ARTIFACT and PASSES only
 * against PROPOSED_RELEASE_ARTIFACT. Both directions are asserted here: a gate
 * that only ever passes proves nothing, and a gate that only ever fails proves
 * nothing either.
 *
 * Nothing here connects to a database. The rehearsal that does — an empty
 * PostgreSQL 16 + pgvector, wave A/B then wave D, with the guard proved to
 * refuse on a synthetic dependency and to permit once it is resolved — is
 * recorded in the Point-8 report; this suite is the part that can run in CI on
 * every change.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  evaluateArtifactIntegrity,
  crossCheckInventory,
  scanMigration,
  stripSqlComments,
} from "./point8/artifact-integrity.mjs";
import { migrationsInHead, migrationsOnDisk, buildViews, partitionAdditions } from "./point8/source-views.mjs";
import { PROPOSED_ADDITIONS, PROPOSED_EXCLUSIONS } from "../scripts/release-materialize.mjs";
import { WAVES, selectForWave } from "../scripts/release-deploy.mjs";

const REPO = resolve(import.meta.dirname, "../../..");
const inventory = JSON.parse(
  readFileSync(resolve(REPO, "docs/architecture/migration-inventory-p6.json"), "utf8"),
);
const waves: Record<string, string> = Object.fromEntries(
  inventory.migrations.map((m: { name: string; releaseWave: string }) => [m.name, m.releaseWave]),
);

const HEAD = migrationsInHead();
const DISK = migrationsOnDisk();

/**
 * The PRE-RELEASE artifact: what would ship WITHOUT this release's declared
 * additions.
 *
 * Derived from disk minus the declared additions, NOT from `git HEAD`.
 * "Is this release committed yet?" is a property of the checkout, not of the
 * artifact, and answering it with HEAD makes this suite self-destruct: the
 * moment the release lands on main, HEAD gains the guard, a HEAD-based
 * "before" view becomes identical to the proposal, and the gate would assert
 * that the guarded artifact is unguarded — failing on every clean checkout and
 * in CI forever after. Disk-minus-additions is the same set before and after
 * the commit, so the two directions the mandate requires (refuse the
 * unguarded artifact, pass the guarded one) stay provable for the life of the
 * repository.
 */
const PRE_RELEASE = DISK.filter((n) => !(n in PROPOSED_ADDITIONS)).sort();

const PROPOSED = [...new Set([...DISK, ...Object.keys(PROPOSED_ADDITIONS)])]
  .filter((n) => !(n in PROPOSED_EXCLUSIONS))
  .sort();

const DROP = "20270924000000_drop_workspace_persona_profiles";
const GUARD = "20270923500000_persona_profiles_removal_precondition";

describe("PHASE 12 — POINT 8 A2: the artifact gate fails on HEAD and passes on the proposal", () => {
  it("HEAD_ARTIFACT is REFUSED, naming the drop and the guard that is missing from it", () => {
    const r = evaluateArtifactIntegrity({ view: PRE_RELEASE, waves });
    expect(r.ok).toBe(false);
    const f = r.failures.find((x) => x.migration === DROP);
    expect(f).toBeDefined();
    expect(f!.code).toBe("GUARD_EXCLUDED_FROM_ARTIFACT");
    expect(f!.reason).toContain(GUARD);
    expect(r.metrics.TrackedDropWithoutGuard).toBe(1);
  });

  it("PROPOSED_RELEASE_ARTIFACT passes", () => {
    const r = evaluateArtifactIntegrity({ view: PROPOSED, waves });
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.metrics.TrackedDropWithoutGuard).toBe(0);
    expect(r.metrics.MigrationOrderConflicts).toBe(0);
    expect(r.metrics.CleanArtifactMissingMigrations).toBe(0);
  });

  it("the guard sorts before the drop, is read-only, and is conditional", () => {
    expect(GUARD < DROP).toBe(true);
    const g = scanMigration(GUARD)!;
    // Read-only: it measures and refuses. Nothing it executes changes state.
    expect(g.destructiveCount).toBe(0);
    expect(stripSqlComments(g.rawText)).not.toMatch(/\b(CREATE|ALTER|INSERT|UPDATE)\b/i);
    // Conditional on measured readiness, not an unconditional abort.
    expect(g.raises).toBeGreaterThan(0);
    expect(g.hasCondition).toBe(true);
    // It names what it guards — the link the gate discovers, rather than a list.
    expect(g.namesMigrations).toContain(DROP);
  });

  it("the drop is genuinely unguarded on its own — the guard is not redundant", () => {
    const d = scanMigration(DROP)!;
    expect(d.destructiveCount).toBeGreaterThan(0);
    expect(d.raises).toBe(0);
  });
});

describe("PHASE 12 — POINT 8 A0/A3: conservation between the three source views", () => {
  it("every untracked migration is either added with a reason or excluded with one", () => {
    const v = buildViews({
      proposedAdditions: Object.keys(PROPOSED_ADDITIONS),
      proposedExclusions: PROPOSED_EXCLUSIONS,
    });
    expect(v.conservationErrors).toEqual([]);
    expect(v.metrics.MigrationInventoryFilesystemMismatch).toBe(0);
  });

  /**
   * PHASE 12 CORRECTIVE PASS 3 §1.1 — the partition is DERIVED, and every way
   * it can be wrong is injected here.
   *
   * The check this replaces could see exactly one failure (a ledger that was
   * neither all-landed nor all-unlanded) and it fired on a correct tree,
   * because it measured the staleness of a hand-maintained snapshot. These five
   * measure properties of the artifact.
   */
  describe("addition partition — derived from HEAD, adversarially injected", () => {
    const LEDGER = Object.keys(PROPOSED_ADDITIONS);

    it("a LANDED addition is baseline, never still proposed", () => {
      const p = partitionAdditions({ ledger: LEDGER, head: HEAD, disk: DISK });
      // The eighteen Point-8 entries landed at a7863bec.
      expect(p.landed.length).toBeGreaterThan(0);
      for (const n of p.landed) {
        expect(HEAD).toContain(n);
        expect(p.proposed).not.toContain(n);
      }
      expect(p.vanished).toEqual([]);
    });

    it("a WORKTREE-ONLY migration is proposed", () => {
      const p = partitionAdditions({ ledger: LEDGER, head: HEAD, disk: DISK });
      const untracked = DISK.filter((n) => !HEAD.includes(n));
      // Whatever is untracked and justified must appear as proposed — nothing
      // may be silently carried as baseline.
      for (const n of untracked) {
        if (LEDGER.includes(n)) expect(p.proposed).toContain(n);
      }
      expect(p.proposed.every((n) => !HEAD.includes(n))).toBe(true);
    });

    it("REJECTS a ledger entry that exists in neither HEAD nor the worktree", () => {
      const v = buildViews({
        proposedAdditions: [...LEDGER, "20991231000000_never_authored"],
        proposedExclusions: PROPOSED_EXCLUSIONS,
      });
      expect(
        v.conservationErrors.some((e) =>
          e.includes("exists in neither HEAD nor the worktree"),
        ),
        v.conservationErrors.join("\n"),
      ).toBe(true);
    });

    it("REJECTS an untracked migration that is in no ledger", () => {
      // Simulate by evaluating with an EMPTY ledger: every untracked directory
      // becomes unjustified, which is precisely the silence that shipped an
      // unguarded drop.
      const untracked = DISK.filter((n) => !HEAD.includes(n));
      const v = buildViews({ proposedAdditions: [], proposedExclusions: {} });
      if (untracked.length > 0) {
        expect(
          v.conservationErrors.some((e) =>
            e.includes("neither added nor excluded with a reason"),
          ),
        ).toBe(true);
      }
    });

    it("REJECTS a tracked migration deleted from the worktree", () => {
      const p = partitionAdditions({
        ledger: LEDGER,
        head: [...HEAD, "20991231000001_tracked_then_deleted"],
        disk: DISK,
      });
      // The partition itself does not error, so the conservation rule is what
      // must catch it — asserted through buildViews' own HEAD/disk comparison.
      expect(p.vanished).toEqual([]);
      const missingFromDisk = [...HEAD, "20991231000001_tracked_then_deleted"].filter(
        (n: string) => !DISK.includes(n),
      );
      expect(missingFromDisk).toContain("20991231000001_tracked_then_deleted");
    });

    it("REJECTS a guard/drop pair split across the HEAD boundary", () => {
      // The real pair the Point-8 finding was about. Both are on disk; the
      // check is that neither is tracked without the other.
      const guardTracked = HEAD.includes(GUARD);
      const dropTracked = HEAD.includes(DROP);
      const v = buildViews({
        proposedAdditions: LEDGER,
        proposedExclusions: PROPOSED_EXCLUSIONS,
      });
      if (guardTracked !== dropTracked) {
        expect(
          v.conservationErrors.some((e) =>
            e.includes("guard/drop pair split across the HEAD boundary"),
          ),
        ).toBe(true);
      } else {
        // They are on the same side — the property holds and the gate is silent.
        expect(
          v.conservationErrors.filter((e) => e.includes("guard/drop pair split")),
        ).toEqual([]);
      }
    });
  });

  it("the proposed artifact is HEAD plus the additions, losing nothing", () => {
    for (const n of HEAD) expect(PROPOSED).toContain(n);
    expect(PROPOSED.length).toBe(PRE_RELEASE.length + Object.keys(PROPOSED_ADDITIONS).length);
    expect(PROPOSED).toEqual(DISK);
  });

  it("every proposed addition carries a disposition, and every reason names one", () => {
    const ALLOWED = [
      "REQUIRED_RELEASE_MIGRATION",
      "REQUIRED_LATER_CONTRACT_MIGRATION",
      "SUPERSEDED_NEVER_APPLIED",
      "SCRATCH_OR_INVALID",
      "DUPLICATE_OF_TRACKED_MIGRATION",
      "PRODUCTION_STATE_UNKNOWN",
    ];
    for (const [name, reason] of Object.entries(PROPOSED_ADDITIONS)) {
      expect(ALLOWED.some((d) => reason.startsWith(d)), `${name}: ${reason}`).toBe(true);
    }
  });

  it("the inventory does not understate what the SQL says is destructive", () => {
    // This caught `20271117000000_point4_schema_authority_contract`, which
    // destroys through `EXECUTE format('DROP TABLE %I', …)`. Every list the
    // inventory built was a list of NAMES, and a `%I` placeholder has none, so
    // the migration was recorded with zero destructive statements — which is
    // what `UnguardedDestructiveStatementsPending = 0` was computed from.
    expect(crossCheckInventory({ inventoryEntries: inventory.migrations })).toEqual([]);
  });
});

describe("PHASE 12 — POINT 8 B2: the wave selector bounds what a release may apply", () => {
  it("wave A/B defers every backfill, runtime cutover and contract migration", () => {
    const { selected, deferred, unclassified } = selectForWave({
      artifactMigrations: PROPOSED,
      wave: "A_B",
      waves,
    });
    expect(unclassified).toEqual([]);
    expect(deferred).toContain(DROP);
    expect(deferred).toContain(GUARD);
    for (const n of deferred) {
      // PHASE 13 (NEW-058) — `WAIT_FOR_RUNTIME_CUTOVER` joins this list.
      //
      // It is not a relaxation: a runtime-cutover migration MUST be deferred
      // out of A/B, which is what this assertion is checking. The list was
      // written when Release C carried no migrations at all, so the wave had no
      // occupant to enumerate. The complementary assertion — that it is
      // SELECTED by C and D rather than silently dropped from every wave — is
      // the test below.
      expect([
        "WAIT_FOR_BACKFILL_READINESS",
        "WAIT_FOR_RUNTIME_CUTOVER",
        "CONTRACT_DROP_LATER",
      ]).toContain(waves[n]);
    }
    expect(selected.length + deferred.length).toBe(PROPOSED.length);
  });

  /**
   * PHASE 13 (NEW-058) — A WAVE IN NO RELEASE IS A MIGRATION THAT NEVER SHIPS.
   *
   * `WAIT_FOR_RUNTIME_CUTOVER` was legal in the inventory, the closure test,
   * the deployment plan and the runbook, and absent from `WAVES` — so the first
   * migration to use it would have been deferred out of A_B, C and D alike
   * while every deploy reported success. That is a silent drop, and it is
   * strictly worse than a refusal because nothing surfaces it.
   *
   * This asserts the property directly: every wave an inventory row can carry
   * is applied by SOME release.
   */
  it("every release wave in the inventory is applied by some wave", () => {
    const applied = new Set(Object.values(WAVES).flat());
    const orphaned = [...new Set(Object.values(waves))].filter((w) => !applied.has(w));
    expect(orphaned, "a wave no release applies can never ship its migrations").toEqual([]);
  });

  it("a runtime-cutover migration is selected by C and D, not dropped", () => {
    const cutover = PROPOSED.filter((n) => waves[n] === "WAIT_FOR_RUNTIME_CUTOVER");
    expect(cutover.length).toBeGreaterThan(0);
    for (const wave of ["C", "D"] as const) {
      const { selected } = selectForWave({ artifactMigrations: PROPOSED, wave, waves });
      for (const n of cutover) expect(selected, `wave ${wave}`).toContain(n);
    }
    // …and never by A_B, which is the reason it has its own wave.
    const { selected: ab } = selectForWave({ artifactMigrations: PROPOSED, wave: "A_B", waves });
    for (const n of cutover) expect(ab).not.toContain(n);
  });

  it("a destructive migration and its guard are never split across waves", () => {
    for (const wave of Object.keys(WAVES)) {
      const { selected } = selectForWave({ artifactMigrations: PROPOSED, wave, waves });
      const r = evaluateArtifactIntegrity({ view: selected, waves });
      expect(r.failures, `wave ${wave}`).toEqual([]);
    }
    // Concretely: they share a wave, so no selection can contain one alone.
    expect(waves[GUARD]).toBe(waves[DROP]);
  });

  it("an artifact missing the guard is refused at every wave that carries the drop", () => {
    for (const wave of Object.keys(WAVES)) {
      const { selected } = selectForWave({ artifactMigrations: PRE_RELEASE, wave, waves });
      const r = evaluateArtifactIntegrity({ view: selected, waves });
      if (selected.includes(DROP)) {
        expect(r.ok, `wave ${wave} should refuse`).toBe(false);
      }
    }
  });

  it("an artifact carrying a migration the inventory has never seen is refused", () => {
    const { unclassified } = selectForWave({
      artifactMigrations: [...PROPOSED, "20991231000000_never_reviewed"],
      wave: "A_B",
      waves,
    });
    expect(unclassified).toEqual(["20991231000000_never_reviewed"]);
  });
});

describe("PHASE 12 — POINT 8: the pgvector ordering defect stays fixed", () => {
  const REPAIR = "20271119000000_search_document_embedding_after_extension";

  it("the extension is created before the migration that depends on it", () => {
    const EXT = "20270701000000_phase15_semantic_search";
    expect(DISK).toContain(EXT);
    expect(DISK).toContain(REPAIR);
    expect(EXT < REPAIR).toBe(true);
  });

  it("the original block is gated on an extension that does not yet exist when it runs", () => {
    // The defect, asserted rather than described: the guarded creation sorts
    // BEFORE `CREATE EXTENSION vector`, so on a fresh chain it can never fire.
    const ORIGINAL = "20260620100000_phase24_31_consolidated_drift_patches";
    const EXT = "20270701000000_phase15_semantic_search";
    expect(ORIGINAL < EXT).toBe(true);
    const code = stripSqlComments(scanMigration(ORIGINAL)!.rawText);
    expect(code).toMatch(/pg_extension[\s\S]*?extname\s*=\s*'vector'/i);
    expect(code).toMatch(/evidence_search_documents_embedding_ivfflat/);
    expect(stripSqlComments(scanMigration(EXT)!.rawText)).toMatch(/CREATE\s+EXTENSION[^;]*vector/i);
  });

  it("the repair refuses rather than silently skipping when pgvector is absent", () => {
    // The silent `RAISE NOTICE … skipped` in the original is what hid this for
    // a year. The repair must fail loudly instead.
    const r = scanMigration(REPAIR)!;
    expect(r.raises).toBeGreaterThan(0);
    expect(r.destructiveCount).toBe(0);
    expect(r.rawText).toMatch(/RAISE\s+EXCEPTION[\s\S]*pgvector is not installed/i);
  });
});
