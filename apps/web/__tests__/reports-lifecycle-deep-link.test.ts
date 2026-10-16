/**
 * REPORTS — a `?lifecycle=` deep link opens on its filter (2026-09-29).
 *
 * Billing's "records with no report yet" count links to
 * `/reports?lifecycle=report_awaiting_issuance`, so the reader lands on the
 * population the number describes. An unknown value must never reach the
 * server, and the Billing link must name a filter that exists.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  LIFECYCLE_FILTERS,
  lifecycleFilterFromSearch,
} from "../components/reports-experience/types";

test("a known filter is read from the query string", () => {
  assert.equal(
    lifecycleFilterFromSearch("?lifecycle=report_awaiting_issuance"),
    "report_awaiting_issuance",
  );
  assert.equal(lifecycleFilterFromSearch("?q=x&lifecycle=package_missing"), "package_missing");
});

test("an absent or unknown filter is ignored, never forwarded", () => {
  assert.equal(lifecycleFilterFromSearch(""), null);
  assert.equal(lifecycleFilterFromSearch("?lifecycle="), null);
  assert.equal(lifecycleFilterFromSearch("?lifecycle=report_not_requested"), null);
  assert.equal(lifecycleFilterFromSearch("?lifecycle=%27%3B--"), null);
});

test("the Billing review link names a filter the Reports page accepts", () => {
  const projection = readFileSync(
    new URL("../../../services/api/src/services/billing/billing-account-projection.service.ts", import.meta.url),
    "utf8",
  );
  const href = projection.match(/reviewHref:\s*"([^"]+)"/)?.[1] ?? "";
  assert.ok(href.startsWith("/reports?"), href);
  const filter = lifecycleFilterFromSearch(href.slice("/reports".length));
  assert.ok(filter && LIFECYCLE_FILTERS.includes(filter), href);
});

// ---------------------------------------------------------------------------
// 2026-10-16 — the filter model: four canonical dimensions in the URL.
// ---------------------------------------------------------------------------

test("a legacy ?lifecycle= link lands on the dimension that value belongs to, and the URL is rewritten canonically", async () => {
  const { filtersFromSearch, filtersToSearch } = await import("../components/reports-experience/types");
  const billing = filtersFromSearch("?lifecycle=report_awaiting_issuance");
  assert.equal(billing.report, "report_awaiting_issuance");
  assert.equal(billing.status, "all");
  assert.equal(filtersFromSearch("?lifecycle=package_missing").package, "package_missing");
  assert.equal(filtersFromSearch("?lifecycle=entitlement_unavailable").entitlement, "entitlement_unavailable");
  // Written back in the canonical form; the legacy key is cleared.
  const url = filtersToSearch(billing);
  assert.equal(url.report, "report_awaiting_issuance");
  assert.equal(url.lifecycle, null);
  assert.equal(url.status, null);
});

test("invalid or stale params fall back to their default one dimension at a time — never forwarded", async () => {
  const { filtersFromSearch, DEFAULT_FILTERS } = await import("../components/reports-experience/types");
  assert.deepEqual(filtersFromSearch(""), DEFAULT_FILTERS);
  assert.deepEqual(
    filtersFromSearch("?status=FAILED_TERMINAL&report=package_ready&package=retry_budget_exhausted&sort=sideways&lifecycle=%27%3B--"),
    DEFAULT_FILTERS,
  );
  // One bad value does not discard the good ones beside it.
  const mixed = filtersFromSearch("?status=needs_attention&report=bogus&q=Joint&sort=oldest");
  assert.equal(mixed.status, "needs_attention");
  assert.equal(mixed.report, "any");
  assert.equal(mixed.q, "Joint");
  assert.equal(mixed.sort, "oldest");
  // Search is bounded to what the server accepts.
  assert.equal(filtersFromSearch(`?q=${"x".repeat(200)}`).q.length, 80);
});

test("the API query: dimensions compose, defaults are omitted", async () => {
  const { apiQueryFor, DEFAULT_FILTERS } = await import("../components/reports-experience/types");
  const all = { recordStatus: true, truthfulBuckets: true, blockedBuckets: true };
  assert.deepEqual(apiQueryFor(DEFAULT_FILTERS, all), { lifecycle: "all" });
  assert.deepEqual(
    apiQueryFor(
      { ...DEFAULT_FILTERS, status: "needs_attention", report: "report_ready", package: "package_missing", sort: "oldest", q: " Joint " },
      all,
    ),
    { status: "needs_attention", lifecycle: "report_ready,package_missing", sort: "oldest", search: "Joint" },
  );
});

// ROLLOUT COMPATIBILITY — the web app deploys on every push to main, before the
// API it talks to. An older API is never sent a parameter it would reject or
// silently ignore.
test("an API without the record status is sent at most ONE lifecycle it accepts, and no status or sort", async () => {
  const { apiQueryFor, supportsRecordStatus, supportsTruthfulOutputBuckets, supportsReportBlockedBuckets, DEFAULT_FILTERS } =
    await import("../components/reports-experience/types");
  assert.equal(supportsRecordStatus({ reportsReady: 1 } as never), false);
  assert.equal(supportsRecordStatus({ reportsReady: 1, recordsTotal: 3 } as never), true);
  assert.equal(supportsRecordStatus(null), false);
  assert.equal(supportsTruthfulOutputBuckets({ reportsReady: 3 } as never), false);
  assert.equal(supportsReportBlockedBuckets({ reportsReady: 1, reportsBlocked: 0, reportsUpdateFailed: 0 } as never), true);

  const f = { ...DEFAULT_FILTERS, status: "needs_attention" as const, report: "report_failed" as const, package: "package_ready" as const, sort: "oldest" as const };
  assert.deepEqual(apiQueryFor(f, { recordStatus: false, truthfulBuckets: true, blockedBuckets: true }), {
    lifecycle: "report_failed",
  });
  // A bucket the API has not proven is never sent.
  assert.deepEqual(
    apiQueryFor({ ...DEFAULT_FILTERS, report: "report_update_failed" }, { recordStatus: false, truthfulBuckets: true, blockedBuckets: false }),
    { lifecycle: "all" },
  );
  assert.deepEqual(
    apiQueryFor({ ...DEFAULT_FILTERS, package: "package_missing" }, { recordStatus: true, truthfulBuckets: false, blockedBuckets: true }),
    { lifecycle: "all" },
  );
});

test("the page reads its filters from the URL and writes them back", () => {
  const index = readFileSync(
    new URL("../components/reports-experience/ReportsIndex.tsx", import.meta.url),
    "utf8",
  );
  assert.match(index, /filtersFromSearch\(searchParams\?\.toString\(\) \?\? ""\)/);
  assert.match(index, /useUrlFilterSync\("\/reports", filtersToSearch\(filters\)\)/);
  // ET-RPT-05/06 — the summary has a loading phase and a fallback-view notice;
  // outcomes keep their tone.
  assert.match(index, /!summaryAnswered\s*\?\s*copy\.summary\.loading/);
  assert.match(index, /setUserScopedView\(true\);/);
  assert.match(index, /setRegenNotice\(\{ message: outcome\.message, tone: outcome\.tone \}\)/);
  assert.match(index, /data-tone=\{GENERATION_OUTCOME_STATUS_TONE\[regenNotice\.tone\]\}/);
});
