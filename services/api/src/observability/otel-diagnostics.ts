/**
 * Phase O1.3 — bounded OTEL runtime diagnostics for the operator.
 *
 * Exposed via `GET /v1/runtime/otel-health` alongside `getOtelStatus()`.
 *
 * Hard rules:
 *   * NEVER return the OTLP endpoint URL, header values, or any token
 *     material. Authorization is reduced to:
 *       - present: boolean
 *       - scheme:  "Basic" | "Bearer" | "none"
 *       - tokenLength: number  (the LENGTH of the credential, not the
 *                               credential itself; used to confirm
 *                               provisioning correctness)
 *   * Package version summary is read from each OTEL package's
 *     `package.json` via `require.resolve` so the values reflect the
 *     ACTUAL resolved version at runtime — guards against the
 *     1.9.0 / 1.9.1 mismatch that broke production once.
 *   * Sentry `skipOpenTelemetrySetup` state is derived from the same
 *     `OTEL_ENABLED` flag the Sentry init reads (see
 *     `observability/sentry.ts`), so the two never drift.
 *   * All failures are caught and produce `"unknown"` rather than
 *     throwing — the diagnostic endpoint must NEVER 500.
 */

import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

/**
 * Resolved version of `@opentelemetry/api` — the package that emits
 * the "duplicate registration" warning when two versions collide.
 * Reading it from the actual resolved manifest is the most reliable
 * proof that the pnpm override has been applied.
 */
function resolveVersion(packageName: string): string | "unknown" {
  try {
    const manifest = require_(`${packageName}/package.json`) as {
      version?: unknown;
    };
    return typeof manifest.version === "string" ? manifest.version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Bounded view of the OTLP headers env. NEVER returns the token; only
 * presence + scheme + length.
 */
function summariseAuthHeader(): {
  present: boolean;
  scheme: "Basic" | "Bearer" | "none";
  tokenLength: number;
} {
  const raw = (process.env.OTEL_EXPORTER_OTLP_HEADERS ?? "").trim();
  if (raw.length === 0) {
    return { present: false, scheme: "none", tokenLength: 0 };
  }
  // Look for Authorization=... pair (case insensitive).
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key.toLowerCase() !== "authorization") continue;
    if (value.toLowerCase().startsWith("basic ")) {
      return {
        present: true,
        scheme: "Basic",
        tokenLength: value.length - "Basic ".length,
      };
    }
    if (value.toLowerCase().startsWith("bearer ")) {
      return {
        present: true,
        scheme: "Bearer",
        tokenLength: value.length - "Bearer ".length,
      };
    }
    return { present: true, scheme: "none", tokenLength: value.length };
  }
  return { present: false, scheme: "none", tokenLength: 0 };
}

/**
 * Operator-safe runtime diagnostics. Stable JSON-serialisable shape;
 * never carries a token / URL / header value. Safe to log if the
 * operator wants to.
 */
export function getOtelRuntimeDiagnostics(): {
  otelEnabled: boolean;
  serviceName: string | null;
  endpointConfigured: boolean;
  protocol: string;
  exporterKind: "otlp-trace-http" | "none";
  authHeader: {
    present: boolean;
    scheme: "Basic" | "Bearer" | "none";
    tokenLength: number;
  };
  packageVersions: {
    "@opentelemetry/api": string;
    "@opentelemetry/sdk-node": string;
    "@opentelemetry/exporter-trace-otlp-proto": string;
    "@opentelemetry/resources": string;
    "@opentelemetry/auto-instrumentations-node": string;
    "@opentelemetry/semantic-conventions": string;
  };
  sentry: {
    /**
     * `true` when our otel-bootstrap owns the OTEL global APIs and
     * `Sentry.init` is configured with `skipOpenTelemetrySetup: true`
     * to avoid duplicate registration. Derived from the same
     * `OTEL_ENABLED` flag the Sentry init reads.
     */
    skipOpenTelemetrySetup: boolean;
  };
} {
  const otelEnabled =
    (process.env.OTEL_ENABLED ?? "").trim().toLowerCase() === "true";
  const endpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "").trim();
  const serviceName =
    (process.env.OTEL_SERVICE_NAME ?? "").trim() || null;
  return {
    otelEnabled,
    serviceName,
    endpointConfigured: endpoint.length > 0,
    protocol:
      (process.env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "").trim() ||
      "http/protobuf",
    exporterKind: otelEnabled ? "otlp-trace-http" : "none",
    authHeader: summariseAuthHeader(),
    packageVersions: {
      "@opentelemetry/api": resolveVersion("@opentelemetry/api"),
      "@opentelemetry/sdk-node": resolveVersion("@opentelemetry/sdk-node"),
      "@opentelemetry/exporter-trace-otlp-proto": resolveVersion(
        "@opentelemetry/exporter-trace-otlp-proto",
      ),
      "@opentelemetry/resources": resolveVersion("@opentelemetry/resources"),
      "@opentelemetry/auto-instrumentations-node": resolveVersion(
        "@opentelemetry/auto-instrumentations-node",
      ),
      "@opentelemetry/semantic-conventions": resolveVersion(
        "@opentelemetry/semantic-conventions",
      ),
    },
    sentry: {
      skipOpenTelemetrySetup: otelEnabled,
    },
  };
}
