/**
 * UC-1 BROWSER ACCEPTANCE — ONE TERMINAL RESULT PER BROWSER.
 *
 * The scheduled run failed twice with "no Playwright result for chromium /
 * edge". Neither was a UC-1 product failure: on 2026-10-03 `pnpm install`
 * failed and on 2026-10-05 the Docker probe leaked its exit code out of the
 * "Infrastructure mode" step, so no browser ever ran. The gate could only say
 * that a file was missing, which reads like a browser failure and names
 * neither the phase nor the cause.
 *
 * Now every requested browser ends with exactly one terminal result at a
 * repository-root-relative path that is the same locally and on GitHub
 * Actions:
 *
 *   apps/extension/e2e/results/<browser>.json
 *     { schema, browser, status: PASSED | FAILED | NOT_EXECUTED,
 *       failedPhase, exitCode, errorSummary, stats }
 *
 * Writers: the harness (scripts/uc1-acceptance-windows.mjs) when it runs, and
 * the workflow's `finalize` step for every phase the harness never reached.
 * Playwright's own JSON report is RAW input only — it lives in
 * `.playwright-raw/`, is never uploaded, and nothing from it leaves except
 * counts and a sanitized, bounded error summary.
 *
 * PASSED is never derived from an absence: it needs a report that executed at
 * least one test with zero unexpected results AND a recorded Playwright exit
 * code of 0 for that browser.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RESULT_SCHEMA = "proovra.uc1.browser-result.v1";
export const BROWSERS = Object.freeze(["chromium", "edge"]);
export const STATUSES = Object.freeze(["PASSED", "FAILED", "NOT_EXECUTED"]);

/** Repository-root-relative — the ONE spelling used locally and in CI. */
export const RESULTS_DIR_REL = "apps/extension/e2e/results";
export const RAW_DIR_REL = "apps/extension/e2e/.playwright-raw";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..", "..");
export const RESULTS_DIR = resolve(REPO_ROOT, RESULTS_DIR_REL);
export const RAW_DIR = resolve(REPO_ROOT, RAW_DIR_REL);

export const resultPathRel = (browser) => `${RESULTS_DIR_REL}/${browser}.json`;
export const resultPath = (browser) => join(RESULTS_DIR, `${browser}.json`);
export const rawReportPath = (browser) => join(RAW_DIR, `${browser}.json`);
export const harnessExitPath = () => join(RAW_DIR, "harness-exit.json");

/**
 * Workflow phases, in execution order. A failure in any phase before
 * `acceptance` means no browser ran; the first failed one is THE failed phase.
 */
export const PHASES = Object.freeze(["install", "browsers", "infra-probe", "infra-native", "acceptance"]);

const SUMMARY_MAX = 600;

/**
 * Bounded and free of anything that could be a credential: URL query strings
 * (presigned S3 parameters live there), URL userinfo (connection-string
 * passwords), bearer/JWT tokens, key=value secrets, and email addresses.
 */
