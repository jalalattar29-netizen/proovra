/**
 * ADM-013 — THE DIAGNOSTIC'S MODULE RESOLUTION CONTRACT.
 *
 * ===========================================================================
 * THE BUG THIS LOCKS OUT
 * ===========================================================================
 * The runbook told an operator to `docker cp` the diagnostic to `/tmp` and run
 * `node /tmp/proovra-diagnostic.cjs`. Against the real production image that
 * failed every time:
 *
 *     Error: Cannot find module '@prisma/client'
 *     Require stack:
 *     - /tmp/proovra-diagnostic.cjs
 *
 * CommonJS resolves a bare specifier by walking up from the directory of the
 * FILE doing the requiring, not from the working directory. The image installs
 * hoisted into `/app/node_modules` and sets WORKDIR to `/app/services/api`, so
 * the walk went `/tmp/node_modules` → `/node_modules` → nothing, and the
 * correct working directory was never consulted because cwd plays no part in
 * the walk.
 *
 * ===========================================================================
 * WHY THIS FILE, WHEN THE CONTAINER SMOKE ALREADY PROVES IT
 * ===========================================================================
 * `scripts/diagnostic-container-smoke.mjs` runs the real matrix against a real
 * image and is the authority — 17 checks, including the exact documented
 * command. But it needs Docker and a built image, so it does not run on every
 * change.
 *
 * This runs on every change and pins the SHAPE that made the fix work, so the
 * resolver cannot quietly revert to a bare `require` between smoke runs. It is
 * a guard on the guard, not a substitute for it.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIAGNOSTIC = resolve(API_ROOT, "scripts/proovra-diagnostic.cjs");
const SUMMARY = resolve(API_ROOT, "scripts/proovra-diagnostic-summary.cjs");
const SMOKE = resolve(API_ROOT, "scripts/diagnostic-container-smoke.mjs");
const RUNBOOK = resolve(
  API_ROOT,
  "../../docs/runbooks/production-diagnostic-handoff.md",
);

const SRC = readFileSync(DIAGNOSTIC, "utf8");
/** Comments stripped. The header discusses the very calls it forbids. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the diagnostic resolves its runtime explicitly", () => {
  it("never bare-requires the Prisma runtime at any depth", () => {
    // This is the exact line that produced the /tmp failure.
    for (const spec of ["@prisma/client", "@prisma/adapter-pg", "pg"]) {
      expect(
        CODE,
        `a bare require("${spec}") resolves from THIS FILE's directory, which ` +
          `is /tmp when the runbook's own instructions are followed`,
      ).not.toMatch(new RegExp(`(?<!req)require\\(["']${spec.replace("/", "\\/")}["']\\)`));
    }
  });

  it("uses createRequire against explicit bases", () => {
    expect(CODE).toMatch(/createRequire/);
    expect(CODE).toMatch(/loadRuntimeDeps/);
  });

  it("tries the script's own directory AND the working directory", () => {
    // Two honest bases: in-tree placement, and /tmp placement under the
    // image's WORKDIR. Losing either re-opens one half of the bug.
    expect(CODE).toMatch(/bases\.push\(__filename\)/);
    expect(CODE).toMatch(/process\.cwd\(\)/);
  });

  it("accepts an explicit --require-base override", () => {
    // The escape hatch for a read-only rootfs, where /tmp is the only
    // writable path and the operator may also have moved cwd.
    expect(CODE).toMatch(/REQUIRE_BASE/);
    expect(CODE).toMatch(/arg\("require-base"\)/);
  });

  it("falls back to conventional roots, but only after the honest bases", () => {
    const cwdAt = CODE.indexOf("process.cwd()");
    const rootsAt = CODE.indexOf("CONVENTIONAL_ROOTS");
    const loopAt = CODE.indexOf("for (const root of CONVENTIONAL_ROOTS)");
    expect(cwdAt).toBeGreaterThan(0);
    expect(rootsAt).toBeGreaterThan(0);
    expect(
      loopAt,
      "the conventional roots must be appended AFTER cwd, or a stale root " +
        "would win over the operator's actual environment",
    ).toBeGreaterThan(cwdAt);
  });

  it("the fallback can be switched off, so its absence is testable", () => {
    // A guard nobody can trigger is a guard nobody has tested.
    expect(CODE).toMatch(/PROOVRA_DIAGNOSTIC_NO_FALLBACK/);
  });

  it("reads no NODE_PATH", () => {
    expect(
      CODE,
      "depending on NODE_PATH would make the script work on one host and not " +
        "another for reasons invisible in the command",
    ).not.toMatch(/NODE_PATH/);
  });

  it("reports which base won", () => {
    // When this breaks again, the operator's transcript should say where it
    // looked rather than only that it worked.
    expect(CODE).toMatch(/runtime resolved from/);
  });

  it("names every base it tried when it cannot resolve", () => {
    expect(CODE).toMatch(/tried: /);
    expect(CODE).toMatch(/--require-base/);
  });
});

describe("errors stay on one line", () => {
  it("boundedError collapses whitespace before truncating", () => {
    // A Prisma validation error is a twenty-line pretty-printed query. 300
    // characters of it across twenty lines turns the safe summary — read on a
    // shared screen mid-incident — into a wall, and reproduces the query shape
    // verbatim in a document that gets passed around.
    expect(CODE).toMatch(/\.replace\(\/\\s\+\/g, " "\)/);
    expect(CODE).toMatch(/redacted-dsn/);
  });

  it("the summary reader collapses again on the way out", () => {
    // It renders a file it did not write — an older diagnostic, or one whose
    // bounding was weaker.
    const summary = readFileSync(SUMMARY, "utf8");
    expect(summary).toMatch(/replace\(\/\\s\+\/g, " "\)/);
  });
});

describe("the container smoke exists and covers the documented command", () => {
  const smoke = readFileSync(SMOKE, "utf8");

  it("runs the exact /tmp command the runbook prints", () => {
    expect(smoke).toMatch(/\/tmp\/proovra-diagnostic\.cjs/);
    expect(smoke).toMatch(/Cannot find module '@prisma\\\/client'/);
  });

  it("covers every property the handoff claims", () => {
    for (const [claim, pattern] of [
      ["no NODE_PATH in the image", /sets no NODE_PATH/],
      ["no repository checkout", /no repository checkout/],
      ["in-tree placement", /inside the application tree/],
      ["stray -w", /stray -w/],
      ["loud failure", /fails LOUDLY/],
      ["require-base rescue", /--require-base rescues/],
      ["valid JSON", /stdout is valid JSON/],
      ["failed section is not zero", /never as zero/],
      ["source hash attestation", /reports its own source hash/],
      ["summary from stdin", /summary reader runs from stdin/],
      ["truncation refusal", /refuses a truncated capture/],
      ["wrong database refusal", /REFUSES a wrong --expect-database/],
      ["missing database refusal", /refuses a missing --expect-database/],
      ["read-only", /contains no write of any kind/],
    ] as const) {
      expect(smoke, `the smoke does not cover: ${claim}`).toMatch(pattern);
    }
  });

  it("asserts the child actually ran before asserting what it said", () => {
    // spawnSync blocks the event loop, so its timeout cannot fire while the
    // child runs — a spawn failure would otherwise read as an empty success.
    expect(smoke).toMatch(/did not run/);
    expect(smoke).toMatch(/produced no exit code/);
  });
});

describe("the runbook matches what was proven", () => {
  const md = readFileSync(RUNBOOK, "utf8");

  /**
   * Only the runnable blocks.
   *
   * The prose deliberately NAMES the commands it forbids ("do not `git pull`")
   * and quotes the error it used to produce. A check that cannot tell an
   * instruction from a warning forbids writing the warning down — which is the
   * part that stops the next operator re-deriving the bug.
   */
  const RUNNABLE = [...md.matchAll(/```bash\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .join("\n");

  it("records the failure it used to produce, and why", () => {
    // It shows the /tmp invocation again — it works now — so it must also
    // record that it did not, or the next person to move the script will
    // rediscover this the hard way.
    expect(md).toMatch(/Cannot find module '@prisma\/client'/);
    expect(md).toMatch(/not from the working directory/i);
    expect(md).toMatch(/--require-base/);
  });

  it("offers extraction from the server's own checkout", () => {
    // A public GitHub Raw URL is a dependency on network egress from a
    // production host and on the repository staying reachable.
    expect(RUNNABLE).toMatch(/git show [0-9a-f]{40}:services\/api\/scripts\//);
    expect(RUNNABLE).toMatch(/git fetch origin/);
  });

  it("pins one commit, and the same one everywhere", () => {
    const pinned = [...md.matchAll(/\b([0-9a-f]{40})\b/g)].map((m) => m[1]);
    expect(pinned.length, "no commit is pinned").toBeGreaterThan(0);
    expect(
      new Set(pinned).size,
      `the runbook pins more than one commit: ${[...new Set(pinned)].join(", ")}`,
    ).toBe(1);
  });

  it("never RUNS a command that disturbs the server checkout", () => {
    for (const forbidden of [
      /git checkout/,
      /git reset/,
      /git pull/,
      /git merge/,
      /git switch/,
    ]) {
      expect(
        RUNNABLE,
        `a runnable block contains ${forbidden} — extracting two files must ` +
          `not disturb what the server is running`,
      ).not.toMatch(forbidden);
    }
  });

  it("still warns against those commands in prose", () => {
    // The inverse of the check above. Removing the warning would pass that
    // one and leave the operator free to do the dangerous thing.
    expect(md).toMatch(/Do not.{0,40}`git checkout`/s);
  });

  it("adapts to this deployment's application directory", () => {
    expect(RUNNABLE).toMatch(/cd \/opt\/proovra\/app/);
  });

  it("asks for the summary only, never the raw document", () => {
    expect(md).toMatch(/Share only the output of that last command/i);
    expect(md).toMatch(/only output that should leave the host/i);
  });

  it("states the shred limit rather than implying more than it delivers", () => {
    expect(md).toMatch(/copy-on-write|wear levelling/i);
  });
});
