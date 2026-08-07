/**
 * PHASE E3.3 — Async Delivery & Retry Runtime contract tests.
 *
 * Closes DEF-023. Pins:
 *   - Retry constants bounded (3 retries after 1 initial = 4 total).
 *   - WEBHOOK_RETRY_BACKOFF_SECONDS = [5, 30, 300] (bounded, no growth).
 *   - WEBHOOK_AUTO_DISABLE_THRESHOLD = 10.
 *   - THREE-VALUED transport classification (NO_COMMIT / AMBIGUOUS /
 *     PERMANENT). Corrected 2026-08-07: a timeout or a generic 5xx is
 *     AMBIGUOUS, never retryable, because the request was written and the
 *     outcome is unknown.
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
  classifyTransportOutcome,
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

/**
 * PHASE 12 CORRECTIVE PASS §1 CONTINUATION (ARCH-005, 2026-08-07).
 *
 * THESE CASES USED TO PIN THE DEFECT.
 *
 * The block that stood here asserted "timeout is retryable", "fetch_error is
 * retryable" and "non_2xx:5xx is retryable". Every one of those is a claim the
 * transport never made, and together they ARE defect NEW-015: a timeout means
 * the request was WRITTEN and the answer was lost, so re-sending it is a
 * SECOND delivery of an event the receiver may already have acted on — a
 * duplicate downstream action wearing a retry's clothes.
 *
 * The contract is now three-valued, and these cases assert it. This is a
 * STRENGTHENING: the old block could not distinguish "nothing was committed"
 * from "we do not know", and the new one refuses to resend unless the
 * transport or the receiver's own declared contract proves the former.
 */
