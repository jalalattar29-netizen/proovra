/**
 * UC-1 browser acceptance — terminal results and the workflow that writes them.
 *
 * The scheduled run failed twice with "no Playwright result for chromium /
 * edge" while no browser had run at all (2026-10-03: `pnpm install` failed;
 * 2026-10-05: the Docker probe leaked `docker version`'s exit code out of the
 * "Infrastructure mode" step). These pin the contract that replaced the bare
 * file-existence gate: one terminal result per browser, honest status, the
 * failed phase named, the same path locally and in CI, nothing secret inside.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BROWSERS,
  RAW_DIR_REL,
  RESULTS_DIR_REL,
  aggregate,
  classifyExecutedBrowser,
  classifyFromPhases,
  resultPathRel,
  sanitizeSummary,
} from "../e2e/uc1-results.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..", "..", "..");
const MODULE = resolve(here, "..", "e2e", "uc1-results.mjs");
const WORKFLOW = readFileSync(resolve(REPO, ".github/workflows/uc1-browser-acceptance.yml"), "utf8");

/** The `steps:` text of one job (jobs are the two-space-indented keys). */
function jobText(name) {
  const start = WORKFLOW.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `job ${name} not found`);
  const rest = WORKFLOW.slice(start + 1);
  const next = rest.slice(3).search(/\n {2}[a-z0-9-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 3);
}

/** One step's text, by its `name:`. */
function stepText(job, name) {
  const at = job.indexOf(`- name: ${name}\n`);
  assert.ok(at >= 0, `step "${name}" not found`);
  const rest = job.slice(at + 1);
  const next = rest.search(/\n {6}- (name|uses):/);
  return next < 0 ? rest : rest.slice(0, next);
}

