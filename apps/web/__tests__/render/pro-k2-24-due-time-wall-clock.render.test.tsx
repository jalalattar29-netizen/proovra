/**
 * PRO-K2-24 (web) — Edit work seeds the due-time control with the VIEWER's
 * wall-clock, so an unchanged save keeps the stored instant.
 *
 * The control is a `datetime-local` input; the editors send back
 * `new Date(value).toISOString()`. Seeding it with the UTC digits of the stored
 * instant ("…T15:00") made that read LOCAL time, so every save moved the due
 * time by the browser's UTC offset. Run in a non-UTC zone:
 *   - allowed: seed -> save round-trips to the same instant (minute precision);
 *   - refused: the seed is never the UTC digits when the zone is not UTC;
 *   - an empty / invalid stored value seeds an empty control (no due date).
 */
import { beforeAll, describe, expect, it } from "vitest";

import { toDateTimeLocalInputValue } from "../../lib/date";

beforeAll(() => {
  // Node re-reads TZ on change; a fixed non-UTC zone with no DST makes the
  // offset certain (UTC+05:30).
  process.env.TZ = "Asia/Kolkata";
});

const STORED = "2026-11-21T15:00:00.000Z";

describe("PRO-K2-24 — due-time control seed", () => {
  it("the zone under test is not UTC", () => {
    expect(new Date(STORED).getTimezoneOffset()).toBe(-330);
  });

  it("allowed: an unchanged seed saves back the same instant", () => {
    const seed = toDateTimeLocalInputValue(STORED);
    expect(new Date(seed).toISOString()).toBe(STORED);
  });

  it("refused: the seed is the viewer's wall-clock, never the UTC digits", () => {
    const seed = toDateTimeLocalInputValue(STORED);
    expect(seed).toBe("2026-11-21T20:30");
    expect(seed).not.toBe(STORED.slice(0, 16));
  });

  it("no stored due date, or an unreadable one, seeds an empty control", () => {
    expect(toDateTimeLocalInputValue(null)).toBe("");
    expect(toDateTimeLocalInputValue(undefined)).toBe("");
    expect(toDateTimeLocalInputValue("not a date")).toBe("");
  });
});
