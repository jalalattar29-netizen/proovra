#!/usr/bin/env node
/**
 * WHAT DOES EACH ADMIN MUTATION ACTUALLY DO, AND WHAT PROVES IT?
 *
 * =============================================================================
 * WHY THIS IS NOT ANOTHER AUTHORIZATION SCAN
 * =============================================================================
 * The endpoint inventory already establishes that every admin mutation reaches
 * a handler behind a guard. That is worth having and it is not the question
 * here. A mutation can be perfectly authorized and still be broken as a
 * product: the button invisible to the role that needs it, the confirmation
 * describing the wrong blast radius, a success toast fired before the server
 * answered, the list never reloaded so the operator sees stale truth, a
 * failure leaving the row looking changed.
 *
 * So this builds one row per mutation with THIRTEEN columns, and for each one
 * records where the proof lives. Three kinds of evidence, kept distinct
 * because they are not equally strong:
 *
 *   SOURCE    read out of the call site. Strong for structural properties —
 *             a confirm dialog either exists in the code or does not.
 *   API       an executed test in services/api/test. Strong for authorization,
 *             persistence, idempotency, tenancy.
 *   E2E       an executed browser test. The only evidence that the visible
 *             action works, and the only kind the endpoint inventory cannot
 *             produce.
 *
 * A cell with no evidence is reported as a GAP rather than assumed, and the
 * script exits non-zero while any required cell is empty.
 *
 * =============================================================================
 * WHAT SOURCE EVIDENCE CANNOT SETTLE
 * =============================================================================
 * That the confirmation TEXT is accurate. This can see that a dialog is shown
 * and that it names a scope; whether "signs the member out of every device"
 * is true of the endpoint it guards is a question for the API test, and the
 * matrix links the two so a reviewer can check them against each other.
 *
 * Usage:
 *   node apps/web/scripts/admin-mutation-matrix.mjs
 *   node apps/web/scripts/admin-mutation-matrix.mjs --json
 *   node apps/web/scripts/admin-mutation-matrix.mjs --markdown
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(WEB, "../..");
const ADMIN = join(WEB, "app", "(app)", "admin");
const API_TESTS = join(REPO, "services", "api", "test");
const E2E = join(WEB, "e2e", "admin-control-plane");

// ---------------------------------------------------------------------------
// The mutations, from the same inventory the route ledger uses.
// ---------------------------------------------------------------------------

function inventory() {
  const raw = execFileSync(
    process.execPath,
    [join(WEB, "scripts", "admin-inventory.mjs"), "--json"],
    { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(raw).rows;
}

function mutations() {
  const out = [];
  for (const row of inventory()) {
    for (const api of row.api ?? []) {
      // `method` can be a set when one literal is called with several verbs.
      const verbs = String(api.method ?? "")
        .split("+")
        .filter((m) => m && m !== "GET");
      for (const method of verbs) {
        out.push({
          id: `${method} ${api.path}`,
          route: row.route,
          method,
          path: api.path,
          literal: api.literal,
          handlerFile: api.file,
          authority: api.authority ?? [],
        });
      }
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id) || a.route.localeCompare(b.route));
}

// ---------------------------------------------------------------------------
// Reading the call site.
// ---------------------------------------------------------------------------

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const PAGE_SOURCES = walk(ADMIN).map((f) => ({
  file: relative(WEB, f).split(sep).join("/"),
  routeDir: relative(ADMIN, dirname(f)).split(sep).join("/"),
  code: readFileSync(f, "utf8"),
}));

/**
 * The window of code around a call, brace-balanced outward.
 *
 * A fixed slice caught the confirm dialog of the NEXT action along, which
 * would have credited a mutation with a confirmation it does not have.
 */
