/**
 * Phase Repair — derivative-detection / reserved-kind / disabled-queue
 * honesty contracts.
 *
 * Source-level invariants for the Phase Repair audit's Tasks A–D.
 * Tests are deliberately source-level (no live DB / Redis) so the
 * contracts hold even when infra is unavailable in CI.
 *
 * Layers covered:
 *   A. resolveDerivativeDetectionStatus returns AUTOMATIC + internal
 *      heuristic provider — matching the live POSSIBLE_DERIVATIVE_OF
 *      producer in graph-builder.service.ts.
 *   B. investigation-diagnostics.service.ts duplicateDerivativeCount
 *      is sourced from investigation_graph_edges (real count), not
 *      hardcoded to 0. The stale "derivative_detection_deferred_no_producer"
 *      warning is no longer pushed unconditionally.
 *   C. MEDIA_INTELLIGENCE_JOB_KINDS catalog no longer advertises
 *      compute_duplicates / compute_lineage as live queue kinds.
 *   D. the disabled-queue projection stays honest. PHASE 12 POINT 5:
 *      its former subjects (mi-ocr / mi-transcript) were removed from
 *      the runtime, so the honest disabled set is now empty.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { MEDIA_INTELLIGENCE_JOB_KINDS } from "@proovra/shared";
import { MEDIA_INTELLIGENCE_RUN_KINDS } from "@proovra/shared-runtime/media-intelligence";

import {
  PRODUCER_REASON_COPY,
  resolveProducerModeStatuses,
} from "@proovra/shared-runtime/media-intelligence";

import { DISABLED_QUEUES_FOR_TESTS } from "../src/services/operations/queue-inventory.service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "../../..");

function readSource(absPath: string): string {
  return readFileSync(absPath, "utf8");
}

const PRODUCER_MODE_SRC = readSource(
  resolve(
    repoRoot,
    "packages/shared-runtime/src/media-intelligence/producer-mode.ts",
  ),
);
const DIAGNOSTICS_SRC = readSource(
  resolve(
    repoRoot,
    "services/api/src/services/investigation-diagnostics.service.ts",
  ),
);
// PHASE 12 — POINT 5: the catalog and its rationale live with the run tracker,
// which is the ONE place that decides what a media-intelligence run kind may be.
const RUN_TRACKER_SRC = readSource(
  resolve(
    repoRoot,
    "packages/shared-runtime/src/media-intelligence/run-tracker.service.ts",
  ),
);
const QUEUE_INVENTORY_SRC = readSource(
  resolve(
    repoRoot,
    "services/api/src/services/operations/queue-inventory.service.ts",
  ),
);
const GRAPH_BUILDER_SRC = readSource(
  resolve(
    repoRoot,
    "packages/shared-runtime/src/graph/graph-builder.service.ts",
  ),
);

// ===========================================================================
// Task A — Honest derivative-detection resolver
// ===========================================================================

describe("Phase Repair Task A — derivative-detection resolver matches the live producer", () => {
  const stubPrisma = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $queryRawUnsafe: async () => [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  it("graph-builder still upserts POSSIBLE_DERIVATIVE_OF (producer is live)", () => {
    // If the producer is ever removed, this test fails and Task A's
    // resolver claim becomes dishonest — so the suite catches drift in
    // either direction.
    expect(GRAPH_BUILDER_SRC).toMatch(
      /upsertEdge[\s\S]{0,200}"POSSIBLE_DERIVATIVE_OF"/,
    );
  });

  it("resolveDerivativeDetectionStatus returns AUTOMATIC + internal heuristic", async () => {
    const out = await resolveProducerModeStatuses({
      teamId: "00000000-0000-0000-0000-000000000000",
      prisma: stubPrisma,
    });
    const derivative = out.find((s) => s.kind === "derivative_detection");
    expect(derivative).toBeDefined();
    expect(derivative?.mode).toBe("AUTOMATIC");
    expect(derivative?.enabled).toBe(true);
    expect(derivative?.configured).toBe(true);
    expect(derivative?.automatic).toBe(true);
    expect(derivative?.indexExistingOnly).toBe(false);
    expect(derivative?.provider).toBe("internal");
    expect(derivative?.reason).toBe(
      PRODUCER_REASON_COPY.DERIVATIVE_HEURISTIC_ACTIVE,
    );
  });

  it("PRODUCER_REASON_COPY.DERIVATIVE_HEURISTIC_ACTIVE exists and is operator-grade", () => {
    expect(PRODUCER_REASON_COPY.DERIVATIVE_HEURISTIC_ACTIVE).toBeDefined();
    const copy = PRODUCER_REASON_COPY.DERIVATIVE_HEURISTIC_ACTIVE;
    expect(typeof copy).toBe("string");
    expect(copy.length).toBeGreaterThan(20);
    // Forbidden internal release-train language.
    expect(copy).not.toMatch(/Wave/i);
    expect(copy).not.toMatch(/Phase/i);
    expect(copy).not.toMatch(/wired/i);
    expect(copy).not.toMatch(/producer/i);
    // Must explain the heuristic so reviewers know the signal source.
    expect(copy).toMatch(/similarity|proximity|traits/i);
  });

  it("resolver source no longer hardcodes DEFERRED for derivative_detection", () => {
    // The Wave 1 hardcoded block returned mode: "DEFERRED" with
    // PRODUCER_REASON_COPY.DEFERRED_NO_PRODUCER. Phase Repair flipped
    // it to AUTOMATIC + DERIVATIVE_HEURISTIC_ACTIVE.
    const derivativeBlock = PRODUCER_MODE_SRC.match(
      /async function resolveDerivativeDetectionStatus[\s\S]*?\n\}/,
    );
    expect(derivativeBlock, "resolveDerivativeDetectionStatus block not found")
      .toBeTruthy();
    const body = derivativeBlock?.[0] ?? "";
    expect(body).toMatch(/mode:\s*"AUTOMATIC"/);
    expect(body).toMatch(/enabled:\s*true/);
    expect(body).toMatch(/provider:\s*"internal"/);
    expect(body).toMatch(/DERIVATIVE_HEURISTIC_ACTIVE/);
    expect(body).not.toMatch(/mode:\s*"DEFERRED"/);
    expect(body).not.toMatch(/PRODUCER_REASON_COPY\.DEFERRED_NO_PRODUCER/);
  });
});

// ===========================================================================
// Task B — Diagnostics duplicateDerivativeCount from real query
// ===========================================================================

describe("Phase Repair Task B — investigation-diagnostics duplicateDerivativeCount is sourced from edges", () => {
  it("queries investigation_graph_edges for POSSIBLE_DERIVATIVE_OF count", () => {
    expect(DIAGNOSTICS_SRC).toMatch(
      /SELECT[\s\S]{0,200}FROM\s+"investigation_graph_edges"[\s\S]{0,200}edge_type"?\s*=\s*'POSSIBLE_DERIVATIVE_OF'/,
    );
  });

  it("query is team-anchored (no cross-team leakage)", () => {
    // The query MUST filter by team_id $1. Find the actual SQL string
    // that mentions POSSIBLE_DERIVATIVE_OF — the comment above the
    // query also mentions the edge type, so we look for the query
    // template-string instance specifically.
    const queryIdx = DIAGNOSTICS_SRC.indexOf(
      "'POSSIBLE_DERIVATIVE_OF'",
    );
    expect(queryIdx).toBeGreaterThan(0);
    const window = DIAGNOSTICS_SRC.slice(
      Math.max(0, queryIdx - 600),
      queryIdx + 400,
    );
    expect(window).toMatch(/"team_id"\s*=\s*\$1/);
  });

  it("excludes stale edges from the count", () => {
    // Stale-edge sweep marks edges with stale_at_utc when source/target
    // is stale. Count MUST exclude them so the diagnostic surface
    // reflects active candidates only.
    const queryIdx = DIAGNOSTICS_SRC.indexOf(
      "'POSSIBLE_DERIVATIVE_OF'",
    );
    expect(queryIdx).toBeGreaterThan(0);
    const window = DIAGNOSTICS_SRC.slice(queryIdx, queryIdx + 400);
    expect(window).toMatch(/"stale_at_utc"\s+IS\s+NULL/);
  });

  it("no longer pushes the stale 'derivative_detection_deferred_no_producer' warning unconditionally", () => {
    // The producer is live; the unconditional warning was dishonest.
    // The only acceptable push is the bounded
    // duplicate_derivative_count_unavailable warning inside the catch.
    expect(DIAGNOSTICS_SRC).not.toMatch(
      /warnings\.push\("derivative_detection_deferred_no_producer"\)/,
    );
  });

  it("uses a bounded warning when the query throws", () => {
    expect(DIAGNOSTICS_SRC).toMatch(
      /warnings\.push\("duplicate_derivative_count_unavailable"\)/,
    );
  });

  it("does not hardcode duplicateDerivativeCount = 0", () => {
    // Hardcoding 0 (the previous Wave 1 dishonest pattern) is banned.
    expect(DIAGNOSTICS_SRC).not.toMatch(
      /out\.duplicateDerivativeCount\s*=\s*0;/,
    );
  });
});

// ===========================================================================
// Task C — Reserved no-op kinds removed from queue vocab
// ===========================================================================

/**
 * PHASE 12 — POINT 5: there is exactly ONE queue-kind catalog now, so this
 * suite asserts against the value instead of against two source shapes.
 *
 * The api array and the worker union it used to compare are both gone; both
 * sides re-export `MEDIA_INTELLIGENCE_JOB_KINDS` from the shared registry.
 * The guarantee is unchanged and is arguably now enforced rather than merely
 * observed: the dead kinds cannot be in the queue vocabulary because there is
 * no second place to put them.
 */
