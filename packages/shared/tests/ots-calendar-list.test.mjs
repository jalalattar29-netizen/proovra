/** A proof goes to several calendars: the record lists them, and says submitted. */
import test from "node:test";
import assert from "node:assert/strict";
import { otsCalendarList, otsCustodyEventLines } from "../dist/index.js";

test("one stored calendar reads as before; a comma-joined list reads as a submission", () => {
  assert.deepEqual(otsCalendarList(" https://a.example ,, https://b.example,"), ["https://a.example", "https://b.example"]);
  assert.deepEqual(otsCalendarList(null), []);
  assert.ok(otsCustodyEventLines({ calendar: "https://a.example" }).includes("Calendar: https://a.example"));
  const lines = otsCustodyEventLines({ calendar: "https://a.example,https://b.example" });
  assert.ok(lines.includes("Submitted to calendars: https://a.example, https://b.example"));
  assert.ok(!lines.some((l) => l.startsWith("Calendar:")));
});
