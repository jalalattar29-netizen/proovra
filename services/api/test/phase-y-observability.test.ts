/**
 * Phase Y — Observability platform regression tests.
 *
 * Covers:
 *   - Prometheus exposition format correctness + name/label safety
 *   - Trace context generation + W3C traceparent round-trip
 *   - withSpan helper duration + outcome reporting (success + error paths)
 *   - Alert threshold evaluation
 *   - Safe label set (forbidden-key filtering)
 *   - Metrics catalog completeness for Phase Y additions
 *   - Source contracts: /metrics endpoint + /v1/ops/alerts wiring
 *   - Source contracts: worker heartbeat + queue health sampler wiring
 *   - Source contracts: Sentry tag enrichment wiring
 *   - Privacy invariants: no raw-payload / no-secret prefixes in catalog
 *     OR allowed-label catalog
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  evaluateAlerts,
  formatPrometheusExposition,
  newTraceContext,
  OPERATIONAL_ALERT_THRESHOLDS,
  parseTraceParentHeader,
  safeLabelSet,
  sanitizePromLabelValue,
  traceParentHeader,
  withSpan,
  type PromMetric,
  type SpanSink,
} from "@proovra/shared";

function readSource(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(rel, import.meta.url)),
    "utf8",
  );
}

// -----------------------------------------------------------------------------
// Prometheus exposition format
// -----------------------------------------------------------------------------

describe("Phase Y — Prometheus exposition", () => {
  it("emits counter + gauge HELP and TYPE lines", () => {
    const out = formatPrometheusExposition({
      metrics: [
        {
          name: "evidence_finalized_total",
          kind: "counter",
          help: "Evidence finalized count",
          value: 42,
        },
        {
          name: "queue_backlog_count",
          kind: "gauge",
          value: 7,
        },
      ],
    });
    expect(out).toContain("# HELP evidence_finalized_total Evidence finalized count");
    expect(out).toContain("# TYPE evidence_finalized_total counter");
    expect(out).toContain("evidence_finalized_total 42");
    expect(out).toContain("# TYPE queue_backlog_count gauge");
    expect(out).toContain("queue_backlog_count 7");
    expect(out).toMatch(/\n$/);
  });

  it("attaches global labels to every sample", () => {
    const out = formatPrometheusExposition({
      globalLabels: [
        { name: "service", value: "proovra-api" },
        { name: "env", value: "prod" },
      ],
      metrics: [{ name: "uptime_seconds", kind: "gauge", value: 100 }],
    });
    expect(out).toContain(
      'uptime_seconds{service="proovra-api",env="prod"} 100',
    );
  });

  it("emits labelled samples for vector metrics", () => {
    const m: PromMetric = {
      name: "lifecycle_transition_total",
      kind: "counter",
      value: [
        {
          labels: [
            { name: "from", value: "ACTIVE" },
            { name: "to", value: "PENDING_DESTRUCTION" },
          ],
          value: 3,
        },
        {
          labels: [
            { name: "from", value: "ACTIVE" },
            { name: "to", value: "ON_HOLD" },
          ],
          value: 1,
        },
      ],
    };
    const out = formatPrometheusExposition({ metrics: [m] });
    expect(out).toContain(
      'lifecycle_transition_total{from="ACTIVE",to="PENDING_DESTRUCTION"} 3',
    );
    expect(out).toContain(
      'lifecycle_transition_total{from="ACTIVE",to="ON_HOLD"} 1',
    );
  });

  it("refuses to emit metrics with invalid names (no crash)", () => {
    const out = formatPrometheusExposition({
      metrics: [
        { name: "valid_metric", kind: "counter", value: 1 },
        { name: "1-bad-starts-with-digit", kind: "counter", value: 9999 },
        { name: "has spaces and \"quotes", kind: "gauge", value: 1 },
      ],
    });
    expect(out).toContain("valid_metric 1");
    expect(out).not.toContain("1-bad");
    expect(out).not.toContain("has spaces");
  });

  it("skips non-finite values silently", () => {
    const out = formatPrometheusExposition({
      metrics: [
        { name: "good", kind: "gauge", value: 5 },
        { name: "nan", kind: "gauge", value: NaN },
        { name: "inf", kind: "gauge", value: Infinity },
      ],
    });
    expect(out).toContain("good 5");
    expect(out).not.toMatch(/^nan/m);
    expect(out).not.toMatch(/^inf/m);
  });

  it("escapes backslash, double-quote, and newline in label values", () => {
    expect(sanitizePromLabelValue('say "hi"')).toBe('say \\"hi\\"');
    expect(sanitizePromLabelValue("path\\to\\file")).toBe(
      "path\\\\to\\\\file",
    );
    expect(sanitizePromLabelValue("line1\nline2")).toBe("line1\\nline2");
  });

  it("caps long label values", () => {
    const long = "x".repeat(500);
    expect(sanitizePromLabelValue(long).length).toBe(200);
  });
});

// -----------------------------------------------------------------------------
// Trace context
// -----------------------------------------------------------------------------

describe("Phase Y — Trace context", () => {
  it("generates a 32-char traceId and 16-char spanId", () => {
    const ctx = newTraceContext();
    expect(ctx.traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(ctx.spanId).toMatch(/^[a-f0-9]{16}$/);
    expect(ctx.parentSpanId).toBeUndefined();
    expect(ctx.sampled).toBe(1);
  });

  it("inherits traceId from parent and links via parentSpanId", () => {
    const parent = newTraceContext();
    const child = newTraceContext(parent);
    expect(child.traceId).toBe(parent.traceId);
    expect(child.parentSpanId).toBe(parent.spanId);
    expect(child.spanId).not.toBe(parent.spanId);
  });

  it("serializes to a W3C traceparent header", () => {
    const ctx: ReturnType<typeof newTraceContext> = {
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
      sampled: 1,
    };
    expect(traceParentHeader(ctx)).toBe(
      "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    );
  });

  it("parses a W3C traceparent header back into a context", () => {
    const ctx = parseTraceParentHeader(
      "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    );
    expect(ctx).not.toBeNull();
    expect(ctx!.traceId).toBe("0123456789abcdef0123456789abcdef");
    expect(ctx!.parentSpanId).toBe("0123456789abcdef");
    expect(ctx!.sampled).toBe(1);
  });

  it("rejects malformed traceparent values", () => {
    expect(parseTraceParentHeader(null)).toBeNull();
    expect(parseTraceParentHeader("")).toBeNull();
    expect(parseTraceParentHeader("00-tooshort-01")).toBeNull();
    expect(parseTraceParentHeader("nonsense")).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// withSpan
// -----------------------------------------------------------------------------

describe("Phase Y — withSpan", () => {
  it("reports an `ok` outcome with duration on success", async () => {
    const events: Array<Parameters<SpanSink>[0]> = [];
    const sink: SpanSink = (e) => events.push(e);
    const result = await withSpan(
      { name: "test.ok", sink, labels: { kind: "demo" } },
      async () => 42,
    );
    expect(result).toBe(42);
    expect(events.length).toBe(1);
    expect(events[0]!.name).toBe("test.ok");
    expect(events[0]!.outcome.status).toBe("ok");
    expect(events[0]!.labels.kind).toBe("demo");
  });

  it("reports an `error` outcome and rethrows", async () => {
    const events: Array<Parameters<SpanSink>[0]> = [];
    const sink: SpanSink = (e) => events.push(e);
    let thrown: Error | null = null;
    try {
      await withSpan({ name: "test.err", sink }, async () => {
        throw new Error("boom");
      });
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toBe("boom");
    expect(events.length).toBe(1);
    expect(events[0]!.outcome.status).toBe("error");
    if (events[0]!.outcome.status === "error") {
      expect(events[0]!.outcome.errorMessage).toBe("boom");
    }
  });

  it("swallows sink errors so observability never crashes the caller", async () => {
    const sink: SpanSink = () => {
      throw new Error("sink crashed");
    };
    const result = await withSpan({ name: "test.sink-error", sink }, async () => 7);
    expect(result).toBe(7);
  });

  it("propagates parent trace id into child spans", async () => {
    const events: Array<Parameters<SpanSink>[0]> = [];
    const sink: SpanSink = (e) => events.push(e);
    const parent = newTraceContext();
    await withSpan({ name: "test.parented", parent, sink }, async () => 1);
    expect(events[0]!.trace.traceId).toBe(parent.traceId);
    expect(events[0]!.trace.parentSpanId).toBe(parent.spanId);
  });
});

// -----------------------------------------------------------------------------
// Alert thresholds
// -----------------------------------------------------------------------------

describe("Phase Y — Alert threshold catalog", () => {
  it("catalog contains the documented critical thresholds", () => {
    const ids = OPERATIONAL_ALERT_THRESHOLDS.map((t) => t.id);
    expect(ids).toContain("audit_chain_drift");
    expect(ids).toContain("immutable_storage_drift_open");
    expect(ids).toContain("critical_severity_incident_open");
    expect(ids).toContain("queue_oldest_pending_age");
    expect(ids).toContain("reconciliation_failed_rate");
  });

  it("audit chain drift is CRITICAL severity", () => {
    const t = OPERATIONAL_ALERT_THRESHOLDS.find(
      (x) => x.id === "audit_chain_drift",
    );
    expect(t?.severity).toBe("CRITICAL");
    expect(t?.metric).toBe("platform_audit_chain_drift_detected_total");
    expect(t?.op).toBe(">");
    expect(t?.value).toBe(0);
  });

  it("evaluateAlerts fires when threshold is exceeded", () => {
    const firing = evaluateAlerts({
      queue_oldest_pending_age_seconds: 900,
      queue_backlog_count: 0,
      immutable_storage_drift_open: 0,
    });
    expect(firing.find((a) => a.id === "queue_oldest_pending_age")).toBeTruthy();
    expect(firing.find((a) => a.id === "queue_backlog_high")).toBeFalsy();
  });

  it("evaluateAlerts does NOT fire below threshold", () => {
    const firing = evaluateAlerts({
      queue_oldest_pending_age_seconds: 60,
      queue_backlog_count: 0,
    });
    expect(firing.find((a) => a.id === "queue_oldest_pending_age")).toBeFalsy();
  });

  it("evaluateAlerts skips metrics with undefined values", () => {
    const firing = evaluateAlerts({});
    // No metrics provided → no alerts.
    expect(firing.length).toBe(0);
  });

  it("evaluateAlerts includes observedValue for the dashboard", () => {
    const firing = evaluateAlerts({
      immutable_storage_drift_open: 3,
    });
    const drift = firing.find((a) => a.id === "immutable_storage_drift_open");
    expect(drift?.observedValue).toBe(3);
  });
});

// -----------------------------------------------------------------------------
// safeLabelSet — defense-in-depth against accidental sensitive labels
// -----------------------------------------------------------------------------

describe("Phase Y — safeLabelSet", () => {
  it("drops keys whose name suggests sensitive content", () => {
    const out = safeLabelSet({
      env: "prod",
      worker: "destruction-orchestrator",
      apiKey: "shhh",
      api_key: "still shhh",
      authToken: "Bearer abc",
      authorization: "Bearer abc",
      legalNote: "privileged communication",
      secret_value: "hidden",
      passwordHash: "abc",
      raw_payload: "blob",
    });
    expect(out.env).toBe("prod");
    expect(out.worker).toBe("destruction-orchestrator");
    expect(out.apiKey).toBeUndefined();
    expect(out.api_key).toBeUndefined();
    expect(out.legalNote).toBeUndefined();
    expect(out.secret_value).toBeUndefined();
    expect(out.passwordHash).toBeUndefined();
    expect(out.raw_payload).toBeUndefined();
  });

  it("sanitizes safe values for Prometheus emission", () => {
    const out = safeLabelSet({ env: 'name="prod"' });
    expect(out.env).toBe('name=\\"prod\\"');
  });
});

// -----------------------------------------------------------------------------
// Metrics catalog completeness for Phase Y
// -----------------------------------------------------------------------------

describe("Phase Y — Metrics catalog completeness", () => {
  const src = readSource("../../../packages/shared-runtime/src/ops/metrics.service.ts");

  it("counters cover Phase Y additions", () => {
    for (const n of [
      "ots_upgrade_started_total",
      "ots_upgrade_succeeded_total",
      "ots_upgrade_failed_total",
      "ots_upgrade_pending_total",
      "platform_audit_chain_drift_detected_total",
      "platform_audit_append_failed_total",
      "worker_span_total",
      "worker_span_failed_total",
      "worker_heartbeat_total",
      "queue_job_enqueued_total",
      "queue_job_processed_total",
      "queue_job_failed_total",
      "queue_job_stalled_total",
      "queue_dlq_total",
      "observability_metrics_exporter_calls_total",
      "observability_alert_evaluations_total",
    ]) {
      expect(src).toContain(`"${n}"`);
    }
  });

  it("gauges cover Phase Y additions", () => {
    for (const n of [
      "ots_upgrade_pending_inflight",
      "ots_upgrade_backlog",
      "audit_chain_last_drift_check_age_seconds",
      "worker_last_heartbeat_age_seconds",
      "queue_active_count",
      "queue_waiting_count",
      "queue_delayed_count",
      "queue_failed_count",
      "queue_dlq_size",
      "observability_alerts_firing",
      "observability_alerts_firing_critical",
    ]) {
      expect(src).toContain(`"${n}"`);
    }
  });

  it("buildPrometheusExposition is exported + bumps the exporter counter", () => {
    expect(src).toContain("export function buildPrometheusExposition");
    expect(src).toContain("observability_metrics_exporter_calls_total");
  });

  it("buildPrometheusExposition attaches service + env global labels", () => {
    expect(src).toContain('name: "service"');
    expect(src).toContain('name: "env"');
  });
});

// -----------------------------------------------------------------------------
// Source contracts
// -----------------------------------------------------------------------------

describe("Phase Y — Route wiring", () => {
  const src = readSource("../src/routes/ops.routes.ts");

  it("exposes /metrics for Prometheus scrape", () => {
    expect(src).toContain('app.get("/metrics"');
    expect(src).toContain(
      'text/plain; version=0.0.4; charset=utf-8',
    );
  });

  it("/metrics is gated by METRICS_SCRAPE_TOKEN when set", () => {
    expect(src).toContain("METRICS_SCRAPE_TOKEN");
    expect(src).toContain("Bearer");
  });

  it("exposes /v1/ops/alerts authenticated endpoint", () => {
    expect(src).toContain('"/v1/ops/alerts"');
    expect(src).toContain("evaluateAlerts");
  });

  it("alerts endpoint updates firing gauges so the dashboard ribbon reflects state", () => {
    expect(src).toContain('setGauge("observability_alerts_firing"');
    expect(src).toContain('setGauge("observability_alerts_firing_critical"');
  });
});

describe("Phase Y — Worker wiring", () => {
  const indexSrc = readSource("../../worker/src/index.ts");
  const obsSrc = readSource("../../worker/src/observability.ts");

  it("worker index imports the observability helpers", () => {
    expect(indexSrc).toContain('from "./observability.js"');
    expect(indexSrc).toContain("heartbeat");
    expect(indexSrc).toContain("instrumentJobOutcome");
    expect(indexSrc).toContain("snapshotQueueHealth");
  });

  it("worker starts the heartbeat + queue health schedulers on startup", () => {
    expect(indexSrc).toContain("startObservabilityHeartbeat");
    expect(indexSrc).toContain("startQueueHealthSampler");
  });

  it("worker stops both schedulers on shutdown", () => {
    expect(indexSrc).toContain("stopObservabilityHeartbeat");
    expect(indexSrc).toContain("stopQueueHealthSampler");
  });

  it("heartbeat env knobs are tunable", () => {
    expect(indexSrc).toContain("WORKER_HEARTBEAT_INTERVAL_MS");
    expect(indexSrc).toContain("WORKER_QUEUE_HEALTH_INTERVAL_MS");
  });

  it("job outcome instrumentation fires on both completed and failed paths", () => {
    // The bindWorkerEvents block must call instrumentJobOutcome from
    // both branches.
    const completedMatch = indexSrc.match(
      /workerInstance\.on\("completed"[\s\S]*?\}\);/,
    );
    const failedMatch = indexSrc.match(
      /workerInstance\.on\("failed"[\s\S]*?\}\);/,
    );
    expect(completedMatch?.[0]).toContain("instrumentJobOutcome");
    expect(failedMatch?.[0]).toContain("instrumentJobOutcome");
  });

  it("observability helper never throws on emission failures", () => {
    // Source-contract: every public helper has a try/catch around
    // its emission. The harness MUST NOT propagate observability
    // failures into business logic.
    expect(obsSrc).toMatch(/heartbeat[\s\S]{0,200}try\s*\{/);
    expect(obsSrc).toMatch(/instrumentJobOutcome[\s\S]{0,200}try\s*\{/);
  });

  it("queue health snapshot is robust to per-queue failures", () => {
    expect(obsSrc).toContain("safeCount");
    expect(obsSrc).toContain("safeOldestPendingAge");
  });
});

describe("Phase Y — Sentry tag enrichment", () => {
  const src = readSource("../../worker/src/sentry.ts");

  it("captureException promotes correlation_id / worker_id / job_kind / queue_name to tags", () => {
    expect(src).toContain('"correlation_id"');
    expect(src).toContain('"worker_id"');
    expect(src).toContain('"job_kind"');
    expect(src).toContain('"queue_name"');
  });

  it("setSentryCorrelationContext is exported for pre-exception tagging", () => {
    expect(src).toContain("export function setSentryCorrelationContext");
  });

  it("redaction still scrubs token / secret / authorization / cookie keys", () => {
    expect(src).toContain('lowered.includes("token")');
    expect(src).toContain('lowered.includes("secret")');
    expect(src).toContain('lowered.includes("authorization")');
    expect(src).toContain('lowered.includes("cookie")');
  });
});

describe("Phase Y — Operational dashboard page", () => {
  const src = readSource(
    "../../../apps/web/app/(app)/operations/observability/page.tsx",
  );

  it("polls the right endpoints", () => {
    expect(src).toContain("/v1/ops/metrics");
    expect(src).toContain("/v1/ops/alerts");
  });

  it("renders the canonical scrape endpoints documentation block", () => {
    expect(src).toContain("GET /metrics");
    expect(src).toContain("GET /readyz");
    expect(src).toContain("GET /healthz");
  });

  it("reuses the canonical workspace hook so it does not regress on workspace resolution", () => {
    expect(src).toContain("useActiveWorkspaceId");
  });

  it("uses muted operator language (no marketing/legal overclaim)", () => {
    const lower = src.toLowerCase();
    for (const banned of [
      "guaranteed",
      "tamper-proof",
      "100% authentic",
      "legally admissible",
      "court-ready",
    ]) {
      expect(lower).not.toContain(banned);
    }
  });
});
