/**
 * Phase O1.1 — OTEL runtime wiring closure tests.
 *
 * Coverage:
 *   * Bootstrap module shape (`otel.bootstrap_started` /
 *     `succeeded` / `disabled` / `failed` log lines).
 *   * Per-service entrypoint pins the bounded service name.
 *   * Worker entrypoint imports OTEL bootstrap BEFORE BullMQ / queue.
 *   * docker-compose pins `OTEL_SERVICE_NAME` per container and does
 *     NOT hardcode the Grafana token.
 *   * The bounded PROOVRA span names cover the documented critical
 *     spans (signer / custody / c2pa / siu / package + queue +
 *     recovery).
 *   * `withProovraSpan` helper exists and is used at critical entry
 *     points: SIU preflight, SIU export, C2PA detect, C2PA package
 *     summary, signer health, recovery validation.
 *   * `/v1/runtime/otel-health` endpoint never returns the OTLP
 *     endpoint URL, headers, or Grafana token.
 *   * Bootstrap logs include `endpointConfigured` / `protocol` /
 *     `exporterKind` but NEVER the URL.
 *   * Sentry init is untouched.
 *   * `.env.example` documents the bounded OTEL keys without
 *     hardcoding any token.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
function read(rel: string): string {
  return readFileSync(REPO_ROOT + rel, "utf-8");
}

describe("O1.1 — API entrypoint import order", () => {
  it("server.ts imports the OTEL bootstrap BEFORE Fastify", () => {
    const src = read("services/api/src/server.ts");
    const otelIdx = src.indexOf('./observability/otel-bootstrap');
    const fastifyIdx = src.search(/from\s+["']fastify["']/);
    expect(otelIdx).toBeGreaterThan(0);
    expect(fastifyIdx).toBeGreaterThan(0);
    expect(otelIdx).toBeLessThan(fastifyIdx);
  });

  it("otel-bootstrap.ts pins `proovra-api` as the default service name", () => {
    const src = read("services/api/src/observability/otel-bootstrap.ts");
    expect(src).toContain('defaultServiceName: "proovra-api"');
  });
});

describe("O1.1 — Worker entrypoint import order", () => {
  it("worker index.ts imports OTEL bootstrap BEFORE bullmq", () => {
    const src = read("services/worker/src/index.ts");
    const otelIdx = src.indexOf("./otel-bootstrap");
    const bullmqIdx = src.search(/from\s+["']bullmq["']/);
    // BullMQ may be imported transitively via queue.ts — we check
    // both the direct bullmq import and the transitive queue import.
    const queueIdx = src.indexOf("./queue");
    expect(otelIdx).toBeGreaterThan(0);
    // OTEL must precede whichever surface imports BullMQ first.
    const firstQueueLike = [bullmqIdx, queueIdx].filter((i) => i > 0).sort((a, b) => a - b)[0];
    expect(firstQueueLike).toBeGreaterThan(0);
    expect(otelIdx).toBeLessThan(firstQueueLike!);
  });

  it("worker otel-bootstrap.ts pins `proovra-worker` as the default service name", () => {
    const src = read("services/worker/src/otel-bootstrap.ts");
    expect(src).toContain('defaultServiceName: "proovra-worker"');
  });
});

describe("O1.1 — Bootstrap log line shape (api + worker)", () => {
  for (const path of [
    "services/api/src/observability/otel.ts",
    "services/worker/src/otel.ts",
  ]) {
    it(`${path} emits the four bounded log lines`, () => {
      const src = read(path);
      expect(src).toContain('"otel.bootstrap_started"');
      expect(src).toContain('"otel.bootstrap_succeeded"');
      expect(src).toContain('"otel.bootstrap_disabled"');
      expect(src).toContain('"otel.bootstrap_failed"');
    });

    it(`${path} NEVER logs the OTLP endpoint URL or headers`, () => {
      const src = read(path);
      // Logged objects MUST NOT include `endpoint:` (the URL) or
      // `headers:`. They MAY include the bounded `endpointConfigured`
      // boolean and `protocol` string.
      expect(src).not.toMatch(/log\.info\([^)]*endpoint:\s*tracesUrl/);
      expect(src).not.toMatch(/log\.info\([^)]*headers:/);
    });

    it(`${path} exports the bounded PROOVRA_SPAN_NAMES with all critical entries`, () => {
      const src = read(path);
      for (const expected of [
        "proovra.signer.health_check",
        "proovra.custody.attestation.sign",
        "proovra.custody.attestation.verify",
        "proovra.package.attestations.collect",
        "proovra.c2pa.detect",
        "proovra.c2pa.validate",
        "proovra.c2pa.package_summary",
        "proovra.siu.export.preflight",
        "proovra.siu.export.generate",
        "proovra.siu.followup.request",
        "proovra.siu.timeline.build",
      ]) {
        expect(src).toContain(`"${expected}"`);
      }
    });

    it(`${path} exposes the bounded withProovraSpan helper`, () => {
      const src = read(path);
      expect(src).toContain("export async function withProovraSpan");
      // The helper must bound attribute keys + values defensively.
      expect(src).toContain("boundedAttributes");
    });

    it(`${path}'s getOtelStatus exposes the bounded health snapshot`, () => {
      const src = read(path);
      expect(src).toContain("lastBootstrapAtUtc");
      expect(src).toContain("lastBootstrapOutcome");
      expect(src).toContain("lastBootstrapFailureCode");
      expect(src).toContain("lastExportErrorCode");
      expect(src).toContain("spansCreatedCount");
      expect(src).toContain("degraded");
      expect(src).toContain("resourceAttributes");
    });
  }
});

describe("O1.1 — docker-compose pins service names + does not hardcode the token", () => {
  const compose = read("infra/docker/docker-compose.prod.yml");

  it("pins OTEL_SERVICE_NAME on each container", () => {
    expect(compose).toMatch(/OTEL_SERVICE_NAME:\s*proovra-api/);
    expect(compose).toMatch(/OTEL_SERVICE_NAME:\s*proovra-worker/);
  });

  it("never hardcodes a Grafana / OTLP token", () => {
    // Headers come from the `.env` via interpolation; no Authorization
    // string is baked into the compose file.
    expect(compose).not.toMatch(/Authorization=Basic\s+[A-Za-z0-9+/=]{8}/);
    expect(compose).not.toMatch(/Authorization=Bearer\s+[A-Za-z0-9._-]{8}/);
  });

  it("inherits endpoint / protocol / headers from `.env`", () => {
    expect(compose).toMatch(
      /OTEL_EXPORTER_OTLP_ENDPOINT:\s*\${OTEL_EXPORTER_OTLP_ENDPOINT/,
    );
    expect(compose).toMatch(
      /OTEL_EXPORTER_OTLP_HEADERS:\s*\${OTEL_EXPORTER_OTLP_HEADERS/,
    );
  });
});

describe("O1.1 — withProovraSpan is wired into critical entry points", () => {
  it("SIU preflight wraps its work with proovra.siu.export.preflight", () => {
    const src = read("services/api/src/services/siu/siu-preflight.service.ts");
    expect(src).toContain("withProovraSpan");
    expect(src).toContain("PROOVRA_SPAN_NAMES.SIU_EXPORT_PREFLIGHT");
  });

  it("SIU export bundle wraps generation with proovra.siu.export.generate", () => {
    const src = read(
      "services/api/src/services/siu/siu-export-bundle.service.ts",
    );
    expect(src).toContain("withProovraSpan");
    expect(src).toContain("PROOVRA_SPAN_NAMES.SIU_EXPORT_GENERATE");
  });

  it("C2PA provider wraps detection with proovra.c2pa.detect", () => {
    const src = read("services/worker/src/c2pa/provider.ts");
    expect(src).toContain("withProovraSpan");
    expect(src).toContain("PROOVRA_SPAN_NAMES.C2PA_DETECT");
  });

  it("C2PA package summary wraps with proovra.c2pa.package_summary", () => {
    const src = read("services/worker/src/c2pa/package-summary.ts");
    expect(src).toContain("withProovraSpan");
    expect(src).toContain("PROOVRA_SPAN_NAMES.C2PA_PACKAGE_SUMMARY");
  });

  it("signer health wraps with proovra.signer.health_check", () => {
    const src = read(
      "services/api/src/services/operations/signer-health.service.ts",
    );
    expect(src).toContain("withProovraSpan");
    expect(src).toContain("PROOVRA_SPAN_NAMES.SIGNER_HEALTH_CHECK");
  });

  it("recovery validation wraps backup + restore", () => {
    const src = read(
      "services/api/src/services/operations/recovery-validation.service.ts",
    );
    expect(src).toContain("PROOVRA_SPAN_NAMES.RECOVERY_BACKUP_VALIDATE");
    expect(src).toContain("PROOVRA_SPAN_NAMES.RECOVERY_RESTORE_VALIDATE");
  });
});

describe("O1.1 — /v1/runtime/otel-health endpoint safety", () => {
  const src = read("services/api/src/routes/runtime-otel-health.routes.ts");

  it("auth-gated through the team-member access check", () => {
    expect(src).toContain("requireAuth");
    expect(src).toContain("evaluateMemberAccess");
  });

  it("returns only the bounded `getOtelStatus()` snapshot", () => {
    expect(src).toContain("getOtelStatus()");
    // Strip the documentation header before sweeping for runtime
    // surfaces — the doc block legitimately names the forbidden keys
    // to document that they are NEVER returned.
    const stripped = src
      .split("\n")
      .filter((line) => !/^\s*\*/.test(line) && !/^\s*\/\//.test(line))
      .join("\n");
    expect(stripped).not.toMatch(/process\.env\.OTEL_EXPORTER_OTLP_HEADERS/);
    expect(stripped).not.toMatch(/process\.env\.OTEL_EXPORTER_OTLP_ENDPOINT/);
    expect(stripped).not.toMatch(/Authorization/);
  });
});

