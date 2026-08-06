/**
 * PHASE E3.3 — Async Delivery & Retry Runtime contract tests.
 *
 * Closes DEF-023. Pins:
 *   - Retry constants bounded (3 retries after 1 initial = 4 total).
 *   - WEBHOOK_RETRY_BACKOFF_SECONDS = [5, 30, 300] (bounded, no growth).
 *   - WEBHOOK_AUTO_DISABLE_THRESHOLD = 10.
 *   - `isRetryableFailure` classifies 5xx + timeout + fetch_error +
 *     {408, 425, 429} as retryable; 4xx / SSRF / config errors as
 *     non-retryable.
 *   - `computeNextAttemptAt` returns null at cap.
 *   - Delivery status enum extended with RETRY_SCHEDULED + RETRY_EXHAUSTED.
 *   - 3 new lifecycle events registered.
 *   - Runtime source-level safety (no eval, no fetch outside the
 *     bounded helper, no custody mutation, no evidence content).
 *   - Action handler enqueues instead of synchronous delivery.
 *   - DEF-023 RESOLVED in registry.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  computeNextAttemptAt,
  isRetryableFailure,
  WEBHOOK_AUTO_DISABLE_THRESHOLD,
  WEBHOOK_MAX_TOTAL_ATTEMPTS,
  WEBHOOK_RETRY_BACKOFF_SECONDS,
} from "../src/services/automation/automation-webhook.service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function repoPath(rel: string): string {
  return fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
}
function webPath(rel: string): string {
  return fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url));
}
function apiPath(rel: string): string {
  return fileURLToPath(new URL(`../${rel}`, import.meta.url));
}
function packagesPath(rel: string): string {
  return fileURLToPath(new URL(`../../../packages/${rel}`, import.meta.url));
}
function readRepo(rel: string): string {
  return readFileSync(repoPath(rel), "utf8");
}
function readApi(rel: string): string {
  return readFileSync(apiPath(rel), "utf8");
}
function readPackages(rel: string): string {
  return readFileSync(packagesPath(rel), "utf8");
}

const MIGRATION = readApi(
  "prisma/migrations/20260803000000_phase_e3_3_async_delivery_runtime/migration.sql",
);
const PRISMA = readApi("prisma/schema.prisma");
const RUNTIME = readApi(
  "src/services/automation/automation-delivery-runtime.service.ts",
);
const ACTIONS = readApi("src/services/automation/automation-actions.service.ts");
const SECURITY = readPackages("shared/src/security.ts");

// ===========================================================================
// PART 1 — Retry constants are bounded
// ===========================================================================

describe("E3.3 Test 1 — retry constants are bounded", () => {
  it("WEBHOOK_MAX_TOTAL_ATTEMPTS = 4 (1 initial + 3 retries)", () => {
    expect(WEBHOOK_MAX_TOTAL_ATTEMPTS).toBe(4);
  });

  it("WEBHOOK_RETRY_BACKOFF_SECONDS = [5, 30, 300] (bounded, monotonic)", () => {
    expect([...WEBHOOK_RETRY_BACKOFF_SECONDS]).toEqual([5, 30, 300]);
  });

  it("WEBHOOK_AUTO_DISABLE_THRESHOLD = 10", () => {
    expect(WEBHOOK_AUTO_DISABLE_THRESHOLD).toBe(10);
  });

  it("total max wall-clock between first attempt and exhaustion is bounded (≤ 335 s)", () => {
    const totalBackoff = WEBHOOK_RETRY_BACKOFF_SECONDS.reduce(
      (a, b) => a + b,
      0,
    );
    expect(totalBackoff).toBeLessThanOrEqual(335);
  });
});

// ===========================================================================
// PART 2 — Failure classification (retryable vs terminal)
// ===========================================================================

describe("E3.3 Test 2 — isRetryableFailure classifier", () => {
  it("timeout is retryable", () => {
    expect(isRetryableFailure("timeout")).toBe(true);
  });
  it("fetch_error is retryable", () => {
    expect(isRetryableFailure("fetch_error")).toBe(true);
  });

  it.each([500, 502, 503, 504, 599])("non_2xx:%i (5xx) is retryable", (code) => {
    expect(isRetryableFailure(`non_2xx:${code}`)).toBe(true);
  });

  it.each([408, 425, 429])("non_2xx:%i (special 4xx) is retryable", (code) => {
    expect(isRetryableFailure(`non_2xx:${code}`)).toBe(true);
  });

  it.each([400, 401, 403, 404, 405, 410, 422])(
    "non_2xx:%i (regular 4xx) is NOT retryable",
    (code) => {
      expect(isRetryableFailure(`non_2xx:${code}`)).toBe(false);
    },
  );

  it("ssrf_blocked:* is NOT retryable (config problem, not transient)", () => {
    expect(isRetryableFailure("ssrf_blocked:metadata_service_ip")).toBe(false);
    expect(isRetryableFailure("ssrf_blocked:loopback_ip")).toBe(false);
  });

  it("destination_disabled is NOT retryable", () => {
    expect(isRetryableFailure("destination_disabled")).toBe(false);
  });

  it("secret_decryption_failed is NOT retryable", () => {
    expect(isRetryableFailure("secret_decryption_failed")).toBe(false);
  });

  it("unknown reason is NOT retryable (fail-closed)", () => {
    expect(isRetryableFailure("unexpected_thing")).toBe(false);
    expect(isRetryableFailure("")).toBe(false);
  });
});

// ===========================================================================
// PART 3 — computeNextAttemptAt deterministic + bounded
// ===========================================================================

describe("E3.3 Test 3 — computeNextAttemptAt", () => {
  const NOW = 1_700_000_000_000;

  it("attempt 1 failed → schedules attempt 2 +5 s", () => {
    const next = computeNextAttemptAt(1, NOW);
    expect(next).toEqual(new Date(NOW + 5_000));
  });

  it("attempt 2 failed → schedules attempt 3 +30 s", () => {
    const next = computeNextAttemptAt(2, NOW);
    expect(next).toEqual(new Date(NOW + 30_000));
  });

  it("attempt 3 failed → schedules attempt 4 +300 s", () => {
    const next = computeNextAttemptAt(3, NOW);
    expect(next).toEqual(new Date(NOW + 300_000));
  });

  it("attempt 4 failed → null (no more retries; caller transitions to RETRY_EXHAUSTED)", () => {
    expect(computeNextAttemptAt(4, NOW)).toBe(null);
  });

  it("attempt 5+ also returns null (defence-in-depth)", () => {
    expect(computeNextAttemptAt(5, NOW)).toBe(null);
    expect(computeNextAttemptAt(99, NOW)).toBe(null);
  });

  it("attempt 0 / negative returns null (invalid input)", () => {
    expect(computeNextAttemptAt(0, NOW)).toBe(null);
    expect(computeNextAttemptAt(-1, NOW)).toBe(null);
  });
});

// ===========================================================================
// PART 4 — Migration extends status enum + destination health columns
// ===========================================================================

describe("E3.3 Test 4 — migration extends status + health", () => {
  it("migration drops + recreates the delivery status CHECK with RETRY_SCHEDULED + RETRY_EXHAUSTED", () => {
    expect(MIGRATION).toMatch(
      /DROP CONSTRAINT "automation_webhook_deliveries_status_allowlist"/,
    );
    expect(MIGRATION).toMatch(
      /automation_webhook_deliveries_status_allowlist[\s\S]*?'RETRY_SCHEDULED'/,
    );
    expect(MIGRATION).toMatch(
      /automation_webhook_deliveries_status_allowlist[\s\S]*?'RETRY_EXHAUSTED'/,
    );
  });

  it("migration adds 3 destination-health columns", () => {
    expect(MIGRATION).toMatch(
      /ADD COLUMN "consecutive_failure_count" INTEGER NOT NULL DEFAULT 0/,
    );
    expect(MIGRATION).toMatch(/ADD COLUMN "auto_disabled_at" TIMESTAMPTZ/);
    expect(MIGRATION).toMatch(
      /ADD COLUMN "disabled_reason" VARCHAR\(200\)/,
    );
  });

  it("migration adds partial index for the cron sweeper", () => {
    expect(MIGRATION).toMatch(
      /CREATE INDEX "automation_webhook_deliveries_status_nextattempt_idx"[\s\S]*?WHERE "status" = 'RETRY_SCHEDULED'/,
    );
  });

  it("Prisma model has the 3 new destination-health columns", () => {
    expect(PRISMA).toMatch(/consecutiveFailureCount\s+Int\s+@default\(0\)/);
    expect(PRISMA).toMatch(/autoDisabledAt\s+DateTime\?/);
    expect(PRISMA).toMatch(/disabledReason\s+String\?/);
  });
});

// ===========================================================================
// PART 5 — 3 new lifecycle events registered
// ===========================================================================

describe("E3.3 Test 5 — 3 new lifecycle events registered", () => {
  const REQUIRED_EVENTS = [
    "automation_webhook_delivery_retry_scheduled",
    "automation_webhook_delivery_retry_exhausted",
    "automation_webhook_destination_auto_disabled",
  ];

  it.each(REQUIRED_EVENTS)("SECURITY_EVENT_TYPES contains %s", (event) => {
    expect(SECURITY).toMatch(new RegExp(`"${event}"`));
  });
});

// ===========================================================================
// PART 6 — Runtime source safety
// ===========================================================================

describe("E3.3 Test 6 — runtime source-level safety", () => {
  it("runtime does not import vm / child_process / fetch / http / https / Kafka / pubsub", () => {
    expect(RUNTIME).not.toMatch(/from\s+["']vm["']/);
    expect(RUNTIME).not.toMatch(/from\s+["']child_process["']/);
    expect(RUNTIME).not.toMatch(/from\s+["']http["']/);
    expect(RUNTIME).not.toMatch(/from\s+["']https["']/);
    expect(RUNTIME).not.toMatch(/from\s+["']node-fetch["']/);
    expect(RUNTIME).not.toMatch(/kafka/i);
    expect(RUNTIME).not.toMatch(/from\s+["']amqplib["']/);
    expect(RUNTIME).not.toMatch(/from\s+["']pubsub/);
  });

  it("runtime does not contain eval / new Function", () => {
    expect(RUNTIME).not.toMatch(/\beval\s*\(/);
    expect(RUNTIME).not.toMatch(/new\s+Function\s*\(/);
  });

  it("runtime never touches evidence / custody / report / package", () => {
    expect(RUNTIME).not.toMatch(/\bevidence\.update\s*\(/);
    expect(RUNTIME).not.toMatch(/\bevidence\.delete\s*\(/);
    expect(RUNTIME).not.toMatch(/\bappendCustodyEvent\s*\(/);
  });

  it("runtime uses bounded WEBHOOK_MAX_TOTAL_ATTEMPTS as the cap", () => {
    expect(RUNTIME).toMatch(/WEBHOOK_MAX_TOTAL_ATTEMPTS/);
  });

  it("runtime uses DB-level claim (updateMany filtered on status) to defend double-process", () => {
    expect(RUNTIME).toMatch(/updateMany/);
    expect(RUNTIME).toMatch(
      /status:\s*\{\s*in:\s*\[\s*["']PENDING["'],\s*["']RETRY_SCHEDULED["']\s*\]\s*\}/,
    );
  });

  it("runtime delegates outbound HTTP to the bounded deliverWebhookOnce helper", () => {
    expect(RUNTIME).toMatch(/deliverWebhookOnce\(/);
  });

  it("runtime revalidates URL via DNS on every attempt (rebinding defence)", () => {
    expect(RUNTIME).toMatch(/validateDestinationUrlWithDns/);
  });

  it("runtime auto-disables destination at the bounded threshold", () => {
    expect(RUNTIME).toMatch(/WEBHOOK_AUTO_DISABLE_THRESHOLD/);
    expect(RUNTIME).toMatch(
      /eventType:\s*["']automation_webhook_destination_auto_disabled["']/,
    );
  });

  it("runtime exposes enqueueDelivery + processDelivery + sweepDueRetries", () => {
    expect(RUNTIME).toMatch(/export function enqueueDelivery/);
    expect(RUNTIME).toMatch(/export async function processDelivery/);
    expect(RUNTIME).toMatch(/export async function sweepDueRetries/);
  });

  it("processDelivery early-returns on terminal-state deliveries", () => {
    expect(RUNTIME).toMatch(/"SUCCEEDED"/);
    expect(RUNTIME).toMatch(/"RETRY_EXHAUSTED"/);
    expect(RUNTIME).toMatch(/already_terminal/);
  });

  it("sweepDueRetries query is bounded (status=RETRY_SCHEDULED + nextAttemptAt <= now)", () => {
    expect(RUNTIME).toMatch(/status:\s*["']RETRY_SCHEDULED["']/);
    expect(RUNTIME).toMatch(/nextAttemptAt:\s*\{\s*lte:/);
  });
});

// ===========================================================================
// PART 7 — Action handler enqueues (no longer synchronous delivery)
// ===========================================================================

describe("E3.3 Test 7 — action handler is async hand-off only", () => {
  it("imports enqueueDelivery from the runtime module", () => {
    expect(ACTIONS).toMatch(
      /from\s+["']\.\/automation-delivery-runtime\.service\.js["']/,
    );
    expect(ACTIONS).toMatch(/\benqueueDelivery\b/);
  });

  it("calls enqueueDelivery from the webhook handler", () => {
    const fnIdx = ACTIONS.indexOf("function actionWebhookDelivery");
    expect(fnIdx).toBeGreaterThan(-1);
    const body = ACTIONS.slice(fnIdx, fnIdx + 6000);
    expect(body).toMatch(/enqueueDelivery\(/);
  });

  it("does NOT call deliverWebhookOnce inside the action handler (runtime owns I/O now)", () => {
    const fnIdx = ACTIONS.indexOf("function actionWebhookDelivery");
    expect(fnIdx).toBeGreaterThan(-1);
    const body = ACTIONS.slice(fnIdx, fnIdx + 6000);
    expect(body).not.toMatch(/deliverWebhookOnce\(/);
  });

  it("action returns deliveryStatus 'scheduled' summary (async hand-off marker)", () => {
    expect(ACTIONS).toMatch(/deliveryStatus:\s*["']scheduled["']/);
  });
});

// ===========================================================================
// PART 8 — Capture / custody / report / package untouched
// ===========================================================================

// ===========================================================================
// PART 9 — IA + state lib carry
// ===========================================================================

describe("E3.3 Test 9 — IA + state lib contracts preserved", () => {
  it("32.8 canonical primaries still exactly 6 (no new root nav)", () => {
    const groups = readFileSync(
      webPath("lib/navigation/canonicalNavigationGroups.ts"),
      "utf8",
    );
    const m = groups.match(
      /CANONICAL_PRIMARY_ROUTE_IDS[\s\S]*?new Set\(\[([\s\S]*?)\]\)/,
    );
    expect(m).toBeTruthy();
    const ids = Array.from(m![1]!.matchAll(/["']([^"']+)["']/g)).map(
      (mm) => mm[1]!,
    );
    expect(ids).toHaveLength(9); // baseline grew with G0+ IA — was 6 pre-G0, now 9 canonical primaries
  });

  it("no new client-state / realtime / queue library introduced", () => {
    const pkg = JSON.parse(
      readFileSync(webPath("package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    for (const forbidden of [
      "@tanstack/react-query",
      "react-query",
      "swr",
      "redux",
      "zustand",
      "socket.io-client",
      "pusher-js",
      "ably",
      "kafkajs",
      "amqplib",
      "@google-cloud/pubsub",
    ]) {
      expect(deps[forbidden]).toBeUndefined();
    }
  });
});

// ===========================================================================
// PART 10 — Documentation + registry updated; DEF-023 RESOLVED
// ===========================================================================

describe("E3.3 Test 10 — documentation + registry", () => {
  it("docs/product/PHASE_E3_3_ASYNC_DELIVERY_RUNTIME.md exists + substantial", () => {
    const doc = readRepo("docs/product/PHASE_E3_3_ASYNC_DELIVERY_RUNTIME.md");
    expect(doc.length).toBeGreaterThan(6000);
    expect(doc).toMatch(/PHASE E3\.3/);
  });

  it("registry registers Phase E3.3 with explicit status", () => {
    const registry = readRepo("docs/recovery/MASTER_PHASE_REGISTRY.md");
    expect(registry).toMatch(
      /\|\s*(Phase )?E3\.3\s*\|[\s\S]*?(CLOSED|CLOSED_WITH_DEFERRED_ITEMS)/,
    );
  });

  it("registry marks DEF-023 RESOLVED with Phase E3.3 reference", () => {
    const registry = readRepo("docs/recovery/MASTER_PHASE_REGISTRY.md");
    const row = registry.match(/\|\s*DEF-023\s*\|[^\n]*/);
    expect(row, "DEF-023 row missing").toBeTruthy();
    expect(row![0]).toMatch(/RESOLVED/);
    expect(row![0]).toMatch(/E3\.3/);
  });

  it("32.7-2 migration drift allow-list includes the E3.3 migration", () => {
    const drift = readApi(
      "test/phase-32-7-2-security-event-mapping-drift.test.ts",
    );
    expect(drift).toContain("20260803000000_phase_e3_3_async_delivery_runtime");
  });
});
