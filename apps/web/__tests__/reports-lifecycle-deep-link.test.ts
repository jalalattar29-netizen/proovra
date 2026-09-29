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

test("the Reports page applies a deep-linked filter after mount", () => {
  const index = readFileSync(
    new URL("../components/reports-experience/ReportsIndex.tsx", import.meta.url),
    "utf8",
  );
  assert.match(index, /lifecycleFilterFromSearch\(window\.location\.search\)/);
});

// ROLLOUT COMPATIBILITY — the web app deploys on every push to main, before the
// API it talks to. Against the previous API it must behave exactly as before.
test("an API without the truthful buckets keeps the previous cards and is never sent a filter it rejects", async () => {
  const { supportsTruthfulOutputBuckets, TRUTHFUL_BUCKET_FILTERS } = await import(
    "../components/reports-experience/types"
  );
  const previousApiSummary = { reportsReady: 3, reportsNotRequested: 2, packagesNotRequested: 1 };
  assert.equal(supportsTruthfulOutputBuckets(previousApiSummary as never), false);
  assert.equal(supportsTruthfulOutputBuckets({ ...previousApiSummary, reportsNotIssued: 0 } as never), true);
  assert.equal(supportsTruthfulOutputBuckets(null), false);

  // Exactly the filters the previous API's enum did not accept are gated.
  assert.deepEqual(
    [...TRUTHFUL_BUCKET_FILTERS].sort(),
    ["entitlement_unavailable", "package_missing", "report_awaiting_issuance", "report_not_issued"],
  );

  const index = readFileSync(
    new URL("../components/reports-experience/ReportsIndex.tsx", import.meta.url),
    "utf8",
  );
  // The previous cards return when the API lacks the new buckets…
  assert.match(index, /supportsTruthfulOutputBuckets\(summarySection\.data\)\s*\?\s*SUMMARY_METRICS\s*:\s*\[\.\.\.SUMMARY_METRICS, \.\.\.LEGACY_SUMMARY_METRICS\]/);
  // …the new filters are offered only once the API has shown them…
  assert.match(index, /\(truthfulBuckets \|\| !TRUTHFUL_BUCKET_FILTERS\.has\(key\)\)/);
  // …and a deep link to one waits for that proof.
  assert.match(index, /TRUTHFUL_BUCKET_FILTERS\.has\(linked\) && !truthfulBuckets/);
});

test("ET-RPT-01/02 — the blocked and updated-report buckets are gated the same way", async () => {
  const { supportsReportBlockedBuckets, REPORT_BLOCKED_BUCKET_FILTERS } = await import(
    "../components/reports-experience/types"
  );
  assert.equal(supportsReportBlockedBuckets({ reportsReady: 1, reportsNotIssued: 0 } as never), false);
  assert.equal(supportsReportBlockedBuckets({ reportsReady: 1, reportsBlocked: 0, reportsUpdateFailed: 0 } as never), true);
  assert.deepEqual([...REPORT_BLOCKED_BUCKET_FILTERS].sort(), ["report_blocked", "report_update_failed"]);
  const index = readFileSync(
    new URL("../components/reports-experience/ReportsIndex.tsx", import.meta.url),
    "utf8",
  );
  assert.match(index, /\(blockedBuckets \|\| !REPORT_BLOCKED_BUCKET_FILTERS\.has\(key\)\)/);
  assert.match(index, /REPORT_BLOCKED_BUCKET_FILTERS\.has\(linked\) && !blockedBuckets/);
  // The cards render only when the API sends the field.
  assert.match(index, /field: "reportsBlocked", filter: "report_blocked"/);
  assert.match(index, /field: "reportsUpdateFailed", filter: "report_update_failed"/);
  // A blocked report row says so; it is not "not generated yet".
  assert.match(index, /row\.report\.state === "blocked"\s*\?\s*"Report blocked/);
});

test("ET-RPT-05/06 — the summary has a loading phase and a fallback-view notice; outcomes keep their tone", () => {
  const index = readFileSync(
    new URL("../components/reports-experience/ReportsIndex.tsx", import.meta.url),
    "utf8",
  );
  assert.match(index, /!summaryAnswered\s*\?\s*"Loading the summary…"/);
  assert.match(index, /state\.envelope\.workspace\.id === "user-scoped"/);
  assert.match(index, /setRegenNotice\(\{ message: outcome\.message, tone: outcome\.tone \}\)/);
  assert.match(index, /data-tone=\{GENERATION_OUTCOME_STATUS_TONE\[regenNotice\.tone\]\}/);
  assert.doesNotMatch(index, /color: "#167A5B"/);
});
