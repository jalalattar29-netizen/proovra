/**
 * Phase O1.3 — final OTEL closure source contracts.
 *
 *   1. Single-version convergence: lockfile + virtual store both
 *      resolve `@opentelemetry/api` to exactly one version.
 *   2. Root `pnpm.overrides` pins `@opentelemetry/api`.
 *   3. Per-service `@opentelemetry/api` deps are pinned (no caret)
 *      and the same value as the root override.
 *   4. PROOVRA_SPAN_NAMES on api and worker are MIRROR-IDENTICAL
 *      (every key + value matches) — guards against drift.
 *   5. Every enum value is a bounded `proovra.*` namespace.
 *   6. Sentry coexistence remains: both `sentry.ts` files still
 *      pass `skipOpenTelemetrySetup: isOtelEnabled()`.
 *   7. Queue-OTEL context helper exists and exposes the three
 *      bounded helpers: inject / extract / wrap.
 *   8. `enqueueReportJob` and `enqueueOtsUpgradeJob` thread the
 *      payload through `injectOtelContextIntoJobData(...)`.
 *   9. Worker `index.ts` wraps `processGenerateReport` and
 *      `processOtsUpgrade` with `wrapJobHandlerWithOtelContext(...)`.
 *  10. `getOtelRuntimeDiagnostics()` returns the documented shape +
 *      NEVER reveals tokens / endpoint URLs / header values.
 *  11. The runtime-otel-health route surfaces the diagnostics block.
 *  12. No secret / token / bearer literal leaks from the new helper.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function read(rel: string): string {
  return readFileSync(REPO_ROOT + rel, "utf8");
}

// ---------------------------------------------------------------------------
// 1 + 2 + 3. Single-version convergence
// ---------------------------------------------------------------------------

describe("O1.3 — @opentelemetry/api single-version convergence", () => {
  it("root package.json pnpm.overrides pins @opentelemetry/api", () => {
    const pkg = JSON.parse(read("package.json")) as {
      pnpm?: { overrides?: Record<string, string> };
    };
    expect(pkg.pnpm?.overrides?.["@opentelemetry/api"]).toBeDefined();
    expect(pkg.pnpm?.overrides?.["@opentelemetry/api"]).toMatch(
      /^\d+\.\d+\.\d+$/,
    );
  });

  it("services/api/package.json pins @opentelemetry/api (no caret)", () => {
    const pkg = JSON.parse(read("services/api/package.json")) as {
      dependencies?: Record<string, string>;
    };
    const v = pkg.dependencies?.["@opentelemetry/api"];
    expect(v).toBeDefined();
    // Must NOT carry a caret / tilde — exact pin only.
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("services/worker/package.json pins @opentelemetry/api (no caret)", () => {
    const pkg = JSON.parse(read("services/worker/package.json")) as {
      dependencies?: Record<string, string>;
    };
    const v = pkg.dependencies?.["@opentelemetry/api"];
    expect(v).toBeDefined();
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("api + worker pin matches the root override pin", () => {
    const root = JSON.parse(read("package.json")) as {
      pnpm?: { overrides?: Record<string, string> };
    };
    const api = JSON.parse(read("services/api/package.json")) as {
      dependencies?: Record<string, string>;
    };
    const worker = JSON.parse(read("services/worker/package.json")) as {
      dependencies?: Record<string, string>;
    };
    const rootPin = root.pnpm?.overrides?.["@opentelemetry/api"];
    expect(api.dependencies?.["@opentelemetry/api"]).toBe(rootPin);
    expect(worker.dependencies?.["@opentelemetry/api"]).toBe(rootPin);
  });

  it("pnpm-lock.yaml NEVER references a second @opentelemetry/api version", () => {
    const lock = read("pnpm-lock.yaml");
    // Extract every appearance of a versioned api package spec.
    // Format we forbid: `@opentelemetry/api@1.X.Y` for ANY non-pinned
    // (1.9.1) value.
    const root = JSON.parse(read("package.json")) as {
      pnpm?: { overrides?: Record<string, string> };
    };
    const pinned = root.pnpm?.overrides?.["@opentelemetry/api"];
    expect(pinned).toBeDefined();
    const versions = new Set<string>();
    for (const m of lock.matchAll(/@opentelemetry\/api@(\d+\.\d+\.\d+)/g)) {
      versions.add(m[1]!);
    }
    // Tolerate zero matches (some lockfile shapes only reference the
    // package by short name in the `overrides` block). But if ANY
    // version is referenced, it MUST be the single pinned one.
    for (const v of versions) {
      expect.soft(v).toBe(pinned);
    }
  });

  it("node_modules/.pnpm has at most one @opentelemetry+api@* virtual store entry", () => {
    const pnpmDir = REPO_ROOT + "node_modules/.pnpm";
    if (!existsSync(pnpmDir)) {
      // Tolerate a missing node_modules in CI sandbox runs.
      return;
    }
    const entries = readdirSync(pnpmDir).filter((d) =>
      /^@opentelemetry\+api@\d+\.\d+\.\d+$/.test(d),
    );
    expect(entries.length).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 4 + 5. Bounded span enum mirror + namespace
// ---------------------------------------------------------------------------

describe("O1.3 — PROOVRA_SPAN_NAMES bounded enum + mirror", () => {
  const apiSrc = read("services/api/src/observability/otel.ts");
  const workerSrc = read("services/worker/src/otel.ts");

  function extractEnumEntries(
    src: string,
  ): Array<{ key: string; value: string }> {
    const start = src.indexOf("export const PROOVRA_SPAN_NAMES");
    expect(start).toBeGreaterThan(-1);
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

  it("api + worker enums are mirror-identical (same key→value pairs)", () => {
    const apiEntries = extractEnumEntries(apiSrc);
    const workerEntries = extractEnumEntries(workerSrc);
    expect(apiEntries.length).toBeGreaterThan(0);
    // Same set of keys, same values.
    const apiByKey = new Map(apiEntries.map((e) => [e.key, e.value]));
    const workerByKey = new Map(workerEntries.map((e) => [e.key, e.value]));
    expect(workerByKey.size).toBe(apiByKey.size);
    for (const [k, v] of apiByKey) {
      expect.soft(workerByKey.get(k)).toBe(v);
    }
    for (const [k, v] of workerByKey) {
      expect.soft(apiByKey.get(k)).toBe(v);
    }
  });

  it("every enum value is a bounded `proovra.*` namespace", () => {
    for (const src of [apiSrc, workerSrc]) {
      const entries = extractEnumEntries(src);
      for (const { value } of entries) {
        expect.soft(value.startsWith("proovra.")).toBe(true);
      }
    }
  });

  it("enum contains the O1.3 / O1.4 names with confirmed runtime emission", () => {
    // Phase O1.4 hard rule: every enum entry MUST be wired by a real
    // `withProovraSpan(…)` call OR a `wrapJobHandlerWithOtelContext(…)`
    // registration. Enum-only entries were removed in O1.4. The list
    // below is therefore the bounded subset of O1.3 / O1.4 names that
    // remain in the enum because each has a real call site (asserted
    // by `phase-o1-4-span-emission.test.ts`).
    const required = [
      "proovra.worker.report.generate",
      "proovra.worker.ots.upgrade",
      "proovra.worker.graph.reconcile",
      "proovra.custody.event.append",
      "proovra.s3.put_object",
      "proovra.s3.get_object",
      "proovra.s3.head_object",
      "proovra.webhook.dispatch",
    ];
    for (const src of [apiSrc, workerSrc]) {
      for (const v of required) {
        expect.soft(src).toContain(`"${v}"`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Sentry coexistence preserved
// ---------------------------------------------------------------------------

describe("O1.3 — Sentry coexistence preserved", () => {
  for (const [label, rel] of [
    ["api/sentry.ts", "services/api/src/observability/sentry.ts"],
    ["worker/sentry.ts", "services/worker/src/sentry.ts"],
  ] as const) {
    it(`${label} still passes skipOpenTelemetrySetup: isOtelEnabled()-derived`, () => {
      const src = read(rel);
      expect(src).toMatch(/skipOpenTelemetrySetup\s*:\s*skipOtelSetup\b/);
      expect(src).toMatch(/const\s+skipOtelSetup\s*=\s*isOtelEnabled\s*\(\s*\)/);
      // Error reporting still wired.
      expect(src).toMatch(/Sentry\.init\s*\(\s*\{/);
      expect(src).toMatch(/captureException/);
      // Bounded beforeSend / beforeSendTransaction still present.
      expect(src).toContain("beforeSend(event, hint)");
      expect(src).toContain("beforeSendTransaction(event)");
      // Sample rate env names still wired.
      expect(src).toContain('"SENTRY_TRACES_SAMPLE_RATE"');
      expect(src).toContain('"SENTRY_PROFILES_SAMPLE_RATE"');
    });
  }
});

// ---------------------------------------------------------------------------
// 7. Queue-OTEL context helper present + bounded shape
// ---------------------------------------------------------------------------

describe("O1.3 — queue-OTEL context helper", () => {
  const helperSrc = read(
    "services/worker/src/observability/queue-otel-context.ts",
  );

  it("exposes injectOtelContextIntoJobData / extractOtelContextFromJobData / wrapJobHandlerWithOtelContext", () => {
    expect(helperSrc).toMatch(
      /export\s+function\s+injectOtelContextIntoJobData/,
    );
    expect(helperSrc).toMatch(
      /export\s+function\s+extractOtelContextFromJobData/,
    );
    expect(helperSrc).toMatch(
      /export\s+function\s+wrapJobHandlerWithOtelContext/,
    );
  });

  it("uses the @opentelemetry/api propagation primitives (single global)", () => {
    expect(helperSrc).toMatch(/from\s+"@opentelemetry\/api"/);
    expect(helperSrc).toMatch(/propagation\.inject\(/);
    expect(helperSrc).toMatch(/propagation\.extract\(/);
    expect(helperSrc).toMatch(/context\.with\(/);
  });

  it("NEVER references forbidden span-attribute keys (raw payload, token, etc.)", () => {
    const forbidden = [
      "rawPayload",
      "fileContent",
      "evidence_content",
      "bearer ",
      "Authorization:",
    ];
    for (const needle of forbidden) {
      expect.soft(helperSrc.toLowerCase()).not.toContain(needle.toLowerCase());
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Enqueue paths inject OTEL context
// ---------------------------------------------------------------------------

describe("O1.3 — enqueue paths inject OTEL context", () => {
  const queueSrc = read("services/worker/src/queue.ts");

  it("imports injectOtelContextIntoJobData", () => {
    expect(queueSrc).toContain(
      'from "./observability/queue-otel-context.js"',
    );
    expect(queueSrc).toContain("injectOtelContextIntoJobData");
  });

  it("enqueueReportJob threads payload through injectOtelContextIntoJobData", () => {
    // Bounded scoping: find the function block and assert the helper
    // is invoked before queue.add.
    const start = queueSrc.indexOf("export async function enqueueReportJob");
    expect(start).toBeGreaterThan(-1);
    const tail = queueSrc.slice(start, start + 4000);
    expect(tail).toMatch(/injectOtelContextIntoJobData\(/);
    expect(tail).toMatch(/reportQueue\.add\(/);
  });

  it("enqueueOtsUpgradeJob threads payload through injectOtelContextIntoJobData", () => {
    const start = queueSrc.indexOf("export async function enqueueOtsUpgradeJob");
    expect(start).toBeGreaterThan(-1);
    const tail = queueSrc.slice(start, start + 4000);
    expect(tail).toMatch(/injectOtelContextIntoJobData\(/);
    expect(tail).toMatch(/otsUpgradeQueue\.add\(/);
  });
});

// ---------------------------------------------------------------------------
// 9. Worker handlers wrapped with the extractor
// ---------------------------------------------------------------------------

describe("O1.3 — worker handlers wrapped with OTEL context extractor", () => {
  const indexSrc = read("services/worker/src/index.ts");

  it("imports wrapJobHandlerWithOtelContext + PROOVRA_SPAN_NAMES", () => {
    expect(indexSrc).toContain(
      'from "./observability/queue-otel-context.js"',
    );
    expect(indexSrc).toContain("wrapJobHandlerWithOtelContext");
    expect(indexSrc).toContain("PROOVRA_SPAN_NAMES");
  });

  it("reportQueueName Worker wraps processGenerateReport", () => {
    expect(indexSrc).toMatch(
      /new\s+Worker\([\s\S]{0,200}reportQueueName[\s\S]{0,400}wrapJobHandlerWithOtelContext[\s\S]{0,300}processGenerateReport/,
    );
    expect(indexSrc).toContain("PROOVRA_SPAN_NAMES.WORKER_REPORT_GENERATE");
  });

  it("otsUpgradeQueueName Worker wraps processOtsUpgrade", () => {
    expect(indexSrc).toMatch(
      /new\s+Worker\([\s\S]{0,200}otsUpgradeQueueName[\s\S]{0,400}wrapJobHandlerWithOtelContext[\s\S]{0,300}processOtsUpgrade/,
    );
    expect(indexSrc).toContain("PROOVRA_SPAN_NAMES.WORKER_OTS_UPGRADE");
  });
});

// ---------------------------------------------------------------------------
// 10. Runtime diagnostics shape + safety
// ---------------------------------------------------------------------------

describe("O1.3 — runtime diagnostics safety", () => {
  const diagSrc = read("services/api/src/observability/otel-diagnostics.ts");

  it("exposes getOtelRuntimeDiagnostics with bounded shape", () => {
    expect(diagSrc).toMatch(/export\s+function\s+getOtelRuntimeDiagnostics/);
    // The documented return-shape fields.
    expect(diagSrc).toContain("otelEnabled");
    expect(diagSrc).toContain("serviceName");
    expect(diagSrc).toContain("endpointConfigured");
    expect(diagSrc).toContain("exporterKind");
    expect(diagSrc).toContain("packageVersions");
    expect(diagSrc).toContain("skipOpenTelemetrySetup");
    expect(diagSrc).toContain("tokenLength");
    expect(diagSrc).toContain("scheme");
  });

  it("NEVER reveals raw endpoint URL / header values / token from any return path", () => {
    // The helper reads env vars but only re-emits bounded summaries.
    // Source-contract floor: no template literal returns the raw
    // value of OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_HEADERS.
    const lines = diagSrc.split("\n");
    for (const line of lines) {
      // Permit reading them via `process.env.OTEL_EXPORTER_OTLP_*`
      // but forbid them being assigned into the returned object or
      // logged.
      if (line.includes("process.env.OTEL_EXPORTER_OTLP_ENDPOINT")) {
        // Allowed: comparing length / checking presence. Forbidden:
        // assigning the raw value to a returned field.
        expect.soft(line).not.toMatch(/:\s*process\.env\.OTEL_EXPORTER_OTLP_ENDPOINT/);
        expect.soft(line).not.toMatch(/return\s+process\.env\.OTEL_EXPORTER_OTLP_ENDPOINT/);
      }
      if (line.includes("process.env.OTEL_EXPORTER_OTLP_HEADERS")) {
        expect.soft(line).not.toMatch(/:\s*process\.env\.OTEL_EXPORTER_OTLP_HEADERS/);
        expect.soft(line).not.toMatch(/return\s+process\.env\.OTEL_EXPORTER_OTLP_HEADERS/);
      }
    }
  });

  it("summarises Authorization header with bounded scheme + tokenLength only", () => {
    expect(diagSrc).toMatch(/scheme\s*:\s*"Basic"/);
    expect(diagSrc).toMatch(/scheme\s*:\s*"Bearer"/);
    expect(diagSrc).toMatch(/scheme\s*:\s*"none"/);
    expect(diagSrc).toMatch(/tokenLength\s*:\s*\d+/);
  });
});

// ---------------------------------------------------------------------------
// 11. Route surfaces the diagnostics block
// ---------------------------------------------------------------------------

describe("O1.3 — runtime-otel-health route surfaces diagnostics", () => {
  const routeSrc = read("services/api/src/routes/runtime-otel-health.routes.ts");

  it("imports getOtelRuntimeDiagnostics + sends it on the reply", () => {
    expect(routeSrc).toContain("getOtelRuntimeDiagnostics");
    expect(routeSrc).toMatch(/send\(\s*\{\s*otel\s*,\s*diagnostics\s*\}\s*\)/);
  });

  it("still strips endpoint URL / headers / Authorization from the response source", () => {
    // Strip comments before checking.
    const stripped = routeSrc
      .split("\n")
      .filter((l) => !/^\s*\*/.test(l) && !/^\s*\/\//.test(l))
      .join("\n");
    expect(stripped).not.toMatch(/process\.env\.OTEL_EXPORTER_OTLP_HEADERS/);
    expect(stripped).not.toMatch(/process\.env\.OTEL_EXPORTER_OTLP_ENDPOINT/);
    expect(stripped).not.toMatch(/Authorization\s*:\s*[A-Z]/);
  });
});
