/**
 * PHASE 12 — POINT 5, STEP 0.2: the media-intelligence job-kind reconciliation.
 *
 * THE CONTRADICTION THIS RESOLVES
 * ---------------------------------------------------------------------------
 * Point-5 reporting said "12 reachable job kinds" in one place and "14 allowed
 * kinds" in another. Both numbers were correct and they measured different
 * things, which is exactly the shape of drift this phase exists to remove — so
 * the sets are now derived independently and reconciled here, mechanically.
 *
 *   12 = the QUEUE vocabulary   (`MEDIA_INTELLIGENCE_JOB_KINDS`)
 *   14 = the RUN-ROW vocabulary (`MEDIA_INTELLIGENCE_RUN_KINDS`, and the
 *        database CHECK constraint that must accept every persistable kind)
 *
 * The difference is exactly two: `compute_duplicates` and `compute_lineage`.
 * No producer enqueues them and no queue accepts them, but historical rows
 * carry them, and narrowing the DB constraint would make those rows
 * unreadable through any path that revalidates. They are LEGACY-ONLY, and that
 * is a disposition rather than an oversight.
 *
 * WHY THIS IS A TEST AND NOT A DOCUMENT
 * ---------------------------------------------------------------------------
 * The four zero-metrics below are the ones that actually matter, and each is a
 * relation between two live values:
 *
 *   * a kind that is producible but DB-rejected cannot have a run row created,
 *     which is what made `runId` optional and produced jobs no reconciler could
 *     find — the original Point-5 defect;
 *   * a kind that is producible but unprocessed is a job that completes as a
 *     silent no-op;
 *   * a kind that is processable but unregistered is a branch nobody can reach;
 *   * a DB-allowed kind with no disposition is drift waiting to be discovered.
 *
 * A prose table cannot fail. This can.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { MEDIA_INTELLIGENCE_JOB_KINDS } from "@proovra/shared";
import { MEDIA_INTELLIGENCE_RUN_KINDS } from "@proovra/shared-runtime/media-intelligence";

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

function read(rel: string): string {
  return readFileSync(resolve(REPO, rel), "utf8");
}

const PROCESSOR_SRC = read(
  "services/worker/src/media-intelligence.processor.ts",
);

// ===========================================================================
// Independently derived sets
// ===========================================================================

/**
 * The kinds the DATABASE will accept, read from the migration that defines the
 * constraint rather than from any TypeScript catalog. This is deliberately a
 * different source from the registry: if they agreed only because one was
 * copied from the other, the reconciliation would prove nothing.
 */
