/**
 * Phase Y — Observability runtime primitives.
 *
 * Foundational, browser-safe, dependency-free observability building
 * blocks shared by the api and worker runtimes. NOT a full
 * OpenTelemetry SDK rollout — this module gives us:
 *
 *   - Prometheus text-format exporter (`formatPrometheusExposition`)
 *   - Trace-context shape compatible with W3C Trace Context + future
 *     OTel SDK adoption (drop-in replacement when an exporter is wired)
 *   - `withSpan(...)` helper that measures duration + outcome and
 *     reports back to a typed sink. Catches errors and rethrows.
 *   - Alert threshold catalog (bounded set of operational alerts the
 *     platform reasons about — see `OPERATIONAL_ALERT_THRESHOLDS`)
 *
 * Hard rules:
 *   - No Node imports, no Prisma, no Fastify. Browser-safe.
 *   - Metric / label names are STABLE strings. The exporter REFUSES
 *     to emit a metric whose name doesn't match the Prometheus naming
 *     spec (`[a-zA-Z_:][a-zA-Z0-9_:]*`). The catalog itself enforces
 *     this — `metrics.service.ts` only accepts names from the catalog.
 *   - Label values are NEVER free-form user input. Every label value
 *     is bounded-catalog. The exporter strips characters that would
 *     break Prometheus parsing.
 *
 * Why this exists:
 *   The platform's in-process `metrics.service.ts` registry already
 *   tracks counters + gauges. This module turns that registry into a
 *   format Prometheus (or any compatible scraper) can consume, without
 *   adding a dependency on the `prom-client` npm package — which would
 *   add `~1MB` to the worker bundle and complicate testing.
 */

// -----------------------------------------------------------------------------
// Prometheus text-format exporter
// -----------------------------------------------------------------------------

const PROM_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

export type PromMetricKind = "counter" | "gauge";

export type PromLabel = {
  /** Stable, bounded-catalog label key (e.g. `env`, `worker`, `queue`). */
  name: string;
  /** Bounded-catalog value (e.g. `prod`, `destruction-orchestrator`). */
  value: string;
};

export type PromMetric = {
  name: string;
  kind: PromMetricKind;
  /** Optional human-readable help text — emitted as `# HELP`. */
  help?: string;
  /**
   * Single value or labelled samples. Both shapes are supported so a
   * counter like `lifecycle_transition_total` can be emitted either
   * as a bare scalar OR as `{from="ACTIVE",to="DESTROYED"} 5`.
   */
  value:
    | number
    | ReadonlyArray<{ labels: ReadonlyArray<PromLabel>; value: number }>;
};

export type PromSnapshot = {
  /** Optional global labels appended to every sample (env, region, etc.). */
  globalLabels?: ReadonlyArray<PromLabel>;
  metrics: ReadonlyArray<PromMetric>;
};

function isValidName(name: string): boolean {
  return PROM_NAME_RE.test(name);
}

/**
 * Sanitize a label value for safe Prometheus emission. Escapes `\`,
 * `"`, and newlines. Never throws.
 */
export function sanitizePromLabelValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .slice(0, 200);
}

function emitLabelList(
  labels: ReadonlyArray<PromLabel>,
): string {
  if (labels.length === 0) return "";
  const parts = labels
    .filter((l) => isValidName(l.name))
    .map((l) => `${l.name}="${sanitizePromLabelValue(l.value)}"`);
  if (parts.length === 0) return "";
  return `{${parts.join(",")}}`;
}

/**
 * Render a `PromSnapshot` to the Prometheus exposition format. The
 * output is suitable for serving from a `/metrics` HTTP endpoint with
 * `content-type: text/plain; version=0.0.4`.
 *
 * Refuses to emit metrics with invalid names. Silently drops malformed
 * entries rather than throwing — observability must never crash the
 * caller.
 */
