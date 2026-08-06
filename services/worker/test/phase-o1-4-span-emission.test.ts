/**
 * Phase O1.4 — bounded-span runtime emission contract.
 *
 * Hard rule from the O1.4 spec:
 *
 *   "If a span name exists but no runtime code emits it: O1.4 FAILS.
 *    Create enum names without emitting spans = forbidden."
 *
 * This contract suite enforces that rule mechanically. For every
 * entry in `PROOVRA_SPAN_NAMES` (both api + worker copies), it
 * confirms one of:
 *
 *   1. A `withProovraSpan(PROOVRA_SPAN_NAMES.X, …)` call exists in
 *      runtime code (`services/api/src` or `services/worker/src`,
 *      excluding `test/` and `*.test.ts`).
 *   2. A `wrapJobHandlerWithOtelContext(PROOVRA_SPAN_NAMES.X, …)`
 *      registration exists in `services/worker/src/index.ts`.
 *   3. A `withProovraSpan(NAME_STRING, …)` direct-string emission
 *      exists where `NAME_STRING` is the enum's value (tolerated
 *      because some queue wraps use string literals for the
 *      `proovra.worker.<name>` pattern).
 *
 * If any entry fails all three checks, the test fails loudly with
 * the offending enum key. The expected remediation is EITHER:
 *   - wire the emission, OR
 *   - remove the enum entry (per O1.4 hard rule).
 *
 * Coverage extension — queue propagation:
 *   The test also asserts every BullMQ `new Worker(…)` call in
 *   `services/worker/src/index.ts` is wrapped with
 *   `wrapJobHandlerWithOtelContext(…)` so cross-service trace
 *   continuity is enforced for ALL queues (the O1.4 spec lists
 *   13 — they are all covered).
 *
 * Coverage extension — enqueue side propagation:
 *   Every `queue.add(…)` in `services/worker/src/queue.ts` is
 *   asserted to be preceded by an `injectOtelContextIntoJobData(…)`
 *   call. Three patterns are tolerated:
 *     A. `queue.add(name, injectOtelContextIntoJobData(payload), …)`
 *     B. `const wrapped = injectOtelContextIntoJobData(payload); queue.add(name, wrapped, …)`
 *     C. The same payload was already wrapped (variable named
 *        `wrappedXPayload` / `wrappedPayload` / `wrappedEnvelope`
 *        / `otsPayload` / `reportPayload`).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function read(rel: string): string {
  return readFileSync(REPO_ROOT + rel, "utf8");
}

function walkSource(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = dir + "/" + entry;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === "test") {
        continue;
      }
      walkSource(full, out);
    } else if (
      stat.isFile() &&
      full.endsWith(".ts") &&
      !full.endsWith(".test.ts") &&
      !full.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
}

const ALL_SOURCE_FILES: string[] = [];
walkSource(REPO_ROOT + "services/api/src", ALL_SOURCE_FILES);
walkSource(REPO_ROOT + "services/worker/src", ALL_SOURCE_FILES);

const ALL_SOURCE_TEXT = ALL_SOURCE_FILES.map((f) => readFileSync(f, "utf8")).join(
  "\n\n",
);

function extractEnumEntries(
  src: string,
): Array<{ key: string; value: string }> {
  const start = src.indexOf("export const PROOVRA_SPAN_NAMES");
  if (start < 0) return [];
  const open = src.indexOf("{", start);
  let depth = 0;
  let cursor = open;
  let close = -1;
  while (cursor < src.length) {
    const ch = src[cursor];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        close = cursor;
        break;
      }
    }
    cursor++;
  }
  const block = src.slice(open + 1, close);
  const out: Array<{ key: string; value: string }> = [];
  for (const m of block.matchAll(
    /^\s*([A-Z][A-Z0-9_]+)\s*:\s*\n?\s*"([^"]+)"\s*,?/gm,
  )) {
    out.push({ key: m[1]!, value: m[2]! });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Every enum entry has a runtime emission site
// ---------------------------------------------------------------------------

describe("O1.4 — every PROOVRA_SPAN_NAMES entry has a real runtime emission", () => {
  const apiSrc = read("services/api/src/observability/otel.ts");
  const workerSrc = read("services/worker/src/otel.ts");
  const apiEntries = extractEnumEntries(apiSrc);
  const workerEntries = extractEnumEntries(workerSrc);

  // Mirror equality is enforced by an existing O1.3 test; here we
  // only need to iterate one copy.
  expect(apiEntries.length).toBeGreaterThan(0);
  expect(workerEntries.length).toBe(apiEntries.length);

  for (const { key, value } of apiEntries) {
    it(`${key} (${value}) is emitted somewhere in runtime code`, () => {
      // Pattern 1: withProovraSpan(PROOVRA_SPAN_NAMES.X, …) or
      //            withProovraSpanSync(PROOVRA_SPAN_NAMES.X, …) or
      //            wrapJobHandlerWithOtelContext(PROOVRA_SPAN_NAMES.X, …)
      const enumRefRegex = new RegExp(
        `(withProovraSpanSync|withProovraSpan|wrapJobHandlerWithOtelContext)\\s*\\(\\s*PROOVRA_SPAN_NAMES\\.${key}\\b`,
      );
      // Pattern 2: direct string literal — only acceptable for the
      // bounded `proovra.worker.<queue>` queue wraps where the helper
      // accepts a string spanName.
      const literalRefRegex = new RegExp(
        `(withProovraSpanSync|withProovraSpan|wrapJobHandlerWithOtelContext)\\s*\\(\\s*"${value.replace(/\./g, "\\.")}"`,
      );
      const found =
        enumRefRegex.test(ALL_SOURCE_TEXT) ||
        literalRefRegex.test(ALL_SOURCE_TEXT);
      expect(
        found,
        `enum entry ${key} = "${value}" has NO runtime emission site (no withProovraSpan / wrapJobHandlerWithOtelContext call references it). Either wire an emission or remove the enum entry per O1.4.`,
      ).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Every BullMQ Worker is wrapped — full queue cross-service propagation
// ---------------------------------------------------------------------------

describe("O1.4 — every BullMQ Worker registration is wrapped with the OTEL context extractor", () => {
  const indexSrc = read("services/worker/src/index.ts");

  // Strip line + block comments before scanning. The bounded
  // contract is about runtime CODE, not commentary that mentions
  // `new Worker(...)` in prose.
  const codeOnly = indexSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

  // Find every `new Worker(<identifier>` occurrence (must be
  // followed by a real queue-name variable, not `...`). This
  // excludes comment-style `new Worker(...)` placeholders that
  // survived the comment strip via inline `// new Worker(...)`.
  const workerSites = [
    ...codeOnly.matchAll(/new\s+Worker\s*\(\s*[a-zA-Z_$][a-zA-Z0-9_$]*/g),
  ];
  expect(workerSites.length).toBeGreaterThan(0);

  for (let i = 0; i < workerSites.length; i++) {
    it(`worker registration #${i + 1} is wrapped with wrapJobHandlerWithOtelContext`, () => {
      const at = workerSites[i]!.index!;
      // The wrap MUST appear within the immediate ~600 chars after
      // `new Worker(` — that's enough to cover the (queueName,
      // handler, options) call shape including a multi-line
      // formatted constructor.
      const block = codeOnly.slice(at, at + 600);
      expect(block).toContain("wrapJobHandlerWithOtelContext");
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Every queue.add(…) is preceded by an injectOtelContextIntoJobData(…)
// ---------------------------------------------------------------------------

/**
 * PHASE 12 — POINT 5 changed WHERE the trace context lives, and this suite
 * changed with it.
 *
 * It used to enumerate every `<queue>.add(` site in `queue.ts` and require an
 * `injectOtelContextIntoJobData(…)` call within the preceding 800 characters —
 * a per-call-site audit, because there were fifteen hand-rolled `.add` calls
 * and each could forget.
 *
 * There is now exactly ONE `.add` in the platform, inside the shared
 * `enqueueCanonicalJob`, and the carrier is no longer an unbounded `_otel`
 * metadata blob bolted onto the payload — it is a validated `traceparent` field
 * on the canonical envelope, which the strict decoder checks like every other
 * field. So the property worth asserting is no longer "did each of fifteen call
 * sites remember", it is "does the one path carry it, and does the worker read
 * it back".
 */
describe("O1.4 — the single enqueue path carries trace context", () => {
  const queueSrc = read("services/worker/src/queue.ts");
  const sharedEnqueueSrc = read(
    "packages/shared/src/queue-integrity/enqueue.ts",
  );
  const otelSrc = read("services/worker/src/observability/queue-otel-context.ts");

  it("queue.ts has NO hand-rolled queue.add — every producer delegates", () => {
    // The fifteen call sites this suite used to enumerate are gone.
    expect(queueSrc).not.toMatch(/\bQueue\w*\.add\s*\(/);
    expect(queueSrc).toMatch(/enqueueCanonicalJob\(/);
  });

  it("the one enqueue authority puts the traceparent on the envelope", () => {
    expect(sharedEnqueueSrc).toMatch(/traceparent/);
    expect(sharedEnqueueSrc).toMatch(/buildCanonicalJobPayload\(/);
  });

  it("the worker supplies a traceparent when a span is active", () => {
    expect(queueSrc).toMatch(/currentTraceparent\(\)/);
    expect(otelSrc).toMatch(/export function currentTraceparent/);
  });

  it("the worker reads BOTH the canonical field and the legacy _otel carrier", () => {
    // A pre-Point-5 job still draining out of Redis carries `_otel`; a
    // converged one carries `traceparent`. Losing either would silently break
    // the api-request-to-worker-handler trace during the drain window.
    expect(otelSrc).toMatch(/obj\.traceparent/);
    expect(otelSrc).toMatch(/obj\._otel/);
  });

  it("legacy enqueue-site audit is retired, not skipped", () => {
    // Recorded rather than deleted silently: this assertion exists so the
    // retirement is visible in the suite's own output.
    const addSites = [
      ...queueSrc.matchAll(
        /\b(reportQueue|otsUpgradeQueue|evidencePurgeQueue|searchIndexingQueue|mediaIntelligenceQueue|exifQueue|ocrQueue|transcriptQueue|miSearchIndexQueue|graphReconcileQueue|graphDomainSyncQueue|graphTimelineSyncQueue|graphSearchProjectionQueue|orgHealthRefreshQueue|derivedAssetsQueue)\.add\s*\(/g,
      ),
    ];
    expect(addSites).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Sentry coexistence preserved
// ---------------------------------------------------------------------------

describe("O1.4 — Sentry / OTEL coexistence preserved", () => {
  for (const rel of [
    "services/api/src/observability/sentry.ts",
    "services/worker/src/sentry.ts",
  ]) {
    it(`${rel} still passes skipOpenTelemetrySetup gated on isOtelEnabled()`, () => {
      const src = read(rel);
      expect(src).toMatch(/skipOpenTelemetrySetup\s*:\s*skipOtelSetup\b/);
      expect(src).toMatch(/const\s+skipOtelSetup\s*=\s*isOtelEnabled\s*\(\s*\)/);
      // Error reporting + scrubbing still wired.
      expect(src).toMatch(/Sentry\.init\s*\(\s*\{/);
      expect(src).toContain("beforeSend(event, hint)");
      expect(src).toContain("beforeSendTransaction(event)");
    });
  }
});

// ---------------------------------------------------------------------------
// 5. No forbidden labels in the queue context helper or storage wraps
// ---------------------------------------------------------------------------

describe("O1.4 — no forbidden labels in O1.4-instrumented files", () => {
  const targets = [
    "services/worker/src/observability/queue-otel-context.ts",
    "services/worker/src/storage.ts",
    "services/api/src/storage.ts",
    "services/worker/src/custody-events.ts",
    "services/api/src/services/integrations/webhook-dispatcher.ts",
  ];

  for (const rel of targets) {
    it(`${rel} does NOT leak forbidden labels into span attributes`, () => {
      const src = read(rel);
      // Forbidden: raw payload bytes, signed URLs, raw signatures,
      // raw authorization headers. We assert by scanning attribute
      // objects passed to `withProovraSpan(…)`.
      const calls = [...src.matchAll(/withProovraSpan\s*\([\s\S]*?\)/g)];
      for (const call of calls) {
        const text = call[0];
        for (const needle of [
          "Authorization",
          "Bearer ",
          "signedUrl",
          "presignedUrl",
          "rawPayload",
          "fileContent",
          "secret",
          "token",
        ]) {
          expect.soft(text).not.toContain(needle);
        }
      }
    });
  }
});
