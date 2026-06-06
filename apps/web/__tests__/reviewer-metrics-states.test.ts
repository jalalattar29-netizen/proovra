/**
 * PHASE 4 — Reviewer metrics page state regression lock.
 *
 * Phase 0 confirmed `/review/metrics` stuck on "Loading metrics…"
 * forever whenever the backend returned anything other than 200 — the
 * page had no FORBIDDEN, EMPTY, or ERROR branch and the useEffect
 * didn't even catch a thrown ApiError.
 *
 * This test pins the four-state model the page must now render:
 *
 *   - LOADING  — initial fetch in flight.
 *   - FORBIDDEN — 403 NOT_PERMITTED. Bounded explanation, no metric
 *                 grid (no data leakage). Distinct copy.
 *   - EMPTY    — 200 response with all-zero metrics ("no reviewer
 *                activity in the last 7 days for this workspace").
 *   - ERROR    — network error / 500 / parse error. Retry control.
 *
 * Runs under Node's built-in `node:test`. Invoke with e.g.
 *   `node --test --import tsx \
 *      apps/web/__tests__/reviewer-metrics-states.test.ts`
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PAGE_PATH = resolve(
  __dirname,
  "..",
  "app",
  "(app)",
  "review",
  "metrics",
  "page.tsx",
);
const PAGE_SOURCE = readFileSync(PAGE_PATH, "utf8");

// ---------------------------------------------------------------------------
// 1. Four-state model is declared with a tagged union, not a boolean.
// ---------------------------------------------------------------------------

test("page models a tagged FetchState union (not a single metrics-or-null)", () => {
  assert.match(
    PAGE_SOURCE,
    /type\s+FetchState\s*=/,
    "Page must declare a tagged FetchState union — the previous " +
      "single `metrics: T | null` collapsed FORBIDDEN / ERROR / EMPTY " +
      "into the loading branch.",
  );
  for (const kind of ["LOADING", "FORBIDDEN", "ERROR", "READY"]) {
    assert.match(
      PAGE_SOURCE,
      new RegExp(`kind:\\s*"${kind}"`),
      `FetchState union must declare a "${kind}" branch.`,
    );
  }
});

test("page replaces silent useEffect with a try/catch dispatcher", () => {
  assert.match(
    PAGE_SOURCE,
    /try\s*\{[\s\S]{0,400}fetchReviewerMetrics\(/,
    "Metrics fetch must be wrapped in try/catch — Phase 0 finding " +
      "was that a thrown ApiError left state=LOADING permanently.",
  );
  assert.match(
    PAGE_SOURCE,
    /catch\s*\(\s*err\s*\)\s*\{/,
    "Catch branch must accept the error so it can classify FORBIDDEN " +
      "vs ERROR.",
  );
});

test("catch branch dispatches FORBIDDEN for 403 / NOT_PERMITTED / FORBIDDEN code", () => {
  assert.match(
    PAGE_SOURCE,
    /status\s*===\s*403|"NOT_PERMITTED"|"FORBIDDEN"/,
    "Catch must distinguish a permission denial from a generic error.",
  );
  assert.match(
    PAGE_SOURCE,
    /setState\(\{\s*kind:\s*"FORBIDDEN"/,
    "Catch must dispatch the FORBIDDEN state when the error matches " +
      "the permission-denial shape.",
  );
});

test("catch branch dispatches ERROR for non-permission failures", () => {
  assert.match(
    PAGE_SOURCE,
    /setState\(\{\s*kind:\s*"ERROR"/,
    "Catch must dispatch the ERROR state for network errors and 500s.",
  );
});

// ---------------------------------------------------------------------------
// 2. Bounded copy per state.
// ---------------------------------------------------------------------------

test("FORBIDDEN renders the required bounded explanation", () => {
  assert.match(
    PAGE_SOURCE,
    /data-reviewer-metrics-forbidden/,
    "FORBIDDEN branch must carry data-reviewer-metrics-forbidden so " +
      "the UI can render a distinct panel.",
  );
  assert.match(
    PAGE_SOURCE,
    /You do not have permission to view team-wide reviewer\s*\n?\s*metrics/,
    "FORBIDDEN copy must match the brief verbatim.",
  );
  assert.match(
    PAGE_SOURCE,
    /Ask a workspace administrator or supervisor/,
    "FORBIDDEN copy must direct the user to an admin / supervisor.",
  );
});

test("EMPTY renders the required bounded copy", () => {
  assert.match(
    PAGE_SOURCE,
    /data-reviewer-metrics-empty/,
    "EMPTY branch must carry data-reviewer-metrics-empty.",
  );
  assert.match(
    PAGE_SOURCE,
    /No reviewer activity in the last 7 days for this workspace\./,
    "EMPTY copy must match the brief verbatim.",
  );
});

test("ERROR renders bounded copy + retry control", () => {
  assert.match(
    PAGE_SOURCE,
    /data-reviewer-metrics-error/,
    "ERROR branch must carry data-reviewer-metrics-error.",
  );
  assert.match(
    PAGE_SOURCE,
    /Could not load reviewer metrics — please retry\./,
    "ERROR copy must match the brief verbatim.",
  );
  assert.match(
    PAGE_SOURCE,
    /data-reviewer-metrics-retry/,
    "ERROR branch must render a retry control tagged " +
      "data-reviewer-metrics-retry — silent failure is forbidden.",
  );
});

test("LOADING is replaced with the bounded loading state", () => {
  assert.match(
    PAGE_SOURCE,
    /data-reviewer-metrics-loading/,
    "LOADING branch must carry data-reviewer-metrics-loading.",
  );
});

// ---------------------------------------------------------------------------
// 3. FORBIDDEN does not leak any metric data.
// ---------------------------------------------------------------------------

test("FORBIDDEN branch never reads state.metrics", () => {
  // Scope the check to the slice between the FORBIDDEN marker and the
  // next state-marker so we only inspect the FORBIDDEN render path.
  const start = PAGE_SOURCE.indexOf("data-reviewer-metrics-forbidden");
  assert.ok(start > 0, "FORBIDDEN slice must be present");
  // Next sibling block boundary — first `data-reviewer-metrics-` marker
  // after FORBIDDEN.
  const after = PAGE_SOURCE.indexOf(
    "data-reviewer-metrics-",
    start + "data-reviewer-metrics-forbidden".length,
  );
  const slice =
    after > 0
      ? PAGE_SOURCE.slice(start, after)
      : PAGE_SOURCE.slice(start, start + 600);
  assert.ok(
    !slice.includes("state.metrics"),
    "FORBIDDEN render path must not read state.metrics — this is the " +
      "anti-leak guarantee.",
  );
  assert.ok(
    !slice.includes("MetricCard"),
    "FORBIDDEN render path must not render any MetricCard.",
  );
});

// ---------------------------------------------------------------------------
// 4. EMPTY detection — every numeric metric is zero.
// ---------------------------------------------------------------------------

test("isMetricsEmpty checks every numeric field", () => {
  assert.match(
    PAGE_SOURCE,
    /function\s+isMetricsEmpty\(/,
    "Page must declare an isMetricsEmpty helper so the EMPTY branch " +
      "is computed from the response — not from a separate request.",
  );
  for (const field of [
    "throughput7d",
    "approvalRate7dPct",
    "escalationRate7dPct",
    "disagreementRate7dPct",
    "qcFailureRate7dPct",
    "avgReviewDurationMs7d",
  ]) {
    assert.match(
      PAGE_SOURCE,
      new RegExp(`m\\.${field}\\s*===\\s*0`),
      `isMetricsEmpty must require ${field} === 0.`,
    );
  }
});

// ---------------------------------------------------------------------------
// 5. The state outcome for each input is enumerable.
// ---------------------------------------------------------------------------

type FetchState =
  | { kind: "LOADING" }
  | { kind: "FORBIDDEN" }
  | { kind: "ERROR" }
  | { kind: "READY"; metrics: { throughput7d: number; approvalRate7dPct: number; escalationRate7dPct: number; disagreementRate7dPct: number; qcFailureRate7dPct: number; avgReviewDurationMs7d: number } };

function classifyError(input: { status: number; code: string }): FetchState {
  if (
    input.status === 403 ||
    input.code === "NOT_PERMITTED" ||
    input.code === "FORBIDDEN"
  ) {
    return { kind: "FORBIDDEN" };
  }
  return { kind: "ERROR" };
}

test("403 / NOT_PERMITTED / FORBIDDEN all classify as FORBIDDEN", () => {
  assert.equal(classifyError({ status: 403, code: "NOT_PERMITTED" }).kind, "FORBIDDEN");
  assert.equal(classifyError({ status: 403, code: "" }).kind, "FORBIDDEN");
  assert.equal(classifyError({ status: 0, code: "FORBIDDEN" }).kind, "FORBIDDEN");
  assert.equal(classifyError({ status: 0, code: "NOT_PERMITTED" }).kind, "FORBIDDEN");
});

test("500 / 0 (network) / unknown code classify as ERROR", () => {
  assert.equal(classifyError({ status: 500, code: "API_ERROR" }).kind, "ERROR");
  assert.equal(classifyError({ status: 0, code: "NETWORK_ERROR" }).kind, "ERROR");
  assert.equal(classifyError({ status: 502, code: "BAD_GATEWAY" }).kind, "ERROR");
});

function isMetricsEmpty(m: {
  throughput7d: number;
  approvalRate7dPct: number;
  escalationRate7dPct: number;
  disagreementRate7dPct: number;
  qcFailureRate7dPct: number;
  avgReviewDurationMs7d: number;
}): boolean {
  return (
    m.throughput7d === 0 &&
    m.approvalRate7dPct === 0 &&
    m.escalationRate7dPct === 0 &&
    m.disagreementRate7dPct === 0 &&
    m.qcFailureRate7dPct === 0 &&
    m.avgReviewDurationMs7d === 0
  );
}

test("all-zero metrics are classified as EMPTY", () => {
  assert.equal(
    isMetricsEmpty({
      throughput7d: 0,
      approvalRate7dPct: 0,
      escalationRate7dPct: 0,
      disagreementRate7dPct: 0,
      qcFailureRate7dPct: 0,
      avgReviewDurationMs7d: 0,
    }),
    true,
  );
});

test("any non-zero metric is classified as non-EMPTY (READY)", () => {
  assert.equal(
    isMetricsEmpty({
      throughput7d: 1,
      approvalRate7dPct: 0,
      escalationRate7dPct: 0,
      disagreementRate7dPct: 0,
      qcFailureRate7dPct: 0,
      avgReviewDurationMs7d: 0,
    }),
    false,
  );
  assert.equal(
    isMetricsEmpty({
      throughput7d: 0,
      approvalRate7dPct: 0,
      escalationRate7dPct: 0,
      disagreementRate7dPct: 0,
      qcFailureRate7dPct: 0,
      avgReviewDurationMs7d: 42,
    }),
    false,
  );
});

// ---------------------------------------------------------------------------
// 6. Structured warn — silent failure forbidden.
// ---------------------------------------------------------------------------

test("metrics fetch logs a structured warn on failure", () => {
  assert.match(
    PAGE_SOURCE,
    /console\.warn\("\[reviewer-workspace\] metrics fetch failed"/,
    "Catch branch must emit a structured warn so silent failure is " +
      "observable in the browser console + log pipeline.",
  );
});

// ---------------------------------------------------------------------------
// 7. Legacy stuck-on-loading copy is gone.
// ---------------------------------------------------------------------------

test("page no longer ships the bare 'Loading metrics…' fallback", () => {
  // The Phase 0 page rendered `<div>Loading metrics…</div>` for every
  // non-200 because metrics stayed null. The replacement uses
  // data-reviewer-metrics-loading + the bounded "Loading reviewer
  // metrics…" copy, and other states render distinct branches.
  assert.doesNotMatch(
    PAGE_SOURCE,
    /<div>Loading metrics…<\/div>/,
    "Bare 'Loading metrics…' div must be removed — it concealed " +
      "FORBIDDEN / EMPTY / ERROR.",
  );
});