export function formatPrometheusExposition(snapshot: PromSnapshot): string {
  const lines: string[] = [];
  const global = (snapshot.globalLabels ?? []).filter((l) =>
    isValidName(l.name),
  );
  for (const m of snapshot.metrics) {
    if (!isValidName(m.name)) continue;
    if (m.help) {
      const safeHelp = m.help.replace(/\n/g, " ").slice(0, 400);
      lines.push(`# HELP ${m.name} ${safeHelp}`);
    }
    lines.push(`# TYPE ${m.name} ${m.kind}`);
    if (typeof m.value === "number") {
      if (!Number.isFinite(m.value)) continue;
      const labelStr = emitLabelList(global);
      lines.push(`${m.name}${labelStr} ${m.value}`);
    } else {
      for (const sample of m.value) {
        if (!Number.isFinite(sample.value)) continue;
        const merged: PromLabel[] = [...global, ...sample.labels];
        const labelStr = emitLabelList(merged);
        lines.push(`${m.name}${labelStr} ${sample.value}`);
      }
    }
  }
  // Prometheus convention — exposition ends with a newline.
  return lines.join("\n") + "\n";
}

// -----------------------------------------------------------------------------
// Trace context (W3C-compatible shape)
// -----------------------------------------------------------------------------

export type TraceContext = {
  /** 32-char lowercase hex — same shape as the `newCorrelationId()` helper. */
  traceId: string;
  /** 16-char lowercase hex — fresh per span. */
  spanId: string;
  /** Optional parent span. Root spans omit this. */
  parentSpanId?: string;
  /** Sampling decision. `1` = record, `0` = skip. */
  sampled: 0 | 1;
};

const HEX = "0123456789abcdef";

function randomHex(bytes: number): string {
  if (typeof globalThis !== "undefined" && globalThis.crypto?.getRandomValues) {
    const buf = new Uint8Array(bytes);
    globalThis.crypto.getRandomValues(buf);
    let out = "";
    for (const b of buf) {
      out += HEX[(b >> 4) & 0xf];
      out += HEX[b & 0xf];
    }
    return out;
  }
  let out = "";
  for (let i = 0; i < bytes * 2; i++) {
    out += HEX[Math.floor(Math.random() * 16)];
  }
  return out;
}

export function newTraceContext(parent?: TraceContext): TraceContext {
  return {
    traceId: parent?.traceId ?? randomHex(16),
    spanId: randomHex(8),
    parentSpanId: parent?.spanId,
    sampled: parent?.sampled ?? 1,
  };
}

/**
 * Serialize a `TraceContext` as a W3C `traceparent` header value.
 * Future OTel SDK adoption can ingest this directly.
 */
export function traceParentHeader(ctx: TraceContext): string {
  // version-traceid-spanid-flags
  const flags = ctx.sampled === 1 ? "01" : "00";
  return `00-${ctx.traceId}-${ctx.spanId}-${flags}`;
}

const TRACE_PARENT_RE =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

export function parseTraceParentHeader(
  value: string | null | undefined,
): TraceContext | null {
  if (typeof value !== "string") return null;
  const m = TRACE_PARENT_RE.exec(value.trim());
  if (!m) return null;
  const flags = parseInt(m[4]!, 16);
  return {
    traceId: m[2]!.toLowerCase(),
    spanId: randomHex(8),
    parentSpanId: m[3]!.toLowerCase(),
    sampled: (flags & 0x01) === 1 ? 1 : 0,
  };
}

// -----------------------------------------------------------------------------
// withSpan — measures duration + outcome and reports to a sink.
// -----------------------------------------------------------------------------

export type SpanOutcome =
  | { status: "ok"; durationMs: number }
  | { status: "error"; durationMs: number; errorMessage: string };

export type SpanSink = (input: {
  name: string;
  outcome: SpanOutcome;
  trace: TraceContext;
  labels: Record<string, string>;
}) => void;

/**
 * Run an async operation inside a span. The span name is the bounded
 * label that downstream tooling uses to identify the operation. The
 * `sink` callback receives the outcome — typical implementations bump
 * a histogram counter or emit a structured log line. Failures are
 * reported via the sink AND re-thrown so the caller's error path
 * behaves identically.
 *
 * The sink is allowed to throw — those throws are swallowed so
 * observability never crashes business logic.
 */
