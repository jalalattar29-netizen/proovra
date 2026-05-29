/**
 * Phase O1.3 — bounded queue-OTEL context propagation.
 *
 * Goal: when the API enqueues a BullMQ job, inject the current OTEL
 * trace context (W3C `traceparent` + `tracestate`) into the job
 * payload under a bounded `_otel` metadata key. When the worker
 * picks up the job, extract that carrier, restore the parent
 * context, and execute the handler inside a child span. This makes
 * an API request → queue → worker chain visible as ONE distributed
 * trace in Grafana Tempo.
 *
 * Design rules:
 *   * Helper is safe to call when OTEL is disabled — `propagation.inject`
 *     becomes a no-op against the no-op tracer, the data passes through
 *     unchanged, and the worker side runs without a parent context.
 *   * `_otel` is a BOUNDED key (W3C carrier only — no PII, no token,
 *     no evidence content). The injector / extractor both operate on
 *     a `Record<string, string>` carrier.
 *   * If the BullMQ job data is not a plain object (e.g. legacy
 *     `{ evidenceId: string }` shape), the inject path clones it
 *     into a new shape with `_otel` added. Downstream code MUST
 *     read its original fields via the same property names — we
 *     never mutate the input.
 *   * The extract path tolerates missing / malformed `_otel`
 *     carriers — it simply runs without a parent context. NEVER
 *     throws.
 *
 * Not yet propagated queues — see
 * `docs/operations/phase-o1-3-otel-final-closure.md` §5 for the
 * deferred list and rationale.
 */

import {
  context,
  propagation,
  trace,
  type Context,
} from "@opentelemetry/api";

/**
 * Bounded carrier shape — a string→string map per W3C TraceContext.
 * NEVER includes anything beyond the standard `traceparent` /
 * `tracestate` keys.
 */
export type OtelCarrier = Record<string, string>;

/**
 * Bounded job-data shape that carries the OTEL context. Caller-supplied
 * data is preserved verbatim; we only ADD a `_otel` field if the
 * current context has an active span. The field is small (< 200 bytes
 * even with a full tracestate).
 */
export type JobDataWithOtel<T> = T & {
  _otel?: OtelCarrier;
};

/**
 * Phase O1.3 — inject the current active OTEL context into a BullMQ
 * job's data payload. Returns a new object (does not mutate the input).
 *
 * When OTEL is disabled or there is no active span, returns the input
 * data unchanged (no `_otel` field).
 *
 * NEVER throws. Failure paths return the input unchanged.
 */
export function injectOtelContextIntoJobData<T extends object>(
  data: T,
): JobDataWithOtel<T> {
  try {
    const carrier: OtelCarrier = {};
    propagation.inject(context.active(), carrier);
    // If there's no active span context, the carrier stays empty;
    // skip the metadata field to avoid an empty `_otel` blob.
    if (Object.keys(carrier).length === 0) return data as JobDataWithOtel<T>;
    return { ...data, _otel: carrier };
  } catch {
    return data as JobDataWithOtel<T>;
  }
}

/**
 * Phase O1.3 — extract the OTEL context from a BullMQ job's data
 * payload and return a context object that can be entered with
 * `context.with(extracted, () => …)`.
 *
 * When the data has no `_otel` field, returns the currently active
 * context unchanged. NEVER throws.
 */
export function extractOtelContextFromJobData(
  data: unknown,
): Context {
  try {
    if (
      data === null ||
      typeof data !== "object" ||
      !("_otel" in data)
    ) {
      return context.active();
    }
    const carrier = (data as { _otel: unknown })._otel;
    if (
      carrier === null ||
      typeof carrier !== "object" ||
      Array.isArray(carrier)
    ) {
      return context.active();
    }
    return propagation.extract(context.active(), carrier as OtelCarrier);
  } catch {
    return context.active();
  }
}

/**
 * Phase O1.3 — wrap a BullMQ job processor handler so the worker side
 * runs inside the parent OTEL context (when the data carries one) and
 * the active span is a child of the API-side enqueue span.
 *
 * Usage at the `new Worker(name, processor, opts)` call site:
 *
 *   const wrapped = wrapJobHandlerWithOtelContext(
 *     PROOVRA_SPAN_NAMES.WORKER_REPORT_GENERATE,
 *     "report",
 *     processGenerateReport,
 *   );
 *   new Worker("report", wrapped, ...);
 *
 * The wrapper:
 *   * Extracts the parent context (no-op if absent).
 *   * Starts a bounded span named `spanName` with bounded
 *     attributes: `proovra.queue_name`, `proovra.job_name`,
 *     `proovra.job_id`, `proovra.attempt`, `proovra.outcome`.
 *   * Runs the handler under `context.with(parent, …)` so child
 *     spans created inside the handler are correctly linked.
 *   * NEVER serialises raw job data into span attributes.
 *
 * Safe when OTEL is disabled — the no-op tracer makes the helper a
 * thin pass-through.
 */
export function wrapJobHandlerWithOtelContext<
  TJobLike extends {
    id?: string | number | null | undefined;
    name?: string | null | undefined;
    data: unknown;
    attemptsMade?: number;
  },
  TResult,
>(
  spanName: string,
  queueName: string,
  handler: (job: TJobLike) => Promise<TResult>,
): (job: TJobLike) => Promise<TResult> {
  return async (job) => {
    const parent = extractOtelContextFromJobData(job.data);
    const tracer = trace.getTracer("proovra");
    return context.with(parent, () =>
      tracer.startActiveSpan(spanName, async (span) => {
        try {
          span.setAttribute("proovra.queue_name", queueName);
          if (job.name) span.setAttribute("proovra.job_name", String(job.name));
          if (job.id !== undefined && job.id !== null) {
            span.setAttribute("proovra.job_id", String(job.id));
          }
          if (typeof job.attemptsMade === "number") {
            span.setAttribute("proovra.attempt", job.attemptsMade + 1);
          }
          const result = await handler(job);
          span.setAttribute("proovra.outcome", "success");
          return result;
        } catch (err) {
          span.setAttribute("proovra.outcome", "failure");
          if (err instanceof Error) {
            // Bounded error code only — never the full message
            // (could carry PII / signing-key paths / S3 keys).
            span.setAttribute("proovra.error_code", err.name.slice(0, 40));
          }
          throw err;
        } finally {
          span.end();
        }
      }),
    );
  };
}
