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

  it("the empty-state surface names a CAUSE, in the canonical readiness vocabulary", () => {
    expect(src).toMatch(/data-search-empty-state-kind="empty-workspace"/);
    // `empty-index` and `partial-index` are gone: both were client guesses at
    // a cause. The server now states which of the three workspace-level states
    // is true, and each has its own branch.
    expect(src).toMatch(/data-search-empty-state-kind="initializing"/);
    expect(src).toMatch(/data-search-empty-state-kind="stalled"/);
    expect(src).not.toMatch(/data-search-empty-state-kind="empty-index"/);
    expect(src).not.toMatch(/data-search-empty-state-kind="partial-index"/);
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

  it("a search failure renders no server text, and never renders as \"0 results\"", () => {
    // REDESIGN/SEARCH — the console no longer keeps a single `error` string
    // that every failure wrote into. A SEARCH failure is classified from the
    // transport's own answer and handed to a state component that owns its own
    // bounded copy, so no server-supplied text reaches the screen at all —
    // strictly stronger than routing it through the safe-feedback mapper.
    //
    // The two invariants this test was written for are unchanged:
    //   (a) the raw backend message is never rendered, and
    //   (b) the catch still clears `rows`, so a failure can never be
    //       presented as a legitimate zero-result answer.
    // The catch classifies, drops the selection that belonged to the result
    // set it is clearing, and clears the rows — in that order.
    expect(src).toMatch(
      /setSearchFailure\(classifySearchFailure\(err\)\);[\s\S]{0,500}?setSelected\(null\);[\s\S]{0,200}?setResults\(\{\s*rows:\s*\[\],/,
    );
    // …and the header does not report a count for a request that never
    // answered, which would read as a legitimate "0 results".
    expect(src).toMatch(/searchFailure\s*\n?\s*\?\s*"No results to show"/);
    // No raw passthrough survives, in the old shape or any new one.
    expect(src).not.toMatch(/setError\(err\?\.message/);
    expect(src).not.toMatch(/setSearchFailure\([^)]*\berr\.message/);
    expect(src).not.toMatch(/searchFailure\.message\}/);
    // A refusal and an outage are separate states; only one may speak about
    // connectivity.
    expect(src).toMatch(/kind: "restricted"/);
    expect(src).toMatch(/kind: "unavailable"/);
  });

  it("action failures still report through the one sanctioned safe-feedback path", () => {
    // Saving, renaming and deleting a view, and loading another page, are
    // ACTIONS. They report where they happened and never become a search
    // state — but their copy must still come from toSafeUserError, which is
    // the only sanctioned error-display path in this app.
    for (const fallback of [
      "Could not load more results.",
      "Could not save view.",
      "Could not delete view.",
      "Could not rename view.",
    ]) {
      expect(src).toContain(fallback);
    }
    // Five now: the four view/page actions plus the index rebuild, which is
    // an operator action and reports through the same sanctioned path.
    const actionSites = [...src.matchAll(/setActionError\(/g)];
    expect(actionSites.length).toBe(5);
    expect(src).toContain("Could not start the index rebuild.");
    // Every one of them wraps the error rather than reading `.message` off it.
    expect(src).not.toMatch(/setActionError\(\s*err[.?]/);
  });
});
