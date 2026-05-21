/**
 * Phase 32.6 — Production runtime recovery: regression tests.
 *
 * Three production blockers from Phase 32.5 stabilization remained
 * visible in operator dashboards:
 *
 *   1. Runtime banner showed "Failing subsystems: workers" on every
 *      fresh API process start because checkWorkers() reported
 *      DEGRADED until the worker's reviewer-reconciliation
 *      scheduler ticked once (default 5 min interval). This was a
 *      false-positive — the worker was perfectly healthy and
 *      hadn't completed its first tick yet.
 *
 *   2. Verification Package download button always rendered as
 *      disabled even for legitimate team-workspace evidence with a
 *      real package row. Root cause: the frontend availability
 *      helper required `detail.verificationPackage.url` to be
 *      truthy, but `/v1/evidence/:id/review-workspace` does NOT
 *      return a `url` field on the projection (URLs are generated
 *      on-demand by the download endpoint).
 *
 *   3. SRE dashboards lacked bounded counters for the package
 *      lifecycle, artifact polling, and worker readiness — making
 *      it hard to size impact + spot regressions.
 *
 * These tests enforce the canonical fixes:
 *
 *   1. checkWorkers() startup grace period: when API uptime < 2x
 *      reconcile interval AND no audit row exists, return HEALTHY
 *      with reasonCode `worker_warming`. After the grace window,
 *      the original DEGRADED behavior kicks in.
 *
 *   2. buildVerificationPackageAvailability() accepts EITHER a
 *      `generatedAtUtc` timestamp OR a non-null `version` as proof
 *      the package exists. No `url` required.
 *
 *   3. New bounded counters registered:
 *      - package_generation_started_total
 *      - package_generation_completed_total
 *      - package_generation_failed_total
 *      - package_generation_skipped_personal_workspace_total
 *      - artifact_status_polled_total
 *      - governance_schema_unavailable_total
 *      - worker_readiness_warming_total
 *      - worker_readiness_degraded_total
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

// =============================================================================
// PART 1 — Workers readiness startup grace period
// =============================================================================

describe("Phase 32.6 — workers readiness startup grace period", () => {
  const SRC = readSource("../src/runtime/runtime-readiness.ts");

  it("checkWorkers reads process uptime to compute the grace window", () => {
    expect(SRC).toMatch(
      /apiUptimeMs = Math\.round\(process\.uptime\(\) \* 1000\)/,
    );
    expect(SRC).toMatch(/startupGraceMs = intervalMs \* 2/);
  });

  it("within grace window returns HEALTHY with reasonCode `worker_warming`", () => {
    const idx = SRC.indexOf("async function checkWorkers");
    const slice = SRC.slice(idx, idx + 4000);
    expect(slice).toMatch(/if \(apiUptimeMs < startupGraceMs\)/);
    expect(slice).toMatch(/reasonCode: "worker_warming"/);
    expect(slice).toMatch(/status: "HEALTHY",[\s\S]{0,200}reasonCode: "worker_warming"/);
  });

  it("after grace window the original `no_recent_reconcile` DEGRADED path still fires", () => {
    const idx = SRC.indexOf("async function checkWorkers");
    // Phase 32.7 — the function body grew due to canonical-event
    // commentary; the previous 4000-char window no longer reaches
    // the DEGRADED branch. Widen to 6000 — the function ends well
    // within that.
    const slice = SRC.slice(idx, idx + 6000);
    expect(slice).toMatch(/reasonCode: "no_recent_reconcile"/);
    expect(slice).toMatch(/status: "DEGRADED"[\s\S]{0,400}no_recent_reconcile/);
  });

  it("3x-interval stale threshold still applies once a reconcile has been observed", () => {
    expect(SRC).toMatch(/staleThresholdMs = intervalMs \* 3/);
    expect(SRC).toMatch(/reasonCode: "stale_reconcile"/);
  });

  it("worker_readiness_warming_total + worker_readiness_degraded_total counters bumped at canonical sites", () => {
    expect(SRC).toMatch(/bump\("worker_readiness_warming_total"\)/);
    expect(SRC).toMatch(/bump\("worker_readiness_degraded_total"\)/);
  });
});

// =============================================================================
// PART 2 — Verification package availability check fix
// =============================================================================

describe("Phase 32.6 — buildVerificationPackageAvailability fix", () => {
  const HELPERS_SRC = readSource(
    "../../../apps/web/app/(app)/evidence/lib/evidence-library-helpers.ts",
  );

  it("availability NO LONGER requires `detail.verificationPackage.url`", () => {
    // Strip comments so the documentation block referencing the old
    // logic doesn't trip the regex.
    const code = stripComments(HELPERS_SRC);
    const helperBody = code.slice(
      code.indexOf("export function buildVerificationPackageAvailability"),
      code.indexOf("export function hasPublicVerification"),
    );
    expect(helperBody).not.toMatch(/verificationPackage\?\.url/);
  });

  it("availability now checks `generatedAtUtc` OR `version` (presence signals)", () => {
    expect(HELPERS_SRC).toMatch(
      /detail\?\.verificationPackage\?\.generatedAtUtc \|\|\s*detail\?\.verificationPackage\?\.version/,
    );
  });

  it("unavailable label uses the bounded `not recorded` phrasing", () => {
    expect(HELPERS_SRC).toMatch(/"Verification package not recorded"/);
  });

  it("no forbidden user-facing vocabulary in the helper", () => {
    const code = stripComments(HELPERS_SRC).toLowerCase();
    for (const w of [
      "tampered",
      "forged",
      "manipulated",
      "authentic",
      "admissible",
      "proves",
      "confirms",
      "doctored",
    ]) {
      expect(code).not.toMatch(new RegExp(`\\b${w}\\b`));
    }
  });
});

// =============================================================================
// PART 3 — Observability counters registered + bumped
// =============================================================================

describe("Phase 32.6 — bounded observability counters", () => {
  const METRICS_SRC = readSource(
    "../../../packages/shared-runtime/src/ops/metrics.service.ts",
  );

  it("registers all 8 brief-requested counters", () => {
    const required = [
      "package_generation_started_total",
      "package_generation_completed_total",
      "package_generation_failed_total",
      "package_generation_skipped_personal_workspace_total",
      "artifact_status_polled_total",
      "governance_schema_unavailable_total",
      "worker_readiness_warming_total",
      "worker_readiness_degraded_total",
    ];
    for (const name of required) {
      expect(METRICS_SRC, `metric ${name} must be registered`).toMatch(
        new RegExp(`"${name}"`),
      );
    }
  });

  it("package_generation_started_total is bumped at the canonical processor entry point", () => {
    const PROC_SRC = readSource("../../worker/src/processor.ts");
    expect(PROC_SRC).toMatch(/bump\("package_generation_started_total"\)/);
  });

  it("package_generation_completed_total is bumped only after the package buffer is materialised", () => {
    const PROC_SRC = readSource("../../worker/src/processor.ts");
    // The completion bump sits AFTER `finalizedVerificationZip = ...buffer;`.
    const idx = PROC_SRC.indexOf("finalizedVerificationZip = finalizedVerificationPackage.buffer");
    expect(idx).toBeGreaterThan(0);
    const slice = PROC_SRC.slice(idx, idx + 600);
    expect(slice).toMatch(/bump\("package_generation_completed_total"\)/);
  });

  it("package_generation_failed_total is bumped in the catch arm (not the happy path)", () => {
    const PROC_SRC = readSource("../../worker/src/processor.ts");
    expect(PROC_SRC).toMatch(/bump\("package_generation_failed_total"\)/);
    // The failed bump sits AFTER the canonical
    // `verification_package_prepare_finalized` Sentry capture in the
    // catch arm. Look forward from that anchor.
    const catchIdx = PROC_SRC.indexOf("verification_package_prepare_finalized");
    expect(catchIdx).toBeGreaterThan(0);
    const sliceAfter = PROC_SRC.slice(catchIdx, catchIdx + 1000);
    expect(sliceAfter).toMatch(/bump\("package_generation_failed_total"\)/);
  });

  it("Phase 32.6.6 — personal-workspace skip site is retired (counter retained for catalog stability)", () => {
    // Historical (Phase 32.6) behavior:
    //   The worker pre-skipped personal-workspace evidence and bumped
    //   `package_generation_skipped_personal_workspace_total`.
    //
    // Current (Phase 32.6.6) behavior:
    //   Personal evidence generates a PERSONAL BASIC package via the
    //   normal generation path. The pre-skip block (and its bump
    //   call site) is removed. The counter NAME is still registered
    //   in the shared-runtime metrics catalog for backward-compat
    //   with historic dashboards, but it stays at zero going forward.
    const PROC_SRC = readSource("../../worker/src/processor.ts");
    expect(PROC_SRC).not.toMatch(/personalWorkspacePackageSkipped/);
    expect(PROC_SRC).not.toMatch(
      /bump\("package_generation_skipped_personal_workspace_total"\)/,
    );

    // The counter is still in the catalog (the catalog assertion
    // earlier in this file checks that), so historic dashboards
    // don't break.
  });

  it("artifact_status_polled_total bumped from the artifact-status route (NOT report/latest)", () => {
    const ROUTES_SRC = readSource("../src/routes/evidence.routes.ts");
    // The bump lives in the /v1/evidence/:id/artifacts/status handler.
    const idx = ROUTES_SRC.indexOf('"/v1/evidence/:id/artifacts/status"');
    expect(idx).toBeGreaterThan(0);
    const slice = ROUTES_SRC.slice(idx, idx + 5000);
    expect(slice).toMatch(/bump\("artifact_status_polled_total"\)/);

    // It MUST NOT bump from the report/latest download route — that
    // route writes custody / download events and is NOT a polling
    // endpoint.
    const reportLatestIdx = ROUTES_SRC.indexOf(
      '"/v1/evidence/:id/report/latest"',
    );
    if (reportLatestIdx > 0) {
      // Read until the next route handler boundary.
      const reportSlice = ROUTES_SRC.slice(reportLatestIdx, reportLatestIdx + 8000);
      expect(reportSlice).not.toMatch(/bump\("artifact_status_polled_total"\)/);
    }
  });

  it("governance_schema_unavailable_total bumped from the canonical bounded wrapper", () => {
    const HELPER_SRC = readSource("../src/routes/_governance-error-bound.ts");
    expect(HELPER_SRC).toMatch(/bump\("governance_schema_unavailable_total"\)/);
  });
});

// =============================================================================
// PART 4 — Polling correctness: no custody/download side effects
// =============================================================================

describe("Phase 32.6 — polling never triggers download/custody events", () => {
  const PAGE_SRC = readSource(
    "../../../apps/web/app/(app)/evidence/[id]/page.tsx",
  );

  it("polling path uses /v1/evidence/:id/artifacts/status (side-effect-free)", () => {
    expect(PAGE_SRC).toMatch(
      /\/v1\/evidence\/\$\{evidenceId\}\/artifacts\/status/,
    );
  });

  it("polling block NEVER calls /report/latest or /verification-package/latest", () => {
    const code = stripComments(PAGE_SRC);
    // Anchor on the pollOnce function body.
    const pollBlock = code.match(/const pollOnce[\s\S]*?\}, \[/);
    expect(pollBlock).toBeTruthy();
    expect(pollBlock![0]).not.toMatch(/\/report\/latest/);
    expect(pollBlock![0]).not.toMatch(/\/verification-package\/latest/);
  });
});

// =============================================================================
// PART 5 — Governance helper still throws on non-schema errors
// =============================================================================

describe("Phase 32.6 — governance bounded helper preserves real-bug bubbling", () => {
  const HELPER_SRC = readSource("../src/routes/_governance-error-bound.ts");

  it("non-Prisma errors are re-thrown (don't swallow real bugs)", () => {
    expect(HELPER_SRC).toMatch(/throw err;/);
  });

  it("schema-drift error codes are recognised: P2022 / P2021 / P2025", () => {
    expect(HELPER_SRC).toMatch(/"P2022"/);
    expect(HELPER_SRC).toMatch(/"P2021"/);
    expect(HELPER_SRC).toMatch(/"P2025"/);
  });

  it("bounded 503 response body has a single error code (no schema names leaked)", () => {
    expect(HELPER_SRC).toMatch(/code: "governance_schema_unavailable"/);
    const messageMatch = HELPER_SRC.match(/message:\s*"([^"]+)"/);
    expect(messageMatch).toBeTruthy();
    expect(messageMatch![1]).not.toMatch(/table|column|schema_validation/i);
  });
});