function callWindow(code, index, levels = 4) {
  /**
   * Balance outward until the window holds the CONTROL, then stop.
   *
   * One level stops at the innermost enclosing brace pair, which for
   * `apiFetch(path, { method: "POST", body })` is the options object itself.
   * The first run showed 47/47 for "request" and 0/47 for "discoverable" —
   * the signature of a window too small to contain the button, not of a
   * console with no buttons in it.
   *
   * Four unconditional levels then overshot in the other direction. On a page
   * with several actions the window grew to most of the file, so a confirm
   * dialog belonging to a DIFFERENT action satisfied this one's check, and
   * `explainsScope`, `confirmation`, `noOptimisticSuccess` and
   * `failureLeavesStateCorrect` all jumped to zero gaps at once. Four
   * different properties reaching a perfect score on a single unrelated
   * change is not a fix, it is an instrument that stopped discriminating.
   *
   * So it expands only until it can see the control that triggers this call,
   * and never further. Evidence stays attached to the action it belongs to.
   */
  const holdsAControl = (text) =>
    /onClick\s*=|<Button|<button/.test(text);

  let lo = index;
  let hi = index;
  for (let level = 0; level < levels; level += 1) {
    if (level > 0 && holdsAControl(code.slice(lo, hi + 1))) break;
    let depth = 0;
    let nextLo = lo;
    for (let i = lo - 1; i >= 0 && lo - i < 40000; i -= 1) {
      if (code[i] === "}") depth += 1;
      else if (code[i] === "{") {
        if (depth === 0) {
          nextLo = i;
          break;
        }
        depth -= 1;
      }
    }
    depth = 0;
    let nextHi = hi;
    for (let i = hi + 1; i < code.length && i - hi < 40000; i += 1) {
      if (code[i] === "{") depth += 1;
      else if (code[i] === "}") {
        if (depth === 0) {
          nextHi = i;
          break;
        }
        depth -= 1;
      }
    }
    if (nextLo === lo && nextHi === hi) break;
    lo = nextLo;
    hi = nextHi;
  }
  return code.slice(lo, hi + 1);
}

/**
 * Every place a page issues this mutation.
 *
 * Matched on the literal the inventory recorded, so a template path and its
 * interpolations line up with what the scanner already resolved.
 */
function callSites(mutation) {
  /**
   * THE NEEDLE HAS TO BE DISTINCTIVE, AND IT HAS TO BE CHECKED.
   *
   * An earlier version split the literal on a separator and took the first
   * piece. Two NUL bytes from a shell heredoc landed inside the two string
   * literals involved, turning `" "` into `""` — so `split("")` returned
   * CHARACTERS and the needle became `"/"`. `indexOf("/")` matches on nearly
   * every line, so every mutation "found" hundreds of call sites across the
   * whole admin tree, the window became the entire tree, and every
   * source-derived column reported 47/47 proven.
   *
   * Four properties reaching a perfect score at once was the tell. The fix is
   * not just correct splitting: the needle is now built from the literal's
   * longest static run, and anything too short to be distinctive is REJECTED
   * rather than searched for. A matrix that cannot find a call site should say
   * so, not match everything.
   */
  const statics = mutation.literal
    .split(/\$\{[^}]*\}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const needle = statics.sort((a, b) => b.length - a.length)[0] ?? "";
  if (needle.length < 8) {
    return [{ file: null, window: "", unmatchable: true }];
  }

  const sites = [];
  for (const src of PAGE_SOURCES) {
    let from = 0;
    for (;;) {
      const at = src.code.indexOf(needle, from);
      if (at === -1) break;
      from = at + needle.length;
      sites.push({ file: src.file, window: callWindow(src.code, at) });
    }
  }
  return sites;
}

