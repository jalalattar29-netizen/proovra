/**
 * "NOT YET" IS NOT "NOT AVAILABLE".
 *
 * THE BUG THIS EXISTS TO PREVENT
 * ---------------------------------------------------------------------------
 * Home's ten reads settled behind one `Promise.all`, so the page showed
 * nothing until the slowest returned. An earlier attempt to publish each slice
 * as it landed was correctly REVERTED, because the view model had no way to
 * say a slice had not arrived: `operationsSummary: null` meant "could not be
 * loaded", and Home rendered "Operations status unavailable" for the moment
 * before a perfectly healthy workspace's summary showed up. A false claim, on
 * the surface whose entire job is to be trusted about operational state.
 *
 * Progressive publishing is only safe once the view model can say NOT YET.
 * This suite pins that it can, and that the hook that publishes progressively
 * cannot regress into either failure — the barrier, or the false claim.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { normalizeHomeViewModel } from "../components/home-experience/home-view-model";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = readFileSync(
  resolve(HERE, "..", "components", "home-experience", "useHomeData.ts"),
  "utf8",
);
const SECTIONS = readFileSync(
  resolve(HERE, "..", "components", "home-experience", "HomeDashboardSections.tsx"),
  "utf8",
);

/** The minimum a caller must supply; every slice absent. */
const base = {
  plan: "PRO" as never,
  planFeatures: { intakeIncluded: true, reportsIncluded: true },
  workspaceId: "w1",
  workspaceName: "Test workspace",
  activeSpaceType: "ORGANIZATION" as never,
  commandCenter: null,
  trustSummary: null,
  billing: null,
  reports: null,
  intakeLinks: null,
  inbox: null,
  communications: null,
  orgs: [],
  evidenceList: null,
  recordsByType: null,
  operationsSummary: null,
};

// ===========================================================================
test("an Operations slice still in flight reports LOADING, not unavailable", () => {
  const vm = normalizeHomeViewModel({
    ...base,
    loadingSlices: new Set(["operationsSummary"] as const),
  });

  assert.equal(
    vm.operations.loadState,
    "loading",
    "a slice that has not settled must say so",
  );
  /*
   * `available` stays false because there IS nothing available yet — but it is
   * the load state a surface must read first, and this is the assertion that
   * stops the two being conflated again.
   */
  assert.equal(vm.operations.available, false);
  assert.equal(
    vm.operations.mayAssertAllClear,
    false,
    "an unsettled slice must never license an all-clear either",
  );
});

test("an Operations slice that has settled empty reports FAILED", () => {
  // Nothing pending: the read finished and produced nothing. That IS the
  // claim "this cannot be loaded", and it is now only reachable this way.
  const vm = normalizeHomeViewModel({ ...base, loadingSlices: new Set() });
  assert.equal(vm.operations.loadState, "failed");
  assert.equal(vm.operations.available, false);
});

test("a settled Operations slice reports READY and carries its figures", () => {
  const vm = normalizeHomeViewModel({
    ...base,
    loadingSlices: new Set(),
    operationsSummary: {
      open: 3,
      critical: 1,
      high: 1,
      warning: 1,
      overdue: 2,
      assignedToMe: 0,
      mayAssertAllClear: false,
      clearRefusalReason: "UNRESOLVED_CONDITIONS",
    } as never,
  });
  assert.equal(vm.operations.loadState, "ready");
  assert.equal(vm.operations.available, true);
  assert.equal(vm.operations.open, 3);
  assert.equal(vm.operations.overdue, 2);
});

test("omitting loadingSlices keeps the previous meaning exactly", () => {
  /*
   * The field is additive. A caller that still awaits every read at once
   * produces no `loadingSlices`, and for that caller an absent slice is a
   * failed one — which is what it was before this change and is still true.
   */
  const vm = normalizeHomeViewModel({ ...base });
  assert.equal(vm.operations.loadState, "failed");
  assert.equal(vm.operations.available, false);
});

// ===========================================================================
// The hook: no barrier, no stale publish, no duplicate subscription.
// ===========================================================================

test("the hook publishes each slice as it settles rather than behind a barrier", () => {
  /*
   * The barrier was a single `await Promise.all([...])` whose result was
   * destructured into ten names and normalized once. What replaces it still
   * awaits all ten — a caller has to know when the run is over — but each
   * promise publishes on its own `.then`, so the page renders as answers
   * arrive.
   */
  assert.match(
    HOOK,
    /const publish = \(\) => \{/,
    "there must be one publish path, called per settlement",
  );
  assert.match(
    HOOK,
    /promise\.then\(\(value\) => \{[\s\S]{0,200}pending\.delete\(key\);[\s\S]{0,80}publish\(\);/,
    "each slice must remove itself from `pending` and publish as it lands",
  );
  assert.match(
    HOOK,
    /loadingSlices: new Set\(pending\)/,
    "the view model must be told which slices are still in flight",
  );
  // The old shape — one destructure of ten awaited results — must not return.
  assert.ok(
    !/const \[\s*\n?\s*cc,\s*\n?\s*trustSummary,/.test(HOOK),
    "the ten-way destructured barrier must not come back",
  );
});

test("a superseded run cannot publish over the current workspace", () => {
  /*
   * Switching workspace starts a new run while the previous one still has
   * responses in flight. Without a guard, a slow read from the OLD workspace
   * lands after the switch and overwrites the new one — cross-workspace
   * contamination on a page whose whole job is to be about one workspace.
   */
  assert.match(HOOK, /const runId = \+\+runIdRef\.current;/);
  const guards = HOOK.match(/if \(runId !== runIdRef\.current\) return;/g) ?? [];
  assert.ok(
    guards.length >= 2,
    `both the publish path and each settlement must check the run id (found ${guards.length})`,
  );
});

test("each slice is subscribed exactly once — no duplicate requests", () => {
  /*
   * The promises are created once, above, and handed to `track`. A refactor
   * that awaited a promise in two places would issue no second request, but
   * one that CALLED the fetch helper again would — so the count of fetch call
   * sites is what this pins.
   */
  const tracked = HOOK.match(/track\("/g) ?? [];
  assert.equal(tracked.length, 10, "all ten slices are tracked, once each");
  const fetches = HOOK.match(/apiFetch\(/g) ?? [];
  assert.ok(
    fetches.length <= 10,
    `at most one fetch per slice; found ${fetches.length}`,
  );
});

// ===========================================================================
// The surface.
// ===========================================================================

test("What needs attention renders a loading state instead of a refusal", () => {
  assert.match(
    SECTIONS,
    /const operationsLoading = operations\?\.loadState === "loading";/,
  );
  /*
   * The refusal must be gated on NOT loading. Before this, the same branch
   * served both, which is how a healthy workspace was told its operational
   * status could not be loaded.
   */
  assert.match(
    SECTIONS,
    /const operationsUnavailable =\s*\n?\s*operations != null && !operations\.available && !operationsLoading;/,
  );
  assert.match(SECTIONS, /data-priorities-loading/);
  // And the loading branch must come FIRST, so it can never fall through to
  // either the refusal or the all-clear.
  const loadingAt = SECTIONS.indexOf("top.length === 0 && operationsLoading");
  const refusalAt = SECTIONS.indexOf("top.length === 0 && !mayAssertAllClear");
  const clearAt = SECTIONS.indexOf("data-priorities-clear");
  assert.ok(loadingAt > 0 && loadingAt < refusalAt && loadingAt < clearAt);
});
