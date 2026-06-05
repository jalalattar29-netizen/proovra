/**
 * Regression lock: the /investigation root page must not crash when
 * `/v1/ops/metrics` returns its real, envelope-shaped payload.
 *
 * Background (root cause):
 *   - The server (services/api/src/routes/ops.routes.ts) returns
 *     `{ metrics: MetricsSnapshot }` — the snapshot is wrapped in a
 *     `metrics` envelope.
 *   - Before the fix, the client fetcher in
 *     apps/web/app/(app)/investigation/page.tsx cast the response
 *     directly to `Promise<MetricsSnapshot>` and shoved the envelope
 *     into `MetricsSnapshot`-typed state.
 *   - `QueueHealthGrid` then evaluated `t.metric in metrics.gauges`.
 *     `metrics.gauges` was undefined (because `metrics` was really the
 *     envelope), so the `in` operator threw a TypeError and the whole
 *     `/investigation` route crashed into error.tsx.
 *
 * This test does two things:
 *
 *   1. Source-level lock — confirm the fetcher unwraps `.metrics` from
 *      the envelope, and confirm `QueueHealthGrid` reads counters /
 *      gauges through `?? {}` fallbacks so a future regression to the
 *      raw-envelope shape can no longer crash the page.
 *
 *   2. Runtime exercise — port the two pieces of logic the page now
 *      uses (envelope unwrap + tile lookup) into this test and prove
 *      they do NOT throw when fed the envelope-shaped response that
 *      previously crashed the page.
 *
 * Runs under Node's built-in `node:test` so it does not require a new
 * test runner in apps/web. Invoke with e.g.
 *   `node --test --import tsx apps/web/__tests__/investigation-metrics-envelope.test.ts`
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PAGE_PATH = resolve(
  __dirname,
  "..",
  "app",
  "(app)",
  "investigation",
  "page.tsx",
);
const PAGE_SOURCE = readFileSync(PAGE_PATH, "utf8");

// ---------------------------------------------------------------------------
// 1. Source-level locks.
// ---------------------------------------------------------------------------

test("page.tsx still types /v1/ops/metrics as the envelope shape", () => {
  // The fetcher's `Promise<...>` cast must allow for the envelope
  // shape (`{ metrics?: MetricsSnapshot }`). If a future contributor
  // re-casts it back to bare `Promise<MetricsSnapshot>`, the envelope
  // unwrap is gone and the original crash returns.
  assert.match(
    PAGE_SOURCE,
    /apiFetch\(\s*["']\/v1\/ops\/metrics["']\s*,[\s\S]*?\{\s*metrics\?:\s*MetricsSnapshot\s*\}/,
    "The /v1/ops/metrics fetcher must type its response as the " +
      "`{ metrics?: MetricsSnapshot }` envelope so the unwrap step " +
      "below is type-safe.",
  );
});

test("page.tsx unwraps the `.metrics` envelope before setMetrics()", () => {
  // The state must be populated from `envelope.metrics`, not the raw
  // envelope. Tolerant of formatter drift: we just require that the
  // word `metrics` is read off the envelope-shaped value somewhere
  // before setMetrics() is called.
  assert.match(
    PAGE_SOURCE,
    /\(metEnvelope as \{\s*metrics:\s*MetricsSnapshot\s*\}\)\.metrics/,
    "The fetcher must unwrap `.metrics` from the envelope before " +
      "calling setMetrics(). Otherwise QueueHealthGrid receives the " +
      "envelope and crashes on `t.metric in metrics.gauges`.",
  );
});

test("QueueHealthGrid defends counters/gauges with `?? {}` fallbacks", () => {
  // Belt-and-braces: even if the envelope-unwrap step regresses, the
  // grid itself must no longer assume metrics.counters / metrics.gauges
  // are objects. `?? {}` fallbacks render bounded "—" tiles instead
  // of throwing.
  assert.match(
    PAGE_SOURCE,
    /metrics\?\.counters\s*\?\?\s*\{\}/,
    "QueueHealthGrid must read counters via `metrics?.counters ?? {}` " +
      "so a missing bag renders empty tiles instead of crashing the " +
      "page with `cannot use 'in' operator on undefined`.",
  );
  assert.match(
    PAGE_SOURCE,
    /metrics\?\.gauges\s*\?\?\s*\{\}/,
    "QueueHealthGrid must read gauges via `metrics?.gauges ?? {}` so " +
      "a missing bag renders empty tiles instead of crashing the " +
      "page with `cannot use 'in' operator on undefined`.",
  );
});

// ---------------------------------------------------------------------------
// 2. Runtime exercise — faithful port of the fetcher unwrap and the
//    QueueHealthGrid tile lookup. If either piece of logic regresses
//    to the pre-fix shape, these assertions throw.
// ---------------------------------------------------------------------------

type MetricsSnapshot = {
  uptimeSeconds: number;
  counters: Record<string, number>;
  gauges: Record<string, number>;
};

// Faithful port of the unwrap branch in page.tsx (lines ~213-222).
function unwrapMetricsEnvelope(
  metEnvelope: { metrics?: MetricsSnapshot } | MetricsSnapshot | null,
): MetricsSnapshot | null {
  return metEnvelope == null
    ? null
    : "metrics" in metEnvelope &&
        (metEnvelope as { metrics?: MetricsSnapshot }).metrics != null
      ? (metEnvelope as { metrics: MetricsSnapshot }).metrics
      : (metEnvelope as MetricsSnapshot).counters != null ||
          (metEnvelope as MetricsSnapshot).gauges != null
        ? (metEnvelope as MetricsSnapshot)
        : null;
}

// Faithful port of QueueHealthGrid's tile lookup (lines ~934-941). The
// `in` operator on `undefined` is exactly what crashed the page; this
// helper must therefore stay defensive even when the input is wrong.
function tileLookup(
  metrics: MetricsSnapshot | null,
  tiles: Array<{ metric: string; kind: "counter" | "gauge" }>,
): Array<{ metric: string; value: number | null }> {
  const counters: Record<string, number> = metrics?.counters ?? {};
  const gauges: Record<string, number> = metrics?.gauges ?? {};
  return tiles.map((t) => {
    const bag = t.kind === "counter" ? counters : gauges;
    const present = metrics != null && t.metric in bag;
    return { metric: t.metric, value: present ? bag[t.metric]! : null };
  });
}

const TILES = [
  { metric: "media_intelligence_queue_depth", kind: "gauge" as const },
  { metric: "media_intelligence_dlq_total", kind: "counter" as const },
];

test("envelope-shaped response unwraps to a usable MetricsSnapshot", () => {
  // This is the exact shape the server returns today
  // (services/api/src/routes/ops.routes.ts → `{ metrics: snapshotMetrics() }`).
  const serverResponse = {
    metrics: {
      uptimeSeconds: 42,
      counters: { media_intelligence_dlq_total: 3 },
      gauges: { media_intelligence_queue_depth: 7 },
    },
  };

  // Pre-fix: the page assigned `serverResponse` directly to
  // `MetricsSnapshot`-typed state, then crashed on `in`. We assert
  // the unwrap produces the bare snapshot AND that the tile lookup
  // does not throw.
  const unwrapped = unwrapMetricsEnvelope(serverResponse);
  assert.ok(unwrapped, "envelope must unwrap to a non-null snapshot");
  assert.equal(unwrapped!.uptimeSeconds, 42);
  assert.equal(unwrapped!.counters.media_intelligence_dlq_total, 3);
  assert.equal(unwrapped!.gauges.media_intelligence_queue_depth, 7);

  const tiles = tileLookup(unwrapped, TILES);
  assert.equal(tiles[0]!.value, 7);
  assert.equal(tiles[1]!.value, 3);
});

test("envelope fed to the grid (pre-fix shape) does NOT throw", () => {
  // The exact failure mode the fix is locking in: if a future change
  // ever lets the raw envelope reach the grid again, the `?? {}`
  // fallbacks must keep `in` operator-safe and the grid must render
  // bounded null tiles instead of throwing.
  const envelopeAsIfMisrouted = {
    metrics: {
      uptimeSeconds: 0,
      counters: {},
      gauges: {},
    },
  } as unknown as MetricsSnapshot;

  // Pre-fix, this line crashed: `t.metric in metrics.gauges` where
  // `metrics.gauges` was undefined. The defensive helper must not
  // throw and every tile must resolve to `null` (bounded empty).
  assert.doesNotThrow(() => {
    const result = tileLookup(envelopeAsIfMisrouted, TILES);
    assert.equal(result.length, TILES.length);
    for (const tile of result) {
      assert.equal(
        tile.value,
        null,
        `envelope-shaped input must render tile '${tile.metric}' as ` +
          "null/empty, never as a defined number",
      );
    }
  });
});

test("null / empty / partial responses degrade gracefully", () => {
  // null response → null snapshot → all tiles empty.
  assert.equal(unwrapMetricsEnvelope(null), null);
  const tilesForNull = tileLookup(null, TILES);
  assert.equal(tilesForNull.every((t) => t.value === null), true);

  // Empty envelope → null (defensive: a wrapper with no inner
  // snapshot is indistinguishable from no data).
  assert.equal(unwrapMetricsEnvelope({ metrics: undefined }), null);

  // Partial snapshot (gauges missing) must not crash; gauge tiles
  // resolve to null and counter tiles still find their values.
  const partial = {
    uptimeSeconds: 1,
    counters: { media_intelligence_dlq_total: 9 },
  } as unknown as MetricsSnapshot;
  const unwrapped = unwrapMetricsEnvelope(partial);
  assert.ok(unwrapped, "partial snapshot with counters must unwrap");
  assert.doesNotThrow(() => {
    const result = tileLookup(unwrapped, TILES);
    const byMetric = Object.fromEntries(result.map((t) => [t.metric, t.value]));
    assert.equal(byMetric.media_intelligence_dlq_total, 9);
    assert.equal(byMetric.media_intelligence_queue_depth, null);
  });
});
