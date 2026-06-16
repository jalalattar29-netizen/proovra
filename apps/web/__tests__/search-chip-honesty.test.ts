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

test("Chip 'Ready' copy fires when reality override is active (cached empty_index → Ready)", () => {
  const src = read(PAGE);
  // When realityOverrides is true the chip body must read
  // "Ready" (a clean Personal/SMB-safe state), NOT "23 records
  // indexed" or "Search index preparing".
  const overrideRegion = src.slice(
    src.indexOf("effectiveHealth === \"healthy\""),
    src.indexOf("effectiveHealth === \"healthy\"") + 600,
  );
  assert.match(overrideRegion, /realityOverrides[\s\S]*?["']Ready["']/);
});

test("Empty-state copy — 'Search index preparing' is structurally unreachable when rows are present", () => {
  const src = read(PAGE);
  // The empty-state branch sits inside
  //   {!results || results.rows.length === 0 ? (...empty...) : (...list...)}
  // so by construction the "empty_index" empty-state copy cannot
  // co-render with rows. Pin the guard so a future refactor
  // cannot accidentally remove it.
  assert.match(
    src,
    /!results \|\| results\.rows\.length === 0 \?/,
  );

  // And the "Search index preparing" copy sits under the
  // empty-state branch, NOT the result-list branch.
  const copyIdx = src.indexOf("Search index is preparing");
  const guardIdx = src.indexOf("!results || results.rows.length === 0");
  assert.ok(copyIdx > 0, "Search index preparing copy missing");
  assert.ok(
    copyIdx > guardIdx,
    "Search index preparing copy must live inside the rows-empty guard",
  );
});

test("Diagnostics-only render path — chip honors searchHealthError fallback ('Search index status unavailable')", () => {
  const src = read(PAGE);
  // When the diagnostics endpoint itself fails (404 on older
  // backends, network error, etc.), the chip must render a
  // bounded "status unavailable" string — NOT a misleading 0/N.
  assert.match(src, /Search index status unavailable/);
  assert.match(src, /searchHealthError/);
});