export function sanitizeSummary(text) {
  if (text == null) return null;
  let s = String(text)
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, "$1[redacted]@")
    .replace(/(\bhttps?:\/\/[^\s?#"'<>]+)\?[^\s"'<>]*/gi, "$1?[redacted]")
    .replace(/\bX-Amz-[A-Za-z-]+=[^\s&"'<>]*/g, "X-Amz-[redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g, "[redacted-jwt]")
    .replace(
      /\b([A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|signature|credential)[A-Za-z0-9_]*)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;&"']+)/gi,
      "$1=[redacted]",
    )
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (s.length > SUMMARY_MAX) s = `${s.slice(0, SUMMARY_MAX - 1)}…`;
  return s || null;
}

/** Counts from a Playwright JSON report; null when it is not one. */
export function reportStats(report) {
  const st = report && typeof report === "object" ? report.stats : null;
  if (!st || typeof st !== "object") return null;
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const stats = {
    expected: n(st.expected),
    unexpected: n(st.unexpected),
    flaky: n(st.flaky),
    skipped: n(st.skipped),
  };
  stats.executed = stats.expected + stats.unexpected + stats.flaky;
  return stats;
}

/** First failing test's title + message, from the report — bounded, sanitized. */
function firstFailure(report) {
  const walk = (suite, trail) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        for (const r of t.results ?? []) {
          if (r.status === "failed" || r.status === "timedOut" || r.status === "interrupted") {
            const msg = r.error?.message ?? r.errors?.[0]?.message ?? r.status;
            return `${[...trail, spec.title].join(" › ")}: ${msg}`;
          }
        }
      }
    }
    for (const child of suite.suites ?? []) {
      const hit = walk(child, [...trail, child.title].filter(Boolean));
      if (hit) return hit;
    }
    return null;
  };
  for (const s of report?.suites ?? []) {
    const hit = walk(s, [s.title].filter(Boolean));
    if (hit) return hit;
  }
  const top = report?.errors?.[0]?.message;
  return top ?? null;
}

function result(browser, status, { failedPhase = null, exitCode = null, errorSummary = null, stats = null } = {}) {
  if (!STATUSES.includes(status)) throw new Error(`unknown status ${status}`);
  return {
    schema: RESULT_SCHEMA,
    browser,
    status,
    failedPhase: status === "PASSED" ? null : failedPhase,
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
    errorSummary: status === "PASSED" ? null : sanitizeSummary(errorSummary),
    stats,
  };
}

/**
 * The verdict of a browser the harness actually ran. `run` is that browser's
 * Playwright invocation: { exitCode, error } (exitCode null when killed).
 */
export function classifyExecutedBrowser(browser, { report, run }) {
  const stats = reportStats(report);
  const exitCode = run && Number.isInteger(run.exitCode) ? run.exitCode : null;
  if (!stats) {
    return result(browser, "FAILED", {
      failedPhase: "playwright",
      exitCode,
      errorSummary: run?.error ?? "Playwright wrote no JSON report for this browser",
    });
  }
  if (stats.executed <= 0) {
    return result(browser, "FAILED", {
      failedPhase: "playwright",
      exitCode,
      stats,
      errorSummary: "Playwright executed ZERO tests for this browser",
    });
  }
  if (stats.unexpected > 0 || exitCode !== 0) {
    return result(browser, "FAILED", {
      failedPhase: "playwright",
      exitCode,
      stats,
      errorSummary:
        firstFailure(report) ??
        run?.error ??
        (exitCode === null ? "Playwright did not exit (killed at the project bound)" : `Playwright exited ${exitCode}`),
    });
  }
  return result(browser, "PASSED", { exitCode, stats });
}

/** A browser the harness never reached because the harness itself failed first. */
export function classifyHarnessFailure(browser, { exitCode = null, error }) {
  return result(browser, "FAILED", { failedPhase: "acceptance", exitCode, errorSummary: error });
}

/**
 * The workflow's view, for a browser with no harness-written result.
 * `phases` maps PHASES → a step outcome (success | failure | cancelled | skipped).
 */
export function classifyFromPhases(browser, { phases, harnessExitCode = null, harnessLogTail = null }) {
  for (const phase of PHASES) {
    const outcome = phases[phase];
    if (phase === "acceptance") break;
    if (outcome === "failure" || outcome === "cancelled") {
      return result(browser, "FAILED", {
        failedPhase: phase,
        errorSummary: `workflow phase "${phase}" ${outcome === "failure" ? "failed" : "was cancelled"} before ${browser} ran; the step log holds the cause`,
      });
    }
  }
  const acceptance = phases.acceptance;
  if (acceptance === "failure" || acceptance === "cancelled") {
    return result(browser, "FAILED", {
      failedPhase: "acceptance",
      exitCode: harnessExitCode,
      errorSummary:
        harnessLogTail ??
        `the acceptance harness ${acceptance === "failure" ? "failed" : "was cancelled"} before writing a result for ${browser}`,
    });
  }
  if (acceptance === "success") {
    // A harness that exited 0 must have written this file. Never upgrade that
    // to PASSED, and never quietly downgrade it to "did not run".
    return result(browser, "FAILED", {
      failedPhase: "acceptance",
      exitCode: harnessExitCode,
      errorSummary: `the acceptance step succeeded but wrote no result for ${browser}`,
    });
  }
  return result(browser, "NOT_EXECUTED", {
    failedPhase: "acceptance",
    errorSummary: `the acceptance step did not run (${acceptance ?? "no outcome recorded"})`,
  });
}

/** A parsed result file is only trusted if it has exactly this shape. */
export function isTerminalResult(r, browser) {
  return (
    !!r &&
    r.schema === RESULT_SCHEMA &&
    r.browser === browser &&
    STATUSES.includes(r.status) &&
    (r.status !== "PASSED" || (r.stats && r.stats.executed > 0 && r.stats.unexpected === 0 && r.exitCode === 0))
  );
}

/**
 * Fail closed: every requested browser must be PASSED. MISSING (no file or an
 * untrusted shape), FAILED and NOT_EXECUTED are reported distinctly.
 */
export function aggregate(browsers, readResult) {
  const rows = browsers.map((browser) => {
    let r = null;
    try {
      r = readResult(browser);
    } catch {
      r = null;
    }
    if (!isTerminalResult(r, browser)) return { browser, state: "MISSING", result: null };
    return { browser, state: r.status, result: r };
  });
  return { ok: rows.length > 0 && rows.every((row) => row.state === "PASSED"), rows };
}

// ----------------------------------------------------------------------------
// file I/O
// ----------------------------------------------------------------------------
export function writeResult(r) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(resultPath(r.browser), `${JSON.stringify(r, null, 2)}\n`);
}