/** A temp copy of the module at the SAME repo-relative position, so its CLI runs for real. */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "uc1-results-"));
  const dest = join(root, "apps", "extension", "e2e");
  mkdirSync(dest, { recursive: true });
  copyFileSync(MODULE, join(dest, "uc1-results.mjs"));
  const cli = (...args) =>
    spawnSync(process.execPath, [join(dest, "uc1-results.mjs"), ...args], { encoding: "utf8", cwd: root });
  const read = (browser) => {
    const f = join(root, ...resultPathRel(browser).split("/"));
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
  };
  const writeRaw = (browser, report) => {
    mkdirSync(join(root, ...RAW_DIR_REL.split("/")), { recursive: true });
    writeFileSync(join(root, ...RAW_DIR_REL.split("/"), `${browser}.json`), JSON.stringify(report));
  };
  const recordRun = (browser, run) => {
    const code = `import(${JSON.stringify(
      `file://${join(dest, "uc1-results.mjs").replace(/\\/g, "/")}`,
    )}).then((m) => m.recordBrowserRun(${JSON.stringify(browser)}, ${JSON.stringify(run)}))`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  return { root, cli, read, writeRaw, recordRun, done: () => rmSync(root, { recursive: true, force: true }) };
}

const passingReport = (n = 4) => ({ stats: { expected: n, unexpected: 0, flaky: 0, skipped: 0 }, suites: [] });

const SETUP_FAILED_INSTALL = [
  "--phase=install=failure",
  "--phase=browsers=skipped",
  "--phase=infra-probe=skipped",
  "--phase=infra-native=skipped",
  "--phase=acceptance=skipped",
  "--harness-exit-code=",
];

test("1. the scheduled run includes Chromium AND Edge, unconditionally", () => {
  assert.match(WORKFLOW, /\n {2}schedule:\n {4}- cron: "17 3 \* \* \*"/);
  const win = jobText("windows-acceptance");
  // No job-level condition that could drop the job on a schedule.
  assert.doesNotMatch(win.split("steps:")[0], /\n {4}if:/);
  const acceptance = stepText(win, "UC-1 acceptance — Chrome + Edge");
  // Both infrastructure branches request both browsers.
  const harnessCalls = acceptance.match(/uc1-acceptance-windows\.mjs[^\n]*/g) ?? [];
  assert.equal(harnessCalls.length, 2);
  for (const call of harnessCalls) assert.match(call, /--browsers=chromium,edge\b/);
  // The acceptance step itself has no `if:` — it runs whenever setup succeeded.
  assert.doesNotMatch(acceptance, /\n {8}if:/);
  assert.match(stepText(win, "Finalize UC-1 browser results"), /finalize --browsers=chromium,edge\b/);
  assert.match(stepText(win, "UC-1 acceptance gate (Chrome + Edge)"), /gate --browsers=chromium,edge\b/);
});

test("2. workflow_dispatch takes the identical path — nothing branches on the event", () => {
  assert.match(WORKFLOW, /\non:\n {2}workflow_dispatch:\n/);
  assert.doesNotMatch(WORKFLOW, /github\.event_name|github\.event\.schedule|github\.event\.inputs/);
  for (const job of ["windows-acceptance", "linux-extension-e2e"]) {
    assert.doesNotMatch(jobText(job).split("steps:")[0], /\n {4}if:/, `${job} has a job-level condition`);
  }
});

test("the infrastructure probe can no longer fail on an unreachable Docker daemon", () => {
  const probe = stepText(jobText("windows-acceptance"), "Infrastructure mode");
  assert.match(probe, /\$probeExit = \$LASTEXITCODE/);
  // The explicit `exit 0` is what keeps GitHub's `exit $LASTEXITCODE` epilogue
  // from failing the step after it already chose native mode.
  assert.match(probe, /\n {10}exit 0\n?$/);
});

test("finalize → upload → gate: results are persisted and uploaded before the gate can fail", () => {
  for (const [job, gate] of [
    ["windows-acceptance", "UC-1 acceptance gate (Chrome + Edge)"],
    ["linux-extension-e2e", "UC-1 e2e gate (Chromium)"],
  ]) {
    const text = jobText(job);
    const prep = text.indexOf("- name: Prepare UC-1 result directories");
    const install = text.indexOf("- name: Install\n");
    const fin = text.indexOf("- name: Finalize UC-1 browser results");
    const up = text.indexOf("- name: Upload UC-1 browser results");
    const g = text.indexOf(`- name: ${gate}`);
    assert.ok(prep >= 0 && prep < install, `${job}: results dir must exist before anything can fail`);
    assert.ok(fin > 0 && fin < up && up < g, `${job}: finalize → upload → gate`);
    for (const name of ["Finalize UC-1 browser results", "Upload UC-1 browser results", gate]) {
      assert.match(stepText(text, name), /\n {8}if: always\(\)/, `${job}: ${name} must run whatever failed`);
    }
    assert.match(stepText(text, "Upload UC-1 browser results"), /if-no-files-found: error/);
  }
});

test("3. a successful run yields BOTH terminal result files, PASSED", () => {
  const sb = sandbox();
  try {
    assert.equal(sb.cli("prepare").status, 0);
    for (const b of BROWSERS) {
      sb.writeRaw(b, passingReport());
      sb.recordRun(b, { exitCode: 0, error: null });
    }
    const fin = sb.cli(
      "finalize",
      "--browsers=chromium,edge",
      "--phase=install=success",
      "--phase=browsers=success",
      "--phase=infra-probe=success",
      "--phase=infra-native=success",
      "--phase=acceptance=success",
      "--harness-exit-code=0",
    );
    assert.equal(fin.status, 0, fin.stderr);
    for (const b of BROWSERS) {
      const r = sb.read(b);
      assert.equal(r.status, "PASSED");
      assert.equal(r.exitCode, 0);
      assert.equal(r.stats.executed, 4);
      assert.equal(r.failedPhase, null);
    }
    assert.equal(sb.cli("gate", "--browsers=chromium,edge").status, 0);
  } finally {
    sb.done();
  }
});

test("4. a setup failure yields an explicit FAILED result naming the phase — for every browser", () => {
  const sb = sandbox();
  try {
    sb.cli("prepare");
    assert.equal(sb.cli("finalize", "--browsers=chromium,edge", ...SETUP_FAILED_INSTALL).status, 0);
    for (const b of BROWSERS) {
      const r = sb.read(b);
      assert.equal(r.status, "FAILED");
      assert.equal(r.failedPhase, "install");
      assert.equal(r.exitCode, null);
      assert.match(r.errorSummary, /"install" failed before/);
    }
    // The 2026-10-05 shape: the probe failed, everything after it skipped.
    const probe = classifyFromPhases("edge", {
      phases: { install: "success", browsers: "success", "infra-probe": "failure", "infra-native": "skipped", acceptance: "skipped" },
    });
    assert.equal(probe.status, "FAILED");
    assert.equal(probe.failedPhase, "infra-probe");
    const gate = sb.cli("gate", "--browsers=chromium,edge");
    assert.equal(gate.status, 1);
    assert.match(gate.stdout, /chromium: FAILED — phase install/);
  } finally {
    sb.done();
  }
});

test("5. a browser that never ran (no failure before it) is NOT_EXECUTED, never PASSED", () => {
  const r = classifyFromPhases("edge", {
    phases: { install: "success", browsers: "success", "infra-probe": "success", "infra-native": "skipped", acceptance: "skipped" },
  });
  assert.equal(r.status, "NOT_EXECUTED");
  assert.equal(r.failedPhase, "acceptance");
  // A step that reported success but wrote nothing is not upgraded to PASSED
  // and not quietly downgraded to "did not run".
  const silent = classifyFromPhases("edge", {
    phases: { install: "success", browsers: "success", "infra-probe": "success", acceptance: "success" },
    harnessExitCode: 0,
  });
  assert.equal(silent.status, "FAILED");
  // The harness exited non-zero before reaching the browser.
  const died = classifyFromPhases("chromium", {
    phases: { install: "success", browsers: "success", "infra-probe": "success", acceptance: "failure" },
    harnessExitCode: 1,
    harnessLogTail: "UC-1 FATAL: migrations failed",
  });
  assert.equal(died.status, "FAILED");
  assert.equal(died.failedPhase, "acceptance");
  assert.equal(died.exitCode, 1);
  assert.match(died.errorSummary, /migrations failed/);
});

test("PASSED requires executed > 0, zero unexpected AND a Playwright exit of 0", () => {
  assert.equal(classifyExecutedBrowser("chromium", { report: passingReport(), run: { exitCode: 0 } }).status, "PASSED");
  const zero = classifyExecutedBrowser("chromium", { report: passingReport(0), run: { exitCode: 0 } });
  assert.equal(zero.status, "FAILED");
  assert.match(zero.errorSummary, /ZERO tests/);
  assert.equal(classifyExecutedBrowser("chromium", { report: null, run: { exitCode: 0 } }).status, "FAILED");
  assert.equal(classifyExecutedBrowser("chromium", { report: passingReport(), run: { exitCode: 1 } }).status, "FAILED");
  assert.equal(classifyExecutedBrowser("chromium", { report: passingReport(), run: { exitCode: null } }).status, "FAILED");
  const failing = classifyExecutedBrowser("edge", {
    report: {
      stats: { expected: 3, unexpected: 1, flaky: 0, skipped: 0 },
      suites: [
        {
          title: "direct-web-capture.spec.ts",
          specs: [{ title: "seals a capture", tests: [{ results: [{ status: "failed", error: { message: "expected SEALED" } }] }] }],
        },
      ],
    },
    run: { exitCode: 1 },
  });
  assert.equal(failing.status, "FAILED");
  assert.equal(failing.failedPhase, "playwright");
  assert.match(failing.errorSummary, /seals a capture: expected SEALED/);
});

test("6. aggregation distinguishes MISSING, FAILED, NOT_EXECUTED and PASSED — and fails closed", () => {
  const passed = classifyExecutedBrowser("chromium", { report: passingReport(), run: { exitCode: 0 } });
  const failed = classifyFromPhases("edge", { phases: { install: "failure" } });
  const notRun = classifyFromPhases("edge", { phases: { acceptance: "skipped" } });

  const both = aggregate(["chromium", "edge"], (b) => (b === "chromium" ? passed : failed));
  assert.equal(both.ok, false);
  assert.deepEqual(both.rows.map((r) => r.state), ["PASSED", "FAILED"]);

  assert.deepEqual(aggregate(["chromium", "edge"], (b) => (b === "chromium" ? passed : notRun)).rows.map((r) => r.state), [
    "PASSED",
    "NOT_EXECUTED",
  ]);
  const missing = aggregate(["chromium", "edge"], (b) => (b === "chromium" ? passed : null));
  assert.equal(missing.ok, false);
  assert.equal(missing.rows[1].state, "MISSING");
  // A forged PASSED (no executed tests) is not trusted — it counts as MISSING.
  const forged = { ...passed, browser: "edge", stats: { ...passed.stats, executed: 0 } };
  assert.equal(aggregate(["edge"], () => forged).rows[0].state, "MISSING");
  // A raw Playwright report sitting at the result path is not a terminal result.
  assert.equal(aggregate(["edge"], () => passingReport()).rows[0].state, "MISSING");
  assert.equal(aggregate([], () => passed).ok, false);
  assert.equal(aggregate(["chromium", "edge"], (b) => ({ ...passed, browser: b })).ok, true);
});

test("7. result paths are the SAME repository-root-relative paths locally and in GitHub Actions", () => {
  assert.equal(RESULTS_DIR_REL, "apps/extension/e2e/results");
  assert.equal(resultPathRel("chromium"), "apps/extension/e2e/results/chromium.json");
  assert.equal(resultPathRel("edge"), "apps/extension/e2e/results/edge.json");
  // The workflow uploads exactly those paths.
  assert.match(WORKFLOW, /\n {12}apps\/extension\/e2e\/results\/chromium\.json\n {12}apps\/extension\/e2e\/results\/edge\.json\n/);
  // Playwright writes its raw report through the module, with no CI-only branch.
  const config = readFileSync(resolve(REPO, "apps/extension/e2e/playwright.config.ts"), "utf8");
  assert.match(config, /import \{ rawReportPath \} from "\.\/uc1-results\.mjs"/);
  assert.match(config, /\["json", \{ outputFile: rawReportPath\(/);
  assert.doesNotMatch(config, /outputFile: `results\//);
  // …and the harness records each browser through the same module.
  const harness = readFileSync(resolve(REPO, "scripts/uc1-acceptance-windows.mjs"), "utf8");
  assert.match(harness, /from "\.\.\/apps\/extension\/e2e\/uc1-results\.mjs"/);
  assert.match(harness, /recordBrowserRun\(project,/);
  // The raw report directory is never uploaded (comments may name it).
  const code = WORKFLOW.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.doesNotMatch(code, /playwright-raw|apps\/extension\/e2e\/results\/\s*$/m);
});

