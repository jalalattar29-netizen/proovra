/**
 * §11 — GROUPING WITHOUT LOSING PER-RECORD TRUTH.
 *
 * The property being defended is conservation. Thirty-four Evidence records
 * that each failed to be timestamped are thirty-four records that cannot be
 * proven; the queue may ARRANGE them so an operator can work, and it may not
 * make any of them harder to find. Every test below is a different way of
 * asking "did anything get lost?".
 *
 * The projection is pure, so these can be proven by enumeration rather than
 * against a database — which matters, because the failure mode is silent: a
 * grouping bug does not throw, it just quietly renders 30 where 34 exist.
 */

import { describe, expect, it } from "vitest";

import {
  AFFECTED_SAMPLE_LIMIT,
  projectConditionGroups,
  totalAffected,
  type GroupableCondition,
} from "../src/services/operations/operations-grouping.service.js";

const T0 = new Date("2026-08-20T09:00:00.000Z");

function condition(
  overrides: Partial<GroupableCondition> & { id: string },
): GroupableCondition {
  return {
    category: "EVIDENCE_INTEGRITY",
    fingerprint: `tsa_failure:${overrides.id}`,
    severity: "HIGH",
    status: "OPEN",
    title: "Trusted timestamping failed",
    safeSummary: "The record could not be timestamped.",
    firstSeenAtUtc: T0,
    lastSeenAtUtc: T0,
    occurrenceCount: 1,
    relatedEvidenceId: overrides.id,
    assignedOperatorUserId: null,
    ...overrides,
  };
}

/** 34 TSA failures — the shape the brief names explicitly. */
function thirtyFourTsaFailures(): GroupableCondition[] {
  return Array.from({ length: 34 }, (_, i) =>
    condition({
      // >= 8 chars: `parseIntegrityFingerprint` validates the evidence id,
      // and a fixture using a 6-char stub would silently exercise the
      // unparseable path instead of the one under test.
      id: `evidence-${String(i).padStart(3, "0")}`,
      failureReasonCode:
        i < 30 ? "TSA_HTTP_504_GATEWAY_TIMEOUT" : "TSA_IMPRINT_MISMATCH",
    }),
  );
}

describe("§11 — conservation", () => {
  it("34 per-record conditions become ONE group with affectedCount 34", () => {
    const groups = projectConditionGroups(thirtyFourTsaFailures());
    expect(groups).toHaveLength(1);
    expect(groups[0].affectedCount).toBe(34);
    expect(groups[0].title).toContain("34 records");
  });

  it("the sum of affectedCount always equals the number of input conditions", () => {
    const mixed = [
      ...thirtyFourTsaFailures(),
      condition({ id: "evidence-o01", fingerprint: "ots_failure:evidence-o01" }),
      condition({ id: "evidence-o02", fingerprint: "ots_failure:evidence-o02" }),
      condition({
        id: "wk-1",
        category: "WORKER",
        fingerprint: "dashboard:review:stale_assignments:t1",
        title: "Stale reviewer assignments",
      }),
    ];
    const groups = projectConditionGroups(mixed);
    expect(totalAffected(groups)).toBe(mixed.length);
  });

  it("a condition with an UNPARSEABLE fingerprint is grouped, never dropped", () => {
    // The failure mode this guards: a fingerprint the parser does not
    // recognise silently vanishing from the queue. It falls into its
    // category's default group instead.
    const rows = [
      condition({ id: "ev-1" }),
      condition({ id: "ev-2", fingerprint: "something-else-entirely" }),
    ];
    const groups = projectConditionGroups(rows);
    expect(totalAffected(groups)).toBe(2);
  });

  it("every input condition appears in exactly one group", () => {
    const rows = thirtyFourTsaFailures();
    const groups = projectConditionGroups(rows, { sampleLimit: 100 });
    const seen = groups.flatMap((g) => g.affectedSample.map((a) => a.conditionId));
    expect(new Set(seen).size).toBe(rows.length);
  });
});

