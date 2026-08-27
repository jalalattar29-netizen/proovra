/**
 * SEARCH INDEX HEALTH — THE LIFECYCLE MAPPING, AND THE PROXY THAT IS GONE.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SOURCE READ, AND WHY IT WAS UNSAFE
 * ---------------------------------------------------------------------------
 * `search.indexing_failure` shipped with a probe that read the newest terminal
 * `GovernanceReconciliationRun` for the workspace: FAILED or PARTIAL meant the
 * condition was ACTIVE, SUCCEEDED meant it had RECOVERED.
 *
 * A run's exit status is a fact about a JOB. The reconciliation scheduler
 * converges by ENQUEUEING — it finds the drifted rows, schedules a rebuild for
 * each under a deterministic job id, and returns — so the run closes SUCCEEDED
 * within milliseconds while the index is still empty. The authority that owns
 * those runs documents exactly this.
 *
 * The consequence was the worst outcome available to an operations surface: an
 * open indexing condition AUTO-RESOLVING while thousands of rebuilds sat in
 * the queue. A false all-clear, produced by the one source that exists to
 * report the opposite.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE CASES HOLD
 * ---------------------------------------------------------------------------
 * The pure half: that the mapping from the canonical readiness state to an
 * operations activity is total, that the two states which most LOOK like
 * progress are not read as recovery, and that a state this build has never
 * seen cannot become recovery by default. The database-backed half — real
 * coverage, real drift, real tenant isolation — is in
 * `operations-search-health.integration.test.ts`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { lifecycleForSourceId } from "@proovra/shared-runtime";

import {
  classifySearchReadiness,
  type SearchHealthVerdict,
} from "../src/services/search/search-health.service.js";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));

const read = (rel: string) => readFileSync(`${REPO}/${rel}`, "utf8");

/** Source with its commentary removed — every "must not contain" check below. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

const PROBES = "services/api/src/services/operations/operations-source-probes.ts";
const PRODUCER =
  "services/api/src/services/operations/search-index-conditions.service.ts";
const HEALTH = "services/api/src/services/search/search-health.service.ts";

/** Every state the canonical derivation can return. */
const ALL_STATES = [
  "EMPTY_WORKSPACE",
  "INITIALIZING",
  "PARTIAL",
  "READY",
  "STALLED",
  "FAILED",
  "RESTRICTED",
  "UNAVAILABLE",
  "DEGRADED",
] as const;

