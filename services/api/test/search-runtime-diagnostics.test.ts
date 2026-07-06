/**
 * Search-runtime-diagnostics — source-contract test.
 *
 * Pins the wiring of the runtime-path fix that prevents the search UI
 * from rendering a misleading "0 results" when the actual cause is API
 * down / empty index / wrong workspace / malformed transport.
 *
 * Test style: vitest source-contract (fs.readFileSync). No DB I/O —
 * the live HTTP probes are documented in the corresponding turn
 * transcript.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const API_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = resolve(API_ROOT, "..", "..");
const WEB_ROOT = resolve(REPO_ROOT, "apps", "web");

const ROUTE_PATH = resolve(API_ROOT, "src/routes/search.routes.ts");
const PAGE_PATH = resolve(WEB_ROOT, "app/(app)/search/page.tsx");

function read(p: string): string {
  return readFileSync(p, "utf8");
}

describe("Search-runtime-diagnostics — backend endpoint", () => {
  const src = read(ROUTE_PATH);

  it("GET /v1/search/diagnostics route is registered", () => {
    expect(src).toMatch(
      /app\.get\(\s*["']\/v1\/search\/diagnostics["']/,
    );
  });

  it("diagnostics route is gated by requireSearchActor (workspace membership)", () => {
    const idx = src.indexOf('"/v1/search/diagnostics"');
    expect(idx).toBeGreaterThan(0);
    const slice = src.slice(idx, idx + 4000);
    expect(slice).toMatch(/requireSearchActor\(req, reply, teamId\)/);
  });

  it("diagnostics returns workspace, evidence.total, index counts, health, runtime", () => {
    const idx = src.indexOf('"/v1/search/diagnostics"');
    // The diagnostics handler grew again when the trash-decision
    // breakdown landed (search-inclusion-audit). Widen the slice
    // so we still capture the response envelope + health
    // classifier + runtime block.
    const slice = src.slice(idx, idx + 16000);
    // The single send() in the handler must include the canonical
    // envelope keys the UI relies on.
    expect(slice).toMatch(/workspace:\s*\{/);
    expect(slice).toMatch(/evidence:\s*\{\s*total:/);
    expect(slice).toMatch(/index:\s*\{/);
    expect(slice).toMatch(/evidenceIndexed:/);
    expect(slice).toMatch(/coverage:/);
    expect(slice).toMatch(/health:/);
    expect(slice).toMatch(/runtime:\s*\{/);
    expect(slice).toMatch(/dbServerIp:/);
    expect(slice).toMatch(/dbName:/);
  });

  it("diagnostics health classifier covers the four runtime conditions", () => {
    const idx = src.indexOf('"/v1/search/diagnostics"');
    // The diagnostics handler grew again when the trash-decision
    // breakdown landed (search-inclusion-audit). Widen the slice
    // so we still capture the response envelope + health
    // classifier + runtime block.
    const slice = src.slice(idx, idx + 16000);
    expect(slice).toMatch(/["']healthy["']/);
    expect(slice).toMatch(/["']partial_index["']/);
    expect(slice).toMatch(/["']empty_index["']/);
    expect(slice).toMatch(/["']empty_workspace["']/);
  });

  it("optional q probe runs the same OR shape as executeSearch", () => {
    const idx = src.indexOf('"/v1/search/diagnostics"');
    // The diagnostics handler grew again when the trash-decision
    // breakdown landed (search-inclusion-audit). Widen the slice
    // so we still capture the response envelope + health
    // classifier + runtime block.
    const slice = src.slice(idx, idx + 16000);
    expect(slice).toMatch(/queryProbe/);
    expect(slice).toMatch(/title:\s*\{\s*contains:/);
    expect(slice).toMatch(/subtitle:\s*\{\s*contains:/);
    expect(slice).toMatch(/summary:\s*\{\s*contains:/);
    expect(slice).toMatch(/searchableText:\s*\{\s*contains:/);
  });
});

describe("Search-runtime-diagnostics — frontend empty-state branches", () => {
  const src = read(PAGE_PATH);

  it("SearchDiagnostics type is declared", () => {
    expect(src).toMatch(/type SearchDiagnostics = \{/);
  });

  it("/v1/search/diagnostics is fetched via URLSearchParams threaded with teamId (+ optional q)", () => {
    // Earlier turns hard-coded the URL as `?teamId=…`. The
    // per-type empty-state work threads a `q` probe into the same
    // endpoint via URLSearchParams, so the fixed-string pin no
    // longer matches. The contract we actually care about is "the
    // diagnostics URL includes teamId" — pin via the params
    // builder.
    expect(src).toMatch(/\/v1\/search\/diagnostics\?\$\{params\.toString\(\)\}/);
    expect(src).toMatch(/params\.set\("q",/);
    expect(src).toMatch(/new URLSearchParams\(\{ teamId \}\)/);
  });

  it("runSearch result handler treats a null / malformed response as error (not 0 results)", () => {
    // The harness must guard the happy-path setResults call so a
    // non-JSON 200 from apiFetch (which returns null) never lands
    // silently in the no-match branch.
    expect(src).toMatch(/Malformed response from search API/);
    expect(src).toMatch(/MALFORMED_RESPONSE/);
  });

  it("empty-state surface renders four distinct kinds: empty-workspace, empty-index, partial-index, no-match", () => {
    expect(src).toMatch(/data-search-empty-state-kind="empty-workspace"/);
    expect(src).toMatch(/data-search-empty-state-kind="empty-index"/);
    expect(src).toMatch(/data-search-empty-state-kind="partial-index"/);
    expect(src).toMatch(/data-search-empty-state-kind="no-match"/);
  });

  it("error branch is preserved (Search is temporarily unavailable)", () => {
    expect(src).toMatch(/Search is temporarily unavailable/);
    expect(src).toMatch(/data-search-empty-state-kind="error"/);
  });

  it("workspace name is rendered in the empty-state copy so wrong-workspace mistakes are visible", () => {
    expect(src).toMatch(/searchHealth\.workspace\.name/);
    // The "No matches in <name>" string is the one place where the
    // workspace name must show up alongside the no-match copy. We
    // pin the literal so an editor doesn't quietly drop it.
    expect(src).toMatch(/No matches[\s\S]*workspace\.name/);
  });

  it("workspace + index-health chip is rendered with data-search-health attribute", () => {
    expect(src).toMatch(/data-search-health=/);
    expect(src).toMatch(/data-search-health-workspace-id=/);
    expect(src).toMatch(/data-search-health-workspace-name=/);
    // search-inclusion-audit replaced `data-…-evidence-total` with
    // the breakdown attributes (evidenceIndexable + per-state
    // counts). Pin via the audience marker + the new attribute
    // names so the contract stays explicit.
    expect(src).toMatch(/data-search-health-audience=/);
    expect(src).toMatch(/data-search-health-evidence-indexable=/);
    expect(src).toMatch(/data-search-health-evidence-indexed=/);
  });

  it("legacy error branch — apiFetch failure lands in the bounded error state via the safe-feedback path (no raw message), and clears rows", () => {
    // PROOVRA Feedback System — the .catch handler must NOT render the raw
    // backend `err.message`. It routes through toSafeUserError(), which maps
    // known codes/status to safe copy and otherwise uses the "Search failed."
    // section fallback. It must still (a) set `error` and (b) clear `rows`
    // so the empty-state surface picks the `error` variant, not no-match.
    expect(src).toMatch(
      /setError\(\s*toSafeUserError\(err, \{ message: "Search failed\." \}\)\.message\s*\)/,
    );
    // The pre-migration raw passthrough must be gone.
    expect(src).not.toMatch(/setError\(err\?\.message \?\? "Search failed\."\)/);
    // The primary catch still clears `rows` so a failure never renders as
    // "0 results".
    expect(src).toMatch(
      /setError\(toSafeUserError\(err, \{ message: "Search failed\." \}\)\.message\);\s*setResults\(\{\s*rows:\s*\[\],/,
    );
  });
});
