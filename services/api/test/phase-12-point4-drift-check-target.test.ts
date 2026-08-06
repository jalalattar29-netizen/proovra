/**
 * PHASE 12 POINT 4 — the canonical drift check honours an explicit target.
 *
 * The gate previously resolved whatever `DATABASE_URL` happened to be, filling
 * it in silently from `.env` when the caller supplied nothing. A verification
 * run against a disposable database was therefore indistinguishable from one
 * that quietly fell back to the developer's configured host — which is exactly
 * what happened when this gate was invoked during Point 4 (it reported
 * "cannot reach postgres:5432" and the run was recorded as unavailable).
 *
 * These tests pin the resolution contract WITHOUT needing a database: every
 * assertion below is decided before the script contacts Postgres.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(API_ROOT, "scripts/drift-check.mjs");

/**
 * How a child invocation ended.
 *
 * PHASE 12 — POINT 7 (determinism pass). This test intermittently failed only
 * in the full parallel suite, and the reason it was hard to characterise is
 * that EVERY child outcome — a timeout, a signal, a spawn error, a Prisma
 * startup crash — arrived at the assertion as the same thing: output that did
 * not contain the expected line. A killed child and a wrong answer are not the
 * same defect and must not produce the same failure message.
 */
type ChildOutcome =
  | "OK"
  | "SPAWN_ERROR"
  | "SPAWN_TIMEOUT"
  | "KILLED_BY_SIGNAL"
  | "BUFFER_EXHAUSTED"
  | "NO_OUTPUT";

type DriftCheckRun = {
  status: number | null;
  output: string;
  outcome: ChildOutcome;
  /** Bounded diagnostic line — safe to print on failure. Never a URL. */
  diagnostics: string;
};

/**
 * The database target, classified. NEVER the connection string: a diagnostic
 * that prints one is a diagnostic that leaks a credential the first time it
 * runs against something real.
 */
function classifyTarget(url: string | undefined): string {
  if (!url || !url.trim()) return "MISSING";
  try {
    const host = new URL(url).hostname.toLowerCase();
    const local = host === "127.0.0.1" || host === "::1" || host === "localhost";
    if (!local) return "FORBIDDEN_PRODUCTION_LIKE";
    return /test|disposable|probe|ci_style/i.test(new URL(url).pathname)
      ? "EXPLICIT_TEST"
      : "DISPOSABLE_LOCAL";
  } catch {
    return "UNKNOWN";
  }
}

/**
 * MEASURED bounds, not cushions.
 *
 * A healthy child — Node boot + the safe preload + Prisma's migration ledger —
 * takes ~4.3s on this machine. Vitest's DEFAULT test timeout is 5000ms, which
 * left under a second of margin, and `spawnSync` BLOCKS the worker thread so
 * vitest cannot even enforce its timeout until the call returns. That is the
 * whole nondeterminism: under any load the child crossed 5s and the TEST timed
 * out — never the child. The failure then read as "output did not contain
 * `database: …`", i.e. as a target-resolution defect, which it never was.
 *
 * Two corrections, both required:
 *   1. run the child ASYNCHRONOUSLY so the worker can yield and vitest's timer
 *      is real rather than blocked;
 *   2. give the child and the test bounds derived from the measurement.
 */
const CHILD_HEALTHY_MS = 4_300;
/** ~7x measured. A runaway child is still named, not waited on forever. */
const CHILD_TIMEOUT_MS = 30_000;
/** Measured healthy output is a few KB. Bounded so a runaway child is named. */
const CHILD_MAX_BUFFER = 4 * 1024 * 1024;
/** Per-test bound: room for the child plus scheduling, derived from the above. */
const TEST_TIMEOUT_MS = CHILD_TIMEOUT_MS + 15_000;

/**
 * The probes run ONE AT A TIME within this file.
 *
 * Each spawns Node + Prisma; three of them competing inside one worker was the
 * pile-up that pushed a 4.3s child past the deadline. This limiter is scoped to
 * this expensive child-probe family only — it changes no production behaviour,
 * every probe still executes the real script, and a failure still propagates.
 */
let probeQueue: Promise<unknown> = Promise.resolve();
function serialise<T>(fn: () => Promise<T>): Promise<T> {
  const next = probeQueue.then(fn, fn);
  probeQueue = next.catch(() => undefined);
  return next;
}