describe("O1.1 — Sentry init is untouched", () => {
  it("Sentry module exists and still exports initSentry", () => {
    const src = read("services/api/src/observability/sentry.ts");
    expect(src).toMatch(/export\s+function\s+initSentry/);
  });

  it("server.ts still calls initSentry", () => {
    const src = read("services/api/src/server.ts");
    expect(src).toContain("initSentry");
  });
});

describe("O1.1 — `.env.example` documents OTEL keys without token", () => {
  const src = read("services/worker/.env.example");

  it("declares the bounded OTEL keys with empty defaults", () => {
    for (const key of [
      "OTEL_ENABLED",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_PROTOCOL",
      "OTEL_EXPORTER_OTLP_HEADERS",
      "OTEL_RESOURCE_ATTRIBUTES",
      "LOG_AGGREGATION_ENABLED",
    ]) {
      expect(src).toContain(key);
    }
  });

  it("never embeds an Authorization token", () => {
    expect(src).not.toMatch(/Authorization=Basic\s+\S{4,}/);
  });
});

describe("O1.1 — bootstrap helper safety (runtime behaviour)", () => {
  it("withProovraSpan executes the inner fn even when OTEL is disabled", async () => {
    process.env.OTEL_ENABLED = "false";
    const mod = await import("../src/otel.js");
    // No bootstrap fired; we still expect the helper to run the fn
    // through the no-op tracer.
    let observed: number | null = null;
    const result = await mod.withProovraSpan(
      mod.PROOVRA_SPAN_NAMES.C2PA_DETECT,
      { evidenceId: "00000000-0000-0000-0000-000000000000" },
      () => {
        observed = 7;
        return Promise.resolve(7);
      },
    );
    expect(result).toBe(7);
    expect(observed).toBe(7);
  });

  it("withProovraSpan bounds attribute values defensively", async () => {
    process.env.OTEL_ENABLED = "false";
    const mod = await import("../src/otel.js");
    // Even when the underlying span is a no-op the helper must not
    // throw on hostile attribute values.
    let result: string | null = null;
    await mod.withProovraSpan(
      mod.PROOVRA_SPAN_NAMES.C2PA_DETECT,
      {
        // bounded — should be truncated by the helper, not thrown.
        nonsense: "x".repeat(1024),
        garbage: undefined,
        wrongtypes: NaN as unknown as number,
      },
      () => {
        result = "ok";
        return Promise.resolve();
      },
    );
    expect(result).toBe("ok");
  });
});