const DB_ALLOWED_KINDS: ReadonlyArray<string> = (() => {
  const sql = read(
    "services/api/prisma/migrations/20271114000000_point5_media_intelligence_kind_catalog/migration.sql",
  );
  const check = sql.slice(
    sql.indexOf('ADD CONSTRAINT "media_intelligence_runs_kind_bounded"'),
  );
  const list = check.slice(check.indexOf("("), check.indexOf("));"));
  return [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();
})();

/** Kinds a PROCESSOR branch handles explicitly. */
const EXPLICITLY_HANDLED: ReadonlyArray<string> = [
  ...new Set(
    [...PROCESSOR_SRC.matchAll(/kind === "([a-z_]+)"/g)].map((m) => m[1]!),
  ),
].sort();

/**
 * Kinds that reach the ANALYZER by falling through every explicit branch.
 *
 * Stated rather than derived, because "the default branch" is not something a
 * regex can identify — but it IS checkable: the assertion below proves each of
 * these is genuinely absent from every explicit branch and from the reserved
 * drain, so falling through is the only thing that can happen to them.
 */
const ANALYZER_FALLTHROUGH: ReadonlyArray<string> = [
  "analyze_metadata",
  "reconcile",
  "wire_ocr_transcript",
];

/** Kinds the reserved-drain branch completes without work. */
const RESERVED_DRAIN: ReadonlyArray<string> = [
  "extract_assets",
  "reindex",
  "compute_duplicates",
  "compute_lineage",
];

/**
 * Kinds a real PRODUCER emits. Derived from `kind:` literals at enqueue sites
 * across both services plus shared-runtime, and from the two similarity
 * producers which pass their kind through a typed helper.
 */
const PRODUCER_EMITTED: ReadonlyArray<string> = (() => {
  const sources = [
    read("services/api/src/services/evidence-finalization-fanout.service.ts"),
    read("services/api/src/routes/media-intelligence.routes.ts"),
    PROCESSOR_SRC,
  ].join("\n");
  const emitted = new Set<string>();
  for (const m of sources.matchAll(/kind:\s*"([a-z_]+)"/g)) {
    if ((MEDIA_INTELLIGENCE_RUN_KINDS as ReadonlyArray<string>).includes(m[1]!)) {
      emitted.add(m[1]!);
    }
  }
  return [...emitted].sort();
})();

/**
 * The explicit disposition of every DB-allowed kind.
 *
 * `UnclassifiedAllowedJobKinds = 0` is the assertion that this map covers the
 * constraint exactly — no kind the database accepts is missing a reason to
 * exist, and no entry here names a kind the database would reject.
 */
const DISPOSITIONS: Record<
  string,
  "produced_and_processed" | "processed_only" | "analyzer_fallthrough" | "legacy_only" | "reserved_drain"
> = {
  // Real producers emit these and explicit processor branches handle them.
  analyze_metadata: "analyzer_fallthrough",
  extract_exif: "produced_and_processed",
  compute_perceptual_hashes: "produced_and_processed",
  extract_ocr_azure: "produced_and_processed",
  extract_transcript_deepgram: "produced_and_processed",
  extract_technical_metadata: "produced_and_processed",
  // Emitted by the text-similarity producer wired in Point 5, handled by the
  // promotion branch. Before Point 5 this path was unreachable twice over: the
  // selector was an optional payload field nobody set, and after that was
  // fixed there was still no producer.
  reconcile_ocr_similarity: "produced_and_processed",
  reconcile_transcript_similarity: "produced_and_processed",
  // Reach the analyzer by falling through every explicit branch.
  reconcile: "analyzer_fallthrough",
  wire_ocr_transcript: "analyzer_fallthrough",
  // Registered and drained without work, pending a future processor.
  extract_assets: "reserved_drain",
  reindex: "reserved_drain",
  // Not in the queue vocabulary at all. Historical rows only.
  compute_duplicates: "legacy_only",
  compute_lineage: "legacy_only",
};

// ===========================================================================
// The reconciliation
// ===========================================================================

describe("Point 5 — media-intelligence job-kind reconciliation", () => {
  it("the two reported numbers are 12 queue kinds and 14 run-row kinds", () => {
    // Both figures were right; they measured different vocabularies.
    expect(MEDIA_INTELLIGENCE_JOB_KINDS).toHaveLength(12);
    expect(MEDIA_INTELLIGENCE_RUN_KINDS).toHaveLength(14);
    expect(DB_ALLOWED_KINDS).toHaveLength(14);
  });

  it("the difference is exactly the two legacy-only kinds", () => {
    const queue = new Set<string>(MEDIA_INTELLIGENCE_JOB_KINDS);
    const extra = (MEDIA_INTELLIGENCE_RUN_KINDS as ReadonlyArray<string>)
      .filter((k) => !queue.has(k))
      .sort();
    expect(extra).toEqual(["compute_duplicates", "compute_lineage"]);
    for (const k of extra) {
      expect(DISPOSITIONS[k]).toBe("legacy_only");
    }
  });

  it("UnclassifiedAllowedJobKinds = 0", () => {
    const undisposed = DB_ALLOWED_KINDS.filter((k) => !DISPOSITIONS[k]);
    expect(undisposed, undisposed.join(", ")).toEqual([]);
    // And no disposition names a kind the database would reject.
    const phantom = Object.keys(DISPOSITIONS).filter(
      (k) => !DB_ALLOWED_KINDS.includes(k),
    );
    expect(phantom, phantom.join(", ")).toEqual([]);
  });

  it("DatabaseRejectedReachableJobKinds = 0", () => {
    // The original Point-5 defect: four kinds the worker implements and
    // producers enqueue were REJECTED by the CHECK constraint, so no run row
    // could be created for them — which is why `runId` had become optional.
    const rejected = (MEDIA_INTELLIGENCE_RUN_KINDS as ReadonlyArray<string>)
      .filter((k) => !DB_ALLOWED_KINDS.includes(k))
      .sort();
    expect(rejected, rejected.join(", ")).toEqual([]);
    // Every ENQUEUEABLE kind must also be persistable, or the job is orphaned.
    const unpersistable = (MEDIA_INTELLIGENCE_JOB_KINDS as ReadonlyArray<string>)
      .filter((k) => !DB_ALLOWED_KINDS.includes(k))
      .sort();
    expect(unpersistable, unpersistable.join(", ")).toEqual([]);
  });

  it("ProducibleUnprocessedJobKinds = 0", () => {
    // Every kind a producer can emit is either handled by an explicit branch,
    // reaches the analyzer, or is an acknowledged reserved drain.
    const handled = new Set([
      ...EXPLICITLY_HANDLED,
      ...ANALYZER_FALLTHROUGH,
      ...RESERVED_DRAIN,
    ]);
    const unhandled = PRODUCER_EMITTED.filter((k) => !handled.has(k));
    expect(unhandled, unhandled.join(", ")).toEqual([]);
    // The producer set is non-empty — otherwise this assertion is vacuous.
    expect(PRODUCER_EMITTED.length).toBeGreaterThan(5);
  });

  it("ProcessableUnregisteredJobKinds = 0", () => {
    // A branch nobody can address is dead code. Every explicitly handled kind
    // must be in the queue vocabulary.
    const unregistered = EXPLICITLY_HANDLED.filter(
      (k) => !(MEDIA_INTELLIGENCE_JOB_KINDS as ReadonlyArray<string>).includes(k),
    );
    expect(unregistered, unregistered.join(", ")).toEqual([]);
  });

  it("the analyzer-fallthrough kinds genuinely fall through", () => {
    // They must appear in NO explicit branch and in NO reserved-drain arm,
    // otherwise "falls through to the analyzer" is a story rather than a fact.
    for (const k of ANALYZER_FALLTHROUGH) {
      expect(EXPLICITLY_HANDLED, `${k} has an explicit branch`).not.toContain(k);
      expect(RESERVED_DRAIN, `${k} is drained`).not.toContain(k);
      expect(MEDIA_INTELLIGENCE_JOB_KINDS).toContain(k);
    }
  });

  it("JobKindMismatches = 0 — no spelling drift between any two sources", () => {
    // Every name in every set is drawn from the same alphabet and appears in
    // the DB constraint. A typo in any one source shows up here as a kind that
    // exists in one place and nowhere else.
    const everywhere = new Set<string>([
      ...MEDIA_INTELLIGENCE_JOB_KINDS,
      ...MEDIA_INTELLIGENCE_RUN_KINDS,
      ...DB_ALLOWED_KINDS,
      ...EXPLICITLY_HANDLED,
      ...ANALYZER_FALLTHROUGH,
      ...RESERVED_DRAIN,
      ...PRODUCER_EMITTED,
    ]);
    const orphans = [...everywhere].filter(
      (k) => !DB_ALLOWED_KINDS.includes(k),
    );
    expect(orphans, `names appearing outside the DB catalog: ${orphans.join(", ")}`).toEqual([]);
  });

  it("the text-similarity capability is REACHABLE — producer, kind and branch", () => {
    // The defect this closes, stated as the property that was false twice.
    //
    // Originally the promotion path was selected by an optional `textKind`
    // payload field that no producer set. Point 5 turned that into a run kind,
    // which made it ADDRESSABLE — and it was still unreachable, because
    // nothing emitted the new kind. Both halves are now wired.
    for (const kind of [
      "reconcile_ocr_similarity",
      "reconcile_transcript_similarity",
    ]) {
      expect(MEDIA_INTELLIGENCE_JOB_KINDS).toContain(kind);
      expect(MEDIA_INTELLIGENCE_RUN_KINDS).toContain(kind);
      expect(DB_ALLOWED_KINDS).toContain(kind);
      expect(EXPLICITLY_HANDLED).toContain(kind);
      expect(PRODUCER_EMITTED).toContain(kind);
      expect(DISPOSITIONS[kind]).toBe("produced_and_processed");
    }
    // The producer commits a durable run BEFORE enqueuing its id — the same
    // ordering every converged chain uses.
    const producerIdx = PROCESSOR_SRC.indexOf(
      "async function enqueueTextSimilarityPass",
    );
    expect(producerIdx).toBeGreaterThan(-1);
    const body = PROCESSOR_SRC.slice(producerIdx, producerIdx + 2000);
    const runIdx = body.indexOf("enqueueMediaIntelligenceRun(");
    const enqueueIdx = body.indexOf("enqueueMediaIntelligenceRunById(");
    expect(runIdx).toBeGreaterThan(-1);
    expect(enqueueIdx).toBeGreaterThan(runIdx);
  });
});
