/**
 * THE ONE OPERATIONS STATUS — every input, every answer (2026-10-14).
 *
 * `operationsStatusFor` decides what a surface may SAY about a workspace from
 * the same facts that decide `mayAssertAllClear`. Enumerated here, without a
 * database, so the table is provable rather than sampled:
 *
 *   - an empty unresolved list is never, by itself, "clear" or "unconfirmed";
 *   - CONFIRMED_CLEAR requires a fresh, complete check;
 *   - STALE carries the last COMPLETE check time when that check saw
 *     everything, and none when it did not;
 *   - PARTIAL names the unseen sources; a source that ran and found nothing
 *     is a success and never makes a check partial;
 *   - an unreadable summary is UNAVAILABLE, never zero;
 *   - the status agrees with `mayAssertAllClear` in every case.
 */
import { describe, expect, it } from "vitest";

import {
  mayAssertOperationsClear,
  operationsStatusFor,
  type OperationsReadiness,
  type WorkspaceOperationsRunSnapshot,
} from "@proovra/shared-runtime";

const NOW = new Date("2026-10-14T12:00:00.000Z");
const AT = "2026-10-14T11:50:00.000Z";

function run(readiness: OperationsReadiness, over: Partial<WorkspaceOperationsRunSnapshot["sources"]> = {}): WorkspaceOperationsRunSnapshot {
  return {
    readiness,
    startedAtUtc: AT,
    completedAtUtc: readiness === "RUNNING" ? null : AT,
    leaseExpiresAtUtc: null,
    sourceSnapshotAtUtc: readiness === "RUNNING" ? null : AT,
    sources: {
      requiredSources: ["a", "b"],
      attemptedSources: ["a", "b"],
      successfulSources: ["a", "b"],
      failedSources: [],
      truncatedSources: [],
      continuationScheduled: false,
      ...over,
    } as WorkspaceOperationsRunSnapshot["sources"],
    safeFailureCategory: null,
    recorded: 0,
  };
}

const status = (r: WorkspaceOperationsRunSnapshot | null, open: number | null = 0, resolved: number | null = 3, readable = true, complete = true) =>
  operationsStatusFor({ now: NOW, run: r, summaryReadable: readable, incidentReadComplete: complete, unresolvedCount: open, resolvedCount: resolved });

describe("operationsStatusFor", () => {
  it("fresh, complete, nothing unresolved → CONFIRMED_CLEAR, with resolved history counted", () => {
    const s = status(run("READY"));
    expect(s).toMatchObject({ state: "CONFIRMED_CLEAR", reason: null, freshness: "FRESH", lastCompleteCheckAtUtc: AT, activeCount: 0, resolvedCount: 3 });
  });

  it("unresolved conditions → ACTIVE_CONDITIONS, whatever the freshness", () => {
    expect(status(run("READY"), 2).state).toBe("ACTIVE_CONDITIONS");
    const stale = status(run("STALE"), 2);
    expect(stale.state).toBe("ACTIVE_CONDITIONS");
    expect(stale.freshness).toBe("STALE");
  });

  it("STALE after a complete check → STALE with that check's time", () => {
    expect(status(run("STALE"))).toMatchObject({ state: "STALE", reason: "STALE", freshness: "STALE", lastCompleteCheckAtUtc: AT, lastCheckAtUtc: AT });
  });

  it("STALE after an incomplete check → STALE with no complete-check time", () => {
    const s = status(run("STALE", { failedSources: ["b"], successfulSources: ["a"] }));
    expect(s.state).toBe("STALE");
    expect(s.lastCompleteCheckAtUtc).toBeNull();
    expect(s.lastCheckAtUtc).toBe(AT);
  });

  it("PARTIAL names the sources it could not see", () => {
    const s = status(run("PARTIAL", { failedSources: ["b"], successfulSources: ["a"], truncatedSources: [] }));
    expect(s).toMatchObject({ state: "PARTIAL", reason: "PARTIAL_SOURCES", failedSourceIds: ["b"], lastCompleteCheckAtUtc: null });
    expect(status(run("PARTIAL", { truncatedSources: ["a"] })).truncatedSourceIds).toEqual(["a"]);
  });

  it("a source that ran and found nothing is a success — it never makes the check partial", () => {
    // Every required source attempted and successful, zero findings anywhere.
    expect(status(run("READY"), 0, 0).state).toBe("CONFIRMED_CLEAR");
  });

  it("an incident read that hit its bound is PARTIAL, not clear", () => {
    expect(status(run("READY"), 0, 3, true, false)).toMatchObject({ state: "PARTIAL", reason: "INCIDENT_READ_INCOMPLETE" });
  });

  it("running / never run / failed / stalled are their own states", () => {
    expect(status(run("RUNNING")).state).toBe("CHECKING");
    expect(status(null)).toMatchObject({ state: "NEVER_CHECKED", freshness: "NONE", lastCheckAtUtc: null });
    expect(status(run("FAILED")).state).toBe("CHECK_FAILED");
    expect(status(run("STALLED")).state).toBe("CHECK_FAILED");
  });

  it("an unreadable summary is UNAVAILABLE — unknown, never zero", () => {
    expect(status(run("READY"), null, null, false)).toMatchObject({ state: "UNAVAILABLE", reason: "SUMMARY_UNAVAILABLE", activeCount: null });
  });

  it("agrees with mayAssertAllClear in every combination", () => {
    const readinesses: OperationsReadiness[] = ["READY", "STALE", "PARTIAL", "RUNNING", "FAILED", "STALLED", "NEVER_RUN"];
    for (const r of readinesses) {
      for (const open of [0, 1]) {
        for (const complete of [true, false]) {
          const snapshot = r === "NEVER_RUN" ? null : run(r);
          const s = status(snapshot, open, 3, true, complete);
          const verdict = mayAssertOperationsClear({ run: snapshot, incidentReadComplete: complete, unresolvedCount: open });
          expect(s.state === "CONFIRMED_CLEAR", `${r}/${open}/${complete}`).toBe(verdict.clear);
        }
      }
    }
  });
});
