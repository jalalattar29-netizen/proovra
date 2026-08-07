#!/usr/bin/env node
/**
 * Phase 2.5F — deploy:safe orchestrator.
 *
 * Single canonical entry point for safe deployment. Runs every
 * Phase 2.5C/D/E check in the correct sequence, with structured
 * output and fail-closed semantics.
 *
 * Sequence:
 *   1. Environment validation
 *      - DATABASE_URL set?
 *      - host classification?
 *      - safe defaults present?
 *   2. Migration risk scan (Phase 2.5D)
 *      - BLOCKED patterns fail immediately
 *   3. Drift check (Phase 2.5C)
 *      - skipped on non-local hosts without override
 *   4. Migrate (Phase 2.5C wrapper)
 *      - wrapper enforces the host policy
 *      - in-process hook is the second layer
 *   5. Prisma generate
 *      - ensures the client matches the post-migration schema
 *   6. Typecheck (proves the new client + code agree)
 *
 * What this orchestrator does NOT do:
 *   - It does NOT boot the API or worker — that's the deploy
 *     pipeline's responsibility, not this script. We deliberately
 *     stop after `prisma generate` so the orchestrator is safe to
 *     run locally as a pre-flight + dry-run.
 *   - It does NOT create backups automatically. The Phase 2.5D
 *     `MIGRATE_BACKUP_ID` requirement is enforced by the wrapper
 *     it invokes.
 *
 * Exit codes:
 *   0   — all stages passed
 *   13  — at least one stage failed
 *   14  — invoked with --dry-run; the dry-run completed (no migrate)
 *
 * Flags:
 *   --dry-run        run env-validation + risk-scan + drift-check only
 *   --allow-remote   forwarded to safe-migrate (for explicit remote deploy)
 *
 * Env passthrough:
 *   MIGRATE_ALLOW_REMOTE, MIGRATE_BACKUP_ID, PRISMA_BYPASS_SAFETY,
 *   PRELIGHT_SKIP_DRIFT — all inherited by the spawned subprocess.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dirname, "..");

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const allowRemoteFlag = argv.includes("--allow-remote");

// ---------------------------------------------------------------------------
// Stage runner
// ---------------------------------------------------------------------------

const stages = [];
let stageIndex = 0;
let failed = false;
let failedStage = null;

function runStage({
  name,
  command,
  args: cmdArgs,
  optional = false,
  env = {},
  // Phase 2.7X Stage 6 — some validators (e.g. consistency-check)
  // exit non-zero with INFO-level signals (WARN=7, local-refusal=2).
  // The orchestrator treats those as PASS via this allowlist.
  acceptableExitCodes = [0],
}) {
  stageIndex++;
  if (failed && !optional) {
    stages.push({ idx: stageIndex, name, status: "SKIPPED", detail: "previous stage failed" });
    return null;
  }
  const t0 = Date.now();
  const result = spawnSync(command, cmdArgs, {
    encoding: "utf8",
    cwd: API_ROOT,
    env: { ...process.env, ...env },
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  const elapsedMs = Date.now() - t0;
  const code = result.status;
  if (acceptableExitCodes.includes(code)) {
    const detail = code === 0 ? undefined : `informational exit ${code}`;
    stages.push({ idx: stageIndex, name, status: "PASS", elapsedMs, detail });
    return 0;
  }
  failed = true;
  if (!failedStage) failedStage = { idx: stageIndex, name, code };
  stages.push({
    idx: stageIndex,
    name,
    status: "FAIL",
    detail: `exit ${code}`,
    elapsedMs,
  });
  return code;
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

process.stderr.write("\n");
process.stderr.write("═══════════════════════════════════════════════════════════════\n");
process.stderr.write(`  PROOVRA deploy:safe orchestrator (Phase 2.5F)\n`);
process.stderr.write(`  mode: ${dryRun ? "DRY-RUN (no migrate)" : "FULL (migrate + generate + typecheck)"}\n`);
process.stderr.write(`  --allow-remote: ${allowRemoteFlag ? "YES" : "no"}\n`);
process.stderr.write("═══════════════════════════════════════════════════════════════\n\n");

// ---------------------------------------------------------------------------
// Stage 1 — Environment validation via db:preflight aggregator.
//
// The preflight refuses non-local hosts unless --allow-remote AND
// MIGRATE_ALLOW_REMOTE=1. It also runs risk-scan + drift-check, so
// this stage covers Stages 1-3 of the original brief in one call.
// ---------------------------------------------------------------------------
runStage({
  name: "preflight (classification + risk-scan + drift-check)",
  command: "node",
  args: [
    resolve(__dirname, "db-preflight.mjs"),
    ...(allowRemoteFlag ? ["--allow-remote"] : []),
  ],
});

// ---------------------------------------------------------------------------
// Stage 1b — PHASE 12 REMEDIATION, AUTH-004 (2026-08-06).
//
// Authorization-authority verification. Static, read-only, source-only: it
// opens no database connection and makes no network call, so it is safe in
// every mode including dry-run.
//
// This is the control that replaces the dead `authorization-allowlist.ts`.
// It fails the deployment when any production module performs a direct
// TeamMember read that could reach an authorization decision without
// proving the membership is live — the exact defect class behind SEC-001,
// AUTH-001, AUTH-002, AUTH-003 and AUTH-005. It runs BEFORE any migration
// so a release carrying a new status-blind gate never reaches the database.
// ---------------------------------------------------------------------------
runStage({
  name: "authorization authorities (Phase 12 AUTH-004)",
  command: "node",
  args: [resolve(__dirname, "verify-authorization-authorities.mjs")],
});

if (dryRun) {
  // ---------------------------------------------------------------------------
  // Stage 2 (dry-run) — Prisma client typecheck only, no migrate.
  //
  // Even in dry-run we typecheck to surface schema-vs-code drift early.
  // ---------------------------------------------------------------------------
  runStage({
    name: "typecheck (services/api)",
    command: "pnpm",
    args: ["exec", "tsc", "--noEmit"],
  });

  // ---------------------------------------------------------------------------
  // Stage 3 (dry-run) — Phase 2.7X Stage 6 org consistency validator.
  //
  // Refuses to run against non-local DB; in dry-run, deploy:safe is
  // local-only by design (the wrapper would refuse non-local anyway).
  // The validator is read-only, so it is safe to run as part of the
  // pre-flight chain.
  //
  // The validator exits 7 on WARN — we treat WARN as informational
  // here, not failure. Hard FAIL (exit 8) still escalates to the
  // deploy:safe failure path via the stage-runner.
  // ---------------------------------------------------------------------------
  runStage({
    name: "org consistency (Phase 2.7X Stage 5)",
    command: "node",
    args: [resolve(__dirname, "check-org-consistency.mjs")],
    acceptableExitCodes: [0, 7],
  });
} else {
  // ---------------------------------------------------------------------------
  // Stage 2 — Migrate via the safe wrapper.
  // ---------------------------------------------------------------------------
  runStage({
    name: "migrate (safe-migrate wrapper)",
    command: "node",
    args: [
      resolve(__dirname, "safe-migrate.mjs"),
      "deploy",
      ...(allowRemoteFlag ? ["--allow-remote"] : []),
    ],
  });

  // ---------------------------------------------------------------------------
  // Stage 3 — Prisma generate.
  // ---------------------------------------------------------------------------
  runStage({
    name: "prisma generate",
    command: "pnpm",
    args: ["exec", "prisma", "generate"],
  });

  // ---------------------------------------------------------------------------
  // Stage 4 — Typecheck (proves the new client + code agree).
  // ---------------------------------------------------------------------------
  runStage({
    name: "typecheck (services/api)",
    command: "pnpm",
    args: ["exec", "tsc", "--noEmit"],
  });

  // ---------------------------------------------------------------------------
  // Stage 5 — Final drift-check (proves the apply landed cleanly).
  // ---------------------------------------------------------------------------
  runStage({
    name: "drift-check (post-migrate)",
    command: "node",
    args: [resolve(__dirname, "drift-check.mjs")],
  });

  // ---------------------------------------------------------------------------
  // Stage 6 — Phase 2.7X Stage 5/6 org consistency post-deploy.
  //
  // Local only: the validator refuses on non-LOCAL classification.
  // For remote deploys, the validator output here is meaningless
  // (it would refuse). The deploy is still valid; production-side
  // consistency observability is a separate pipeline (Stage 7+).
  //
  // WARN (exit 7) is informational, not a failure. Hard FAIL (8)
  // does escalate.
  // ---------------------------------------------------------------------------
  runStage({
    name: "org consistency (Phase 2.7X Stage 5)",
    command: "node",
    args: [resolve(__dirname, "check-org-consistency.mjs")],
    acceptableExitCodes: [0, 2, 7],
  });
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

process.stderr.write("\n");
process.stderr.write("═══════════════════════════════════════════════════════════════\n");
process.stderr.write("  deploy:safe summary\n");
process.stderr.write("═══════════════════════════════════════════════════════════════\n");
for (const s of stages) {
  const icon =
    s.status === "PASS" ? "✓" : s.status === "SKIPPED" ? "•" : "✗";
  const elapsed = s.elapsedMs != null ? `(${s.elapsedMs}ms)` : "";
  process.stderr.write(`  ${s.idx}. [${s.status.padEnd(7, " ")}] ${icon}  ${s.name} ${elapsed}\n`);
  if (s.detail) process.stderr.write(`              ${s.detail}\n`);
}
process.stderr.write("═══════════════════════════════════════════════════════════════\n");

if (failed) {
  process.stderr.write(
    `  RESULT: FAILED at stage ${failedStage?.idx} (${failedStage?.name})\n` +
      `          stage exit code: ${failedStage?.code}\n` +
      `          See output above for the underlying tool's error message.\n` +
      `          Refer to docs/operations/MIGRATION_DISCIPLINE.md for recovery.\n`,
  );
  process.stderr.write("═══════════════════════════════════════════════════════════════\n\n");
  process.exit(13);
}

if (dryRun) {
  process.stderr.write("  RESULT: DRY-RUN OK — preflight + typecheck passed.\n");
  process.stderr.write("          Re-run without --dry-run to apply migrations.\n");
  process.stderr.write("═══════════════════════════════════════════════════════════════\n\n");
  process.exit(14);
}

process.stderr.write("  RESULT: ALL STAGES PASSED — deploy:safe complete.\n");
process.stderr.write("═══════════════════════════════════════════════════════════════\n\n");
process.exit(0);