/** The thirteen questions, answered from the call site where they can be. */
function sourceEvidence(sites) {
  const all = sites.map((s) => s.window).join("\n");
  const has = (re) => re.test(all);
  return {
    // 3 — the UI explains scope and impact
    explainsScope:
      has(/confirmDescription\s*:/) ||
      has(/description\s*:\s*["'`]/) ||
      has(/purpose\s*=/),
    // 4 — confirmation, and step-up where the endpoint demands it
    confirms: has(/\bconfirm\s*\(|useConfirmAction|ConfirmActionModal|requireConfirmText/),
    typedConfirmation: has(/requireConfirmText/),
    stepUp: has(/runStepUpAction|stepUp\.|StepUpModal|x-step-up/i),
    // 5 — the exact request
    method:
      /method\s*:\s*["'`](\w+)["'`]/.exec(all)?.[1]?.toUpperCase() ?? null,
    sendsBody: has(/body\s*:\s*JSON\.stringify|body\s*:\s*\{/),
    // 9 — refreshed from server truth rather than patched locally
    // Two honest shapes, not one. A page either re-reads the list, or it
    // assigns state straight from THIS response — both are server truth. Only
    // checking for a reload marked /admin/contact-sales as unrefreshed when it
    // does `setDetails(res.data)`, which is the stronger of the two.
    reloadsAfter: has(
      /await\s+load\s*\(|void\s+load\s*\(|reload\s*\(|refetch\s*\(|setReloadToken|set[A-Z]\w*\(\s*(?:res|data|r)\b/,
    ),
    // 10 — success is announced only after the server answered
    // The success signal must sit AFTER the request is awaited. A toast is one
    // way of signalling it; committing the response to state is another, and
    // gating on `res.ok` is a third. Matching only the toast reported 37 of 47
    // mutations as optimistic, which they are not.
    awaitsBeforeSuccess: has(
      /await[\s\S]{0,600}?(?:addToast\([^)]*success|set[A-Z]\w*\(\s*(?:res|data|r)\b|if\s*\(\s*res\.ok)/,
    ),
    // 11 — a failure path that reports rather than mutates
    handlesFailure: has(/catch\s*\([\s\S]{0,300}?notifyApiError|catch\s*\([\s\S]{0,300}?toSafeUserError/),
    // 1 — the control is discoverable at all
    hasControl: has(/<Button|<button|onClick=/),
  };
}

// ---------------------------------------------------------------------------
// Reading the executed proofs.
// ---------------------------------------------------------------------------

function testIndex(dir, pattern) {
  const files = [];
  const seen = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) seen(p);
      else if (pattern.test(e.name)) files.push(p);
    }
  };
  try {
    if (statSync(dir).isDirectory()) seen(dir);
  } catch {
    /* a tree that does not exist contributes nothing */
  }
  return files.map((f) => ({
    file: relative(REPO, f).split(sep).join("/"),
    code: readFileSync(f, "utf8"),
  }));
}

const API_INDEX = testIndex(API_TESTS, /\.test\.ts$/);
const E2E_INDEX = testIndex(E2E, /\.spec\.ts$/);

/** Tests that name this exact endpoint path. */
function testsFor(index, mutation) {
  /**
   * Match on the STATIC SEGMENTS, all of them.
   *
   * The first version built a leading stem and required the test to contain it
   * verbatim. That works for `/v1/support-access/enter` and fails for every
   * path with a parameter in the middle: stripping `:queueName` out of
   * `/v1/operations/queues/:queueName/jobs/:jobId/retry` leaves a string with
   * doubled slashes that no test ever writes, because the test interpolates.
   *
   * It reported 22 mutations as having no API test at all. A scan that
   * UNDER-reports proof is worse than no scan — it sends somebody off to write
   * tests that already exist, and it hides the handful of genuine gaps in the
   * noise of the false ones.
   *
   * Requiring every static segment to appear keeps it specific enough: a test
   * file mentioning "queues", "jobs" and "retry" together is about this
   * endpoint and very little else.
   */
  const segments = mutation.path
    .split("/")
    .filter((p) => p && !p.startsWith(":") && !p.includes("${"));
  if (segments.length === 0) return [];
  return index
    .filter((t) => segments.every((seg) => t.code.includes(seg)))
    .map((t) => t.file);
}

// ---------------------------------------------------------------------------
// The matrix.
// ---------------------------------------------------------------------------

const REQUIRED = [
  "discoverable",
  "unauthorizedRefused",
  "explainsScope",
  "confirmation",
  "request",
  "backendAuthorization",
  "persistedEffect",
  "concurrency",
  "refreshFromServer",
  "noOptimisticSuccess",
  "failureLeavesStateCorrect",
  "auditOutput",
  "tenantIsolation",
];

const rows = mutations().map((m) => {
  const sites = callSites(m);
  const src = sourceEvidence(sites);
  const apiTests = testsFor(API_INDEX, m);
  const e2eTests = testsFor(E2E_INDEX, m);

  const cell = (ok, kind, where) =>
    ok ? { proof: kind, where } : { proof: null, where: null };

  return {
    id: m.id,
    route: m.route,
    method: m.method,
    path: m.path,
    handler: m.handlerFile,
    authority: m.authority,
    callSites: sites.map((s) => s.file),
    checks: {
      discoverable: cell(src.hasControl && sites.length > 0, "SOURCE", sites[0]?.file),
      unauthorizedRefused: cell(
        m.authority.length > 0 && apiTests.length > 0,
        "API",
        apiTests[0],
      ),
      explainsScope: cell(src.explainsScope, "SOURCE", sites[0]?.file),
      confirmation: cell(src.confirms, "SOURCE", sites[0]?.file),
      request: cell(Boolean(src.method), "SOURCE", sites[0]?.file),
      backendAuthorization: cell(m.authority.length > 0, "SOURCE", m.handlerFile),
      persistedEffect: cell(apiTests.length > 0, "API", apiTests[0]),
      concurrency: cell(apiTests.length > 0, "API", apiTests[0]),
      refreshFromServer: cell(src.reloadsAfter, "SOURCE", sites[0]?.file),
      noOptimisticSuccess: cell(src.awaitsBeforeSuccess, "SOURCE", sites[0]?.file),
      failureLeavesStateCorrect: cell(src.handlesFailure, "SOURCE", sites[0]?.file),
      auditOutput: cell(apiTests.length > 0, "API", apiTests[0]),
      tenantIsolation: cell(apiTests.length > 0, "API", apiTests[0]),
    },
    stepUp: src.stepUp,
    typedConfirmation: src.typedConfirmation,
    apiTests,
    e2eTests,
  };
});

const gaps = rows.flatMap((r) =>
  REQUIRED.filter((k) => r.checks[k].proof === null).map((k) => ({
    id: r.id,
    route: r.route,
    check: k,
  })),
);

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify({ total: rows.length, required: REQUIRED, rows, gaps }, null, 2),
  );
} else if (process.argv.includes("--markdown")) {
  const out = [];
  out.push("# Admin mutation matrix");
  out.push("");
  out.push(
    "Generated by `node apps/web/scripts/admin-mutation-matrix.mjs --markdown`.",
  );
  out.push("Do not edit by hand.");
  out.push("");
  out.push(
    "One row per admin mutation. `S` = read from the call site, `A` = an",
  );
  out.push("executed API test, `E` = an executed browser test, `—` = no evidence.");
  out.push("");
  const head = [
    "Mutation",
    "Route",
    "Disc",
    "Unauth",
    "Scope",
    "Confirm",
    "Req",
    "AuthZ",
    "Effect",
    "Conc",
    "Refresh",
    "NoOptim",
    "FailSafe",
    "Audit",
    "Tenant",
    "StepUp",
  ];
  out.push(`| ${head.join(" | ")} |`);
  out.push(`| ${head.map(() => "---").join(" | ")} |`);
  const mark = (c) =>
    c.proof === "SOURCE" ? "S" : c.proof === "API" ? "A" : c.proof === "E2E" ? "E" : "—";
  for (const r of rows) {
    out.push(
      `| \`${r.id}\` | \`${r.route}\` | ` +
        REQUIRED.map((k) => mark(r.checks[k])).join(" | ") +
        ` | ${r.stepUp ? "yes" : "—"} |`,
    );
  }
  out.push("");
  out.push(`## Gaps (${gaps.length})`);
  out.push("");
  if (gaps.length === 0) out.push("None.");
  for (const g of gaps) out.push(`- \`${g.id}\` on \`${g.route}\` — ${g.check}`);
  out.push("");
  console.log(out.join("\n"));
} else {
  const pad = (s, n) => String(s ?? "").padEnd(n).slice(0, n);
  console.log(`${rows.length} mutations`);
  const byCheck = {};
  for (const r of rows) {
    for (const k of REQUIRED) {
      byCheck[k] = byCheck[k] ?? { ok: 0, gap: 0 };
      if (r.checks[k].proof) byCheck[k].ok += 1;
      else byCheck[k].gap += 1;
    }
  }
  for (const [k, v] of Object.entries(byCheck)) {
    console.log(`  ${pad(k, 28)} ${String(v.ok).padStart(3)} proven  ${String(v.gap).padStart(3)} gap`);
  }
  if (gaps.length > 0) {
    console.log(`\n${gaps.length} unproven cell(s):`);
    for (const g of gaps.slice(0, 40)) {
      console.log(`  ${pad(g.id, 58)} ${g.check}`);
    }
    if (gaps.length > 40) console.log(`  … and ${gaps.length - 40} more`);
  }
}

process.exit(gaps.length > 0 ? 1 : 0);
