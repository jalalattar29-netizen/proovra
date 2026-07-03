/**
 * Phase P2.0B + O1.1 — OpenTelemetry bootstrap for the PROOVRA worker.
 *
 * Mirror of `services/api/src/observability/otel.ts`. Kept as a
 * separate file so the worker package is self-contained — it does
 * not import from the api package at build time.
 *
 * Service-name resolution prefers `OTEL_SERVICE_NAME` from env when
 * set, falling back to the explicit default `proovra-worker`. In
 * docker-compose.prod.yml we set `OTEL_SERVICE_NAME=proovra-worker`
 * on the worker container so the api + worker share `.env` with a
 * single Grafana token but report as distinct services.
 *
 * Phase O1.1 additions:
 *   * Bounded `withProovraSpan(name, attrs, fn)` helper.
 *   * Extended bounded `PROOVRA_SPAN_NAMES` enum covering signer /
 *     custody / SIU surfaces.
 *   * Bootstrap state tracking exposed via `getOtelStatus()` so the
 *     api-side `/v1/runtime/otel-health` endpoint can render it.
 */

import {
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  SpanStatusCode,
  trace,
  type Span,
} from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { Resource } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_NAMESPACE,
  SEMRESATTRS_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

let started = false;
let lastBootstrapAtUtc: string | null = null;
let lastBootstrapOutcome: "succeeded" | "failed" | "disabled" | null = null;
let lastBootstrapFailureCode: string | null = null;
let spansCreatedCount = 0;
let lastExportErrorCode: string | null = null;
let lastSpanName: string | null = null;
let lastSpanAtUtc: string | null = null;

function isEnabled(): boolean {
  return (process.env.OTEL_ENABLED ?? "").trim().toLowerCase() === "true";
}

