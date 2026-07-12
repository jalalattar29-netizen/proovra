/** Phase D5 — QC sampling strategies (behavioral). */
import { describe, expect, it } from "vitest";

import { selectQcSample, type QcRunRow } from "../src/services/ai/ai-qc-sampling.service.js";

function row(over: Partial<QcRunRow>): QcRunRow {
  return {
    id: over.id ?? `r-${Math.floor(performance.now() * 1000) % 100000}`,
    workspaceId: "ws-1", feature: "CASE_COPILOT", status: "ok",
    generatedAt: new Date(0), droppedCitations: 0, observationCount: 10,
    editedCount: 0, rejectedCount: 0, ...over,
  };
}

describe("D5 — sampling strategies", () => {
  const rows = [
    row({ id: "a", editedCount: 6 }),               // 60% edit
    row({ id: "b", droppedCitations: 5 }),          // low citation
    row({ id: "c", rejectedCount: 4 }),             // disagreement
    row({ id: "d", status: "blocked_prohibited_claim" }),
    row({ id: "e", status: "schema_error" }),
    row({ id: "f" }),                               // clean
  ];
  it("HIGH_EDIT_RATE selects only ≥30% edit-rate runs", () => {
    const s = selectQcSample(rows, "HIGH_EDIT_RATE");
    expect(s.map((r) => r.id)).toEqual(["a"]);
  });
  it("LOW_CITATION selects runs with dropped citations", () => {
    expect(selectQcSample(rows, "LOW_CITATION").map((r) => r.id)).toEqual(["b"]);
  });
  it("DISAGREEMENT selects rejected runs", () => {
    expect(selectQcSample(rows, "DISAGREEMENT").map((r) => r.id)).toEqual(["c"]);
  });
  it("POLICY_BLOCK / PROVIDER_FAILURE filter by status", () => {
    expect(selectQcSample(rows, "POLICY_BLOCK").map((r) => r.id)).toEqual(["d"]);
    expect(selectQcSample(rows, "PROVIDER_FAILURE").map((r) => r.id)).toEqual(["e"]);
  });
  it("RANDOM is deterministic (seeded) and bounded by limit", () => {
    const a = selectQcSample(rows, "RANDOM", 3);
    const b = selectQcSample(rows, "RANDOM", 3);
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
    expect(a.length).toBe(3);
  });
  it("RISK_BASED ranks risky runs first", () => {
    const s = selectQcSample(rows, "RISK_BASED", 2);
    expect(["a", "b", "c"]).toContain(s[0]?.id);
  });
});
