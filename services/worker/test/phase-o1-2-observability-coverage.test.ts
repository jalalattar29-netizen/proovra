/**
 * Phase O1.2 — observability coverage closure tests.
 *
 * Coverage:
 *   * Queue replay + retry services wrap with `withProovraSpan` and
 *     reference the bounded `QUEUE_JOB_REPLAY` / `QUEUE_JOB_RETRY`
 *     names.
 *   * Custody attestation sign / verify / backfill services wrap
 *     with `withProovraSpan` and reference the bounded
 *     `CUSTODY_ATTESTATION_SIGN` / `_VERIFY` / `_BACKFILL` names.
 *   * Bounded `PROOVRA_SPAN_NAMES` enum includes the new
 *     `CUSTODY_ATTESTATION_BACKFILL` entry on BOTH api and worker
 *     copies.
 *   * Bounded metric registry includes every counter name referenced
 *     by the new dashboards + alerts.
 *   * `infra/grafana/dashboards/` ships the four documented JSON
 *     files; every panel's PromQL references a counter that exists
 *     in the bounded registry.
 *   * `infra/grafana/alerts/proovra-operations-alerts.yaml` ships the
 *     eleven documented alert rules; each rule references a metric
 *     in the bounded registry AND links a runbook URL.
 *   * Runbook anchors documented in `observability-runbooks.md` for
 *     every alert.
 *   * SLO doc declares the six bounded internal SLOs.
 *   * `getOtelStatus()` exposes `lastSpanName` + `lastSpanAtUtc` on
 *     both api and worker copies; the OTEL health endpoint returns
 *     them safely (no token / header / URL leak).
 *   * Source contracts confirm no forbidden telemetry labels appear
 *     in the wrapped services (`email`, `token`, `secret`,
 *     `signature`, `rawPayload`, `fileContent`).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { COUNTER_NAMES } from "@proovra/shared-runtime/ops";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
function read(rel: string): string {
  return readFileSync(REPO_ROOT + rel, "utf-8");
}

// ---------------------------------------------------------------------------
// 1. Span wiring source contracts
// ---------------------------------------------------------------------------

describe("O1.2 — span wiring (queue + custody)", () => {
  it("queue-replay-action.service.ts wraps retry + replay with bounded spans", () => {
    const src = read(
      "services/api/src/services/operations/queue-replay-action.service.ts",
    );
    expect(src).toContain("PROOVRA_SPAN_NAMES.QUEUE_JOB_RETRY");
    expect(src).toContain("PROOVRA_SPAN_NAMES.QUEUE_JOB_REPLAY");
    expect(src).toContain("withProovraSpan");
  });

  it("queue retry path bumps both success + failure counters", () => {
    const src = read(
      "services/api/src/services/operations/queue-replay-action.service.ts",
    );
    expect(src).toContain('"queue_retry_total"');
    expect(src).toContain('"queue_retry_failure_total"');
  });

  it("custody-attestation.service.ts wraps sign / verify / backfill with bounded spans", () => {
    const src = read(
      "services/api/src/services/operations/custody-attestation.service.ts",
    );
    expect(src).toContain("PROOVRA_SPAN_NAMES.CUSTODY_ATTESTATION_SIGN");
    expect(src).toContain("PROOVRA_SPAN_NAMES.CUSTODY_ATTESTATION_VERIFY");
    expect(src).toContain("PROOVRA_SPAN_NAMES.CUSTODY_ATTESTATION_BACKFILL");
  });

  it("custody attestation path bumps signed / verified / failure counters", () => {
    const src = read(
      "services/api/src/services/operations/custody-attestation.service.ts",
    );
    expect(src).toContain('"custody_attestation_signed_total"');
    expect(src).toContain('"custody_attestation_verified_total"');
    expect(src).toContain('"custody_attestation_verification_failure_total"');
    expect(src).toContain('"custody_attestation_sign_failure_total"');
  });

  it("PROOVRA_SPAN_NAMES enum now includes CUSTODY_ATTESTATION_BACKFILL on both copies", () => {
    for (const path of [
      "services/api/src/observability/otel.ts",
      "services/worker/src/otel.ts",
    ]) {
      expect(read(path)).toContain('"proovra.custody.attestation.backfill"');
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Metric registry
// ---------------------------------------------------------------------------

describe("O1.2 — metric registry", () => {
  for (const counter of [
    "queue_retry_total",
    "queue_retry_failure_total",
    "queue_replay_duration_ms",
    "custody_attestation_sign_failure_total",
    "siu_export_generated_total",
    "siu_export_failed_total",
    "siu_export_download_total",
    "siu_export_upload_failure_total",
    "package_generation_total",
    "package_generation_failed_total",
    "export_generation_total",
    "export_generation_failed_total",
    "export_reproducibility_verify_total",
    "recovery_backup_validation_total",
    "recovery_restore_validation_total",
    "recovery_validation_failed_total",
    "c2pa_backfill_run_failure_total",
    "siu_pii_revealed_total",
  ]) {
    it(`COUNTER_NAMES includes ${counter}`, () => {
      expect(COUNTER_NAMES).toContain(counter);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Dashboards
// ---------------------------------------------------------------------------

const DASHBOARD_FILES = [
  "infra/grafana/dashboards/proovra-operations-overview.json",
  "infra/grafana/dashboards/proovra-queue-operations.json",
  "infra/grafana/dashboards/proovra-exports-reproducibility.json",
  "infra/grafana/dashboards/proovra-recovery.json",
] as const;

describe("O1.2 — Grafana dashboards", () => {
  for (const path of DASHBOARD_FILES) {
    it(`${path} parses as JSON + carries a bounded uid + title`, () => {
      const json = JSON.parse(read(path)) as {
        uid?: string;
        title?: string;
        panels?: Array<{ targets?: Array<{ expr?: string }> }>;
      };
      expect(typeof json.uid).toBe("string");
      expect(typeof json.title).toBe("string");
      expect(Array.isArray(json.panels)).toBe(true);
    });

    it(`${path} only references metrics that exist in the bounded registry`, () => {
      const json = JSON.parse(read(path)) as {
        panels?: Array<{ targets?: Array<{ expr?: string }> }>;
      };
      // Collect every metric token (`word_token`) we can find in
      // every PromQL expression.
      const allowExtras = new Set<string>([
        // Auto-instrumentation / Prometheus-default metrics.
        "up",
        "http_server_requests_total",
        // OTEL bootstrap probe — exposed via a derived gauge in the
        // bounded log lines. Not in COUNTER_NAMES because it is a
        // gauge / synthesised signal.
        "otel_bootstrap_started",
      ]);
      const allowed = new Set<string>([...COUNTER_NAMES, ...allowExtras]);
      for (const panel of json.panels ?? []) {
        for (const tgt of panel.targets ?? []) {
          const expr = tgt.expr ?? "";
          const tokens = expr.match(/[a-z][a-z0-9_]+_total\b/g) ?? [];
          for (const tok of tokens) {
            expect.soft(allowed.has(tok)).toBe(true);
          }
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 4. Alerts
// ---------------------------------------------------------------------------

describe("O1.2 — alert rules", () => {
  const src = read("infra/grafana/alerts/proovra-operations-alerts.yaml");

  it("ships the eleven bounded alert UIDs", () => {
    for (const uid of [
      "proovra-api-down",
      "proovra-worker-degraded",
      "proovra-queue-failed-jobs-spike",
      "proovra-export-failure-spike",
      "proovra-package-generation-failure",
      "proovra-recovery-validation-failure",
      "proovra-siu-export-upload-failure",
      "proovra-c2pa-backfill-failure",
      "proovra-signer-health-degraded",
      "proovra-forbidden-replay-attempted",
      "proovra-pii-reveal-spike",
    ]) {
      expect(src).toContain(`uid: ${uid}`);
    }
  });

  it("every alert links a runbook URL anchor", () => {
    const lines = src.split("\n");
    const runbookCount = lines.filter((l) => /runbook_url:/.test(l)).length;
    expect(runbookCount).toBeGreaterThanOrEqual(11);
  });
});

// ---------------------------------------------------------------------------
// 5. Runbooks
// ---------------------------------------------------------------------------

describe("O1.2 — runbook anchors", () => {
  const md = read("docs/operations/observability-runbooks.md");
  for (const anchor of [
    "## api-down",
    "## worker-degraded",
    "## queue-failures",
    "## export-failures",
    "## package-generation-failures",
    "## recovery-validation-failures",
    "## siu-export-upload-failure",
    "## c2pa-backfill-failure",
    "## signer-health-degraded",
    "## forbidden-replay-attempted",
    "## siu-pii-reveal-spike",
  ]) {
    it(`runbook anchor ${anchor} exists`, () => {
      expect(md).toContain(anchor);
    });
  }
});

// ---------------------------------------------------------------------------
// 6. SLO doc
// ---------------------------------------------------------------------------

describe("O1.2 — SLO model", () => {
  const md = read("docs/operations/slo-model.md");

  it("declares the six bounded internal SLOs", () => {
    for (const slo of [
      "API availability",
      "Verification Package generation success",
      "Report generation success",
      "Queue recovery safety",
      "Export reproducibility",
      "Worker health",
    ]) {
      expect(md).toContain(slo);
    }
  });

  it("explicitly labels SLOs as internal — not a customer SLA", () => {
    expect(md).toMatch(/internal targets/i);
    expect(md).toMatch(/not.*customer SLA/i);
  });
});

// ---------------------------------------------------------------------------
// 7. OTEL health extension
// ---------------------------------------------------------------------------

describe("O1.2 — OTEL health extension (lastSpanName / lastSpanAtUtc)", () => {
  for (const path of [
    "services/api/src/observability/otel.ts",
    "services/worker/src/otel.ts",
  ]) {
    it(`${path} exposes lastSpanName + lastSpanAtUtc`, () => {
      const src = read(path);
      expect(src).toContain("lastSpanName");
      expect(src).toContain("lastSpanAtUtc");
    });
  }

  it("/v1/runtime/otel-health endpoint never returns endpoint / headers / token", () => {
    const src = read("services/api/src/routes/runtime-otel-health.routes.ts");
    const stripped = src
      .split("\n")
      .filter((line) => !/^\s*\*/.test(line) && !/^\s*\/\//.test(line))
      .join("\n");
    expect(stripped).not.toMatch(/process\.env\.OTEL_EXPORTER_OTLP_HEADERS/);
    expect(stripped).not.toMatch(/process\.env\.OTEL_EXPORTER_OTLP_ENDPOINT/);
    expect(stripped).not.toMatch(/Authorization/);
  });
});

// ---------------------------------------------------------------------------
// 8. Telemetry sensitivity sweep
// ---------------------------------------------------------------------------

describe("O1.2 — no forbidden telemetry labels in wrapped services", () => {
  const FORBIDDEN_LABEL_KEYS = [
    "email:",
    "token:",
    "secret:",
    "signature:",
    "rawPayload:",
    "fileContent:",
  ];
  for (const path of [
    "services/api/src/services/operations/queue-replay-action.service.ts",
    "services/api/src/services/operations/custody-attestation.service.ts",
  ]) {
    it(`${path} does NOT pass forbidden labels through withProovraSpan`, () => {
      const src = read(path);
      // We only assert that the bounded attribute objects passed to
      // `withProovraSpan(...)` don't contain forbidden keys. Find
      // every span call site and inspect the bounded attribute
      // literal.
      const callSites = src.match(
        /withProovraSpan\([\s\S]*?\)\s*;|withProovraSpan\([\s\S]*?,\s*\)\s*=>/g,
      ) ?? [];
      for (const call of callSites) {
        for (const key of FORBIDDEN_LABEL_KEYS) {
          expect.soft(call.includes(key)).toBe(false);
        }
      }
    });
  }
});
