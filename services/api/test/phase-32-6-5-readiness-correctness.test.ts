/**
 * Phase 32.6.5 — Readiness correctness regression tests (source-contract).
 *
 * Three confirmed production false-positives the hotfix closes:
 *
 *   1. `migrations` reported CRITICAL with failed=3, pending=3 even
 *      after `prisma migrate deploy` succeeded and `prisma migrate
 *      status` reported "Database schema is up to date!". Root cause:
 *      `checkMigrations()` counted EVERY row where `rolled_back_at !=
 *      NULL`, including historical rows that had since been re-applied
 *      (Prisma keeps both rows when `migrate resolve --rolled-back`
 *      then `migrate deploy` is used). The fix dedups by
 *      `migration_name`, keeping only the most-recent-by-`started_at`
 *      row per name — bringing the readiness check into agreement with
 *      `prisma migrate status`.
 *
 *   2. `workers` reported DEGRADED with `no_recent_reconcile` even
 *      when the reviewer reconciliation worker was running fine. Root
 *      cause: the reader queried
 *      `prisma.adminAuditLog.findFirst({ where: { action:
 *      "reviewer_reconcile_run" } })` but the writer
 *      (`reviewer-operations-engine.service.ts:1016`) calls
 *      `safeEmitSecurityEvent({ eventType: "reviewer_reconcile_run"
 *      })` which writes to `security_events`, NOT `admin_audit_logs`.
 *      The two tables never had a sync path; the readiness check has
 *      been broken since it shipped. Fix: align the reader with the
 *      existing writer by querying
 *      `prisma.securityEvent.findFirst({ where: { eventType:
 *      "reviewer_reconcile_run" } })`.
 *
 *   3. `redis` CRITICAL fired a duplicate Sentry alert for the
 *      bounded "Stream isn't writeable and enableOfflineQueue options
 *      is false" string. This is the readiness ping client's normal
 *      fast-fail behavior when the 500ms connectTimeout expires;
 *      Phase 32.6.1 deliberately configured it that way. The Sentry
 *      `beforeSend` filter previously caught `ECONNREFUSED /
 *      Connection is closed / Connection lost` but NOT "Stream isn't
 *      writeable" — the duplicate alert was pure noise. The fix adds
 *      that string to the filter on BOTH api and worker. The
 *      readiness CRITICAL signal continues to surface (we are NOT
 *      silencing the underlying signal — only suppressing the
 *      duplicate Sentry alert).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// =============================================================================
// Part 1 — checkMigrations: stale-rolled-back false positive
// =============================================================================

describe("Phase 32.6.5 — checkMigrations stale-rolled-back repair", () => {
  const SRC = readSource("../src/runtime/runtime-readiness.ts");
  const fnStart = SRC.indexOf("async function checkMigrations");
  const fnEnd = SRC.indexOf("async function checkDatabase", fnStart);
  const fn = SRC.slice(fnStart, fnEnd);

  it("selects `started_at` from _prisma_migrations (needed for dedup)", () => {
    expect(fn).toMatch(
      /SELECT[\s\S]*?migration_name[\s\S]*?finished_at[\s\S]*?rolled_back_at[\s\S]*?started_at[\s\S]*?FROM\s+"_prisma_migrations"/,
    );
  });

  it("dedups by migration_name keeping the most recent row per name", () => {
    // Verify the Map-based dedup exists.
    expect(fn).toMatch(
      /latestPerMigration\s*=\s*new\s+Map<\s*string\s*,/,
    );
    // Verify it only inserts the first occurrence (which is most-recent
    // because the SQL orders by started_at DESC).
    expect(fn).toMatch(/if\s*\(\s*!latestPerMigration\.has\(row\.migration_name\)\s*\)/);
  });

  it("`failed` counts only currently-rolled-back live rows (NOT historical)", () => {
    expect(fn).toMatch(
      /failed\s*=\s*liveRows\.filter\(\(r\)\s*=>\s*r\.rolled_back_at\s*!=\s*null\)\.length/,
    );
  });

  it("`pending` excludes rows that are rolled back (a rolled-back row has finished_at NULL too)", () => {
    expect(fn).toMatch(
      /pending\s*=\s*liveRows\.filter\([\s\S]*?r\.finished_at\s*==\s*null\s*&&\s*r\.rolled_back_at\s*==\s*null[\s\S]*?\)\.length/,
    );
  });

  it("`latest` reflects the most recent LIVE row (post-dedup), not raw rows[0]", () => {
    // Ensure the metadata.latest references the deduped result, not the
    // pre-dedup `rows[0]` which would still be a stale rolled-back row.
    expect(fn).toMatch(/latestLive[\s\S]*?reduce/);
    // And the metadata in each branch reads from latestLive.
    expect(fn).toMatch(/latest:\s*latestLive\?\.migration_name\s*\?\?\s*""/);
  });

  it("query LIMIT increased to 500 so dedup has enough history to be correct", () => {
    expect(fn).toMatch(/LIMIT\s+500/);
  });

  it("HEALTHY response reports `applied` (post-dedup) instead of raw rows.length", () => {
    // Capture only the HEALTHY-return slice.
    const healthyIdx = fn.indexOf('status: "HEALTHY"');
    expect(healthyIdx).toBeGreaterThan(-1);
    const tail = fn.slice(healthyIdx, healthyIdx + 800);
    expect(tail).toMatch(/applied,\s*\n\s*totalLive/);
  });
});

// =============================================================================
// Part 2 — Sentry filter coverage for "Stream isn't writeable"
// =============================================================================

describe("Phase 32.6.5 — Sentry filter catches `Stream isn't writeable`", () => {
  const API_SENTRY = readSource("../src/observability/sentry.ts");
  const WORKER_SENTRY = readSource("../../worker/src/sentry.ts");

  it("API beforeSend filter includes `Stream isn't writeable`", () => {
    expect(API_SENTRY).toMatch(
      /message\.includes\(\s*"Stream isn't writeable"\s*\)/,
    );
  });

  it("Worker beforeSend filter includes `Stream isn't writeable`", () => {
    expect(WORKER_SENTRY).toMatch(
      /message\.includes\(\s*"Stream isn't writeable"\s*\)/,
    );
  });

  it("the original three transient-signal filters are preserved (no weakening)", () => {
    for (const src of [API_SENTRY, WORKER_SENTRY]) {
      expect(src).toMatch(/ECONNREFUSED/);
      expect(src).toMatch(/Connection is closed/);
      expect(src).toMatch(/Connection lost/);
    }
  });

  it("filter is guarded by an explicit `if (message.includes(...))` (no broad message drop)", () => {
    for (const src of [API_SENTRY, WORKER_SENTRY]) {
      // The bounded filter is only allowed to drop events whose
      // message matches the four bounded signatures. Verify the
      // `return null` lives inside an `if (message.includes(...))`
      // guard rather than being unconditional.
      expect(src).toMatch(
        /if\s*\(\s*\n?\s*message\.includes\([\s\S]{0,400}?\)\s*\)\s*\{\s*\n?\s*return\s+null;/,
      );
      // And there must be exactly one `return event` (the fallthrough
      // for ALL events that did NOT match any bounded signature).
      const returnEventCount = (src.match(/return\s+event;/g) ?? []).length;
      expect(returnEventCount).toBe(1);
    }
  });
});

// =============================================================================
// Part 3 — checkWorkers query target repair
// =============================================================================

describe("Phase 32.6.5 — checkWorkers queries security_events (the writer's table)", () => {
  const SRC = readSource("../src/runtime/runtime-readiness.ts");
  const fnStart = SRC.indexOf("async function checkWorkers");
  expect(fnStart).toBeGreaterThan(-1);
  const fnEnd = SRC.indexOf("\n}\n", fnStart);
  const fn = SRC.slice(fnStart, fnEnd);

  it("queries prisma.securityEvent (NOT prisma.adminAuditLog) for reviewer_reconcile_run", () => {
    expect(fn).toMatch(/prisma\.securityEvent\.findFirst/);
    expect(fn).not.toMatch(
      /prisma\.adminAuditLog\.findFirst\([\s\S]{0,200}reviewer_reconcile_run/,
    );
  });

  it("uses `eventType` field on the SecurityEvent model (not `action`)", () => {
    expect(fn).toMatch(
      /where:\s*\{\s*eventType:\s*"reviewer_reconcile_run"\s*\}/,
    );
  });

  it("Phase 32.6 startup grace window still applies (`worker_warming` HEALTHY)", () => {
    expect(fn).toMatch(/reasonCode:\s*"worker_warming"/);
    expect(fn).toMatch(/if\s*\(\s*apiUptimeMs\s*<\s*startupGraceMs\s*\)/);
  });

  it("after grace, `no_recent_reconcile` DEGRADED still fires", () => {
    expect(fn).toMatch(/reasonCode:\s*"no_recent_reconcile"/);
  });

  it("3x-interval `stale_reconcile` threshold still applies once a reconcile observed", () => {
    expect(fn).toMatch(/reasonCode:\s*"stale_reconcile"/);
  });
});

// =============================================================================
// Part 4 — Writer/reader alignment cross-check (canonical agreement)
// =============================================================================

describe("Phase 32.6.5 — reconcile writer/reader alignment", () => {
  const READER_SRC = readSource("../src/runtime/runtime-readiness.ts");
  const WRITER_SRC = readSource(
    "../src/services/reviewer-ops/reviewer-operations-engine.service.ts",
  );

  it("writer emits SecurityEvent with eventType `reviewer_reconcile_run`", () => {
    expect(WRITER_SRC).toMatch(
      /safeEmitSecurityEvent\(\s*\{[\s\S]{0,400}?eventType:\s*"reviewer_reconcile_run"/,
    );
  });

  it("reader queries the same table (SecurityEvent) with the same key (eventType)", () => {
    // The reader fragment must reference both `securityEvent` and
    // `eventType: "reviewer_reconcile_run"` close together.
    expect(READER_SRC).toMatch(
      /prisma\.securityEvent\.findFirst\(\s*\{\s*where:\s*\{\s*eventType:\s*"reviewer_reconcile_run"/,
    );
  });

  it("no orphan reader still pointing at adminAuditLog for reviewer_reconcile_run", () => {
    expect(READER_SRC).not.toMatch(
      /prisma\.adminAuditLog\.findFirst\(\s*\{\s*where:\s*\{\s*action:\s*"reviewer_reconcile_run"/,
    );
  });
});

// =============================================================================
// Part 5 — Governance fail-closed contract preserved
// =============================================================================

describe("Phase 32.6.5 — governance fail-closed contract preserved (no weakening)", () => {
  const GOV_BOUND = readSource("../src/routes/_governance-error-bound.ts");

  it("runGovernanceHandler still catches P2022 / P2021 / P2025", () => {
    expect(GOV_BOUND).toMatch(/P2022/);
    expect(GOV_BOUND).toMatch(/P2021/);
    expect(GOV_BOUND).toMatch(/P2025/);
  });

  it("still emits 503 with bounded `governance_schema_unavailable` code", () => {
    expect(GOV_BOUND).toMatch(/code:\s*"governance_schema_unavailable"/);
    expect(GOV_BOUND).toMatch(/503/);
  });

  it("non-Prisma errors are re-thrown (no silent permissive default)", () => {
    expect(GOV_BOUND).toMatch(/throw\s+err/);
  });
});