async function runDriftCheck(
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<DriftCheckRun> {
  return serialise(async () => {
    const startedAt = Date.now();
    const result = await new Promise<{
      status: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
      error?: NodeJS.ErrnoException;
    }>((resolveRun) => {
      const child = execFile(
        process.execPath,
        [SCRIPT, ...args],
        {
          cwd: API_ROOT,
          encoding: "utf8",
          env: { ...process.env, ...env },
          timeout: CHILD_TIMEOUT_MS,
          maxBuffer: CHILD_MAX_BUFFER,
        },
        (error, stdout, stderr) => {
          resolveRun({
            status: child.exitCode,
            signal: child.signalCode,
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            // A non-zero exit is reported by execFile as an error; that is a
            // legitimate outcome here (exit 2 and exit 3 are contract states),
            // so it is NOT treated as a spawn failure.
            error:
              error && (error as NodeJS.ErrnoException).code !== undefined &&
              typeof (error as NodeJS.ErrnoException).code === "string"
                ? (error as NodeJS.ErrnoException)
                : undefined,
          });
        },
      );
    });
    const elapsedMs = Date.now() - startedAt;
    const stdout = result.stdout;
    const stderr = result.stderr;
    const errCode = result.error?.code;

    let outcome: ChildOutcome = "OK";
    if (errCode === "ETIMEDOUT") outcome = "SPAWN_TIMEOUT";
    else if (errCode === "ENOBUFS") outcome = "BUFFER_EXHAUSTED";
    else if (errCode === "ENOENT" || errCode === "EAGAIN") outcome = "SPAWN_ERROR";
    else if (result.signal) outcome = "KILLED_BY_SIGNAL";
    else if (!stdout && !stderr) outcome = "NO_OUTPUT";

    return {
      status: result.status,
      output: `${stdout}\n${stderr}`,
      outcome,
      diagnostics: [
        `outcome=${outcome}`,
        `status=${String(result.status)}`,
        `signal=${String(result.signal)}`,
        `errorCode=${String(errCode)}`,
        `elapsedMs=${elapsedMs}`,
        `healthyMs=${CHILD_HEALTHY_MS}`,
        `stdoutBytes=${stdout.length}`,
        `stderrBytes=${stderr.length}`,
        `parentPid=${process.pid}`,
        `target=${classifyTarget(env.DATABASE_URL ?? process.env.DATABASE_URL)}`,
        `driftTarget=${classifyTarget(env.DRIFT_CHECK_DATABASE_URL)}`,
      ].join(" "),
    };
  });
}

/**
 * Assert the child actually RAN before asserting what it said.
 *
 * Without this, a child that was killed under load fails with "expected output
 * to contain 'database: …'" — which reads as a target-resolution defect and is
 * not one.
 */
function expectChildRan(run: DriftCheckRun): void {
  expect(
    run.outcome,
    `the drift-check child did not complete: ${run.diagnostics}`,
  ).toBe("OK");
}

describe("Phase 12 Point 4 — drift-check target resolution", () => {
  it("honours --database-url and reports it as the source", async () => {
    // Port 1 is closed, so prisma fails immediately — but the banner is
    // printed first, and it must name the SUPPLIED database, never a default.
    const run = await runDriftCheck([
      "--database-url=postgresql://u:p@127.0.0.1:1/proovra_disposable_probe",
    ]);
    expectChildRan(run);
    expect(run.output).toContain("database: proovra_disposable_probe");
    expect(run.output).toContain("source  : --database-url argument");
  }, TEST_TIMEOUT_MS);

  it("honours DRIFT_CHECK_DATABASE_URL as a task-scoped target", async () => {
    const run = await runDriftCheck([], {
      DRIFT_CHECK_DATABASE_URL: "postgresql://u:p@127.0.0.1:1/task_scoped_probe",
      // An ambient DATABASE_URL must NOT win over the explicit task target.
      DATABASE_URL: "postgresql://u:p@127.0.0.1:1/ambient_should_lose",
    });
    expectChildRan(run);
    expect(run.output).toContain("database: task_scoped_probe");
    expect(run.output).toContain("source  : DRIFT_CHECK_DATABASE_URL");
        expect(run.output).not.toContain("ambient_should_lose");
  }, TEST_TIMEOUT_MS);

  it("still resolves DATABASE_URL when no explicit target is given (CI/production path unchanged)", async () => {
    const run = await runDriftCheck([], {
      DATABASE_URL: "postgresql://u:p@127.0.0.1:1/ci_style_target",
      DRIFT_CHECK_DATABASE_URL: undefined,
    });
    expectChildRan(run);
    expect(run.output).toContain("database: ci_style_target");
    expect(run.output).toContain("source  : DATABASE_URL (environment)");
  }, TEST_TIMEOUT_MS);

  it("REFUSES an explicit target on a remote host (exit 3, before any connection)", async () => {
    const run = await runDriftCheck([
      "--database-url=postgresql://x:y@ep-fake.eu-central-1.aws.neon.tech:5432/sentinel",
    ]);
    expectChildRan(run);
    expect(run.status).toBe(3);
    expect(run.output).toContain("REFUSING an explicit target on a remote host");
    // It must not have reached prisma at all.
        expect(run.output).not.toContain("migrations found in prisma/migrations");
  }, TEST_TIMEOUT_MS);

  it("does not guess a default database when nothing is supplied", async () => {
    // `.env` files are only consulted as a last resort, and the script must
    // announce that. With the loader unable to find a URL it exits 2 rather
    // than silently pointing at whatever a config file happens to hold.
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).toMatch(/no database target resolved/);
    expect(src).toMatch(/refuses to guess a default database/);
    // The chosen source is always printed, so a run is never ambiguous.
    expect(src).toMatch(/source {2}: \$\{urlSource\}/);
  }, TEST_TIMEOUT_MS);

  it("the .env fallback is announced, not silent", async () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).toMatch(/\.env file \(no explicit target supplied\)/);
  }, TEST_TIMEOUT_MS);
});
