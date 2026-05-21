/**
 * Phase 32.7.5 — Worker reconcile false-DEGRADED fix.
 *
 * Production proof (per Phase 32.7.5 brief):
 *   - Worker logs `reviewer_ops.reconciliation.scheduler.started`
 *     and `reviewer_reconcile.completed { ok:true }` every ~5 min.
 *   - REVIEWER_OPS_CRON_SECRET matches on both API and worker.
 *   - Redis HEALTHY, queues HEALTHY, schema HEALTHY.
 *   - Yet `/admin/runtime/readiness` reports `workers` DEGRADED with
 *     `no_recent_reconcile`.
 *
 * Root cause:
 *   The per-team heartbeat write
 *     `safeEmitSecurityEvent({ eventType: "reviewer_reconcile_run", ... })`
 *   fires INSIDE `runReconcile()`. The all-teams sweep at the API
 *   endpoint only iterates teams matching
 *     `evidenceReviewWorkflows: { some: {} }`
 *   When the production DB has ZERO teams matching that predicate,
 *   the loop runs zero times → no heartbeat is ever persisted. The
 *   endpoint still returns 200 (the sweep "completed"), the worker
 *   logs `reviewer_reconcile.completed`, but no canonical row lands
 *   in `security_events` for the readiness reader to find.
 *
 * Fix (zero SQL, zero schema change):
 *   Add a SWEEP-LEVEL canonical heartbeat at the end of the all-
 *   teams branch in `services/api/src/routes/reviewer-ops.routes.ts`.
 *   It fires UNCONDITIONALLY, regardless of `teams.length`. Uses
 *   the canonical `wireStringFor("WORKER_HEARTBEAT")` resolver
 *   (Phase 32.7) so writer + reader cannot drift. `teamId: null`
 *   distinguishes the sweep heartbeat from per-team heartbeats;
 *   the readiness reader filters by `eventType` only, so both
 *   sources satisfy "recent reconcile observed".
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readApi(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}

// =============================================================================
// Part 1 — Sweep-level canonical heartbeat at the endpoint
// =============================================================================

describe("Phase 32.7.5 — sweep-level canonical heartbeat fires on every all-teams tick", () => {
  const SRC = readApi("src/routes/reviewer-ops.routes.ts");
  const routeIdx = SRC.indexOf('"/v1/reviewer-ops/reconcile"');
  expect(routeIdx).toBeGreaterThan(-1);
  const routeBody = SRC.slice(routeIdx, routeIdx + 8000);

  it("the all-teams branch emits a heartbeat AFTER the for-loop", () => {
    // The sweep heartbeat must be positioned AFTER the for-loop
    // that iterates teams, and BEFORE the response.send. This
    // ordering guarantees:
    //   - empty-teams case: heartbeat still fires
    //   - non-empty case: heartbeat fires once additional to the
    //     per-team heartbeats inside runReconcile
    const forLoopIdx = routeBody.indexOf("for (const t of teams)");
    const heartbeatIdx = routeBody.indexOf(
      'eventType: wireStringFor("WORKER_HEARTBEAT")',
    );
    const responseIdx = routeBody.lastIndexOf("return reply.code(200).send");
    expect(forLoopIdx).toBeGreaterThan(-1);
    expect(heartbeatIdx).toBeGreaterThan(forLoopIdx);
    expect(responseIdx).toBeGreaterThan(heartbeatIdx);
  });

  it("heartbeat uses the canonical WORKER_HEARTBEAT wire string (Phase 32.7 contract)", () => {
    expect(routeBody).toMatch(/wireStringFor\(\s*"WORKER_HEARTBEAT"\s*\)/);
  });

  it("heartbeat uses safeEmitSecurityEvent (fire-and-forget; does not block the response)", () => {
    const heartbeatIdx = routeBody.indexOf(
      'eventType: wireStringFor("WORKER_HEARTBEAT")',
    );
    expect(heartbeatIdx).toBeGreaterThan(-1);
    // Look for safeEmitSecurityEvent in the 1500 chars immediately
    // surrounding the eventType to confirm the call shape.
    const surround = routeBody.slice(
      Math.max(0, heartbeatIdx - 400),
      heartbeatIdx + 1500,
    );
    expect(surround).toMatch(/safeEmitSecurityEvent\(\s*\{/);
    expect(surround).toMatch(/severity:\s*"INFO"/);
  });

  it("heartbeat carries bounded sweep telemetry in details (source/trigger/correlationId/counts)", () => {
    const heartbeatIdx = routeBody.indexOf(
      'eventType: wireStringFor("WORKER_HEARTBEAT")',
    );
    const block = routeBody.slice(heartbeatIdx, heartbeatIdx + 1800);
    expect(block).toMatch(/source:\s*"sweep"/);
    expect(block).toMatch(/trigger:/);
    expect(block).toMatch(/correlationId:/);
    expect(block).toMatch(/teams:\s*teams\.length/);
    expect(block).toMatch(/failedTeams/);
  });

  it("heartbeat sets teamId: null (it is a sweep-level signal, not team-scoped)", () => {
    const heartbeatIdx = routeBody.indexOf(
      'eventType: wireStringFor("WORKER_HEARTBEAT")',
    );
    const block = routeBody.slice(
      Math.max(0, heartbeatIdx - 200),
      heartbeatIdx + 200,
    );
    expect(block).toMatch(/teamId:\s*null/);
  });

  it("heartbeat emission is wrapped in try/catch so a heartbeat failure cannot break the sweep response", () => {
    const heartbeatIdx = routeBody.indexOf(
      'eventType: wireStringFor("WORKER_HEARTBEAT")',
    );
    const surround = routeBody.slice(
      Math.max(0, heartbeatIdx - 400),
      heartbeatIdx + 2000,
    );
    expect(surround).toMatch(/try\s*\{[\s\S]{0,2000}safeEmitSecurityEvent/);
    expect(surround).toMatch(/safeEmitSecurityEvent[\s\S]{0,1500}\}\s*catch\s*\{/);
  });

  it("response still includes the existing sweep payload (no regression)", () => {
    const sendIdx = routeBody.lastIndexOf("return reply.code(200).send");
    const sendBlock = routeBody.slice(sendIdx, sendIdx + 800);
    for (const key of [
      "teams: teams.length",
      "failedTeams",
      "totalEscalationsCreated",
      "totalFlippedBreached",
      "totalFlippedDueSoon",
      "totalDueSoonReminders",
      "totalInactivityReminders",
      "perTeam",
    ]) {
      expect(sendBlock).toContain(key);
    }
  });
});

// =============================================================================
// Part 2 — Per-team heartbeat preserved (no regression on the existing signal)
// =============================================================================

describe("Phase 32.7.5 — per-team heartbeat inside runReconcile still fires", () => {
  const SRC = readApi(
    "src/services/reviewer-ops/reviewer-operations-engine.service.ts",
  );

  it("runReconcile still emits its per-team heartbeat via the canonical resolver", () => {
    expect(SRC).toMatch(
      /eventType:\s*canonicalOperationalWireStringFor\([\s\S]{0,100}"WORKER_HEARTBEAT"/,
    );
  });

  it("per-team heartbeat carries the team-scoped telemetry", () => {
    // The Phase 25.7 stuck sweep added these fields; they remain.
    expect(SRC).toMatch(/stuckDetected/);
    expect(SRC).toMatch(/stuckEscalated/);
  });
});

// =============================================================================
// Part 3 — Reader unchanged: queries the same eventType, ignores teamId
// =============================================================================

describe("Phase 32.7.5 — readiness reader queries the canonical eventType without teamId filter", () => {
  const SRC = readApi("src/runtime/runtime-readiness.ts");
  const fnIdx = SRC.indexOf("async function checkWorkers");
  const fnEnd = SRC.indexOf("\n}\n", fnIdx);
  const fn = SRC.slice(fnIdx, fnEnd);

  it("queries prisma.securityEvent with eventType binding, no teamId filter", () => {
    expect(fn).toMatch(
      /prisma\.securityEvent\.findFirst\(\s*\{\s*where:\s*\{\s*eventType:\s*heartbeatWireString\s*\}/,
    );
    // Crucially, the where clause must NOT include `teamId` —
    // sweep-level heartbeats have `teamId: null`.
    const queryIdx = fn.indexOf("prisma.securityEvent.findFirst");
    const queryEnd = fn.indexOf("})", queryIdx);
    const queryBlock = fn.slice(queryIdx, queryEnd);
    expect(queryBlock).not.toMatch(/teamId:/);
  });

  it("resolves the wire string through the same canonical helper as the writers", () => {
    expect(fn).toMatch(/wireStringFor\(\s*"WORKER_HEARTBEAT"\s*\)/);
  });

  it("HEALTHY when a fresh row exists within the interval threshold", () => {
    // The check returns HEALTHY when `ageMs <= staleThresholdMs`.
    expect(fn).toMatch(/staleThresholdMs\s*=\s*intervalMs\s*\*\s*3/);
    expect(fn).toMatch(/status:\s*"HEALTHY"[\s\S]{0,500}reasonCode:\s*"ok"/);
  });

  it("startup grace returns HEALTHY (worker_warming) within 2x interval after API start", () => {
    expect(fn).toMatch(/startupGraceMs\s*=\s*intervalMs\s*\*\s*2/);
    expect(fn).toMatch(/reasonCode:\s*"worker_warming"/);
    expect(fn).toMatch(/apiUptimeMs\s*<\s*startupGraceMs/);
  });

  it("DEGRADED only fires after grace AND no row found AND env precondition checked", () => {
    // The Phase 32.7.3 env precondition fires first; the actual
    // no_recent_reconcile branch fires last.
    const noRecentIdx = fn.lastIndexOf('reasonCode: "no_recent_reconcile"');
    const cronCheckIdx = fn.indexOf('reasonCode: "reconcile_cron_secret_missing"');
    expect(noRecentIdx).toBeGreaterThan(-1);
    expect(cronCheckIdx).toBeGreaterThan(-1);
    expect(noRecentIdx).toBeGreaterThan(cronCheckIdx);
  });
});

// =============================================================================
// Part 4 — Writer/reader canonical alignment (one source of truth)
// =============================================================================

describe("Phase 32.7.5 — writer + reader bind to one canonical event name", () => {
  const ROUTE_SRC = readApi("src/routes/reviewer-ops.routes.ts");
  const ENGINE_SRC = readApi(
    "src/services/reviewer-ops/reviewer-operations-engine.service.ts",
  );
  const READER_SRC = readApi("src/runtime/runtime-readiness.ts");
  const CANONICAL_SRC = readFileSync(
    fileURLToPath(
      new URL(
        "../../../packages/shared-runtime/src/ops/canonical-events.ts",
        import.meta.url,
      ),
    ),
    "utf8",
  );

  it("all three sites resolve WORKER_HEARTBEAT through wireStringFor", () => {
    expect(ROUTE_SRC).toMatch(/wireStringFor\(\s*"WORKER_HEARTBEAT"\s*\)/);
    expect(ENGINE_SRC).toMatch(
      /canonicalOperationalWireStringFor\([\s\S]{0,100}"WORKER_HEARTBEAT"/,
    );
    expect(READER_SRC).toMatch(/wireStringFor\(\s*"WORKER_HEARTBEAT"\s*\)/);
  });

  it("canonical contract module declares WORKER_HEARTBEAT → reviewer_reconcile_run mapping", () => {
    expect(CANONICAL_SRC).toMatch(
      /WORKER_HEARTBEAT:\s*"reviewer_reconcile_run"/,
    );
  });

  it("no inline literal `eventType: \"reviewer_reconcile_run\"` in the heartbeat call sites (canonical resolver enforced)", () => {
    // Engine: the per-team writer
    expect(ENGINE_SRC).not.toMatch(/eventType:\s*"reviewer_reconcile_run"/);
    // Route: the sweep-level writer
    expect(ROUTE_SRC).not.toMatch(/eventType:\s*"reviewer_reconcile_run"/);
  });
});

// =============================================================================
// Part 5 — No regression on adjacent governance / Redis / queue checks
// =============================================================================

describe("Phase 32.7.5 — adjacent readiness subsystems unchanged", () => {
  const SRC = readApi("src/runtime/runtime-readiness.ts");

  it("Redis ping still uses Phase 32.7.3 explicit connect-then-ping ordering", () => {
    const fnIdx = SRC.indexOf("async function checkRedis");
    expect(fnIdx).toBeGreaterThan(-1);
    const fnSlice = SRC.slice(fnIdx, fnIdx + 4000);
    const connectIdx = fnSlice.indexOf("pingClient.connect()");
    const pingIdx = fnSlice.indexOf("pingClient.ping()");
    expect(connectIdx).toBeGreaterThan(-1);
    expect(pingIdx).toBeGreaterThan(connectIdx);
  });

  it("queues subsystem still derives signal from OperationalIncident table (no change)", () => {
    expect(SRC).toMatch(/category:\s*"WORKER"/);
  });

  it("Phase 32.7.4 governance handler bounded server-side diagnostic preserved", () => {
    const BOUND_SRC = readApi("src/routes/_governance-error-bound.ts");
    expect(BOUND_SRC).toMatch(/reply\.log\.warn\(/);
    expect(BOUND_SRC).toMatch(/event:\s*"governance\.schema_unavailable"/);
  });
});