test("8. no credentials, presigned query parameters or private data reach a result file", () => {
  const secret = [
    "PUT https://uc1-acceptance.s3.amazonaws.com/evidence/abc.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20261005&X-Amz-Signature=deadbeefcafe failed",
    "db postgresql://proovra:uc1_disposable@127.0.0.1:5432/uc1_acceptance_test unreachable",
    "Authorization: Bearer sk_live_abcdefghijklmnop",
    "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.c2lnbmF0dXJlLXZhbHVl",
    "S3_SECRET_KEY=uc1miniolocalsecret api_key: AbCdEf123 password=hunter2",
    "user reem.example@hotmail.com could not sign in",
  ].join("\n");
  const s = sanitizeSummary(secret);
  for (const leaked of [
    "X-Amz-Signature=dead",
    "X-Amz-Credential=AKIA",
    "AKIAEXAMPLE",
    "deadbeefcafe",
    "uc1_disposable",
    "sk_live_abcdefghijklmnop",
    "eyJhbGciOiJIUzI1NiJ9",
    "uc1miniolocalsecret",
    "AbCdEf123",
    "hunter2",
    "reem.example@hotmail.com",
  ]) {
    assert.ok(!s.includes(leaked), `leaked ${leaked}: ${s}`);
  }
  assert.ok(s.length <= 600);
  assert.ok(sanitizeSummary("x".repeat(5000)).length <= 600, "the summary is bounded");

  // End to end: a failing report carrying all of it, through the CLI.
  const sb = sandbox();
  try {
    sb.cli("prepare");
    sb.writeRaw("edge", {
      stats: { expected: 0, unexpected: 1, flaky: 0, skipped: 0 },
      suites: [{ title: "s", specs: [{ title: "t", tests: [{ results: [{ status: "failed", error: { message: secret } }] }] }] }],
    });
    sb.recordRun("edge", { exitCode: 1, error: null });
    const file = readFileSync(join(sb.root, ...resultPathRel("edge").split("/")), "utf8");
    for (const leaked of ["X-Amz-Signature=dead", "uc1_disposable", "sk_live_", "hunter2", "@hotmail.com", "uc1miniolocalsecret"]) {
      assert.ok(!file.includes(leaked), `result file leaked ${leaked}`);
    }
    // Only the terminal shape — never the raw report's suites/config.
    assert.deepEqual(Object.keys(JSON.parse(file)).sort(), [
      "browser",
      "errorSummary",
      "exitCode",
      "failedPhase",
      "schema",
      "stats",
      "status",
    ]);
  } finally {
    sb.done();
  }
});