describe("Phase Repair Task C — compute_duplicates / compute_lineage dropped from queue vocab", () => {
  it("the queue vocabulary does not contain the dead kinds", () => {
    expect(MEDIA_INTELLIGENCE_JOB_KINDS).not.toContain("compute_duplicates");
    expect(MEDIA_INTELLIGENCE_JOB_KINDS).not.toContain("compute_lineage");
  });

  it("the dead kinds SURVIVE in the run-row catalog (legacy history stays readable)", () => {
    // This is the half the original test could not express, because it only
    // looked at queue vocabularies. Historical rows carry these kinds;
    // narrowing the DB catalog would make them unreadable through any path
    // that revalidates.
    expect(MEDIA_INTELLIGENCE_RUN_KINDS).toContain("compute_duplicates");
    expect(MEDIA_INTELLIGENCE_RUN_KINDS).toContain("compute_lineage");
  });

  it("documents why the dead kinds were dropped (explanation survives)", () => {
    // Kept so a future contributor does not re-add them to the queue without
    // checking the run-tracker DB enum context. The explanation moved with the
    // catalog, into the shared registry.
    expect(RUN_TRACKER_SRC).toMatch(
      /compute_duplicates.*compute_lineage|compute_lineage.*compute_duplicates/s,
    );
  });
});