function parseHeaders(): Record<string, string> | undefined {
  const raw = (process.env.OTEL_EXPORTER_OTLP_HEADERS ?? "").trim();
  if (raw.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    if (k && v) out[k] = v;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function parseResourceAttribute(key: string): string | null {
  const raw = (process.env.OTEL_RESOURCE_ATTRIBUTES ?? "").trim();
  if (raw.length === 0) return null;
  for (const pair of raw.split(",")) {
    const [k, v] = pair.split("=");
    if (k?.trim() === key) return v?.trim() ?? null;
  }
  return null;
}

export function initOpenTelemetry(input: {
  defaultServiceName: "proovra-api" | "proovra-worker";
  log: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
}): boolean {
  input.log.info(
    {
      serviceName:
        (process.env.OTEL_SERVICE_NAME ?? "").trim() ||
        input.defaultServiceName,
      endpointConfigured:
        (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "").trim().length > 0,
      protocol:
        (process.env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "").trim() ||
        "http/protobuf",
    },
    "otel.bootstrap_started",
  );
  if (started) return false;
  if (!isEnabled()) {
    lastBootstrapAtUtc = new Date().toISOString();
    lastBootstrapOutcome = "disabled";
    input.log.info(
      {
        reason: "OTEL_ENABLED not true",
        defaultServiceName: input.defaultServiceName,
      },
      "otel.bootstrap_disabled",
    );
    return false;
  }

  const serviceName =
    (process.env.OTEL_SERVICE_NAME ?? "").trim() || input.defaultServiceName;
  const serviceNamespace =
    parseResourceAttribute("service.namespace") ?? "proovra";
  const environment =
    parseResourceAttribute("deployment.environment") ??
    (process.env.NODE_ENV ?? "development");
  const serviceVersion =
    process.env.OTEL_SERVICE_VERSION ??
    process.env.APP_RELEASE_SHA ??
    process.env.GIT_SHA ??
    null;

  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

  try {
    const headers = parseHeaders();
    const endpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "").trim();
    const tracesUrl = endpoint
      ? endpoint.replace(/\/+$/, "") + "/v1/traces"
      : undefined;

    const exporter = new OTLPTraceExporter({
      url: tracesUrl,
      headers,
    });

    const resourceAttrs: Record<string, string> = {
      [SEMRESATTRS_SERVICE_NAME]: serviceName,
      [SEMRESATTRS_SERVICE_NAMESPACE]: serviceNamespace,
      [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: environment,
    };
    if (serviceVersion) {
      resourceAttrs[SEMRESATTRS_SERVICE_VERSION] = serviceVersion;
    }

    const sdk = new NodeSDK({
      traceExporter: exporter,
      resource: new Resource(resourceAttrs),
      instrumentations: [
        getNodeAutoInstrumentations({
          "@opentelemetry/instrumentation-fs": { enabled: false },
          "@opentelemetry/instrumentation-dns": { enabled: false },
          "@opentelemetry/instrumentation-http": { enabled: true },
          "@opentelemetry/instrumentation-ioredis": { enabled: true },
          "@opentelemetry/instrumentation-pg": { enabled: false },
        }),
      ],
    });

    sdk.start();
    started = true;
    lastBootstrapAtUtc = new Date().toISOString();
    lastBootstrapOutcome = "succeeded";
    lastBootstrapFailureCode = null;

    input.log.info(
      {
        serviceName,
        serviceNamespace,
        environment,
        serviceVersion,
        endpointConfigured:
          (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "").trim().length > 0,
        protocol:
          (process.env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "").trim() ||
          "http/protobuf",
        exporterKind: "otlp-trace-http",
      },
      "otel.bootstrap_succeeded",
    );

    for (const sig of ["SIGTERM", "SIGINT"] as const) {
      process.once(sig, () => {
        void sdk
          .shutdown()
          .catch(() => undefined)
          .finally(() => undefined);
      });
    }

    return true;
  } catch (err) {
    const code = err instanceof Error ? err.name.slice(0, 40) : "unknown";
    lastBootstrapAtUtc = new Date().toISOString();
    lastBootstrapOutcome = "failed";
    lastBootstrapFailureCode = code;
    input.log.warn({ code }, "otel.bootstrap_failed");
    return false;
  }
}

export function getOtelStatus(): {
  enabled: boolean;
  started: boolean;
  serviceName: string | null;
  serviceNamespace: string | null;
  environment: string | null;
  endpointConfigured: boolean;
  protocol: string | null;
  lastBootstrapAtUtc: string | null;
  lastBootstrapOutcome: "succeeded" | "failed" | "disabled" | null;
  lastBootstrapFailureCode: string | null;
  lastExportErrorCode: string | null;
  spansCreatedCount: number;
  lastSpanName: string | null;
  lastSpanAtUtc: string | null;
  degraded: boolean;
  resourceAttributes: Record<string, string>;
} {
  const enabled = isEnabled();
  const endpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "").trim();
  const serviceName = enabled
    ? (process.env.OTEL_SERVICE_NAME ?? "").trim() || null
    : null;
  const serviceNamespace = enabled
    ? parseResourceAttribute("service.namespace") ?? null
    : null;
  const environment = enabled
    ? parseResourceAttribute("deployment.environment") ?? null
    : null;
  const protocol = enabled
    ? (process.env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "").trim() ||
      "http/protobuf"
    : null;
  const resourceAttributes: Record<string, string> = {};
  if (serviceName) resourceAttributes["service.name"] = serviceName;
  if (serviceNamespace)
    resourceAttributes["service.namespace"] = serviceNamespace;
  if (environment) resourceAttributes["deployment.environment"] = environment;
  const degraded =
    enabled &&
    (!started ||
      lastBootstrapOutcome === "failed" ||
      lastExportErrorCode !== null);
  return {
    enabled,
    started,
    serviceName,
    serviceNamespace,
    environment,
    endpointConfigured: endpoint.length > 0,
    protocol,
    lastBootstrapAtUtc,
    lastBootstrapOutcome,
    lastBootstrapFailureCode,
    lastExportErrorCode,
    spansCreatedCount,
    lastSpanName,
    lastSpanAtUtc,
    degraded,
    resourceAttributes,
  };
}

export const PROOVRA_SPAN_NAMES = {
  // Phase O1.1 / O1.2 / O1.3 / O1.4 — bounded runtime emission (mirror
  // of api/otel.ts). EVERY entry below is wired by a real
  // `withProovraSpan(PROOVRA_SPAN_NAMES.X, …)` call OR a
  // `wrapJobHandlerWithOtelContext(PROOVRA_SPAN_NAMES.X, …)`
  // registration. The contract test
  // `services/worker/test/phase-o1-4-span-emission.test.ts` asserts
  // every entry has a real call site. Per the O1.4 hard rule, no
  // enum-only entries are permitted. See
  // `docs/operations/phase-o1-4-business-flow-instrumentation.md` §6
  // for the list of pre-O1.4 entries that were REMOVED because they
  // were enum-only (historical drift from O1.1 / O1.2 / O1.3).
  QUEUE_JOB_REPLAY: "proovra.queue.job.replay",
  QUEUE_JOB_RETRY: "proovra.queue.job.retry",
  RECOVERY_BACKUP_VALIDATE: "proovra.recovery.backup.validate",
  RECOVERY_RESTORE_VALIDATE: "proovra.recovery.restore.validate",
  SIGNER_HEALTH_CHECK: "proovra.signer.health_check",
  SIGNER_ROTATION_PREVIEW: "proovra.signer.rotation.preview",
  SIGNER_ROTATION_PROMOTE: "proovra.signer.rotation.promote",
  CUSTODY_ATTESTATION_SIGN: "proovra.custody.attestation.sign",
  CUSTODY_ATTESTATION_VERIFY: "proovra.custody.attestation.verify",
  CUSTODY_ATTESTATION_BACKFILL: "proovra.custody.attestation.backfill",
  SIU_EXPORT_PREFLIGHT: "proovra.siu.export.preflight",
  SIU_EXPORT_GENERATE: "proovra.siu.export.generate",
  WORKER_REPORT_GENERATE: "proovra.worker.report.generate",
  WORKER_OTS_UPGRADE: "proovra.worker.ots.upgrade",
  WORKER_GRAPH_RECONCILE: "proovra.worker.graph.reconcile",
  CUSTODY_EVENT_APPEND: "proovra.custody.event.append",
  S3_PUT_OBJECT: "proovra.s3.put_object",
  S3_GET_OBJECT: "proovra.s3.get_object",
  S3_HEAD_OBJECT: "proovra.s3.head_object",
  WEBHOOK_DISPATCH: "proovra.webhook.dispatch",
  // Phase O1.5A — Capture + Evidence + Upload + Finalize (mirror).
  CAPTURE_SESSION_CREATE: "proovra.capture.session.create",
  CAPTURE_ITEM_ADD: "proovra.capture.item.add",
  CAPTURE_ITEM_REMOVE: "proovra.capture.item.remove",
  CAPTURE_ITEM_MAP: "proovra.capture.item.map",
  CAPTURE_REVIEW_BEGIN: "proovra.capture.review.begin",
  CAPTURE_FINISH_SIGN: "proovra.capture.finish_sign",
  EVIDENCE_CREATE: "proovra.evidence.create",
  EVIDENCE_UPLOAD_PRESIGN: "proovra.evidence.upload.presign",
  EVIDENCE_UPLOAD_COMPLETE: "proovra.evidence.upload.complete",
  EVIDENCE_FINALIZE: "proovra.evidence.finalize",
  EVIDENCE_VERIFY_PUBLIC: "proovra.evidence.verify.public",
  EVIDENCE_REPORT_LATEST: "proovra.evidence.report.latest",
  EVIDENCE_PACKAGE_STATUS: "proovra.evidence.package.status",
  // Phase O1.5B — Integrity + Custody chain + TSA + OTS (mirror).
  INTEGRITY_HASH_COMPUTE: "proovra.integrity.hash.compute",
  INTEGRITY_CANONICAL_DIGEST: "proovra.integrity.canonical.digest",
  INTEGRITY_SIGNATURE_VERIFY: "proovra.integrity.signature.verify",
  INTEGRITY_TIMESTAMP_VERIFY: "proovra.integrity.timestamp.verify",
  INTEGRITY_PUBLIC_ANCHOR_VERIFY: "proovra.integrity.public_anchor.verify",
  CUSTODY_CHAIN_VERIFY: "proovra.custody.chain.verify",
  TSA_TIMESTAMP_REQUEST: "proovra.tsa.timestamp.request",
  TSA_TIMESTAMP_VERIFY: "proovra.tsa.timestamp.verify",
  OTS_ANCHOR: "proovra.ots.anchor",
  OTS_UPGRADE: "proovra.ots.upgrade",
  OTS_VERIFY: "proovra.ots.verify",
  // Phase O1.5C — Report pipeline.
  REPORT_GENERATE: "proovra.report.generate",
  REPORT_RENDER_HTML: "proovra.report.render.html",
  REPORT_RENDER_PDF: "proovra.report.render.pdf",
  REPORT_UPLOAD: "proovra.report.upload",
  REPORT_PUBLISH: "proovra.report.publish",
  // Phase O1.5C — Verification Package pipeline.
  PACKAGE_GENERATE: "proovra.package.generate",
  PACKAGE_MANIFEST_CREATE: "proovra.package.manifest.create",
  PACKAGE_ATTESTATIONS_COLLECT: "proovra.package.attestations.collect",
  PACKAGE_SIGNER_SNAPSHOT_GENERATE: "proovra.package.signer_snapshot.generate",
  PACKAGE_ZIP_FINALIZE: "proovra.package.zip.finalize",
  PACKAGE_UPLOAD: "proovra.package.upload",
  // Phase O1.5D — Reviewer Ops.
  REVIEWER_ASSIGNMENT_CREATE: "proovra.reviewer.assignment.create",
  REVIEWER_ASSIGNMENT_COMPLETE: "proovra.reviewer.assignment.complete",
  REVIEWER_QUEUE_BUILD: "proovra.reviewer.queue.build",
  REVIEWER_CONSOLE_LOAD: "proovra.reviewer.console.load",
  REVIEWER_RECONCILE: "proovra.reviewer.reconcile",
  // Phase O1.5D — Graph.
  GRAPH_RECONCILE: "proovra.graph.reconcile",
  GRAPH_TIMELINE_BUILD: "proovra.graph.timeline.build",
  GRAPH_DOMAIN_SYNC: "proovra.graph.domain.sync",
  GRAPH_SEARCH_PROJECTION: "proovra.graph.search.projection",
  // Phase O1.5D — SIU followup/timeline.
  SIU_FOLLOWUP_REQUEST: "proovra.siu.followup.request",
  SIU_TIMELINE_BUILD: "proovra.siu.timeline.build",
  // Phase O1.5E — AI.
  OPENAI_AI_REQUEST: "proovra.openai.ai_request",
  AI_CHAT: "proovra.ai.chat",
  AI_CAPTURE_REVIEW: "proovra.ai.capture.review",
  AI_SUPPORT_RESPONSE: "proovra.ai.support.response",
  // Phase O1.5E — SMTP + external review.
  SMTP_EMAIL_SEND: "proovra.smtp.email_send",
  EXTERNAL_REVIEW_NOTIFY: "proovra.external.review.notify",
} as const;

export type ProovraSpanName =
  (typeof PROOVRA_SPAN_NAMES)[keyof typeof PROOVRA_SPAN_NAMES];

export async function withProovraSpan<T>(
  name: ProovraSpanName,
  attributes: Record<string, string | number | boolean | null | undefined>,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  const tracer = trace.getTracer("proovra");
  return tracer.startActiveSpan(name, async (span) => {
    spansCreatedCount++;
    lastSpanName = name;
    lastSpanAtUtc = new Date().toISOString();
    try {
      const bounded = boundedAttributes(attributes);
      for (const [k, v] of Object.entries(bounded)) {
        try {
          span.setAttribute(k, v);
        } catch {
          // ignore
        }
      }
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      const code =
        err instanceof Error ? err.name.slice(0, 40) : "unknown";
      lastExportErrorCode = code;
      span.setStatus({ code: SpanStatusCode.ERROR, message: code });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Phase O1.5B — sync-safe bounded span helper (mirror of api/otel.ts).
 * Preserves return type for sync code paths that cannot be made async.
 */
export function withProovraSpanSync<T>(
  name: ProovraSpanName,
  attributes: Record<string, string | number | boolean | null | undefined>,
  fn: (span: Span) => T,
): T {
  const tracer = trace.getTracer("proovra");
  return tracer.startActiveSpan(name, (span) => {
    spansCreatedCount++;
    lastSpanName = name;
    lastSpanAtUtc = new Date().toISOString();
    try {
      const bounded = boundedAttributes(attributes);
      for (const [k, v] of Object.entries(bounded)) {
        try {
          span.setAttribute(k, v);
        } catch {
          // ignore
        }
      }
      const result = fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      const code =
        err instanceof Error ? err.name.slice(0, 40) : "unknown";
      lastExportErrorCode = code;
      span.setStatus({ code: SpanStatusCode.ERROR, message: code });
      throw err;
    } finally {
      span.end();
    }
  });
}

function boundedAttributes(
  raw: Record<string, string | number | boolean | null | undefined>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined) continue;
    if (!k || k.length > 60) continue;
    if (typeof v === "string") {
      out[k] = v.slice(0, 200);
    } else if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = v;
    } else if (typeof v === "boolean") {
      out[k] = v;
    }
  }
  return out;
}

export function __resetOtelStateForTests(): void {
  started = false;
  lastBootstrapAtUtc = null;
  lastBootstrapOutcome = null;
  lastBootstrapFailureCode = null;
  spansCreatedCount = 0;
  lastExportErrorCode = null;
  lastSpanName = null;
  lastSpanAtUtc = null;
}