export function readJson(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

/** Results and raw dirs exist and are EMPTY before anything runs. */
export function prepareResultDirs() {
  for (const dir of [RESULTS_DIR, RAW_DIR]) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
}

/** Called by the harness once per browser it ran. */
export function recordBrowserRun(browser, run) {
  const exits = readJson(harnessExitPath()) ?? {};
  exits[browser] = { exitCode: Number.isInteger(run.exitCode) ? run.exitCode : null, error: run.error ?? null };
  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(harnessExitPath(), `${JSON.stringify(exits, null, 2)}\n`);
  let report = null;
  try {
    report = readJson(rawReportPath(browser));
  } catch {
    report = null;
  }
  const r = classifyExecutedBrowser(browser, { report, run: exits[browser] });
  writeResult(r);
  return r;
}

/** Workflow finalize: fill in every browser the harness never wrote. */
export function finalize({ browsers, phases, harnessExitCode = null, harnessLogTail = null }) {
  const out = [];
  const setupFailed = PHASES.slice(0, PHASES.indexOf("acceptance")).some(
    (p) => phases[p] === "failure" || phases[p] === "cancelled",
  );
  for (const browser of browsers) {
    let existing = null;
    try {
      existing = readJson(resultPath(browser));
    } catch {
      existing = null;
    }
    const r =
      !setupFailed && isTerminalResult(existing, browser)
        ? { ...existing, errorSummary: sanitizeSummary(existing.errorSummary) }
        : classifyFromPhases(browser, { phases, harnessExitCode, harnessLogTail });
    writeResult(r);
    out.push(r);
  }
  return out;
}

// ----------------------------------------------------------------------------
// CLI:  node apps/extension/e2e/uc1-results.mjs prepare
//       node apps/extension/e2e/uc1-results.mjs finalize --browsers=chromium,edge \
//            --phase=install=success ... [--harness-exit-code=N] [--harness-log=FILE]
//       node apps/extension/e2e/uc1-results.mjs gate --browsers=chromium,edge
// ----------------------------------------------------------------------------
function parseArgs(argv) {
  const phases = {};
  const opts = { browsers: [...BROWSERS], phases };
  for (const a of argv) {
    const m = /^--([a-z-]+)=(.*)$/.exec(a);
    if (!m) continue;
    const [, k, v] = m;
    if (k === "browsers") opts.browsers = v.split(",").map((s) => s.trim()).filter(Boolean);
    else if (k === "phase") {
      const [name, outcome] = v.split("=");
      if (!PHASES.includes(name)) throw new Error(`unknown phase ${name}`);
      phases[name] = outcome || "skipped";
    } else if (k === "harness-exit-code") opts.harnessExitCode = /^-?\d+$/.test(v) ? Number(v) : null;
    else if (k === "harness-log") opts.harnessLog = v;
  }
  for (const b of opts.browsers) if (!BROWSERS.includes(b)) throw new Error(`unknown browser ${b}`);
  return opts;
}

function logTail(file) {
  if (!file || !existsSync(file)) return null;
  const lines = readFileSync(file, "utf8")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .filter(Boolean);
  const errorish = lines.filter((l) => /fatal|error|fail|refus/i.test(l)).slice(-4);
  return (errorish.length ? errorish : lines.slice(-4)).join(" | ");
}

function cli(argv) {
  const [cmd, ...rest] = argv;
  const opts = parseArgs(rest);
  if (cmd === "prepare") {
    prepareResultDirs();
    console.log(`uc1-results: prepared ${RESULTS_DIR_REL} and ${RAW_DIR_REL}`);
    return 0;
  }
  if (cmd === "finalize") {
    const rows = finalize({
      browsers: opts.browsers,
      phases: opts.phases,
      harnessExitCode: opts.harnessExitCode ?? null,
      harnessLogTail: logTail(opts.harnessLog),
    });
    for (const r of rows) {
      console.log(`uc1-results: ${resultPathRel(r.browser)} → ${r.status}${r.failedPhase ? ` (phase ${r.failedPhase})` : ""}`);
    }
    return 0;
  }
  if (cmd === "gate") {
    const { ok, rows } = aggregate(opts.browsers, (b) => readJson(resultPath(b)));
    for (const row of rows) {
      const r = row.result;
      const line =
        row.state === "MISSING"
          ? `${row.browser}: MISSING — no trusted terminal result at ${resultPathRel(row.browser)}`
          : `${row.browser}: ${row.state}${r.failedPhase ? ` — phase ${r.failedPhase}` : ""}${
              r.exitCode !== null ? `, exit ${r.exitCode}` : ""
            }${r.stats ? `, executed ${r.stats.executed}, unexpected ${r.stats.unexpected}` : ""}${
              r.errorSummary ? ` — ${r.errorSummary}` : ""
            }`;
      console.log(row.state === "PASSED" ? line : `::error title=UC-1 ${row.browser} ${row.state}::${line}`);
    }
    return ok ? 0 : 1;
  }
  console.error("usage: uc1-results.mjs prepare | finalize | gate [--browsers=chromium,edge]");
  return 2;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(cli(process.argv.slice(2)));
