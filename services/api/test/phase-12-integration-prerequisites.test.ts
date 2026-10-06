/**
 * PHASE 12 — the canonical integration command must be self-contained.
 *
 * WHAT BROKE
 * ---------------------------------------------------------------------------
 * `clean-db-boot` ran `pnpm test:integration` on a clean checkout. Every export
 * of `@proovra/shared-runtime` points at `./dist/*`, `pnpm install` does not
 * produce `dist`, and the root `build:shared` script builds four packages —
 * shared, shared-evidence-presentation, shared-billing, ui — but NOT
 * shared-runtime. Vite could not resolve the package, all 23 integration suites
 * failed during module COLLECTION, and the run reported 86 tests / 84 skipped:
 * the cases belonging to the suites that did load. The 23 that died never
 * registered a case, so their absence looked like "skipped" rather than
 * "never executed" — the most dangerous shape a CI failure can take.
 *
 * It passed locally because local certification always built the shared
 * packages first. The command itself was never self-sufficient.
 *
 * WHAT THIS GUARDS
 * ---------------------------------------------------------------------------
 * That the prerequisite ORDER is owned by one script, that every exported entry
 * the API imports is produced by it, and that no caller bypasses it. Resolution
 * is driven through Node's real resolver against the package's own `exports`
 * map — not a byte pin, not a source-window regex.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const API_ROOT = resolve(import.meta.dirname, "..");
const REPO_ROOT = resolve(API_ROOT, "../..");
const SHARED_RUNTIME = resolve(REPO_ROOT, "packages/shared-runtime");

const apiPkg = JSON.parse(readFileSync(resolve(API_ROOT, "package.json"), "utf8"));
const runtimePkg = JSON.parse(readFileSync(resolve(SHARED_RUNTIME, "package.json"), "utf8"));

/** Every subpath `@proovra/shared-runtime` publishes, from its own exports map. */
const EXPORTED_SUBPATHS: string[] = Object.keys(runtimePkg.exports ?? { ".": {} });

