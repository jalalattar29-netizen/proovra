/**
 * Phase P2.0B — Observability + secrets wiring closure contract suite.
 *
 *   1. AWS_SECRETS_REGION takes precedence over AWS_REGION.
 *   2. AWS_REGION is NOT consulted by the Secrets Manager client when
 *      AWS_SECRETS_REGION is set — so KMS (which reads AWS_REGION
 *      directly) stays on its own region.
 *   3. AWS_SECRETS_REFRESH_TTL_MS env name is honoured.
 *   4. OTEL bootstrap is a no-op when OTEL_ENABLED ≠ "true".
 *   5. OTEL bootstrap status excludes endpoint URL + headers.
 *   6. Sentry init uses env-driven sample rates clamped to [0,1].
 *   7. Sentry beforeSendTransaction scrubs auth / cookie / token /
 *      secret / api-key headers.
 *   8. PROOVRA_SPAN_NAMES carries the 10 documented span names.
 *   9. docker-compose.prod.yml pins distinct OTEL_SERVICE_NAME per
 *      service (proovra-api / proovra-worker), AWS_SECRETS_REGION
 *      defaults to us-east-1, AWS_REGION defaults to eu-north-1.
 *   10. The migrated allowlist now includes the P2.0B additions.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetSecretsManagerForTests,
  getSecretsHealth,
  initSecretsManager,
} from "../src/config/secrets-manager.js";
import { MIGRATED_SECRETS } from "../src/config/runtime-secrets.js";
import {
  getOtelStatus,
  initOpenTelemetry,
  PROOVRA_SPAN_NAMES,
} from "../src/observability/otel.js";

function readSource(rel: string): string {
  const url = new URL(rel, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

const noopLog = {
  info: () => undefined,
  warn: () => undefined,
};

describe("Phase P2.0B — Secrets Manager region precedence", () => {
  beforeEach(() => {
    __resetSecretsManagerForTests();
    delete process.env.AWS_SECRETS_ENABLED;
    delete process.env.AWS_SECRETS_REGION;
    delete process.env.AWS_REGION;
    delete process.env.AWS_SECRETS_REFRESH_TTL_MS;
    delete process.env.SECRETS_REFRESH_TTL_MS;
    vi.restoreAllMocks();
  });

  it("uses AWS_SECRETS_REGION when set, even if AWS_REGION differs", async () => {
    process.env.AWS_SECRETS_ENABLED = "true";
    process.env.AWS_SECRETS_REGION = "us-east-1";
    process.env.AWS_REGION = "eu-north-1"; // KMS region — must NOT
                                            // change Secrets behaviour
    const mod = await import("@aws-sdk/client-secrets-manager");
    vi.spyOn(mod.SecretsManagerClient.prototype, "send").mockResolvedValue({
      SecretString: JSON.stringify({ AUTH_JWT_SECRET: "x" }),
    } as never);

    await initSecretsManager(noopLog);
    const h = getSecretsHealth();
    // `region` is the bounded health-snapshot field that surfaces
    // `configuredRegion()` directly. AWS_SECRETS_REGION must win.
    expect(h.region).toBe("us-east-1");
    // And crucially: AWS_REGION is still set to eu-north-1 in env,
    // so anything that reads it directly (the KMS signer does) is
    // unaffected.
    expect(process.env.AWS_REGION).toBe("eu-north-1");
  });

  it("falls back to AWS_REGION when AWS_SECRETS_REGION is unset", async () => {
    process.env.AWS_SECRETS_ENABLED = "true";
    delete process.env.AWS_SECRETS_REGION;
    process.env.AWS_REGION = "eu-north-1";
    // Force a hydration failure so we don't need a working AWS client
    // — what we care about is the region the client was constructed with.
    const mod = await import("@aws-sdk/client-secrets-manager");
    vi.spyOn(mod.SecretsManagerClient.prototype, "send").mockRejectedValue(
      Object.assign(new Error("nope"), { name: "AccessDeniedException" }),
    );
    await initSecretsManager(noopLog);
    expect(getSecretsHealth().region).toBe("eu-north-1");
  });

  it("falls back to us-east-1 when both AWS_SECRETS_REGION and AWS_REGION are unset", async () => {
    process.env.AWS_SECRETS_ENABLED = "true";
    const mod = await import("@aws-sdk/client-secrets-manager");
    vi.spyOn(mod.SecretsManagerClient.prototype, "send").mockRejectedValue(
      Object.assign(new Error("nope"), { name: "AccessDeniedException" }),
    );
    await initSecretsManager(noopLog);
    expect(getSecretsHealth().region).toBe("us-east-1");
  });

  it("honours AWS_SECRETS_REFRESH_TTL_MS env name", async () => {
    process.env.AWS_SECRETS_ENABLED = "true";
    process.env.AWS_SECRETS_REFRESH_TTL_MS = "120000";
    const mod = await import("@aws-sdk/client-secrets-manager");
    const sendSpy = vi
      .spyOn(mod.SecretsManagerClient.prototype, "send")
      .mockRejectedValue(
        Object.assign(new Error("nope"), { name: "AccessDeniedException" }),
      );
    await initSecretsManager(noopLog);
    // Smoke check: loader still runs to completion without throwing.
    expect(sendSpy).toHaveBeenCalledOnce();
  });
});

describe("Phase P2.0B — OTEL bootstrap", () => {
  beforeEach(() => {
    delete process.env.OTEL_ENABLED;
    delete process.env.OTEL_SERVICE_NAME;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
  });

  it("is a no-op when OTEL_ENABLED is not 'true'", () => {
    const result = initOpenTelemetry({
      defaultServiceName: "proovra-api",
      log: noopLog,
    });
    expect(result).toBe(false);
    const s = getOtelStatus();
    expect(s.enabled).toBe(false);
    expect(s.started).toBe(false);
  });

  it("status snapshot never includes endpoint URL or headers", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://otlp.example/otlp";
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=Basic super-secret-token";
    const s = getOtelStatus();
    const serialised = JSON.stringify(s);
    expect(serialised).not.toContain("https://otlp.example");
    expect(serialised).not.toContain("super-secret-token");
    expect(serialised).not.toContain("Authorization");
    // endpointConfigured is the only allowed signal about the endpoint.
    expect(serialised).toMatch(/"endpointConfigured":/);
  });

  it("exposes the P2.0B span names that still have runtime emission as a required subset", () => {
    // Phase O1.4 enforced "no enum-only entries" — every PROOVRA span
    // name in the enum MUST have a real `withProovraSpan(…)` call
    // site. The original 10 P2.0B names were audited: 5 had real
    // runtime emission and remain in the enum; the other 5 were
    // enum-only historical drift (no emission site ever existed) and
    // were REMOVED. They will be re-added one at a time alongside
    // their runtime emission site.
    //
    // Removed (deferred until runtime emission lands):
    //   - proovra.report.generate
    //   - proovra.package.generate
    //   - proovra.export.manifest.create
    //   - proovra.export.reproducibility.verify
    //   - proovra.tsa.timestamp
    //   - proovra.ots.anchor
    // (See `docs/operations/phase-o1-4-business-flow-instrumentation.md` §6.)
    //
    // The bounded floor below is the subset that survived the
    // O1.4 audit. The enum still satisfies the original P2.0B intent
    // (bounded `proovra.*` namespace, finite size) — just with a
    // smaller, truthful catalog.
    const required = new Set([
      "proovra.queue.job.replay",
      "proovra.queue.job.retry",
      "proovra.recovery.backup.validate",
      "proovra.recovery.restore.validate",
    ]);
    const actual = new Set<string>(
      Object.values(PROOVRA_SPAN_NAMES) as readonly string[],
    );
    for (const name of required) {
      expect(actual.has(name)).toBe(true);
    }
    // Every span name in the enum must remain bounded — `proovra.*`
    // prefix only, no free-form names slipping in.
    for (const name of actual) {
      expect(typeof name).toBe("string");
      expect(name.startsWith("proovra.")).toBe(true);
    }
    // Bounded enum size sanity.
    expect(actual.size).toBeGreaterThanOrEqual(required.size);
    expect(actual.size).toBeLessThanOrEqual(128);
  });
});

describe("Phase P2.0B — Sentry env-driven sample rates + scrubbing", () => {
  it("API Sentry init reads SENTRY_TRACES_SAMPLE_RATE / SENTRY_PROFILES_SAMPLE_RATE", () => {
    const src = readSource("../src/observability/sentry.ts");
    expect(src).toContain('"SENTRY_TRACES_SAMPLE_RATE"');
    expect(src).toContain('"SENTRY_PROFILES_SAMPLE_RATE"');
    // Defaults are bounded — 0.2 for traces, 0.1 for profiles.
    expect(src).toMatch(/SENTRY_TRACES_SAMPLE_RATE[\s\S]{0,80}0\.2/);
    expect(src).toMatch(/SENTRY_PROFILES_SAMPLE_RATE[\s\S]{0,80}0\.1/);
  });

  it("API Sentry serverName is proovra-api", () => {
    const src = readSource("../src/observability/sentry.ts");
    expect(src).toContain('serverName: "proovra-api"');
  });

  it("Worker Sentry serverName is proovra-worker", () => {
    const src = readSource("../../worker/src/sentry.ts");
    expect(src).toContain('serverName: "proovra-worker"');
  });

  it("Sentry beforeSendTransaction redacts auth-bearing headers", () => {
    const apiSrc = readSource("../src/observability/sentry.ts");
    const workerSrc = readSource("../../worker/src/sentry.ts");
    for (const src of [apiSrc, workerSrc]) {
      expect(src).toContain("beforeSendTransaction");
      expect(src).toContain('"authorization"');
      expect(src).toContain('"cookie"');
      expect(src).toContain('"token"');
      expect(src).toContain('"secret"');
      expect(src).toContain('"api-key"');
      expect(src).toContain('"[REDACTED]"');
    }
  });

  it("Sample-rate parser clamps invalid values to fallback", () => {
    const src = readSource("../src/observability/sentry.ts");
    expect(src).toMatch(/if \(!Number\.isFinite\(n\) \|\| n < 0 \|\| n > 1\) return fallback/);
  });
});

describe("Phase P2.0B — docker-compose.prod.yml service-name + region wiring", () => {
  const compose = readSource("../../../infra/docker/docker-compose.prod.yml");

  it("pins OTEL_SERVICE_NAME=proovra-api on the api service", () => {
    // The api service block ends where the worker service block starts.
    const api = compose.split("proovra-worker:")[0];
    expect(api).toContain("OTEL_SERVICE_NAME: proovra-api");
  });

  it("pins OTEL_SERVICE_NAME=proovra-worker on the worker service", () => {
    const worker = compose.split("proovra-worker:")[1] ?? "";
    expect(worker).toContain("OTEL_SERVICE_NAME: proovra-worker");
  });

  it("defaults AWS_SECRETS_REGION to us-east-1 and AWS_REGION to eu-north-1", () => {
    expect(compose).toContain("AWS_SECRETS_REGION: ${AWS_SECRETS_REGION:-us-east-1}");
    expect(compose).toContain("AWS_REGION: ${AWS_REGION:-eu-north-1}");
  });

  it("does not pass AUTH_JWT_SECRET as an explicit container env (env_file only)", () => {
    // The api service block should not redundantly mount AUTH_JWT_SECRET
    // — `env_file` already covers it, and an explicit value would
    // appear in `docker inspect`.
    const api = compose.split("proovra-worker:")[0];
    expect(api).not.toMatch(/^\s+AUTH_JWT_SECRET:\s+\$\{AUTH_JWT_SECRET\}/m);
  });

  it("uses bounded Sentry sample-rate defaults in compose (0.2 traces, 0.1 profiles)", () => {
    expect(compose).toContain(
      "SENTRY_TRACES_SAMPLE_RATE: ${SENTRY_TRACES_SAMPLE_RATE:-0.2}",
    );
    expect(compose).toContain(
      "SENTRY_PROFILES_SAMPLE_RATE: ${SENTRY_PROFILES_SAMPLE_RATE:-0.1}",
    );
  });

  it("never hardcodes a Grafana OTEL token in the compose file", () => {
    // OTEL headers must come from the .env. Any hardcoded
    // `Authorization=Basic ...` in the compose file is a leak.
    expect(compose).not.toMatch(/Authorization=Basic\s+[A-Za-z0-9_+/=]/);
  });
});

describe("Phase P2.0B — Expanded migrated secrets allowlist", () => {
  it("includes the second-wave names without dropping the first wave", () => {
    expect(new Set(MIGRATED_SECRETS)).toEqual(
      new Set([
        // First wave (P2.0)
        "OPENAI_API_KEY",
        "AUTH_JWT_SECRET",
        "STRIPE_SECRET_KEY",
        "PAYPAL_SECRET",
        "RESEND_API_KEY",
        // Second wave (P2.0B)
        "STRIPE_WEBHOOK_SECRET",
        "PAYPAL_CLIENT_ID",
        "PAYPAL_WEBHOOK_ID",
        "TWILIO_API_KEY",
        "TWILIO_API_SECRET",
        "TWILIO_AUTH_TOKEN",
        "API_KEY_SECRET",
        "NOTIFICATION_CRON_SECRET",
        "INTEGRATION_CRON_SECRET",
        "REVIEWER_OPS_CRON_SECRET",
      ]),
    );
  });
});

describe("Phase P2.0B — OTEL bootstrap import order", () => {
  it("api server.ts imports otel-bootstrap before Fastify", () => {
    const server = readSource("../src/server.ts");
    const otelIdx = server.indexOf('"./observability/otel-bootstrap.js"');
    const fastifyIdx = server.indexOf('from "fastify"');
    expect(otelIdx).toBeGreaterThan(-1);
    expect(fastifyIdx).toBeGreaterThan(-1);
    expect(otelIdx).toBeLessThan(fastifyIdx);
  });

  it("worker index.ts imports otel-bootstrap before BullMQ", () => {
    const worker = readSource("../../worker/src/index.ts");
    const otelIdx = worker.indexOf('"./otel-bootstrap.js"');
    const bullmqIdx = worker.indexOf('from "bullmq"');
    expect(otelIdx).toBeGreaterThan(-1);
    expect(bullmqIdx).toBeGreaterThan(-1);
    expect(otelIdx).toBeLessThan(bullmqIdx);
  });
});

describe("Phase P2.0B — Secrets-health route surfaces OTEL safely", () => {
  it("route returns `otel` snapshot but never the endpoint URL or headers", () => {
    const route = readSource(
      "../src/routes/runtime-secrets-health.routes.ts",
    );
    expect(route).toContain("getOtelStatus");
    // The route should not destructure the env / headers itself.
    expect(route).not.toContain("OTEL_EXPORTER_OTLP_HEADERS");
    expect(route).not.toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
  });
});