describe("E3.3 Test 2 — three-valued transport classification", () => {
  it("NO_COMMIT: the connection was never established, so a resend is a retry", () => {
    for (const reason of ["connect_failed", "dns_failed", "tls_failed"]) {
      expect(classifyTransportOutcome(reason), reason).toBe("NO_COMMIT");
      expect(isRetryableFailure(reason), reason).toBe(true);
    }
  });

  it("NO_COMMIT: 408 and 425, whose HTTP semantics guarantee no processing", () => {
    // 408 — the server never received a complete request.
    // 425 — the server refused to risk processing a replayable one.
    for (const code of [408, 425]) {
      expect(classifyTransportOutcome(`non_2xx:${code}`), String(code)).toBe(
        "NO_COMMIT",
      );
      expect(isRetryableFailure(`non_2xx:${code}`), String(code)).toBe(true);
    }
  });

  it("AMBIGUOUS: written-then-lost is never resent", () => {
    for (const reason of [
      "timeout",
      "connection_reset",
      "socket_hang_up",
      "transport_unknown",
    ]) {
      expect(classifyTransportOutcome(reason), reason).toBe("AMBIGUOUS");
      expect(isRetryableFailure(reason), reason).toBe(false);
    }
  });

  it("AMBIGUOUS: a generic 5xx or 429 — the receiver answered, but about what?", () => {
    // A 500 can be raised after the handler committed. A 502/504 comes from a
    // GATEWAY, which by definition does not know what the origin did. A 503
    // from a load balancer means the request never arrived; a 503 from the
    // application may mean it arrived and failed midway — and the sender
    // cannot tell those apart from a status line.
    for (const code of [500, 502, 503, 504, 599, 429]) {
      expect(classifyTransportOutcome(`non_2xx:${code}`), String(code)).toBe(
        "AMBIGUOUS",
      );
      expect(isRetryableFailure(`non_2xx:${code}`), String(code)).toBe(false);
    }
  });

  it("a DECLARED refusal-before-commit contract is the only way 429/5xx resends", () => {
    const declared = { refusalBeforeCommitStatuses: [429] };
    expect(classifyTransportOutcome("non_2xx:429", declared)).toBe("NO_COMMIT");
    expect(isRetryableFailure("non_2xx:429", declared)).toBe(true);
    // Per status, and it does not leak to its neighbours.
    expect(classifyTransportOutcome("non_2xx:503", declared)).toBe("AMBIGUOUS");
    // Nothing is assumed on a customer's behalf.
    expect(classifyTransportOutcome("non_2xx:429")).toBe("AMBIGUOUS");
  });

  it("PERMANENT: a definite refusal, and our own configuration errors", () => {
    for (const code of [400, 401, 403, 404, 405, 410, 422]) {
      expect(classifyTransportOutcome(`non_2xx:${code}`), String(code)).toBe(
        "PERMANENT",
      );
      expect(isRetryableFailure(`non_2xx:${code}`), String(code)).toBe(false);
    }
    for (const reason of [
      "ssrf_blocked:localhost",
      "destination_disabled",
      "secret_decryption_failed",
      "destination_not_in_team",
    ]) {
      expect(classifyTransportOutcome(reason), reason).toBe("PERMANENT");
      expect(isRetryableFailure(reason), reason).toBe(false);
    }
  });

  it("an UNRECOGNISED reason defaults to AMBIGUOUS, never to retryable", () => {
    // The one default that matters: guessing "retryable" here is exactly how
    // duplicate deliveries reappear.
    expect(classifyTransportOutcome("something_new_from_undici")).toBe("AMBIGUOUS");
    expect(isRetryableFailure("something_new_from_undici")).toBe(false);
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

  /**
   * ARCH-005 (2026-08-07) — `enqueueDelivery` is GONE, and its absence is the
   * assertion now.
   *
   * It was a `setImmediate`: the action handler inserted a PENDING row and
   * scheduled the attempt on this process's event loop, so a restart between
   * the two left a delivery nobody would ever attempt and a second API
   * instance could not see the work. The durable row IS the queue.
   */
  it("runtime exposes processDelivery + sweepDueDeliveries, and NO in-process enqueue", () => {
    expect(RUNTIME).toMatch(/export async function processDelivery/);
    expect(RUNTIME).toMatch(/export async function sweepDueDeliveries/);
    expect(RUNTIME).not.toMatch(/export function enqueueDelivery/);
  });

  it("runtime schedules NOTHING in process — no timers, at all", () => {
    // Both the initial `setImmediate` and the retry `setTimeout` are removed.
    // Re-adding either is exactly how the defect returns, so the import and
    // both call shapes are banned by name.
    expect(RUNTIME).not.toMatch(/from\s+["']node:timers["']/);
    expect(RUNTIME).not.toMatch(/setImmediateNative\s*\(/);
    expect(RUNTIME).not.toMatch(/setTimeoutNative\s*\(/);
    expect(RUNTIME).not.toMatch(/\bsetTimeout\s*\(/);
    expect(RUNTIME).not.toMatch(/\bsetImmediate\s*\(/);
  });

  it("the delivery claim carries a LEASE and a FENCE, not just a status", () => {
    // A status-only precondition stops two claimers at the same instant and
    // says nothing about a worker that DIED holding the row — which is how a
    // DELIVERING delivery became permanently stuck.
    expect(RUNTIME).toMatch(/claimGeneration:\s*generation/);
    expect(RUNTIME).toMatch(
      /leaseExpiresAtUtc:\s*new Date\(nowMs \+ DELIVERY_LEASE_MS\)/,
    );
    // …and the reconciler that only a lease makes possible.
    expect(RUNTIME).toMatch(/leaseExpiresAtUtc:\s*\{\s*lte:\s*now\s*\}/);
  });

  it("processDelivery early-returns on terminal-state deliveries", () => {
    expect(RUNTIME).toMatch(/"SUCCEEDED"/);
    expect(RUNTIME).toMatch(/"RETRY_EXHAUSTED"/);
    expect(RUNTIME).toMatch(/already_terminal/);
  });

  it("the sweep is bounded AND claims PENDING as well as RETRY_SCHEDULED", () => {
    // The old sweep swept RETRIES only, because the FIRST attempt was supposed
    // to have been made by the `setImmediate` — so a PENDING delivery
    // abandoned by a restart was invisible to the one component built to
    // rescue it.
    expect(RUNTIME).toMatch(
      /status:\s*\{\s*in:\s*\["PENDING",\s*"RETRY_SCHEDULED"\]\s*\}/,
    );
    expect(RUNTIME).toMatch(/nextAttemptAt:\s*\{\s*lte:/);
    expect(RUNTIME).toMatch(/take:\s*limit/);
  });

  it("an unobserved lease expiry becomes RETRY_EXHAUSTED, never FAILED", () => {
    // "We do not know" and "it was refused" are different claims about the
    // outside world, and only one of them is true here.
    expect(RUNTIME).toMatch(/lease_expired_after_max_attempts/);
    expect(RUNTIME).toMatch(/lease_expired_reclaimed/);
    const idx = RUNTIME.indexOf("lease_expired_after_max_attempts");
    expect(RUNTIME.slice(Math.max(0, idx - 400), idx)).toMatch(/RETRY_EXHAUSTED/);
  });
});

// ===========================================================================
// PART 7 — Action handler enqueues (no longer synchronous delivery)
// ===========================================================================

describe("E3.3 Test 7 — action handler is async hand-off only", () => {
  /**
   * ARCH-005 (2026-08-07) — the hand-off is a ROW, not a call.
   *
   * The action handler used to import the delivery runtime and call
   * `enqueueDelivery`. It now imports NOTHING that delivers: it writes one
   * PENDING, DUE row and returns. That import staying absent is what stops an
   * in-process hand-off reappearing here.
   */
  it("does NOT import the delivery runtime at all", () => {
    expect(ACTIONS).not.toMatch(
      /^import[^\n]*from\s+["']\.\/automation-delivery-runtime\.service\.js["']/m,
    );
    expect(ACTIONS).not.toMatch(/enqueueDelivery\s*\(/);
  });

  it("writes ONE durable, due delivery row — not insert-then-update", () => {
    const fnIdx = ACTIONS.indexOf("function actionWebhookDelivery");
    expect(fnIdx).toBeGreaterThan(-1);
    const body = ACTIONS.slice(fnIdx, fnIdx + 6000);
    // The old code inserted DELIVERING, updated it back to PENDING so the
    // runtime's claim would accept it, then scheduled a timer — a row that
    // briefly claimed to be in flight when nothing was.
    expect(body).toMatch(/status:\s*"PENDING"/);
    expect(body).toMatch(/nextAttemptAt:\s*new Date\(\)/);
    expect(body).not.toMatch(/status:\s*"DELIVERING"/);
    expect(body.match(/automationWebhookDelivery\.update\(/g) ?? []).toEqual([]);
  });

  it("a retry reuses the run's durable ACTION intent key", () => {
    const fnIdx = ACTIONS.indexOf("function actionWebhookDelivery");
    const body = ACTIONS.slice(fnIdx, fnIdx + 6000);
    expect(body).toMatch(/input\.actionIdempotencyKey/);
    // A second delivery for the same (run, destination) is the idempotency
    // working, not a failure.
    expect(body).toMatch(/duplicate_delivery/);
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
