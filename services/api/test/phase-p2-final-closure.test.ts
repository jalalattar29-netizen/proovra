/**
 * Phase P2 FINAL — Source-contract closure suite.
 *
 * Covers P2.2 → P2.7:
 *
 *   * P2.2 — `/admin/platform/exports` frontend uses the right endpoints,
 *            never renders fake immutable badges, exposes manifest
 *            JSON viewer + reproducibility verify.
 *   * P2.3 — Queue operations backend exposes the documented routes,
 *            replay safety matrix is the canonical source, forbidden
 *            jobs are hard-refused, replay routes require a reason.
 *   * P2.4 — `/admin/platform/queues` frontend renders replay-safety
 *            badges, never renders a replay button for `forbidden`
 *            jobs, integrates step-up wrapper.
 *   * P2.5 — DR backend exposes the documented routes, restore
 *            validation is step-up gated, unsupported domains are
 *            present in every report.
 *   * P2.6 — `/admin/platform/recovery` frontend surfaces the unsupported
 *            domains panel, never renders fake all-green.
 *   * P2.7 — operations routes registered in server.ts; metrics +
 *            event types are extended; step-up purposes added.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  const url = new URL(rel, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

function exists(rel: string): boolean {
  const url = new URL(rel, import.meta.url);
  return existsSync(fileURLToPath(url));
}

// ============================================================================
// P2.2 — WORM Export Frontend
// ============================================================================

describe("Phase P2.2 — WORM Export Frontend", () => {
  it("/admin/platform/exports page exists", () => {
    expect(
      exists("../../../apps/web/app/(app)/admin/platform/exports/page.tsx"),
    ).toBe(true);
  });

  it("calls the P2.1 backend endpoints", () => {
    const p = readSource(
      "../../../apps/web/app/(app)/admin/platform/exports/page.tsx",
    );
    expect(p).toContain("/v1/operations/exports");
    expect(p).toContain("/v1/operations/exports/object-lock");
    expect(p).toContain("/verify");
  });

  it("manifest viewer + hash + verify button exist", () => {
    const p = readSource(
      "../../../apps/web/app/(app)/admin/platform/exports/page.tsx",
    );
    expect(p).toContain('data-testid="manifest-json"');
    expect(p).toContain('data-testid="manifest-hash"');
    expect(p).toContain('data-testid="verify-button"');
  });

  it("immutable badge is gated on platformMode==='verified'", () => {
    const p = readSource(
      "../../../apps/web/app/(app)/admin/platform/exports/page.tsx",
    );
    // Two-part contract:
    //   1. There is a boolean `immutable` derived from
    //      `objectLockMode === "verified"`.
    //   2. The IMMUTABLE badge renders only when that boolean is true.
    expect(p).toMatch(
      /const\s+immutable\s*=\s*[\s\S]{0,80}objectLockMode\s*===\s*"verified"/,
    );
    expect(p).toMatch(/\{immutable\s*\?\s*\([\s\S]{0,400}IMMUTABLE/);
  });

  it("renders the four bounded reproducibility outcome states", () => {
    const p = readSource(
      "../../../apps/web/app/(app)/admin/platform/exports/page.tsx",
    );
    expect(p).toContain('"artifact_missing"');
    expect(p).toContain('"artifact_drift"');
    expect(p).toContain('"retention_drift"');
    expect(p).toContain('"match"');
    expect(p).toContain('"not_applicable"');
  });
});

// ============================================================================
// P2.3 — Queue Operations Backend
// ============================================================================

describe("Phase P2.3 — Queue Operations Backend", () => {
  it("replay safety matrix exposes the bounded ReplayCategory enum", () => {
    const src = readSource(
      "../src/services/operations/queue-replay-safety.service.ts",
    );
    expect(src).toContain('"safe"');
    expect(src).toContain('"requires_step_up"');
    expect(src).toContain('"forbidden"');
    expect(src).toContain('"unknown"');
    expect(src).toContain("PurgeDeletedEvidenceJob");
    expect(src).toMatch(/PurgeDeletedEvidenceJob[\s\S]{0,400}"forbidden"/);
  });

  it("operations queues route file exposes all 6 endpoints", () => {
    const r = readSource("../src/routes/operations-queues.routes.ts");
    expect(r).toContain('"/v1/operations/queues"');
    expect(r).toContain('"/v1/operations/queues/workers"');
    expect(r).toContain('"/v1/operations/queues/replay-safety"');
    expect(r).toContain('"/v1/operations/queues/:queueName/failed"');
    expect(r).toContain('"/v1/operations/queues/:queueName/jobs/:jobId/retry"');
    expect(r).toContain('"/v1/operations/queues/:queueName/jobs/:jobId/replay"');
    expect(r).toContain('"/v1/operations/queues/:queueName/jobs/:jobId/cancel"');
  });

  it("replay routes route through requireStepUpForSensitiveAction with QUEUE_JOB_REPLAY", () => {
    const r = readSource("../src/routes/operations-queues.routes.ts");
    expect(r).toMatch(
      /requireStepUpForSensitiveAction[\s\S]{0,300}purpose:\s*"QUEUE_JOB_REPLAY"/,
    );
  });

  it("replay routes require a reason ≥ 1 char (zod validation)", () => {
    const r = readSource("../src/routes/operations-queues.routes.ts");
    expect(r).toMatch(/reason:\s*z\.string\(\)\.min\(1\)\.max\(240\)/);
  });

  it("queue inventory service sanitises stack traces", () => {
    const src = readSource(
      "../src/services/operations/queue-inventory.service.ts",
    );
    expect(src).toContain("sanitiseStack");
    expect(src).toContain("<path>");
  });

  it("forbidden job replay returns bounded error code, emits audit", () => {
    const src = readSource(
      "../src/services/operations/queue-replay-action.service.ts",
    );
    expect(src).toContain('"replay_forbidden"');
    expect(src).toContain('"queue_job_replay_forbidden"');
    expect(src).toContain('bump("queue_replay_forbidden_total")');
  });
});

// ============================================================================
// P2.4 — Queue Operations Frontend
// ============================================================================

describe("Phase P2.4 — Queue Operations Frontend", () => {
  it("/admin/platform/queues page exists and references the matrix endpoint", () => {
    const p = readSource(
      "../../../apps/web/app/(app)/admin/platform/queues/page.tsx",
    );
    expect(p).toContain("/v1/operations/queues/replay-safety");
    expect(p).toContain("/v1/operations/queues/workers");
  });

  it("renders the four bounded replay-safety categories", () => {
    const p = readSource(
      "../../../apps/web/app/(app)/admin/platform/queues/page.tsx",
    );
    expect(p).toContain('"safe"');
    expect(p).toContain('"requires_step_up"');
    expect(p).toContain('"forbidden"');
    expect(p).toContain('"unknown"');
  });

  it("hides the replay button for forbidden / unknown categories", () => {
    const p = readSource(
      "../../../apps/web/app/(app)/admin/platform/queues/page.tsx",
    );
    // The disabled gate compares cat to "forbidden" or "unknown".
    expect(p).toMatch(
      /cat\s*===\s*"forbidden"\s*\|\|\s*cat\s*===\s*"unknown"/,
    );
    // Operator-facing copy MUST mention forbidden + audit center.
    expect(p).toMatch(/Forbidden.*audit center/);
  });

  it("integrates the step-up modal via useStepUpAction", () => {
    const p = readSource(
      "../../../apps/web/app/(app)/admin/platform/queues/page.tsx",
    );
    expect(p).toContain("useStepUpAction");
    expect(p).toContain("StepUpModal");
    expect(p).toContain("runStepUpAction");
  });

  it("replay dialog requires a reason input", () => {
    const p = readSource(
      "../../../apps/web/app/(app)/admin/platform/queues/page.tsx",
    );
    expect(p).toContain('data-testid="replay-reason"');
    expect(p).toMatch(/reason\.trim\(\)\.length\s*===\s*0/);
  });
});

// ============================================================================
// P2.5 — DR Backend
// ============================================================================

describe("Phase P2.5 — DR / Recovery Backend", () => {
  it("recovery validation service exists with the bounded outcome enum", () => {
    const src = readSource(
      "../src/services/operations/recovery-validation.service.ts",
    );
    expect(src).toContain('"passed"');
    expect(src).toContain('"warning"');
    expect(src).toContain('"failed"');
    expect(src).toContain('"unsupported"');
  });

  it("backup validation report lists infra-layer domains as unsupported", () => {
    const src = readSource(
      "../src/services/operations/recovery-validation.service.ts",
    );
    expect(src).toContain('"infrastructure_database_backups"');
    expect(src).toContain('"infrastructure_s3_backups"');
    expect(src).toContain('"full_disaster_recovery_rehearsal"');
  });

  it("restore validation lists cross-region failover as unsupported", () => {
    const src = readSource(
      "../src/services/operations/recovery-validation.service.ts",
    );
    expect(src).toContain('"cross_region_failover"');
    expect(src).toContain('"infrastructure_layer_restore_orchestration"');
  });

  it("operations recovery routes expose the documented endpoints", () => {
    const r = readSource("../src/routes/operations-recovery.routes.ts");
    expect(r).toContain('"/v1/operations/recovery"');
    expect(r).toContain('"/v1/operations/recovery/validate-backup"');
    expect(r).toContain('"/v1/operations/recovery/validate-restore"');
    expect(r).toContain('"/v1/operations/recovery/reports"');
    expect(r).toContain('"/v1/operations/recovery/reports/:id"');
  });

  it("restore validation route is step-up gated via RESTORE_VALIDATION_EXECUTE", () => {
    const r = readSource("../src/routes/operations-recovery.routes.ts");
    expect(r).toMatch(
      /requireStepUpForSensitiveAction[\s\S]{0,300}purpose:\s*"RESTORE_VALIDATION_EXECUTE"/,
    );
  });

  it("validation service emits the bounded audit event chain", () => {
    const src = readSource(
      "../src/services/operations/recovery-validation.service.ts",
    );
    expect(src).toContain('"backup_validation_started"');
    expect(src).toContain('"backup_validation_completed"');
    expect(src).toContain('"restore_validation_started"');
    expect(src).toContain('"restore_validation_completed"');
    expect(src).toContain('"restore_validation_failed"');
    expect(src).toContain('"recovery_report_generated"');
  });
});

// ============================================================================
// P2.6 — DR Frontend
// ============================================================================

describe("Phase P2.6 — DR / Recovery Frontend", () => {
  it("/admin/platform/recovery page exists", () => {
    expect(
      exists("../../../apps/web/app/(app)/admin/platform/recovery/page.tsx"),
    ).toBe(true);
  });

  it("calls the P2.5 backend endpoints", () => {
    const p = readSource(
      "../../../apps/web/app/(app)/admin/platform/recovery/page.tsx",
    );
    expect(p).toContain("/v1/operations/recovery");
    expect(p).toContain("/v1/operations/recovery/validate-backup");
    expect(p).toContain("/v1/operations/recovery/validate-restore");
  });

  it("surfaces the unsupported-domains panel (no fake all-green)", () => {
    const p = readSource(
      "../../../apps/web/app/(app)/admin/platform/recovery/page.tsx",
    );
    expect(p).toContain('data-testid="unsupported-domains"');
    expect(p).toContain("Unsupported domains (honest disclosure)");
    expect(p).not.toContain("all systems go");
    expect(p).not.toContain("backup guaranteed");
    expect(p).not.toContain("restore guaranteed");
  });

  it("renders the four bounded outcome states", () => {
    const p = readSource(
      "../../../apps/web/app/(app)/admin/platform/recovery/page.tsx",
    );
    expect(p).toContain('"passed"');
    expect(p).toContain('"warning"');
    expect(p).toContain('"failed"');
    expect(p).toContain('"unsupported"');
  });

  it("restore button is wired through useStepUpAction", () => {
    const p = readSource(
      "../../../apps/web/app/(app)/admin/platform/recovery/page.tsx",
    );
    expect(p).toContain("useStepUpAction");
    expect(p).toContain("runStepUpAction");
    expect(p).toContain('data-testid="run-restore-validation"');
  });
});

// ============================================================================
// P2.7 — Coherence + registry extensions
// ============================================================================

describe("Phase P2.7 — Coherence + bounded registries", () => {
  it("server.ts registers all three operations route modules", () => {
    const s = readSource("../src/server.ts");
    expect(s).toContain("operationsExportsRoutes");
    expect(s).toContain("operationsQueuesRoutes");
    expect(s).toContain("operationsRecoveryRoutes");
    expect(s).toMatch(/app\.register\(\s*operationsExportsRoutes/);
    expect(s).toMatch(/app\.register\(\s*operationsQueuesRoutes/);
    expect(s).toMatch(/app\.register\(\s*operationsRecoveryRoutes/);
  });

  it("step-up purposes include QUEUE_JOB_REPLAY and RESTORE_VALIDATION_EXECUTE", () => {
    const idn = readSource(
      "../../../packages/shared/src/identity-security.ts",
    );
    expect(idn).toContain('"QUEUE_JOB_REPLAY"');
    expect(idn).toContain('"RESTORE_VALIDATION_EXECUTE"');
  });

  it("metric registry carries the P2 queue + DR keys", () => {
    const m = readSource(
      "../../../packages/shared-runtime/src/ops/metrics.service.ts",
    );
    for (const k of [
      "queue_replay_total",
      "queue_replay_forbidden_total",
      "queue_replay_safe_total",
      "queue_replay_step_up_total",
      "dlq_job_total",
      "worker_stalled_total",
      "worker_heartbeat_missing_total",
      "backup_validation_total",
      "restore_validation_total",
      "restore_validation_failure_total",
      "recovery_report_generation_total",
      "export_verification_total",
      "export_reproducibility_failure_total",
    ]) {
      expect(m).toContain(`"${k}"`);
    }
  });

  it("security event registry carries the P2 events", () => {
    const sec = readSource("../../../packages/shared/src/security.ts");
    for (const k of [
      "queue_job_replay_attempted",
      "queue_job_replay_forbidden",
      "queue_job_replay_succeeded",
      "queue_job_replay_failed",
      "queue_worker_stalled_detected",
      "backup_validation_started",
      "backup_validation_completed",
      "restore_validation_started",
      "restore_validation_completed",
      "restore_validation_failed",
      "recovery_report_generated",
      "export_reproducibility_verified",
    ]) {
      expect(sec).toContain(`"${k}"`);
    }
  });

  it("tenant gating: every operations route uses the same actor gate", () => {
    // ADM-013 — "the same gate" used to mean "the same code, copied". Each
    // file carried its own actor check; three were byte-identical and the
    // fourth differed only in name, which is how all four came to authorize
    // on `identity.member.read` while serving platform data. They now call
    // ONE function, so this asserts the call rather than the copy.
    for (const f of [
      "../src/routes/operations-exports.routes.ts",
      "../src/routes/operations-queues.routes.ts",
      "../src/routes/operations-recovery.routes.ts",
      "../src/routes/operations-signers.routes.ts",
    ]) {
      const src = readSource(f);
      expect(src).toContain("requirePlatformOpsActor");
      expect(src).toContain('from "./require-platform-ops-actor.js"');
      // And no file may reintroduce a local copy.
      expect(
        src,
        `${f} declares its own actor gate again — that is how the four drifted apart`,
      ).not.toMatch(/async function require(OpsActor|OpsReader)\(/);
    }
  });

  it("the one actor gate still carries every property the four used to", () => {
    const src = readSource("../src/routes/require-platform-ops-actor.ts");
    // Anti-enumeration 404 for non-members.
    expect(src).toMatch(/reply\.code\(404\)/);
    // Active-member gate.
    expect(src).toContain('"member_inactive"');
    // Permission check via the access-policy service.
    expect(src).toContain("evaluateMemberAccess");
    // And the property none of the four had: platform authority, evaluated
    // BEFORE the workspace lookup so a non-operator cannot probe workspace ids
    // by telling 404 from 403.
    expect(src).toContain("resolvePlatformAdmin");
    // Ordering is read from CODE. The file's header explains the ordering and
    // names both calls in prose, so an index taken over the raw text reports
    // the documentation's order rather than the function's.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const platformAt = code.indexOf("resolvePlatformAdmin(");
    const memberAt = code.indexOf("teamMember.findUnique");
    expect(platformAt).toBeGreaterThan(0);
    expect(memberAt).toBeGreaterThan(0);
    expect(
      platformAt,
      "the workspace lookup runs before the platform check, which turns the " +
        "404/403 difference into an enumeration oracle",
    ).toBeLessThan(memberAt);
  });
});
