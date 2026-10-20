/**
 * AUD-25 (2026-10-20) — capturedAtUtc is when PROOVRA received the bytes; the
 * record summary never calls it "Captured".
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./support/render.mjs";

let ER;
before(async () => {
  ER = await loadModule("src/product/evidence-record.ts", []);
});

test("the record summary labels server receipt 'Received by PROOVRA'", () => {
  const items = ER.recordSummaryItems(
    { createdAt: "2026-10-01T09:00:00.000Z", capturedAtUtc: "2026-10-01T09:01:00.000Z", workflow: {}, sizeBytes: 1 },
    (iso) => iso,
  );
  const labels = items.map((i) => i.label);
  assert.ok(labels.includes("Received by PROOVRA"));
  assert.ok(!labels.includes("Captured"));
  assert.equal(items.find((i) => i.label === "Received by PROOVRA").value, "2026-10-01T09:01:00.000Z");
});
