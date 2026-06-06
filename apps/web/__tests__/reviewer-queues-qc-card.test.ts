/**
 * PHASE RW3-3 — QC discovery card on /review/queues.
 *
 * Phase 0 decision: Option B (link only, count card). The queue Prisma
 * query is workflow-centric (`evidenceReviewWorkflow.findMany`) and
 * cannot cleanly absorb QcSample rows. Instead we render a top-of-page
 * discovery card backed by GET /v1/reviewer-ops/qc/pending-count, with
 * a link to the canonical /review/qc surface.
 *
 * What this test pins:
 *
 *   1. The page does NOT add a QC option to the queue filter or
 *      iterate QC rows into the workflow queue table.
 *   2. The page fetches /v1/reviewer-ops/qc/pending-count on mount,
 *      wrapped in try/catch with a structured warn log.
 *   3. The card renders a tagged FetchState (LOADING / FORBIDDEN /
 *      ERROR / READY) and surfaces bounded copy for each.
 *   4. The READY-zero branch is honest (renders "no pending QC
 *      samples"), never a fake banner.
 *   5. The card links to /review/qc — discovery hint, not duplicate.
 *
 * Runs under Node's built-in `node:test`. Invoke with e.g.
 *   `node --test --import tsx \
 *      apps/web/__tests__/reviewer-queues-qc-card.test.ts`
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { REVIEWER_OPS_QUEUE_TYPES } from "@proovra/shared";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PAGE_PATH = resolve(
  __dirname,
  "..",
  "app",
  "(app)",
  "review",
  "queues",
  "page.tsx",
);
const PAGE_SOURCE = readFileSync(PAGE_PATH, "utf8");

// ---------------------------------------------------------------------------
// 1. QC option is NOT added to the queue filter.
// ---------------------------------------------------------------------------

test("REVIEWER_OPS_QUEUE_TYPES still has no QC branch (decision-rule pin)", () => {
  // Phase 0 evidence: the canonical enum is workflow-centric. Adding a
  // QC branch would require unioning QcSample into the queue projection
  // — the decision rule went the other way and chose Option B.
  const qcLike = (REVIEWER_OPS_QUEUE_TYPES as ReadonlyArray<string>).filter(
    (q) => q.toUpperCase().includes("QC"),
  );
  assert.equal(
    qcLike.length,
    0,
    "REVIEWER_OPS_QUEUE_TYPES grew a QC branch — Option B (link only) " +
      "is no longer the right design and this test must be revisited.",
  );
});

test("queue filter does NOT render a fake QC option", () => {
  assert.ok(
    !PAGE_SOURCE.includes('value="QC"'),
    "Queue filter must not surface a fake QC option — the count card " +
      "is the canonical QC discovery surface on this page.",
  );
  assert.ok(
    !PAGE_SOURCE.includes('value="QC_SAMPLED"'),
    "Queue filter must not surface a fake QC_SAMPLED option.",
  );
});

test("queue table does NOT iterate QC rows into the workflow projection", () => {
  // The queue table only renders EvidenceReviewWorkflow rows. Mixing
  // QcSample rows would either need a union row type (we don't) or a
  // denormalised projection (we don't). Either would muddy the bulk-
  // assign / bulk-decide semantics. The decision rule chose Option B
  // to avoid that.
  assert.doesNotMatch(
    PAGE_SOURCE,
    /qcSamples\.map\(/,
    "Queue table must not iterate qcSamples — QC samples live in the " +
      "/review/qc surface.",
  );
  assert.doesNotMatch(
    PAGE_SOURCE,
    /qcRows\.map\(/,
    "Queue table must not iterate qcRows — QC samples live in the " +
      "/review/qc surface.",
  );
});

// ---------------------------------------------------------------------------
// 2. The page fetches the new endpoint with try/catch + warn log.
// ---------------------------------------------------------------------------

test("queue page fetches /v1/reviewer-ops/qc/pending-count", () => {
  assert.match(
    PAGE_SOURCE,
    /\/v1\/reviewer-ops\/qc\/pending-count/,
    "QC card must source its count from the new dedicated endpoint.",
  );
});

test("QC fetch is wrapped in try/catch with a structured warn log", () => {
  assert.match(
    PAGE_SOURCE,
    /refreshQc[\s\S]{0,2000}?console\.warn\(\s*"\[reviewer-workspace\] qc pending-count fetch failed"/,
    "QC fetch must emit a structured warn log on failure with the " +
      "status + code fields — silent failure is forbidden.",
  );
});

test("QC fetch runs on mount via its own useEffect (independent of queue)", () => {
  // A QC failure must not blank the queue and a queue failure must
  // not blank the QC card. They share a page, not a fetch.
  assert.match(
    PAGE_SOURCE,
    /useEffect\(\(\)\s*=>\s*\{[\s\S]{0,200}?void\s+refreshQc\(\)/,
    "QC card must have its own useEffect so it is fetched on mount " +
      "independently of the queue.",
  );
});

// ---------------------------------------------------------------------------
// 3. Tagged FetchState + bounded copy per state.
// ---------------------------------------------------------------------------

test("page declares the tagged QcDiscoveryState union", () => {
  assert.match(
    PAGE_SOURCE,
    /type\s+QcDiscoveryState\s*=/,
    "QC card state must be a tagged union so the UI renders one branch " +
      "at a time and the tests can pin each one.",
  );
  for (const tag of ['kind: "LOADING"', 'kind: "FORBIDDEN"', 'kind: "ERROR"', 'kind: "READY"']) {
    assert.ok(
      PAGE_SOURCE.includes(tag),
      `QcDiscoveryState must include the ${tag} variant.`,
    );
  }
});

test("QC card root carries data-reviewer-queue-qc-{card,state}", () => {
  assert.match(
    PAGE_SOURCE,
    /data-reviewer-queue-qc-card/,
    "QC card root must carry data-reviewer-queue-qc-card so tests can " +
      "target the element deterministically.",
  );
  assert.match(
    PAGE_SOURCE,
    /data-reviewer-queue-qc-state=\{state\.kind\}/,
    "QC card root must surface the tagged state for behavioural tests.",
  );
});

test("QC FORBIDDEN branch is bounded copy, no fake count", () => {
  assert.match(
    PAGE_SOURCE,
    /data-reviewer-queue-qc-denied/,
    "FORBIDDEN branch must render an element tagged " +
      "data-reviewer-queue-qc-denied.",
  );
  assert.match(
    PAGE_SOURCE,
    /QC samples are restricted in this workspace\./,
    "FORBIDDEN bounded copy must be operator-readable.",
  );
});

test("QC ERROR branch is bounded copy + retry, no silent zero", () => {
  assert.match(
    PAGE_SOURCE,
    /data-reviewer-queue-qc-error/,
    "ERROR branch must render an element tagged " +
      "data-reviewer-queue-qc-error.",
  );
  assert.match(
    PAGE_SOURCE,
    /data-reviewer-queue-qc-retry/,
    "ERROR branch must offer a retry button so operators can recover.",
  );
  assert.match(
    PAGE_SOURCE,
    /QC pending count could not be loaded\. Try again shortly\./,
    "ERROR bounded copy must be operator-readable.",
  );
});

// ---------------------------------------------------------------------------
// 4. READY-zero is honest, not a fake success banner.
// ---------------------------------------------------------------------------

test("QC READY-zero renders an honest empty-state line", () => {
  // pendingCount === 0 is a REAL outcome — no samples awaiting
  // verdict. We surface it honestly with bounded copy rather than
  // hiding the card (which would imply "no QC discovery" — a
  // different signal).
  assert.match(
    PAGE_SOURCE,
    /data-reviewer-queue-qc-empty/,
    "READY-zero must render an element tagged " +
      "data-reviewer-queue-qc-empty.",
  );
  assert.match(
    PAGE_SOURCE,
    /No QC samples are awaiting verdict\./,
    "READY-zero bounded copy must read honestly — not a fake banner.",
  );
});

test("QC READY-positive surfaces the real pendingCount", () => {
  assert.match(
    PAGE_SOURCE,
    /data-reviewer-queue-qc-count=\{state\.pendingCount\}/,
    "READY-positive must surface the real pendingCount on a data " +
      "attribute so tests can pin the value.",
  );
  assert.match(
    PAGE_SOURCE,
    /sample[\s\S]{0,80}?awaiting verdict\./,
    "READY-positive copy must include the verdict-awaiting phrase.",
  );
});

// ---------------------------------------------------------------------------
// 5. Discovery link to /review/qc.
// ---------------------------------------------------------------------------

test("QC card renders a link to /review/qc (discovery hint, not duplicate)", () => {
  assert.match(
    PAGE_SOURCE,
    /href="\/review\/qc"/,
    "QC card must link to /review/qc — the canonical QC samples surface.",
  );
  assert.match(
    PAGE_SOURCE,
    /data-reviewer-queue-qc-link/,
    "QC link must carry data-reviewer-queue-qc-link so tests can pin it.",
  );
});

// ---------------------------------------------------------------------------
// 6. Pure-function model of the QC fetch outcome → tagged state.
// ---------------------------------------------------------------------------

type QcDiscoveryState =
  | { kind: "LOADING" }
  | { kind: "FORBIDDEN"; message: string }
  | { kind: "ERROR"; message: string }
  | { kind: "READY"; pendingCount: number };

function classifyQcOutcome(input: {
  status?: number;
  code?: string;
  body?: { pendingCount?: unknown };
}): QcDiscoveryState {
  if (
    input.status === 403 ||
    input.code === "REVIEW_PERMISSION_DENIED" ||
    input.code === "NOT_PERMITTED" ||
    input.code === "FORBIDDEN"
  ) {
    return {
      kind: "FORBIDDEN",
      message: "QC samples are restricted in this workspace.",
    };
  }
  if (input.code !== undefined || (input.status ?? 200) >= 400) {
    return {
      kind: "ERROR",
      message: "QC pending count could not be loaded. Try again shortly.",
    };
  }
  const raw = input.body?.pendingCount;
  const pendingCount =
    typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  return { kind: "READY", pendingCount };
}

test("classifyQcOutcome maps 403 to FORBIDDEN", () => {
  const s = classifyQcOutcome({ status: 403 });
  assert.equal(s.kind, "FORBIDDEN");
});

test("classifyQcOutcome maps REVIEW_PERMISSION_DENIED to FORBIDDEN", () => {
  const s = classifyQcOutcome({ code: "REVIEW_PERMISSION_DENIED" });
  assert.equal(s.kind, "FORBIDDEN");
});

test("classifyQcOutcome maps unknown 5xx to ERROR", () => {
  const s = classifyQcOutcome({ status: 500, code: "SERVER_ERROR" });
  assert.equal(s.kind, "ERROR");
});

test("classifyQcOutcome maps OK 0 to READY pendingCount=0 (honest zero)", () => {
  const s = classifyQcOutcome({ body: { pendingCount: 0 } });
  assert.deepEqual(s, { kind: "READY", pendingCount: 0 });
});

test("classifyQcOutcome maps OK N to READY pendingCount=N", () => {
  const s = classifyQcOutcome({ body: { pendingCount: 7 } });
  assert.deepEqual(s, { kind: "READY", pendingCount: 7 });
});

test("classifyQcOutcome treats non-number pendingCount as 0 (honest fallback)", () => {
  // Server returning a malformed body would otherwise render `NaN`
  // — the page guards against it explicitly. We model the same here.
  const s = classifyQcOutcome({ body: { pendingCount: "lots" } });
  assert.deepEqual(s, { kind: "READY", pendingCount: 0 });
});

// ---------------------------------------------------------------------------
// 7. CANNOT_WIRE inventory: QC card is WIRED, but mixing into the
//    queue table remains CANNOT_WIRE by design.
// ---------------------------------------------------------------------------

test("CANNOT_WIRE inventory: QC discovery card is WIRED, queue mix stays NO", () => {
  const cannotWire = {
    qcDiscoveryCardWired:
      PAGE_SOURCE.indexOf("/v1/reviewer-ops/qc/pending-count") !== -1 &&
      PAGE_SOURCE.indexOf("data-reviewer-queue-qc-card") !== -1 &&
      PAGE_SOURCE.indexOf("data-reviewer-queue-qc-link") !== -1,
    qcMixedIntoQueueTable:
      // We deliberately do NOT mix QC rows into the workflow queue —
      // the decision rule chose Option B. This flag must STAY false.
      /qcSamples\.map\(|qcRows\.map\(/.test(PAGE_SOURCE),
  };
  assert.deepEqual(cannotWire, {
    qcDiscoveryCardWired: true,
    qcMixedIntoQueueTable: false,
  });
});