// ===========================================================================
// Task D — the disabled-queue projection
//
// PHASE 12 POINT 5 — this block's original subject was `mi-ocr` and
// `mi-transcript`: two queues whose processors logged
// `not_configured_completed` and returned success, surfaced to operators as
// "disabled" so the dishonesty was at least visible. Point 5 removed the
// queues instead, so the honest projection is now an EMPTY disabled set.
//
// The mechanism is still tested — a queue with no live processor must be
// reported as disabled with a reason rather than sampled from Redis — because
// that mechanism is what keeps the next such queue visible. What changed is
// that no queue currently needs it, which is the stronger outcome.
// ===========================================================================

describe("Phase Repair Task D — the disabled-queue projection stays honest", () => {
  it("queue-inventory declares a 'disabled' QueueHealthStatus value", () => {
    expect(QUEUE_INVENTORY_SRC).toMatch(
      /export type QueueHealthStatus\s*=[\s\S]*?\|\s*"disabled"/,
    );
  });

  it("QueueInventoryItem carries a disabledReason field", () => {
    expect(QUEUE_INVENTORY_SRC).toMatch(/disabledReason:\s*string\s*\|\s*null/);
  });

  it("the DISABLED_QUEUES map exists and is EMPTY — every queue has a live processor", () => {
    expect(QUEUE_INVENTORY_SRC).toMatch(/DISABLED_QUEUES.*=\s*\{/s);
    expect(Object.keys(DISABLED_QUEUES_FOR_TESTS)).toEqual([]);
  });

  it("any future entry must carry an operator-grade reason, not release-train language", () => {
    for (const [queue, reason] of Object.entries(DISABLED_QUEUES_FOR_TESTS)) {
      expect(reason.trim().length, queue).toBeGreaterThan(0);
      expect(reason, queue).not.toMatch(/Wave\s*\d/i);
      expect(reason, queue).not.toMatch(/Phase\s*\d/i);
      expect(reason, queue).not.toMatch(/TODO|FIXME/);
    }
  });

  it("getQueueInventory short-circuits disabled queues with the disabled health + reason", () => {
    // The loop should set health:"disabled", oldestWaitingAgeMs:null,
    // counts:zeros, disabledReason:reason, and continue — bypassing
    // the Redis getJobCounts call.
    expect(QUEUE_INVENTORY_SRC).toMatch(
      /if\s*\(\s*disabledReason\s*\)\s*\{[\s\S]{0,400}health:\s*"disabled"[\s\S]{0,200}disabledReason,?\s*\n\s*\}\);[\s\S]{0,50}continue;/,
    );
  });

  it("healthy + outage push paths set disabledReason: null (shape stays bounded)", () => {
    // Both the success path and the catch path should attach
    // disabledReason: null so the field is always present.
    const successMatch = QUEUE_INVENTORY_SRC.match(
      /classifyHealth\(projection\)[\s\S]{0,200}disabledReason:\s*null/,
    );
    expect(successMatch).toBeTruthy();
    const outageMatch = QUEUE_INVENTORY_SRC.match(
      /health:\s*"outage"[\s\S]{0,200}disabledReason:\s*null/,
    );
    expect(outageMatch).toBeTruthy();
  });
});