describe("§11 — per-record traceability survives grouping", () => {
  it("the sample carries each condition's own id and evidence id", () => {
    const groups = projectConditionGroups(thirtyFourTsaFailures());
    for (const row of groups[0].affectedSample) {
      expect(row.conditionId).toMatch(/^evidence-\d{3}$/);
      expect(row.evidenceId).toBe(row.conditionId);
    }
  });

  it("the sample is BOUNDED and says so rather than reading as the total", () => {
    const groups = projectConditionGroups(thirtyFourTsaFailures());
    expect(groups[0].affectedSample).toHaveLength(AFFECTED_SAMPLE_LIMIT);
    expect(groups[0].hasMoreAffected).toBe(true);
    // The full number is still reported — a shorter list must never be
    // mistakable for a smaller problem.
    expect(groups[0].affectedCount).toBe(34);
  });

  it("failure sub-groups describe the set without merging anything", () => {
    const groups = projectConditionGroups(thirtyFourTsaFailures());
    const total = groups[0].failureGroups.reduce((s, g) => s + g.count, 0);
    expect(total).toBe(34);
    expect(
      groups[0].failureGroups.map((g) => g.count).sort((a, b) => a - b),
    ).toEqual([4, 30]);
  });

  it("an unclassifiable reason is counted as UNGROUPED, never guessed", () => {
    const rows = [condition({ id: "ev-1" })]; // no failureReasonCode at all
    const groups = projectConditionGroups(rows);
    expect(groups[0].failureGroups[0].failureClass).toBe("UNGROUPED");
  });
});

describe("§11 — the group is a projection, not a lifecycle", () => {
  it("one record recovering reduces the count and keeps the group identity", () => {
    const before = projectConditionGroups(thirtyFourTsaFailures());
    const after = projectConditionGroups(thirtyFourTsaFailures().slice(0, 33));
    expect(after[0].groupKey).toBe(before[0].groupKey);
    expect(after[0].affectedCount).toBe(33);
  });

  it("the group disappears only when its last member does", () => {
    expect(projectConditionGroups(thirtyFourTsaFailures().slice(0, 1))).toHaveLength(1);
    expect(projectConditionGroups([])).toHaveLength(0);
  });

  it("the group key is deterministic and independent of input order", () => {
    const rows = thirtyFourTsaFailures();
    const a = projectConditionGroups(rows);
    const b = projectConditionGroups([...rows].reverse());
    expect(a.map((g) => g.groupKey)).toEqual(b.map((g) => g.groupKey));
    expect(a.map((g) => g.affectedCount)).toEqual(b.map((g) => g.affectedCount));
  });

  it("a single-member group renders that condition's own title", () => {
    // Not a manufactured "1 record" heading — one problem must not read like a
    // summary of several.
    const groups = projectConditionGroups([
      condition({ id: "ev-1", title: "Trusted timestamping failed" }),
    ]);
    expect(groups[0].title).toBe("Trusted timestamping failed");
  });

  it("the group takes the severity of its WORST member", () => {
    const rows = [
      condition({ id: "ev-1", severity: "WARNING" }),
      condition({ id: "ev-2", severity: "CRITICAL" }),
      condition({ id: "ev-3", severity: "HIGH" }),
    ];
    expect(projectConditionGroups(rows)[0].severity).toBe("CRITICAL");
  });

  it("TSA and OTS failures are DIFFERENT groups — different problems", () => {
    const rows = [
      condition({ id: "evidence-001", fingerprint: "tsa_failure:evidence-001" }),
      condition({ id: "evidence-002", fingerprint: "ots_failure:evidence-002" }),
    ];
    const groups = projectConditionGroups(rows);
    expect(groups).toHaveLength(2);
    expect(new Set(groups.map((g) => g.groupKey)).size).toBe(2);
  });

  it("counts how many members somebody has already taken", () => {
    const rows = [
      condition({ id: "ev-1", assignedOperatorUserId: "u1" }),
      condition({ id: "ev-2" }),
      condition({ id: "ev-3", assignedOperatorUserId: "u2" }),
    ];
    expect(projectConditionGroups(rows)[0].assignedCount).toBe(2);
  });
});