export async function withSpan<T>(
  input: {
    name: string;
    parent?: TraceContext;
    labels?: Record<string, string>;
    sink: SpanSink;
  },
  body: (trace: TraceContext) => Promise<T>,
): Promise<T> {
  const trace = newTraceContext(input.parent);
  const labels = input.labels ?? {};
  const startedAt = Date.now();
  try {
    const result = await body(trace);
    safeSinkCall(input.sink, {
      name: input.name,
      trace,
      labels,
      outcome: { status: "ok", durationMs: Date.now() - startedAt },
    });
    return result;
  } catch (err) {
    safeSinkCall(input.sink, {
      name: input.name,
      trace,
      labels,
      outcome: {
        status: "error",
        durationMs: Date.now() - startedAt,
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}

function safeSinkCall(
  sink: SpanSink,
  input: Parameters<SpanSink>[0],
): void {
  try {
    sink(input);
  } catch {
    // Observability sinks must never propagate.
  }
}

// -----------------------------------------------------------------------------
// Alert thresholds catalog
//
// Bounded set of operational thresholds the platform considers worth
// surfacing. Each entry pairs a metric name with the threshold beyond
// which the operator dashboard / future alert provider should fire.
// Threshold values are intentionally conservative — engineering can
// tune them per environment via the future alert-config service.
// -----------------------------------------------------------------------------

export type OperationalAlertSeverity = "WARNING" | "HIGH" | "CRITICAL";

export type OperationalAlertThreshold = {
  /** Stable alert identifier — operators reference these in runbooks. */
  id: string;
  /** Metric this alert reads. */
  metric: string;
  /** Comparison operator. */
  op: ">" | ">=" | "<" | "<=";
  /** Threshold value. */
  value: number;
  severity: OperationalAlertSeverity;
  /** Short description shown on the dashboard. */
  reason: string;
  /** Window over which the comparison applies. */
  window: "instant" | "5m" | "15m" | "1h" | "24h";
};

export const OPERATIONAL_ALERT_THRESHOLDS: ReadonlyArray<OperationalAlertThreshold> =
  [
    {
      id: "queue_oldest_pending_age",
      metric: "queue_oldest_pending_age_seconds",
      op: ">",
      value: 600,
      severity: "HIGH",
      reason: "A job has been waiting in queue for over 10 minutes.",
      window: "instant",
    },
    {
      id: "queue_backlog_high",
      metric: "queue_backlog_count",
      op: ">",
      value: 1000,
      severity: "WARNING",
      reason: "Queue backlog exceeds 1000 jobs.",
      window: "instant",
    },
    {
      id: "reconciliation_failed_rate",
      metric: "governance_reconciliation_run_failed_total",
      op: ">",
      value: 5,
      severity: "HIGH",
      reason: "Reconciliation runs failing in a sustained window.",
      window: "15m",
    },
    {
      id: "destruction_blocked_spike",
      metric: "destruction_blocked_by_hold_total",
      op: ">",
      value: 25,
      severity: "WARNING",
      reason:
        "Destruction attempts blocked by hold rising — operator may need to review hold scope.",
      window: "1h",
    },
    {
      id: "immutable_storage_drift_open",
      metric: "immutable_storage_drift_open",
      op: ">",
      value: 0,
      severity: "HIGH",
      reason:
        "DB and S3 Object Lock disagree on at least one evidence record. Investigate before any destruction proceeds.",
      window: "instant",
    },
    {
      id: "stuck_destruction_executions",
      metric: "destruction_executions_inflight",
      op: ">",
      value: 10,
      severity: "WARNING",
      reason:
        "Multiple destruction executions stuck in non-terminal state — orchestrator may be wedged.",
      window: "instant",
    },
    {
      id: "ots_failure_rate",
      metric: "ots_upgrade_failed_total",
      op: ">",
      value: 10,
      severity: "WARNING",
      reason: "OpenTimestamps upgrade failures rising.",
      window: "1h",
    },
    {
      id: "audit_chain_drift",
      metric: "platform_audit_chain_drift_detected_total",
      op: ">",
      value: 0,
      severity: "CRITICAL",
      reason:
        "Append-only audit chain integrity verification failed. STOP destructive operations immediately and contact security.",
      window: "instant",
    },
    {
      id: "governance_notification_delivery_failed",
      metric: "governance_notification_delivery_failed_total",
      op: ">",
      value: 20,
      severity: "WARNING",
      reason: "Governance notifications failing to deliver.",
      window: "1h",
    },
    {
      id: "high_severity_incident_open",
      metric: "operational_incidents_open_high",
      op: ">",
      value: 0,
      severity: "HIGH",
      reason: "At least one HIGH-severity incident is open.",
      window: "instant",
    },
    {
      id: "critical_severity_incident_open",
      metric: "operational_incidents_open_critical",
      op: ">",
      value: 0,
      severity: "CRITICAL",
      reason: "At least one CRITICAL-severity incident is open.",
      window: "instant",
    },
    {
      id: "review_overdue_backlog",
      metric: "reviewer_queue_overdue",
      op: ">",
      value: 50,
      severity: "WARNING",
      reason: "Reviewer overdue backlog exceeds 50 items.",
      window: "instant",
    },
    {
      id: "stale_session_backlog",
      metric: "stale_session_backlog",
      op: ">",
      value: 100,
      severity: "WARNING",
      reason: "Stale session sweep backlog growing.",
      window: "instant",
    },
  ] as const;

/**
 * Evaluate the alert catalog against a given metrics snapshot. Returns
 * the alerts whose threshold is currently exceeded. The caller decides
 * what to do — render on a dashboard, fan out to a paging provider, or
 * emit a security event.
 *
 * Pure function. No side effects. Safe to call on every dashboard
 * poll.
 */
export function evaluateAlerts(
  metricValues: Record<string, number | undefined>,
): ReadonlyArray<
  OperationalAlertThreshold & { observedValue: number }
> {
  const out: Array<OperationalAlertThreshold & { observedValue: number }> = [];
  for (const t of OPERATIONAL_ALERT_THRESHOLDS) {
    const observed = metricValues[t.metric];
    if (typeof observed !== "number" || !Number.isFinite(observed)) continue;
    const fires =
      (t.op === ">" && observed > t.value) ||
      (t.op === ">=" && observed >= t.value) ||
      (t.op === "<" && observed < t.value) ||
      (t.op === "<=" && observed <= t.value);
    if (fires) out.push({ ...t, observedValue: observed });
  }
  return out;
}

// -----------------------------------------------------------------------------
// Safe label extraction — strips known-sensitive prefixes.
// -----------------------------------------------------------------------------

const FORBIDDEN_LABEL_PREFIXES = [
  "secret",
  "token",
  "credential",
  "password",
  "apikey",
  "api_key",
  "legalnote",
  "privileged",
  "raw",
  "payload",
  // Defense in depth — these never appear in legitimate metric labels
  // but a future careless caller might pass them. The Sentry redactor
  // already filters these on the error-capture path; we mirror that
  // here so label catalogs stay enterprise-safe. `session` is NOT
  // added because legitimate session-count gauges (`stale_session_backlog`
  // etc.) need to be labeled — we filter session IDs at the call site.
  "authorization",
  "cookie",
  "bearer",
] as const;

/**
 * Filter a labels object to drop any key whose name suggests it might
 * carry sensitive content. Operators set label catalogs in code; this
 * helper is a defense in depth for accidental leakage. Returns a new
 * object with only safe keys.
 */
export function safeLabelSet(
  labels: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) {
    const lowered = String(k).toLowerCase();
    if (FORBIDDEN_LABEL_PREFIXES.some((p) => lowered.includes(p))) {
      continue;
    }
    out[String(k).slice(0, 64)] = sanitizePromLabelValue(v);
  }
  return out;
}