describe("the readiness → activity mapping", () => {
  it("prints the mapping", () => {
    // eslint-disable-next-line no-console -- the mapping IS the deliverable
    console.table(
      ALL_STATES.map((state) => ({
        state,
        verdict: classifySearchReadiness(state),
      })),
    );
    expect(ALL_STATES.length).toBe(9);
  });

  it("only a PROVEN-COMPLETE index is healthy", () => {
    const healthy = ALL_STATES.filter(
      (s) => classifySearchReadiness(s) === "HEALTHY",
    );
    // READY            everything eligible is present, nothing awaiting removal
    // EMPTY_WORKSPACE  nothing to index and no leftover document
    //
    // DEGRADED IS DELIBERATELY ABSENT. It says the counts converged AND a
    // capability this workspace turned on is not answering. Reading the first
    // half as recovery let an open condition close itself at the moment the
    // platform was reporting that part of Search does not work.
    expect([...healthy].sort()).toEqual(["EMPTY_WORKSPACE", "READY"].sort());
  });

  it("only PROVEN drift or a PROVEN failure is failing", () => {
    const failing = ALL_STATES.filter(
      (s) => classifySearchReadiness(s) === "FAILING",
    );
    // STALLED  work outstanding with nothing assigned to it — no run, a
    //          finished run with drift and no job in flight, or a RUNNING row
    //          past its lease, which is a crashed process
    // FAILED   the durable run row says the reconciliation failed
    expect([...failing].sort()).toEqual(["FAILED", "STALLED"].sort());
  });

  it("THE STATES THAT LOOK LIKE PROGRESS ARE NOT RECOVERY", () => {
    // The subtle ones, and the reason the mapping is three-valued rather than
    // boolean. INITIALIZING and PARTIAL mean the index is INCOMPLETE with a
    // rebuild genuinely in flight. Reading them as recovery is the defect this
    // replaces; reading them as failure would open a condition every time a
    // workspace uploaded a record.
    expect(classifySearchReadiness("INITIALIZING")).toBe("INDETERMINATE");
    expect(classifySearchReadiness("PARTIAL")).toBe("INDETERMINATE");
  });

  it("unreadable and unauthorized truth is indeterminate, never healthy", () => {
    expect(classifySearchReadiness("UNAVAILABLE")).toBe("INDETERMINATE");
    expect(classifySearchReadiness("RESTRICTED")).toBe("INDETERMINATE");
  });

  it("A STATE THIS BUILD HAS NEVER SEEN CANNOT BECOME RECOVERY", () => {
    // The mapping's default arm is the fail-closed one BY CONSTRUCTION, so a
    // state a future release adds is indeterminate without anyone remembering
    // to extend a list. Asserted because the opposite default is precisely how
    // the previous probe came to treat SUCCEEDED as health.
    const future = "SOME_FUTURE_STATE" as unknown as (typeof ALL_STATES)[number];
    const verdict: SearchHealthVerdict = classifySearchReadiness(future);
    expect(verdict).toBe("INDETERMINATE");
  });

  it("the mapping is total over every declared state", () => {
    for (const state of ALL_STATES) {
      expect(
        ["HEALTHY", "FAILING", "INDETERMINATE"],
        state,
      ).toContain(classifySearchReadiness(state));
    }
  });
});

