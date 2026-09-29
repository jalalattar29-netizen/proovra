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
