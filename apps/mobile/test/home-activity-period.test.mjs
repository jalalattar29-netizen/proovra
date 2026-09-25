/**
 * T-12 / RC-13 — Home's "Activity period" (HomeDashboardSections.tsx:752).
 *
 * The web lets the reader widen the evidence activity chart to a month, three
 * months or six (weekly / fortnightly columns); native was fixed at fourteen
 * daily bars, and said "in the last 14 days" because it counted its bars.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React } from "./support/render.mjs";

const h = React.createElement;
let H;
let UI;

before(async () => {
  H = await loadModule("src/product/home-operations.ts");
  UI = await loadModule("src/ui/home-operations-sections.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});

const NOW = Date.parse("2026-09-24T12:00:00");
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();

test("the four ranges are the web's, verbatim", () => {
  assert.deepEqual(
    H.ACTIVITY_RANGES.map((r) => [r.id, r.label, r.days, r.bucketDays]),
    [
      ["14d", "Last 14 days", 14, 1],
      ["1m", "Last month", 30, 1],
      ["3m", "Last 3 months", 91, 7],
      ["6m", "Last 6 months", 182, 14],
    ],
  );
});

test("wider ranges group their columns and count what the narrow one cannot see", () => {
  const list = [daysAgo(0), daysAgo(3), daysAgo(20), daysAgo(80), daysAgo(170)];
  const by = H.buildActivitySeriesByRange({ createdAtIsoList: list, hasMore: false, nowMs: NOW });
  assert.equal(by["14d"].total, 2);
  assert.equal(by["1m"].total, 3);
  assert.equal(by["3m"].total, 4);
  assert.equal(by["6m"].total, 5);
  assert.equal(by["3m"].buckets.length, 13, "91 days in weekly columns");
  assert.equal(by["6m"].buckets.length, 13, "182 days in fortnightly columns");
  // The newest column holds today.
  assert.ok(by["3m"].buckets.at(-1).count >= 1);
  // A grouped column is named by where it starts: "d Mon", not a weekday.
  assert.match(by["3m"].buckets[0].label, /^\d{1,2} [A-Z][a-z]{2}$/);
  assert.equal(by["6m"].days, 182);
});

test("the default 14-day series is unchanged", () => {
  const s = H.buildActivitySeries({ createdAtIsoList: [daysAgo(0)], hasMore: false, nowMs: NOW });
  assert.equal(s.buckets.length, 14);
  assert.equal(s.bucketDays, 1);
  assert.equal(s.total, 1);
});

test("the rendered chart offers the period and follows it", async () => {
  const by = H.buildActivitySeriesByRange({ createdAtIsoList: [daysAgo(0), daysAgo(100)], hasMore: false, nowMs: NOW });
  const r = await renderComponent(
    h(UI.TestProviders, null, h(UI.HomeAnalyticsSections, { distribution: null, series: by["14d"], seriesByRange: by, activity: [] })),
  );
  assert.ok(r.byLabel("Activity period: Last 14 days").length > 0, "no Activity period control");
  assert.ok(r.hasText("1 record in the last 14 days"));
  assert.ok(r.hasText("Daily totals"));
  await r.press("Activity period: Last 6 months");
  assert.ok(r.hasText("2 records in the last 182 days"));
  assert.ok(r.hasText("Fortnightly totals"));
});