describe("the run's exit status is no longer an authority", () => {
  it("NEITHER THE PROBE NOR THE PRODUCER READS A RECONCILIATION STATUS", () => {
    // The exact shape of the removed defect: a comparison against a
    // `GovernanceReconciliationStatus` deciding whether a condition opens or
    // closes. The readiness derivation still reads the run row — through
    // `latestSearchRun`, with the LEASE evaluated — but neither of these two
    // modules may reach for it directly.
    for (const rel of [PROBES, PRODUCER]) {
      const src = code(rel);
      expect(src, `${rel} reads a run status`).not.toMatch(
        /GovernanceReconciliationStatus/,
      );
      expect(src, `${rel} reads the run kind`).not.toMatch(
        /SEARCH_INDEX["\s,)]/,
      );
      expect(src, `${rel} queries the run table`).not.toMatch(
        /governanceReconciliationRun/,
      );
    }
  });

  it("both go through the ONE health authority", () => {
    expect(code(PROBES)).toContain("search-health.service.js");
    expect(code(PRODUCER)).toContain("resolveWorkspaceSearchReadiness");
    expect(code(PRODUCER)).toContain("classifySearchReadiness");
  });

  it("THE DERIVATION IS CALLED, NOT REIMPLEMENTED", () => {
    // The rule lives in `@proovra/shared`. Exactly one module in the API may
    // call it — the extracted collector — and nothing may re-derive a state
    // from counts of its own.
    const callers = ["services/api/src/routes/search.routes.ts", PROBES, PRODUCER, HEALTH]
      .filter((rel) => code(rel).includes("deriveSearchReadiness"));
    expect(callers).toEqual([HEALTH]);
  });

  it("the health authority reads the facts the brief names", () => {
    const src = read(HEALTH);
    // eligible vs indexed, the removal backlog, the queue probe, the lease.
    expect(src).toContain("eligibleCount");
    expect(src).toContain("indexedEvidenceCount");
    expect(src).toContain("unresolvedRemovals");
    expect(src).toContain("probeSearchScheduledWork");
    expect(src).toContain("latestSearchRun");
  });

  it("EVERY QUERY IN THE HEALTH AUTHORITY IS TENANT-BOUND", () => {
    const src = code(HEALTH);
    // Each raw query names the workspace in its own WHERE clause. A widening
    // arm — `team_id IS NULL`, or an OR that reaches past the tenant — would
    // let one workspace's index decide another workspace's condition.
    const queries = [...src.matchAll(/\$queryRawUnsafe<[\s\S]*?`([\s\S]*?)`/g)].map(
      (m) => m[1],
    );
    expect(queries.length).toBeGreaterThanOrEqual(3);
    for (const sql of queries) {
      expect(sql, `query is not tenant-bound:\n${sql}`).toMatch(
        /team_id = \$1::uuid/,
      );
      expect(sql, `query widens past the tenant:\n${sql}`).not.toMatch(
        /team_id IS NULL/i,
      );
    }
  });
});

describe("the source contract still refuses a manual close", () => {
  it("search.indexing_failure is SOURCE_TRUTH with the health probe", () => {
    const lifecycle = lifecycleForSourceId("search.indexing_failure")!;
    expect(lifecycle.discoveryState).toBe("ACTIVE");
    expect(lifecycle.resolutionAuthority).toBe("SOURCE_TRUTH");
    expect(lifecycle.recoveryPolicy).toBe("PROBE_AUTO_RESOLVE");
    // Named for what it measures. The old key said `index_run_state`, which
    // was an accurate name for the wrong thing.
    expect(lifecycle.activityProbeKey).toBe("search.index_health");
    expect(lifecycle.requiresResolutionNote).toBe(false);
  });
});

// ===========================================================================
// PREMATURE RECOVERY — THE FULL STATE CONTRACT
// ===========================================================================

/**
 * The mapping, stated one state at a time.
 *
 * Written out rather than table-driven on purpose: a table shares one
 * assertion, so a change to the mapping edits the data and every row keeps
 * passing. These are the states an operator's open condition is closed or kept
 * open by, and each one deserves a line a reviewer has to delete on purpose.
 */
describe("no Search condition closes without proven recovery", () => {
  const activityFor = (state: (typeof ALL_STATES)[number]) => {
    switch (classifySearchReadiness(state)) {
      case "HEALTHY":
        return "RECOVERED";
      case "FAILING":
        return "ACTIVE";
      default:
        return "UNKNOWN";
    }
  };

  it("1. READY is the recovered state", () => {
    expect(activityFor("READY")).toBe("RECOVERED");
  });

  it("2. EMPTY_WORKSPACE is recovered — complete, not pending", () => {
    // Nothing eligible and no leftover document is a CONVERGED index, not an
    // unmeasured one.
    expect(activityFor("EMPTY_WORKSPACE")).toBe("RECOVERED");
  });

  it("3. STALLED is active — outstanding work with nothing assigned to it", () => {
    expect(activityFor("STALLED")).toBe("ACTIVE");
  });

  it("4. FAILED is active", () => {
    expect(activityFor("FAILED")).toBe("ACTIVE");
  });

  it("5. DEGRADED IS UNKNOWN, NOT RECOVERY", () => {
    // The correction. Converged deterministic counts beside a configured
    // capability that is not answering is not proof that the condition an
    // operator is looking at is over.
    expect(classifySearchReadiness("DEGRADED")).toBe("INDETERMINATE");
    expect(activityFor("DEGRADED")).toBe("UNKNOWN");
    expect(activityFor("DEGRADED")).not.toBe("RECOVERED");
  });

  it("6. INITIALIZING is unknown", () => {
    expect(activityFor("INITIALIZING")).toBe("UNKNOWN");
  });

  it("7. PARTIAL is unknown — an eligible-versus-indexed gap is not recovery", () => {
    expect(activityFor("PARTIAL")).toBe("UNKNOWN");
  });

  it("8. UNAVAILABLE is unknown — unmeasured is not measured-and-fine", () => {
    // Every count below an unreachable search service would be a zero nobody
    // observed, and a zero gap reads as convergence.
    expect(activityFor("UNAVAILABLE")).toBe("UNKNOWN");
  });

  it("9. RESTRICTED is unknown — that answer is about the ACTOR", () => {
    expect(activityFor("RESTRICTED")).toBe("UNKNOWN");
  });

  it("10. A STATE A FUTURE RELEASE ADDS IS UNKNOWN", () => {
    for (const future of ["CONVERGING", "SUCCEEDED", "OK", ""]) {
      const state = future as unknown as (typeof ALL_STATES)[number];
      const verdict: SearchHealthVerdict = classifySearchReadiness(state);
      expect(verdict, future).toBe("INDETERMINATE");
      expect(activityFor(state), future).toBe("UNKNOWN");
    }
  });

  it("11. RECOVERY IS AN ALLOWLIST, SO THE DEFAULT CANNOT BE RECOVERED", () => {
    // Structural, because the previous defect was exactly a default that
    // meant health: the fail-closed answer has to be the one you get by
    // writing nothing.
    const src = code(HEALTH);
    const body = src.slice(src.indexOf("export function classifySearchReadiness("));
    const fn = body.slice(0, body.indexOf("\n}"));
    expect(fn).toContain('return "INDETERMINATE";');
    // The last statement in the function is the fail-closed one.
    expect(fn.trimEnd().endsWith('return "INDETERMINATE";')).toBe(true);
    // And no arm returns HEALTHY except through the explicit set.
    expect(fn).not.toMatch(/case\s+"DEGRADED"/);
  });

  it("12. AN UNKNOWN OBSERVATION CLOSES NOTHING AND INVENTS NO RESOLVER", () => {
    // The consumer half of the contract. The recovery sweep leaves anything
    // that is not a proven RECOVERED untouched — no status change, no
    // resolvedByUserId, no resolution note, no SLA close.
    const sweep = code(
      "services/api/src/services/operations/source-truth-recovery.service.ts",
    );
    expect(sweep).toContain('if (observation.activity !== "RECOVERED") continue;');
    // …and the skip happens before the writer, not after it.
    expect(sweep.indexOf('!== "RECOVERED") continue;')).toBeLessThan(
      sweep.indexOf("operationalIncident.update("),
    );
  });

  it("13. THE PROBE IS READ-ONLY AND CALLS THE SHARED AUTHORITY", () => {
    // It must not mutate search documents, evidence, queue jobs,
    // reconciliation runs, proofs, custody data or storage objects — and it
    // must not recompute readiness locally.
    const probe = code(PROBES);
    const observe = probe.slice(
      probe.indexOf("async function observeSearchIndexHealth("),
    );
    const body = observe.slice(0, observe.indexOf("\n}\n"));
    expect(body).toContain("resolveWorkspaceSearchReadiness");
    expect(body).toContain("classifySearchReadiness");
    for (const write of [".update(", ".create(", ".delete(", ".upsert(", "$executeRaw"]) {
      expect(body, `the probe calls ${write}`).not.toContain(write);
    }
    // The default arm is UNKNOWN, and there is exactly one RECOVERED arm.
    expect(body).toContain('default:');
    expect((body.match(/activity: "RECOVERED"/g) ?? []).length).toBe(1);
  });

  it("14. THE PROBE IS BOUND TO ONE WORKSPACE", () => {
    // Workspace B never decides Workspace A's state: the only team id the
    // probe can reach is the one on its own context.
    const probe = code(PROBES);
    const observe = probe.slice(
      probe.indexOf("async function observeSearchIndexHealth("),
    );
    const body = observe.slice(0, observe.indexOf("\n}\n"));
    expect(body).toContain("teamId: ctx.teamId");
    expect(body).not.toMatch(/teamId: (null|undefined)/);
  });
});