/** The file each export resolves to, relative to the package root. */
function exportTarget(subpath: string): string {
  const entry = runtimePkg.exports[subpath];
  const target = typeof entry === "string" ? entry : (entry.import ?? entry.default);
  return String(target).replace(/^\.\//, "");
}

describe("PHASE 12 — integration-test prerequisites", () => {
  it("every shared-runtime export points at COMPILED output, never at TypeScript source", () => {
    expect(EXPORTED_SUBPATHS.length).toBeGreaterThan(0);

    for (const sub of EXPORTED_SUBPATHS) {
      const target = exportTarget(sub);
      // A package alias to `src` would "fix" resolution by shipping raw TS and
      // silently diverge test resolution from production resolution.
      expect(target, `${sub} must not export TypeScript source`).not.toMatch(/^src\//);
      expect(target, `${sub} must resolve into dist/`).toMatch(/^dist\//);
    }
  });

  it("the exported entries exist and load through Node's real resolver", () => {
    const require_ = createRequire(resolve(API_ROOT, "package.json"));

    for (const sub of EXPORTED_SUBPATHS) {
      const spec = sub === "." ? "@proovra/shared-runtime" : `@proovra/shared-runtime/${sub.slice(2)}`;

      // Resolution goes through the package's exports map, exactly as Vite and
      // Node do at run time. If `dist` is missing this throws — which is the
      // failure this suite exists to make impossible to ship unnoticed.
      expect(() => require_.resolve(spec), `${spec} does not resolve`).not.toThrow();

      const file = resolve(SHARED_RUNTIME, exportTarget(sub));
      expect(existsSync(file), `${spec} resolves to a missing file`).toBe(true);
    }
  });

  it("every subpath the API imports is an exported subpath", () => {
    const imported = new Set<string>();
    const grep = execFileSync(
      "git",
      ["-C", REPO_ROOT, "grep", "-hoE", "@proovra/shared-runtime(/[a-z-]+)?", "--", "services/api"],
      { encoding: "utf8", maxBuffer: 1 << 28 },
    );
    for (const line of grep.split("\n")) {
      const t = line.trim();
      if (t) imported.add(t.replace("@proovra/shared-runtime", "").replace(/^\//, "") || ".");
    }

    const exported = new Set(EXPORTED_SUBPATHS.map((s) => (s === "." ? "." : s.slice(2))));
    for (const sub of imported) {
      expect(exported.has(sub), `services/api imports an unexported subpath: ${sub}`).toBe(true);
    }
    // The API really does import subpaths — otherwise this test proves nothing.
    expect(imported.size).toBeGreaterThan(1);
  });

  it("the canonical command prepares before it runs, and preparation builds shared-runtime", () => {
    const s = apiPkg.scripts;

    expect(s["test:integration"]).toBeDefined();
    expect(s["test:integration:prepare"]).toBeDefined();
    expect(s["test:integration:run"]).toBeDefined();

    // Prepare THEN run, chained so a failed build stops the suite starting.
    expect(s["test:integration"]).toContain("test:integration:prepare");
    expect(s["test:integration"]).toContain("test:integration:run");
    expect(s["test:integration"]).toContain("&&");

    // Preparation must generate Prisma (shared-runtime's sources import
    // `@prisma/client` types) and build the dependency set.
    const prepareSrc = readFileSync(
      resolve(API_ROOT, "scripts/integration-prepare.mjs"),
      "utf8",
    );
    expect(s["test:integration:prepare"]).toContain("integration-prepare.mjs");
    expect(prepareSrc).toMatch(/prisma:generate/);
    expect(prepareSrc).toContain("build:deps");
    expect(s["build:deps"]).toContain("@proovra/shared-runtime");

    // Prepare must never silently continue past a failed step.
    expect(prepareSrc).toMatch(/process\.exit\(/);
  });

  it("build ordering has ONE owner — prebuild and prepare share it", () => {
    const s = apiPkg.scripts;

    // `prebuild` must not keep a second copy of the ordering.
    expect(s.prebuild).toContain("build:deps");
    expect(s.prebuild).not.toContain("@proovra/shared-runtime");
  });

  it("the raw Vitest integration runner has exactly one INVOKER: the canonical script", () => {
    // Mentioning the config file is fine — census lists, exclude globs and
    // comments all name it. What must be unique is INVOCATION: a command that
    // actually starts Vitest against that config, bypassing preparation.
    const INVOCATION = /vitest\s+run\s+--config\s+vitest\.integration\.config/;

    const files = execFileSync("git", ["-C", REPO_ROOT, "ls-files"], {
      encoding: "utf8",
      maxBuffer: 1 << 28,
    })
      .split("\n")
      .filter(Boolean)
      .filter((f) => /\.(json|ya?ml|mjs|cjs|js|ts|sh|ps1)$/.test(f))
      .filter((f) => !f.includes("phase-12-integration-prerequisites"));

    const invokers = files.filter((f) => {
      let body = "";
      try {
        body = readFileSync(resolve(REPO_ROOT, f), "utf8");
      } catch {
        return false;
      }
      return INVOCATION.test(body);
    });

    expect(invokers, "the raw runner is invoked outside the canonical script").toEqual([
      "services/api/package.json",
    ]);
  });

  it("no workflow invokes the raw runner, and the integration caller uses the canonical script", () => {
    const wfDir = resolve(REPO_ROOT, ".github/workflows");
    const files = execFileSync("git", ["-C", REPO_ROOT, "ls-files", "--", ".github/workflows"], {
      encoding: "utf8",
      maxBuffer: 1 << 28,
    })
      .split("\n")
      .filter(Boolean);

    let callers = 0;
    for (const rel of files) {
      const body = readFileSync(resolve(REPO_ROOT, rel), "utf8");
      expect(body, `${rel} calls the raw integration runner`).not.toMatch(
        /vitest\s+run\s+--config\s+vitest\.integration\.config/,
      );
      if (/pnpm\s+(run\s+)?test:integration\b/.test(body)) callers += 1;
      // A green run must be able to block the release.
      expect(body, `${rel} disables failure propagation`).not.toContain("continue-on-error: true");
    }

    expect(existsSync(wfDir)).toBe(true);
    expect(callers, "no workflow runs the integration suite").toBeGreaterThan(0);
  });

  it("no compiled dist output is committed", () => {
    const tracked = execFileSync("git", ["-C", REPO_ROOT, "ls-files"], {
      encoding: "utf8",
      maxBuffer: 1 << 28,
    })
      .split("\n")
      .filter((f) => /(^|\/)dist\//.test(f));

    expect(tracked).toEqual([]);
  });

  it("the integration per-test budget never returns to five minutes", () => {
    // 300_000 was five minutes of SILENCE per test: three tests hit it in CI and
    // the job burned ~19 minutes to report "Test timed out in 300000ms" and
    // nothing else. The budget must stay small enough that a hang is visible
    // quickly, and the database bounds must stay BELOW it so PostgreSQL reports
    // the cause before Vitest reports a bare timeout.
    const cfg = readFileSync(resolve(API_ROOT, "vitest.integration.config.ts"), "utf8");

    const testTimeout = Number(
      /testTimeout:\s*([0-9_]+)/.exec(cfg)?.[1]?.replace(/_/g, "") ?? "0",
    );
    expect(testTimeout).toBeGreaterThan(0);
    expect(testTimeout).toBeLessThanOrEqual(120_000);

    const harness = readFileSync(resolve(API_ROOT, "test/integration-harness.ts"), "utf8");
    const secondsOf = (name: string): number =>
      Number(new RegExp(`-c ${name}=(\\d+)s`).exec(harness)?.[1] ?? "0");

    const lock = secondsOf("lock_timeout");
    const statement = secondsOf("statement_timeout");
    const idle = secondsOf("idle_in_transaction_session_timeout");

    // Each must be set (0 means "wait forever" — the original defect)…
    expect(lock).toBeGreaterThan(0);
    expect(statement).toBeGreaterThan(0);
    expect(idle).toBeGreaterThan(0);
    // …and each must fire before the per-test deadline.
    expect(lock * 1000).toBeLessThan(testTimeout);
    expect(statement * 1000).toBeLessThan(testTimeout);
    expect(idle * 1000).toBeLessThan(testTimeout);
    // A lock wait is a narrower failure than a whole statement.
    expect(lock).toBeLessThanOrEqual(statement);
  });

  it("the purge claim stands down instead of waiting for a competing worker", () => {
    // The production defect: a bare `FOR UPDATE` made the losing purge WAIT for
    // the winner with no `lock_timeout`, so the loser held its row lock and its
    // pool connection until the test deadline. Losers must never block.
    const processor = readFileSync(
      resolve(REPO_ROOT, "services/worker/src/processor.ts"),
      "utf8",
    );

    // Comments discuss `FOR UPDATE` by name — including the one explaining this
    // very fix — so inspect SQL, not prose.
    const blocking = processor
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .filter((l) => /FOR UPDATE\s*$/.test(l.trim()))
      .filter((l) => !/SKIP LOCKED|NOWAIT/.test(l));

    expect(
      blocking,
      "a blocking FOR UPDATE returned to the worker; losers must stand down, not wait",
    ).toEqual([]);
  });

  it("integration failure can block the downstream release", () => {
    const files = execFileSync("git", ["-C", REPO_ROOT, "ls-files", "--", ".github/workflows"], {
      encoding: "utf8",
      maxBuffer: 1 << 28,
    })
      .split("\n")
      .filter(Boolean);

    for (const rel of files) {
      const body = readFileSync(resolve(REPO_ROOT, rel), "utf8");
      // Neither the job nor the step may swallow a red integration run.
      expect(body, `${rel} allows a failing step to pass`).not.toMatch(
        /continue-on-error:\s*true/,
      );
    }
  });
});
