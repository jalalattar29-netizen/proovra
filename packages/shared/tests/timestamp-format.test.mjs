import test from "node:test";
import assert from "node:assert/strict";
import {
  formatTimestampForReportUtc,
  formatTimestampForDashboard,
  formatTimestampForVerify,
  formatTimestampForPackage,
  formatTimestampParts,
  formatDeviceTime,
  TIMESTAMP_NOT_RECORDED,
} from "../dist/index.js";

const ISO = "2026-07-03T00:48:42.193Z";

test("report UTC: '03 Jul 2026, 00:48:42 UTC' regardless of viewer", () => {
  assert.equal(formatTimestampForReportUtc(ISO), "03 Jul 2026, 00:48:42 UTC");
  // No GMT+X, no AM/PM, no raw ISO.
  const out = formatTimestampForReportUtc(ISO);
  assert.ok(!/GMT/.test(out));
  assert.ok(!/[AP]M/.test(out));
  assert.ok(!out.includes("T00:48"));
});

test("report UTC: null/invalid → fallback", () => {
  assert.equal(formatTimestampForReportUtc(null), TIMESTAMP_NOT_RECORDED);
  assert.equal(formatTimestampForReportUtc("nonsense"), TIMESTAMP_NOT_RECORDED);
  assert.equal(formatTimestampForReportUtc(null, { fallback: "N/A" }), "N/A");
});

test("dashboard: viewer timezone with IANA name, no GMT+2", () => {
  const berlin = formatTimestampForDashboard(ISO, "Europe/Berlin");
  assert.equal(berlin, "03 Jul 2026, 02:48:42 Europe/Berlin");
  assert.ok(!/GMT/.test(berlin));
  assert.ok(!/[AP]M/.test(berlin));
  // A different zone shifts the wall clock but stays IANA-named.
  assert.equal(
    formatTimestampForDashboard(ISO, "America/New_York"),
    "02 Jul 2026, 20:48:42 America/New_York",
  );
});

test("dashboard: blank/absent timezone → UTC", () => {
  assert.equal(formatTimestampForDashboard(ISO), "03 Jul 2026, 00:48:42 UTC");
  assert.equal(formatTimestampForDashboard(ISO, ""), "03 Jul 2026, 00:48:42 UTC");
  assert.equal(formatTimestampForDashboard(null, "Europe/Berlin"), TIMESTAMP_NOT_RECORDED);
});

test("verify: viewer tz when known, UTC fallback otherwise", () => {
  assert.equal(
    formatTimestampForVerify(ISO, "Europe/Berlin"),
    "03 Jul 2026, 02:48:42 Europe/Berlin",
  );
  assert.equal(formatTimestampForVerify(ISO, null), "03 Jul 2026, 00:48:42 UTC");
  assert.equal(formatTimestampForVerify(ISO, ""), "03 Jul 2026, 00:48:42 UTC");
});

test("package: raw ISO UTC is preserved (never reformatted)", () => {
  assert.equal(formatTimestampForPackage(ISO), ISO);
  assert.equal(formatTimestampForPackage("2026-07-03T00:48:42Z"), "2026-07-03T00:48:42Z");
  assert.equal(formatTimestampForPackage("bad"), null);
  assert.equal(formatTimestampForPackage(new Date(ISO)), ISO);
});

test("device time: offset preserved as UTC±HH:MM", () => {
  assert.deepEqual(formatDeviceTime("2026-07-03T02:23:34+02:00"), {
    formatted: "03 Jul 2026, 02:23:34 UTC+02:00",
    hasZone: true,
  });
  assert.deepEqual(formatDeviceTime("2026-07-03T02:23:34-05:00"), {
    formatted: "03 Jul 2026, 02:23:34 UTC-05:00",
    hasZone: true,
  });
  // Z is an explicit +00:00 offset.
  assert.deepEqual(formatDeviceTime("2026-07-03T02:23:34Z"), {
    formatted: "03 Jul 2026, 02:23:34 UTC+00:00",
    hasZone: true,
  });
});

test("device time: naive local → 'time zone unavailable', never invents UTC", () => {
  const naive = formatDeviceTime("2026-07-03T02:23:34");
  assert.deepEqual(naive, {
    formatted: "03 Jul 2026, 02:23:34",
    hasZone: false,
    note: "time zone unavailable",
  });
  // Wall clock is read verbatim — NOT shifted.
  assert.ok(naive.formatted.includes("02:23:34"));
  assert.ok(!naive.formatted.includes("UTC"));
});

test("device time: null/invalid → null", () => {
  assert.equal(formatDeviceTime(null), null);
  assert.equal(formatDeviceTime(""), null);
  assert.equal(formatDeviceTime("not-a-time"), null);
});

test("parts: en-GB midnight normalizes to 00", () => {
  const p = formatTimestampParts("2026-07-03T00:00:00Z", "UTC");
  assert.equal(p.time, "00:00:00");
  assert.equal(p.date, "03 Jul 2026");
});
