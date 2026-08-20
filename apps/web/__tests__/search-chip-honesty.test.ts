/**
 * Search status-chip honesty — UI regression test.
 *
 * Pins three trust-eroding bugs that the incident user surfaced:
 *
 *   1. After a successful production backfill, the workspace
 *      health chip stayed stuck on
 *      "Search index preparing (0/119)" because the diagnostics
 *      fetch ran once per teamId and was never refetched. Search
 *      returned rows, but the chip still claimed the index was
 *      empty — directly contradicting the result list.
 *
 *   2. The internal semantic-mode chip exposed developer wording
 *      ("Hybrid semantic search fell back to keyword for this
 *      query", "Hybrid semantic search active") to every user —
 *      including Personal/SMB tier users who never opted into
 *      semantic ranking. That copy belongs in the platform-admin
 *      surface only.
 *
 *   3. In the brief window between a search result arriving and
 *      the diagnostics refetch completing, the chip could
 *      momentarily show "Search index preparing (0/N)" alongside
 *      a non-empty result list. Reality (rows returned) must
 *      always win over a stale cached health state.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const PAGE = resolve(
  REPO_ROOT,
  "apps/web/app/(app)/search/page.tsx",
);

function read(p: string): string {
  return readFileSync(p, "utf8");
}

test("Semantic-fallback chip is gated on isPlatformAdmin (hidden for Personal/SMB users)", () => {
  const src = read(PAGE);
  // The render site for SemanticStatusChip must be wrapped in an
  // `isPlatformAdmin ? ... : null` ternary so non-admin users never
  // see the dev-language chip. Pin the exact wrapping pattern.
  const chipIdx = src.indexOf("<SemanticStatusChip");
  assert.ok(chipIdx > 0, "SemanticStatusChip JSX still rendered");

  // The 200 chars preceding the chip must contain the admin gate.
  const window = src.slice(Math.max(0, chipIdx - 200), chipIdx);
  assert.match(
    window,
    /isPlatformAdmin\s*\?/,
    "SemanticStatusChip must be gated on isPlatformAdmin",
  );
});

test("'Hybrid semantic search fell back to keyword' copy only renders inside SemanticStatusChip (gated)", () => {
  const src = read(PAGE);
  // The dev-language string itself stays in the codebase (it's the
  // label inside the chip component) — what matters is that the
  // CHIP's render site is gated. The previous assertion proves the
  // gate. Here we double-pin that the string never appears outside
  // the SemanticStatusChip body.
  const occurrences = [
    ...src.matchAll(/Hybrid semantic search fell back to keyword/g),
  ];
  assert.ok(
    occurrences.length > 0,
    "the literal copy should still exist inside SemanticStatusChip",
  );
  // Every occurrence must live inside the SemanticStatusChip
  // function body (between `function SemanticStatusChip(` and the
  // next top-level `function `).
  const chipFnStart = src.indexOf("function SemanticStatusChip(");
  assert.ok(chipFnStart > 0, "SemanticStatusChip function body present");
  // Heuristic end-of-body: the next `\nfunction ` after the start.
  const afterFn = src.indexOf("\nfunction ", chipFnStart + 1);
  const fnEnd = afterFn === -1 ? src.length : afterFn;
  for (const m of occurrences) {
    assert.ok(
      m.index! >= chipFnStart && m.index! <= fnEnd,
      `dev-language copy escaped the SemanticStatusChip body at index ${m.index}`,
    );
  }
});

test("Diagnostics refetch — reloadHealth(filter.q) is invoked when search rows contradict stale health", () => {
  const src = read(PAGE);
  // The page must define a stable callback that refetches the
  // diagnostics envelope (so the same closure can be invoked from
  // the search-result handler and the workspace-change effect).
  assert.match(
    src,
    /const reloadHealth = useCallback\(/,
    "reloadHealth callback missing",
  );

  // The search-result `.then(...)` handler must call
  // reloadHealth(filter.q) in the branch where rows came back but
  // the cached health says "empty_index" / "empty_workspace". The
  // probe query is now threaded so queryProbe stays fresh for the
  // per-type empty-state copy — pin the (filter.q) call shape.
  const idx = src.indexOf(".then((r)");
  assert.ok(idx > 0, "search-result handler missing");
  // Search the next 3.5 KiB window for the reload trigger.
  const handlerWindow = src.slice(idx, idx + 3500);
  assert.match(handlerWindow, /reloadHealth\(filter\.q\)/);
  assert.match(handlerWindow, /searchHealth\.health === "empty_index"/);
  assert.match(handlerWindow, /searchHealth\.health === "empty_workspace"/);
});

test("Reality-wins chip — rows in result list suppress 'empty_index' / 'empty_workspace' chip copy", () => {
  const src = read(PAGE);
  // The chip render block must compute an `effectiveHealth` value
  // that overrides the cached health when results have rows.
  // Pin: presence of the override variable + the conditions that
  // trigger it.
  assert.match(src, /realityOverrides/);
  assert.match(src, /effectiveHealth/);
  // The override branch maps "empty_*" → "healthy" so the chip
  // never reads "Search index preparing (0/N)" alongside a
  // populated result list.
  const overrideRegion = src.slice(
    src.indexOf("realityOverrides"),
    src.indexOf("realityOverrides") + 1500,
  );
  assert.match(overrideRegion, /empty_index/);
  assert.match(overrideRegion, /empty_workspace/);
  assert.match(overrideRegion, /healthy/);

  // The data-attribute exposes both the cached health and the
  // effective override so end-to-end tests can assert the chip
  // is showing the right state.
  assert.match(src, /data-search-health-cached=/);
  assert.match(src, /data-search-health-reality-overrides=/);
});

test("a stale readiness reading cannot survive a search that returns rows", () => {
  const src = read(PAGE);
  // PREVIOUS GUARANTEE: when `realityOverrides` was true the chip read
  // "Ready" rather than "Search index preparing" — a client-side patch over
  // a cached envelope that disagreed with the rows on screen.
  //
  // REPLACEMENT, stronger: the state is derived by the SERVER on every
  // request from live counts and the index's own last-write timestamp, so
  // there is no cached classification to override. The client's only job is
  // to refetch when reality contradicts what it holds, which it still does.
  assert.match(src, /realityOverride/);
  assert.match(src, /reloadHealth\(filter\.q\)/);
  // …and the support chip reports that server state verbatim rather than
  // composing a second description of it.
  const chipIdx = src.indexOf("data-search-health-audience");
  const chipBody = src.slice(chipIdx, src.indexOf("</AppStatusBadge>", chipIdx));
  assert.match(chipBody, /readiness\.state/);
  assert.match(chipBody, /readiness\.indexedCount/);
  assert.match(chipBody, /readiness\.eligibleCount/);
});

test("readiness copy is never derived from a count comparison in the client", () => {
  const raw = read(PAGE);
  // Measure what RENDERS. A comment explaining why a sentence was deleted is
  // not that sentence coming back.
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  // PREVIOUS GUARANTEE: the 'Search index preparing' copy could not render
  // while rows were present. That protected one symptom of a deeper defect —
  // the client deciding readiness by comparing two numbers, which cannot
  // tell a run that is progressing from one that never started.
  //
  // REPLACEMENT, strictly stronger: the client derives NO readiness state at
  // all. It renders the state the server projected, so the copy cannot
  // contradict the numbers beside it in any combination.
  assert.match(src, /readiness = searchHealth\?\.readiness \?\? null/);
  assert.match(src, /state=\{readiness\.state\}/);
  // No client-side classification survives.
  assert.doesNotMatch(src, /indexedEvidence\s*<\s*evidenceIndexable/);
  // No state is described as 'preparing' anywhere the user or an operator
  // can read it — that word was the promise a stopped index could not keep.
  assert.doesNotMatch(src, /Search index preparing|Search index is preparing/);
  assert.doesNotMatch(src, /Search is being set up/);
});

test("Diagnostics-only render path — chip honors searchHealthError fallback ('Search index status unavailable')", () => {
  const src = read(PAGE);
  // When the diagnostics endpoint itself fails (404 on older
  // backends, network error, etc.), the chip must render a
  // bounded "status unavailable" string — NOT a misleading 0/N.
  assert.match(src, /Search index status unavailable/);
  assert.match(src, /searchHealthError/);
});
