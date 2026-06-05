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
 *   D. mi-ocr / mi-transcript queues are surfaced as "disabled" with
 *      an honest reason copy through getQueueInventory.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  PRODUCER_REASON_COPY,
  resolveProducerModeStatuses,
} from "@proovra/shared-runtime/media-intelligence";

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
const QUEUE_SRC = readSource(
  resolve(
    repoRoot,
    "services/api/src/queue/media-intelligence-queue.ts",
  ),
);
const WORKER_QUEUE_SRC = readSource(
  resolve(repoRoot, "services/worker/src/queue.ts"),
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
    $queryRawUnsafe: async (..._args: any[]) => [],
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

describe("Phase Repair Task C — compute_duplicates / compute_lineage dropped from queue vocab", () => {
  it("API-side MEDIA_INTELLIGENCE_JOB_KINDS array no longer contains the dead kinds as live entries", () => {
    const arrayMatch = QUEUE_SRC.match(
      /MEDIA_INTELLIGENCE_JOB_KINDS\s*=\s*\[([\s\S]*?)\]\s*as const/,
    );
    expect(arrayMatch, "MEDIA_INTELLIGENCE_JOB_KINDS array not found").toBeTruthy();
    const arrayBody = arrayMatch?.[1] ?? "";
    // Array body should NOT include the string literal entries.
    expect(arrayBody).not.toMatch(/^\s*"compute_duplicates",?\s*$/m);
    expect(arrayBody).not.toMatch(/^\s*"compute_lineage",?\s*$/m);
  });

  it("worker MediaIntelligenceJobKind type union no longer contains the dead kinds", () => {
    const typeMatch = WORKER_QUEUE_SRC.match(
      /export type MediaIntelligenceJobKind\s*=([\s\S]*?);/,
    );
    expect(typeMatch, "MediaIntelligenceJobKind union not found").toBeTruthy();
    const unionBody = typeMatch?.[1] ?? "";
    expect(unionBody).not.toMatch(/\|\s*"compute_duplicates"/);
    expect(unionBody).not.toMatch(/\|\s*"compute_lineage"/);
  });

  it("documents why the dead kinds were dropped (comment block survives)", () => {
    // We keep the explanation so future contributors don't re-add the
    // kinds without checking the run-tracker DB enum context.
    expect(QUEUE_SRC).toMatch(/compute_duplicates.*compute_lineage|compute_lineage.*compute_duplicates/s);
  });
});

// ===========================================================================
// Task D — mi-ocr / mi-transcript surfaced as disabled
// ===========================================================================

describe("Phase Repair Task D — mi-ocr / mi-transcript queues are honestly disabled", () => {
  it("queue-inventory declares a 'disabled' QueueHealthStatus value", () => {
    expect(QUEUE_INVENTORY_SRC).toMatch(
      /export type QueueHealthStatus\s*=[\s\S]*?\|\s*"disabled"/,
    );
  });

  it("QueueInventoryItem carries a disabledReason field", () => {
    expect(QUEUE_INVENTORY_SRC).toMatch(/disabledReason:\s*string\s*\|\s*null/);
  });

  it("DISABLED_QUEUES map lists mi-ocr and mi-transcript with operator-grade reasons", () => {
    expect(QUEUE_INVENTORY_SRC).toMatch(/DISABLED_QUEUES.*=\s*\{/s);
    expect(QUEUE_INVENTORY_SRC).toMatch(/"mi-ocr"\s*:\s*"[^"]+"/);
    expect(QUEUE_INVENTORY_SRC).toMatch(/"mi-transcript"\s*:\s*"[^"]+"/);
  });

  it("reasons do NOT leak internal release-train language", () => {
    const mapMatch = QUEUE_INVENTORY_SRC.match(
      /const DISABLED_QUEUES:[\s\S]*?\n\};/,
    );
    expect(mapMatch).toBeTruthy();
    const mapBody = mapMatch?.[0] ?? "";
    expect(mapBody).not.toMatch(/Wave\s*\d/i);
    expect(mapBody).not.toMatch(/Phase\s*\d/i);
    expect(mapBody).not.toMatch(/TODO|FIXME/);
    // Operator gets a real explanation of where automatic extraction
    // actually runs.
    expect(mapBody).toMatch(/media-intelligence/);
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
