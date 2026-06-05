/**
 * Phase Repair (Problem 13) — Timeline SQL failures must not be
 * disguised as TRUE_EMPTY.
 *
 * Before this repair, `buildInvestigationTimeline` swallowed any
 * exception with a bare `catch { return { ok: true, events: [],
 * truncated: false }; }`. The route forwarded `events:[]` and the
 * UI empty-state classifier picked TRUE_EMPTY — rendering
 * "Nothing has been recorded here yet." even when the underlying
 * SQL projection had failed. Operators could not distinguish an
 * empty workspace from a broken query.
 *
 * The repair turns `TimelineQueryResult` into a discriminated union:
 *   - `{ ok: true, events, truncated }`           (happy path)
 *   - `{ ok: false, classification: "QUERY_FAILED", reason }`  (failure)
 *
 * These tests pin the new contract end-to-end:
 *   1. Source-level lock on the new return-type variant.
 *   2. Source-level lock on the `bump("timeline_query_failed_total")`
 *      + structured warn line in the catch.
 *   3. Source-level lock on the route propagating `status:"failed"`.
 *   4. Source-level lock on the frontend short-circuiting to
 *      PIPELINE_FAILED instead of running the classifier (which
 *      would have picked TRUE_EMPTY on `events:[]`).
 *   5. Source-level lock on the diagnostics service probing the
 *      timeline projection and pushing `timeline_query_failed`.
 *   6. Runtime exercise — when the prisma raw query throws, the
 *      function returns the new failure shape.
 *   7. Runtime exercise — happy path still returns `ok:true`.
 *   8. Runtime exercise — `domain-sync.runTimelineSync` propagates
 *      the failure shape as `ok:false`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildInvestigationTimeline,
  type TimelineQueryResult,
} from "@proovra/shared-runtime/graph";
import { runTimelineSync } from "@proovra/shared-runtime/graph";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// ---------------------------------------------------------------------------
// PART 1 — Source-level locks
// ---------------------------------------------------------------------------

describe("Phase Repair Problem 13 — TimelineQueryResult discriminated union", () => {
  const src = readSource(
    "../../../packages/shared-runtime/src/graph/graph-builder.service.ts",
  );

  it("TimelineQueryResult is now a discriminated union with a QUERY_FAILED variant", () => {
    const decl = src.match(
      /export type TimelineQueryResult\s*=[\s\S]*?(?:\};|\}\s*;)/,
    )?.[0];
    expect(decl, "TimelineQueryResult declaration found").toBeTruthy();
    // ok:true and ok:false variants both present.
    expect(decl!).toMatch(/ok:\s*true/);
    expect(decl!).toMatch(/ok:\s*false/);
    expect(decl!).toMatch(/classification:\s*"QUERY_FAILED"/);
    expect(decl!).toMatch(/reason:\s*string/);
  });

  it("catch branch returns ok:false + QUERY_FAILED + reason (NOT ok:true / events:[])", () => {
    const fn = src.match(
      /export async function buildInvestigationTimeline\([\s\S]*?\n\}\s*\n/,
    )?.[0];
    expect(fn).toBeTruthy();
    expect(fn!).toMatch(
      /catch\s*\(err\)\s*\{[\s\S]*?return\s*\{\s*ok:\s*false,\s*classification:\s*"QUERY_FAILED"/,
    );
    // Forbidden: the legacy disguise must be gone.
    expect(fn!).not.toMatch(
      /catch\s*\{\s*return\s*\{\s*ok:\s*true,\s*events:\s*\[\]/,
    );
  });

  it("catch branch bumps the dedicated failure counter", () => {
    const fn = src.match(
      /export async function buildInvestigationTimeline\([\s\S]*?\n\}\s*\n/,
    )?.[0];
    expect(fn!).toMatch(/bump\(\s*"timeline_query_failed_total"\s*\)/);
  });

  it("catch branch emits a structured warn line with the bounded code", () => {
    const fn = src.match(
      /export async function buildInvestigationTimeline\([\s\S]*?\n\}\s*\n/,
    )?.[0];
    // The shared-runtime layer has no logger registry — the
    // conventional fallback is a `console.warn` with a JSON payload.
    expect(fn!).toMatch(/console\.warn/);
    expect(fn!).toMatch(/investigation_timeline\.query_failed/);
  });

  it("the new failure-counter is in the canonical COUNTER_NAMES catalog", () => {
    const metricsSrc = readSource(
      "../../../packages/shared-runtime/src/ops/metrics.service.ts",
    );
    expect(metricsSrc).toMatch(/"timeline_query_failed_total"/);
  });
});

describe("Phase Repair Problem 13 — /v1/graph/timeline route propagates failure", () => {
  const src = readSource("../src/routes/graph.routes.ts");

  it("the GET handler short-circuits on !result.ok with status:'failed'", () => {
    // Find the FIRST occurrence (the GET handler, not the export
    // route). The GET block ends before the next `app.post(`.
    const getBlock = src.match(
      /app\.get\(\s*"\/v1\/graph\/timeline"[\s\S]*?\n\s*\},\s*\n\s*\)/,
    )?.[0];
    expect(getBlock, "GET /v1/graph/timeline block found").toBeTruthy();
    expect(getBlock!).toMatch(/if\s*\(\s*!result\.ok\s*\)/);
    expect(getBlock!).toMatch(/status:\s*"failed"/);
    expect(getBlock!).toMatch(/classification:\s*result\.classification/);
    expect(getBlock!).toMatch(/reason:\s*result\.reason/);
  });

  it("the GET handler tags the success branch with status:'ok'", () => {
    const getBlock = src.match(
      /app\.get\(\s*"\/v1\/graph\/timeline"[\s\S]*?\n\s*\},\s*\n\s*\)/,
    )?.[0];
    expect(getBlock!).toMatch(/status:\s*"ok"/);
  });

  it("the POST /export handler refuses to emit a misleading empty export on failure (503)", () => {
    const postBlock = src.match(
      /app\.post\(\s*"\/v1\/graph\/timeline\/export"[\s\S]*?\n\s*\},\s*\n\s*\)/,
    )?.[0];
    expect(postBlock, "POST /v1/graph/timeline/export block found").toBeTruthy();
    expect(postBlock!).toMatch(/if\s*\(\s*!result\.ok\s*\)/);
    expect(postBlock!).toMatch(/reply\.code\(\s*503\s*\)/);
    expect(postBlock!).toMatch(/status:\s*"failed"/);
  });
});

describe("Phase Repair Problem 13 — Frontend renders PIPELINE_FAILED on failure", () => {
  const src = readSource(
    "../../../apps/web/app/(app)/investigation/timeline/page.tsx",
  );

  it("TimelineResponse type carries the new status + reason discriminator", () => {
    expect(src).toMatch(/status\?:\s*"ok"\s*\|\s*"failed"/);
    expect(src).toMatch(/reason\?:\s*string/);
  });

  it("page state stores the bounded failure reason separately from fetchError", () => {
    expect(src).toMatch(/queryFailedReason/);
    expect(src).toMatch(/setQueryFailedReason/);
  });

  it("page short-circuits to PIPELINE_FAILED before the classifier runs", () => {
    // The empty-state block must check queryFailedReason BEFORE
    // calling classifyInvestigationEmptyState — otherwise the
    // classifier (which sees data === [] + fetchError === null)
    // would pick TRUE_EMPTY and the operator would never see the
    // failure card.
    expect(src).toMatch(/queryFailedReason\s*!==\s*null\s*\?/);
    expect(src).toMatch(/classification="PIPELINE_FAILED"/);
  });

  it("freshness pill no longer claims 'No events recorded yet' on backend error", () => {
    // The pill string was the operator-visible giveaway: it said
    // "No events recorded yet" on transport error. The repair
    // replaces it with honest copy that distinguishes a failed
    // projection from an unreachable backend.
    expect(src).not.toMatch(/"No events recorded yet"/);
    expect(src).toMatch(/Timeline projection failed/);
    expect(src).toMatch(/Timeline unavailable/);
  });
});

describe("Phase Repair Problem 13 — Diagnostics surface timeline_query_failed", () => {
  const src = readSource(
    "../src/services/investigation-diagnostics.service.ts",
  );

  it("the aggregator probes buildInvestigationTimeline and pushes the warning on !ok", () => {
    expect(src).toMatch(/buildInvestigationTimeline/);
    expect(src).toMatch(
      /warnings\.push\(\s*"timeline_query_failed"\s*\)/,
    );
  });

  it("the probe is bounded to limit:1", () => {
    // The diagnostics aggregator runs on the hot path of the
    // investigation drawer; we keep the probe cheap.
    const probe = src.match(
      /buildInvestigationTimeline\([\s\S]*?limit:\s*1/,
    );
    expect(probe).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// PART 2 — Runtime exercises
// ---------------------------------------------------------------------------

describe("Phase Repair Problem 13 — Runtime: buildInvestigationTimeline failure shape", () => {
  it("returns ok:false + QUERY_FAILED when the raw projection throws", async () => {
    // Mock prisma whose $queryRawUnsafe always throws — simulates
    // any underlying SQL failure (schema drift, missing column,
    // transient connection error).
    const fakeClient = {
      $queryRawUnsafe: async () => {
        throw new Error("relation \"investigation_graph_nodes\" does not exist");
      },
    } as unknown as Parameters<typeof buildInvestigationTimeline>[1];

    const result = await buildInvestigationTimeline(
      {
        teamId: "00000000-0000-0000-0000-000000000001",
        rootNodeId: null,
        evidenceId: null,
        fromUtc: null,
        toUtc: null,
      },
      fakeClient,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.classification).toBe("QUERY_FAILED");
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
      // The reason must NOT contain "events:[]" or anything that
      // would lead a downstream consumer to treat this as success.
      expect(result.reason).toMatch(/timeline_query_failed/);
    }
  });

  it("returns ok:true + events:[] on a real empty workspace (no SQL error)", async () => {
    // Distinct from the failure case: the projection ran cleanly
    // and produced zero rows. This is the TRUE_EMPTY path; the
    // classifier picks "Nothing has been recorded here yet." and
    // that is HONEST.
    const fakeClient = {
      $queryRawUnsafe: async () => [],
    } as unknown as Parameters<typeof buildInvestigationTimeline>[1];

    const result = await buildInvestigationTimeline(
      {
        teamId: "00000000-0000-0000-0000-000000000002",
        rootNodeId: null,
        evidenceId: null,
        fromUtc: null,
        toUtc: null,
      },
      fakeClient,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.events).toEqual([]);
      expect(result.truncated).toBe(false);
    }
  });

  it("union discriminator narrows correctly when ok:true", () => {
    // Compile-time + runtime check: the discriminator works as a
    // type guard. If a future contributor accidentally widens the
    // type, this assertion will fail to compile.
    const ok: TimelineQueryResult = {
      ok: true,
      events: [],
      truncated: false,
    };
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(Array.isArray(ok.events)).toBe(true);
    }
  });

  it("union discriminator narrows correctly when ok:false", () => {
    const failed: TimelineQueryResult = {
      ok: false,
      classification: "QUERY_FAILED",
      reason: "timeline_query_failed:simulated",
    };
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.classification).toBe("QUERY_FAILED");
    }
  });
});

describe("Phase Repair Problem 13 — Runtime: runTimelineSync propagates failure", () => {
  it("returns ok:false when the timeline projection fails", async () => {
    // runTimelineSync builds the timeline as its first step. When
    // buildInvestigationTimeline returns the new failure shape,
    // the sync helper must mirror that honestly — NOT report
    // eventCount:0 as a healthy snapshot.
    const fakeClient = {
      $queryRawUnsafe: async () => {
        throw new Error("simulated projection failure");
      },
      $executeRawUnsafe: async () => 0,
    } as unknown as Parameters<typeof runTimelineSync>[1];

    const result = await runTimelineSync(
      "00000000-0000-0000-0000-000000000003",
      fakeClient,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.eventCount).toBe(0);
      expect(result.truncated).toBe(false);
      expect(result.reason).toContain("timeline_query_failed");
    }
  });
});

// ---------------------------------------------------------------------------
// PART 3 — Empty-state classifier behaviour on the new envelope
// ---------------------------------------------------------------------------

describe("Phase Repair Problem 13 — Empty-state classifier on the new envelope", () => {
  it("the route never silently downgrades QUERY_FAILED → TRUE_EMPTY", () => {
    // This is the bug class in a nutshell. We document it as a
    // standalone invariant: any change that causes the route to
    // forward `events: []` without the `status:"failed"` flag on a
    // failure must break this test.
    const src = readSource("../src/routes/graph.routes.ts");
    const getBlock = src.match(
      /app\.get\(\s*"\/v1\/graph\/timeline"[\s\S]*?\n\s*\},\s*\n\s*\)/,
    )?.[0];
    expect(getBlock).toBeTruthy();
    // The success branch must NOT be reachable when result.ok is false.
    // (Verified by the structure of the if-guard.)
    const failureGuardIdx = getBlock!.indexOf("if (!result.ok)");
    const successSendIdx = getBlock!.indexOf("status: \"ok\"");
    expect(failureGuardIdx).toBeGreaterThan(-1);
    expect(successSendIdx).toBeGreaterThan(failureGuardIdx);
  });
});
