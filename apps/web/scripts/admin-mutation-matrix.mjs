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
 * So this builds one row per (mutation, page) with THIRTEEN columns, and for
 * each one records where the proof lives. Four kinds of evidence, kept
 * distinct because they are not equally strong:
 *
 *   SOURCE    read out of the call site. Strong for structural properties —
 *             a confirm dialog either exists in the code or does not.
 *   API       an executed test in services/api/test. Strong for authorization,
 *             persistence, idempotency, tenancy.
 *   RENDER    an executed jsdom test in apps/web/__tests__/render that mounts
 *             the real page: the only evidence that the control opens the
 *             dialog, sends THAT request, and reports a failure truthfully.
 *   E2E       an executed browser test. The only evidence that the visible
 *             action works end to end.
 *
 * A cell with no evidence is reported as MISSING rather than assumed, and the
 * script exits non-zero while any required cell is MISSING.
 *
 * =============================================================================
 * THE ONE HAND-MAINTAINED INPUT, AND WHAT IT MAY NOT SAY
 * =============================================================================
 * `admin-mutation-dispositions.json` (next to this file) carries, per row, a
 * risk class, the visible control, the affected scope, and — only where the
 * source scan cannot see a proof — a disposition per cell that NAMES the test
 * file carrying it. That file must exist and must contain the exact mutation
 * id ("POST /v1/…"), so a proof cannot be borrowed from a neighbouring action
 * on the same page.
 *
 * NOT_APPLICABLE is allowed for two cells only, confirmation and
 * explainsScope, and only for risk classes where it can be true:
 *
 *   confirmation   SAFE_IDEMPOTENT_RETRY, LOW_RISK_PREFERENCE,
 *                  REVERSIBLE_STATE_CHANGE — never for anything destructive,
 *                  security-sensitive, external, replaying, or consequential
 *                  to a customer
 *   explainsScope  LOW_RISK_PREFERENCE only (a genuinely scope-free setting)
 *
 * failureLeavesStateCorrect and noOptimisticSuccess can never be
 * NOT_APPLICABLE: every mutation can fail, and no mutation may announce
 * success before the server has.
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
 *   node apps/web/scripts/admin-mutation-matrix.mjs --closure   (the 68-cell
 *                                                              before/after)
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(WEB, "../..");
const ADMIN = join(WEB, "app", "(app)", "admin");
const API_TESTS = join(REPO, "services", "api", "test");
const RENDER_TESTS = join(WEB, "__tests__");
const E2E = join(WEB, "e2e", "admin-control-plane");
const DISPOSITIONS = join(WEB, "scripts", "admin-mutation-dispositions.json");
const BEFORE = join(REPO, "docs", "admin", "evidence", "mutation-matrix-before.json");

// ---------------------------------------------------------------------------
// The vocabulary.
// ---------------------------------------------------------------------------

export const RISK_CLASSES = Object.freeze([
  "DESTRUCTIVE",
  "HIGH_IMPACT_OPERATIONAL",
  "SECURITY_SENSITIVE",
  "REVERSIBLE_STATE_CHANGE",
  "SAFE_IDEMPOTENT_RETRY",
  "LOW_RISK_PREFERENCE",
]);

/** Risk classes for which a confirmation may be NOT_APPLICABLE. */
const CONFIRMATION_OPTIONAL = new Set([
  "SAFE_IDEMPOTENT_RETRY",
  "LOW_RISK_PREFERENCE",
  "REVERSIBLE_STATE_CHANGE",
]);

/** Risk classes for which explaining the scope may be NOT_APPLICABLE. */
const SCOPE_OPTIONAL = new Set(["LOW_RISK_PREFERENCE"]);

export const FINAL_VALUES = Object.freeze(["PROVEN", "FIXED_AND_PROVEN", "NOT_APPLICABLE"]);

export const REQUIRED = Object.freeze([
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
]);

const NEVER_NOT_APPLICABLE = new Set(["failureLeavesStateCorrect", "noOptimisticSuccess"]);

/*
 * The dimensions that are claims about what the SERVER DOES when the request
 * arrives — as opposed to what the page renders, which source text can
 * legitimately settle.
 *
 * None of these may be concluded from reading a handler. See the note at the
 * cell resolver for the three Phase 3 defects that each read as correct in
 * the source and were false in execution.
 */
const SERVER_BEHAVIOUR_CHECKS = new Set([
  "backendAuthorization",
  "unauthorizedRefused",
  "persistedEffect",
  "concurrency",
  "auditOutput",
  "tenantIsolation",
]);

/** Evidence kinds that ran the code, rather than reading it. */
const EXECUTED_KINDS = new Set(["API", "E2E"]);

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

/**
 * One row per (mutation, page). A page that issues the same request from two
 * call sites is one row with two call sites, not two rows that could carry
 * different verdicts about one behaviour.
 */
function mutations() {
  const byKey = new Map();
  for (const row of inventory()) {
    for (const api of row.api ?? []) {
      // `method` can be a set when one literal is called with several verbs.
      const verbs = String(api.method ?? "")
        .split("+")
        .filter((m) => m && m !== "GET");
      for (const method of verbs) {
        const id = `${method} ${api.path}`;
        const key = `${id} @ ${row.route}`;
        const existing = byKey.get(key);
        const literal = api.sourceLiteral ?? api.literal;
        if (existing) {
          if (!existing.literals.includes(literal)) existing.literals.push(literal);
          continue;
        }
        byKey.set(key, {
          key,
          id,
          route: row.route,
          method,
          path: api.path,
          literals: [literal],
          handlerFile: api.file,
          authority: api.authority ?? [],
        });
      }
    }
  }
  return [...byKey.values()].sort(
    (a, b) => a.id.localeCompare(b.id) || a.route.localeCompare(b.route),
  );
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
  const holdsAControl = (text) => /onClick\s*=|<Button|<button/.test(text);

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
   *
   * The search is confined to the PAGE'S OWN directory: a literal that two
   * pages share must not let one page's dialog vouch for the other's.
   */
  const sites = [];
  const routeDir = mutation.route.replace(/^\/admin\/?/, "").replace(/:(\w+)/g, "[$1]");
  const inRoute = (src) =>
    routeDir === "" ? !src.routeDir.includes("/") && src.routeDir === "" : src.routeDir === routeDir || src.routeDir.startsWith(`${routeDir}/`);
  for (const literal of mutation.literals) {
    const statics = literal
      .split(/\$\{[^}]*\}/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    const needle = statics.sort((a, b) => b.length - a.length)[0] ?? "";
    if (needle.length < 8) {
      sites.push({ file: null, window: "", unmatchable: true });
      continue;
    }
    for (const src of PAGE_SOURCES) {
      if (!inRoute(src)) continue;
      let from = 0;
      for (;;) {
        const at = src.code.indexOf(needle, from);
        if (at === -1) break;
        from = at + needle.length;
        sites.push({ file: src.file, window: callWindow(src.code, at) });
      }
    }
  }
  return sites;
}

/** The thirteen questions, answered from the call site where they can be. */
function sourceEvidence(sites) {
  const all = sites.map((s) => s.window).join("\n");
  const has = (re) => re.test(all);
  return {
    // 3 — the UI explains scope and impact. A `description:` may be followed
    // by a newline before its string or template; that is formatting, not
    // absence.
    explainsScope:
      has(/confirmDescription\s*:/) ||
      has(/description\s*:\s*[\s\S]{0,4}?["'`]/) ||
      has(/description\s*:\s*[\s\S]{0,8}?(?:===|\?)/) ||
      has(/purpose\s*=/),
    // 4 — confirmation, and step-up where the endpoint demands it
    confirms: has(/\bconfirm\s*\(|useConfirmAction|ConfirmActionModal|requireConfirmText/),
    typedConfirmation: has(/requireConfirmText/),
    stepUp: has(/runStepUpAction|stepUp\.|StepUpModal|x-step-up/i),
    // 5 — the exact request
    method: /method\s*:\s*["'`](\w+)["'`]/.exec(all)?.[1]?.toUpperCase() ?? null,
    sendsBody: has(/body\s*:\s*JSON\.stringify|body\s*:\s*\{/),
    // 9 — refreshed from server truth rather than patched locally
    // Two honest shapes, not one. A page either re-reads the list, or it
    // assigns state straight from THIS response — both are server truth. Only
    // checking for a reload marked /admin/contact-sales as unrefreshed when it
    // does `setDetails(res.data)`, which is the stronger of the two.
    reloadsAfter: has(
      /await\s+load\s*\(|void\s+load\s*\(|reload\s*\(|refetch\s*\(|setReloadToken|set[A-Z]\w*\(\s*(?:res|data|r)\b|loadList\(\)|loadDetails\(|loadSnapshot\(|loadSupportGrants\(|loadEmergencyGrants\(|loadFailed\(|loadAll\(/,
    ),
    // 10 — success is announced only after the server answered
    // The success signal must sit AFTER the request is awaited. A toast is one
    // way of signalling it; committing the response to state is another, and
    // gating on `res.ok` is a third. Matching only the toast reported 37 of 47
    // mutations as optimistic, which they are not.
    awaitsBeforeSuccess: has(
      /await[\s\S]{0,900}?(?:addToast\([^)]*success|set[A-Z]\w*\(\s*(?:res|data|r)\b|if\s*\(\s*res\.ok|setSuccess\(|setNotice\(|setRegenNotice\(|setRowResult\(\s*\{[\s\S]{0,80}?ok:\s*true|setElevationNotice\(|onSuccess\(|kind:\s*"success")/,
    ),
    // 11 — a failure path that reports rather than mutates
    handlesFailure: has(
      /catch\s*\([\s\S]{0,400}?(?:notifyApiError|toSafeUserError|classifyFailure|readScimDenial)/,
    ),
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
const RENDER_INDEX = testIndex(RENDER_TESTS, /\.render\.test\.tsx$/);
const E2E_INDEX = testIndex(E2E, /\.spec\.ts$/);

/**
 * Tests that name this exact endpoint path.
 *
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
function testsFor(index, mutation) {
  const segments = mutation.path
    .split("/")
    .filter((p) => p && !p.startsWith(":") && !p.includes("${"));
  if (segments.length === 0) return [];
  return index
    .filter((t) => segments.every((seg) => t.code.includes(seg)))
    .map((t) => t.file);
}

/** Executed tests that carry the EXACT mutation id — the strongest binding. */
function boundTestsFor(index, mutation) {
  return index.filter((t) => t.code.includes(mutation.id)).map((t) => t.file);
}

// ---------------------------------------------------------------------------
// The dispositions file.
// ---------------------------------------------------------------------------

function readDispositions() {
  if (!existsSync(DISPOSITIONS)) return { rows: {}, reclassified: {} };
  const parsed = JSON.parse(readFileSync(DISPOSITIONS, "utf8"));
  const rows = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (k.startsWith("_")) continue;
    rows[k] = v;
  }
  return { rows, reclassified: parsed._reclassified ?? {} };
}

const KIND_OF_FILE = (file) =>
  file.startsWith("services/api/test/")
    ? "API"
    : file.startsWith("apps/web/e2e/")
      ? "E2E"
      : file.startsWith("apps/web/__tests__/render/")
        ? "RENDER"
        : null;

/**
 * Check one named evidence file against one mutation: it must exist, be a
 * test, and contain the exact mutation id. Returns the problem, or null.
 */
function checkEvidence(file, mutation) {
  const kind = KIND_OF_FILE(file);
  if (!kind) return `${file} is not under an executed-test tree`;
  const abs = join(REPO, file);
  if (!existsSync(abs)) return `${file} does not exist`;
  const code = readFileSync(abs, "utf8");
  if (!code.includes(mutation.id)) {
    return `${file} does not name "${mutation.id}" — evidence must bind to the exact mutation`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The matrix.
// ---------------------------------------------------------------------------

const { rows: DISPOSITION_ROWS, reclassified: RECLASSIFIED } = readDispositions();
const problems = [];

const rows = mutations().map((m) => {
  const sites = callSites(m);
  const src = sourceEvidence(sites);
  const apiTests = testsFor(API_INDEX, m);
  const boundApi = boundTestsFor(API_INDEX, m);
  const boundRender = boundTestsFor(RENDER_INDEX, m);
  const boundE2e = boundTestsFor(E2E_INDEX, m);
  const disp = DISPOSITION_ROWS[m.key];

  if (!disp) {
    problems.push(`${m.key}: no disposition — every mutation needs a risk class, control and scope`);
  } else {
    if (!RISK_CLASSES.includes(disp.riskClass)) {
      problems.push(`${m.key}: riskClass "${disp.riskClass}" is not one of ${RISK_CLASSES.join(", ")}`);
    }
    if (!disp.control || disp.control.length < 8) problems.push(`${m.key}: name the visible control`);
    if (!disp.scope || disp.scope.length < 12) problems.push(`${m.key}: describe the affected scope`);
  }

  /**
   * One cell: automatic evidence first, then the disposition.
   *
   * Automatic evidence is never overridden downward, and a disposition that
   * names a stronger executed proof is recorded alongside the automatic one.
   */
  const cell = (check, autoOk, autoKind, autoWhere) => {
    const proofs = [];
    if (autoOk) proofs.push({ kind: autoKind, where: autoWhere });
    // Executed proofs that name this exact mutation count for every
    // behavioural cell they can speak to.
    const d = disp?.cells?.[check];
    let final = autoOk ? "PROVEN" : null;
    let reason = null;
    if (d) {
      if (!FINAL_VALUES.includes(d.disposition)) {
        problems.push(`${m.key}/${check}: disposition "${d.disposition}" is not one of ${FINAL_VALUES.join(", ")}`);
      } else if (d.disposition === "NOT_APPLICABLE") {
        if (NEVER_NOT_APPLICABLE.has(check)) {
          problems.push(`${m.key}/${check}: can never be NOT_APPLICABLE`);
        } else if (check === "confirmation" && !CONFIRMATION_OPTIONAL.has(disp?.riskClass)) {
          problems.push(`${m.key}/confirmation: NOT_APPLICABLE is not allowed for risk class ${disp?.riskClass}`);
        } else if (check === "explainsScope" && !SCOPE_OPTIONAL.has(disp?.riskClass)) {
          problems.push(`${m.key}/explainsScope: NOT_APPLICABLE is not allowed for risk class ${disp?.riskClass}`);
        } else if (!["confirmation", "explainsScope"].includes(check)) {
          problems.push(`${m.key}/${check}: NOT_APPLICABLE is only allowed for confirmation and explainsScope`);
        } else if (!d.reason || d.reason.length < 60) {
          problems.push(`${m.key}/${check}: NOT_APPLICABLE needs a concrete risk-based reason (60+ chars)`);
        } else {
          final = "NOT_APPLICABLE";
          reason = d.reason;
        }
      } else {
        const evidence = Array.isArray(d.evidence) ? d.evidence : [];
        if (evidence.length === 0) {
          problems.push(`${m.key}/${check}: ${d.disposition} names no evidence file`);
        }
        for (const file of evidence) {
          const bad = checkEvidence(file, m);
          if (bad) problems.push(`${m.key}/${check}: ${bad}`);
          else proofs.push({ kind: KIND_OF_FILE(file), where: file });
        }
        if (evidence.length > 0 && !evidence.some((f) => checkEvidence(f, m))) {
          final = d.disposition;
        }
      }
    }
    /*
     * A SERVER-BEHAVIOUR CELL MAY NOT BE SETTLED FROM SOURCE TEXT.
     *
     * Reading a handler tells you what it NAMES, never what it DOES, and
     * Phase 3 kept finding the gap between the two by executing the routes:
     *
     *   * POST /v1/admin/identity/sessions/:id/score named
     *     `requireIdentityAdmin` and passed the source scan, while actually
     *     enforcing `identity.org_policy.read` — a READ permission on a route
     *     that rewrites a session's risk score.
     *   * The queue replay route imported the step-up middleware and called
     *     it only when the CALLER volunteered a job-name hint; omitting the
     *     hint skipped the gate. The retry route imported it and never called
     *     it at all, while its comment said the service did.
     *   * `createSsoConnection` had an unremarkable handler that could never
     *     succeed: it re-validated its own actor field against a `.strict()`
     *     schema, so every provider creation threw.
     *
     * Each of those reads as correct in the source. So a server-behaviour
     * dimension backed only by SOURCE is reported MISSING, and the run fails
     * until an executed API/E2E proof names the mutation.
     */
    if (SERVER_BEHAVIOUR_CHECKS.has(check) && final === "PROVEN") {
      const executed = proofs.filter((p) => EXECUTED_KINDS.has(p.kind));
      if (executed.length === 0) {
        problems.push(
          `${m.key}/${check}: settled from SOURCE alone — a server-behaviour ` +
            `dimension needs an executed API or E2E proof that names this mutation`,
        );
        return {
          final: "MISSING",
          proofs,
          reason:
            "source text shows what the handler names, not what it does; " +
            "an executed proof is required",
        };
      }
    }

    return { final, proofs, reason };
  };

  const checks = {
    discoverable: cell("discoverable", src.hasControl && sites.length > 0, "SOURCE", sites[0]?.file),
    unauthorizedRefused: cell(
      "unauthorizedRefused",
      m.authority.length > 0 && apiTests.length > 0,
      "API",
      apiTests[0],
    ),
    explainsScope: cell("explainsScope", src.explainsScope, "SOURCE", sites[0]?.file),
    confirmation: cell("confirmation", src.confirms, "SOURCE", sites[0]?.file),
    request: cell("request", Boolean(src.method), "SOURCE", sites[0]?.file),
    /*
     * Both halves are required, and the second is the one that matters.
     *
     * That the handler NAMES an authority is a precondition read from source;
     * that the authority actually refuses the wrong caller is a claim only an
     * executed test can settle. This cell used to be SOURCE-only, and rated
     * `POST /v1/admin/identity/sessions/:id/score` PROVEN while it enforced a
     * READ permission on a route that rewrites a session's risk score.
     */
    backendAuthorization: cell(
      "backendAuthorization",
      m.authority.length > 0 && !m.authority.includes("UNRESOLVED") && apiTests.length > 0,
      "API",
      apiTests[0],
    ),
    persistedEffect: cell("persistedEffect", apiTests.length > 0, "API", apiTests[0]),
    concurrency: cell("concurrency", apiTests.length > 0, "API", apiTests[0]),
    refreshFromServer: cell("refreshFromServer", src.reloadsAfter, "SOURCE", sites[0]?.file),
    noOptimisticSuccess: cell("noOptimisticSuccess", src.awaitsBeforeSuccess, "SOURCE", sites[0]?.file),
    failureLeavesStateCorrect: cell("failureLeavesStateCorrect", src.handlesFailure, "SOURCE", sites[0]?.file),
    auditOutput: cell("auditOutput", apiTests.length > 0, "API", apiTests[0]),
    tenantIsolation: cell("tenantIsolation", apiTests.length > 0, "API", apiTests[0]),
  };

  // A confirmation that the risk class REQUIRES may not be missing even if
  // the disposition forgot to speak.
  if (disp && !CONFIRMATION_OPTIONAL.has(disp.riskClass) && checks.confirmation.final === "NOT_APPLICABLE") {
    problems.push(`${m.key}: risk class ${disp.riskClass} requires a confirmation`);
  }

  return {
    key: m.key,
    id: m.id,
    route: m.route,
    method: m.method,
    path: m.path,
    handler: m.handlerFile,
    authority: m.authority,
    riskClass: disp?.riskClass ?? null,
    control: disp?.control ?? null,
    scope: disp?.scope ?? null,
    callSites: [...new Set(sites.map((s) => s.file).filter(Boolean))],
    checks,
    stepUp: src.stepUp,
    typedConfirmation: src.typedConfirmation,
    apiTests,
    boundTests: { api: boundApi, render: boundRender, e2e: boundE2e },
  };
});

const gaps = rows.flatMap((r) =>
  REQUIRED.filter((k) => r.checks[k].final === null).map((k) => ({
    key: r.key,
    id: r.id,
    route: r.route,
    check: k,
  })),
);

// ---------------------------------------------------------------------------
// The closure: every cell that was MISSING before, and what happened to it.
// ---------------------------------------------------------------------------

function closure() {
  if (!existsSync(BEFORE)) return null;
  const before = JSON.parse(readFileSync(BEFORE, "utf8"));
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const out = [];
  for (const g of before.gaps) {
    const key = `${g.id} @ ${g.route}`;
    const now = byKey.get(key);
    if (!now) {
      const re = RECLASSIFIED[key];
      if (!re) {
        problems.push(`closure: "${key}" is no longer a mutation and _reclassified does not explain it`);
        out.push({ ...g, key, final: "MISSING", reason: "row vanished without explanation" });
        continue;
      }
      out.push({
        ...g,
        key,
        control: re.control ?? null,
        riskClass: re.riskClass ?? null,
        scope: re.scope ?? null,
        final: re.disposition,
        reason: re.reason,
        replacedBy: re.replacedBy ?? [],
        evidence: re.evidence ?? [],
      });
      continue;
    }
    const c = now.checks[g.check];
    out.push({
      ...g,
      key,
      control: now.control,
      method: now.method,
      endpoint: now.path,
      riskClass: now.riskClass,
      scope: now.scope,
      final: c.final ?? "MISSING",
      reason: c.reason ?? null,
      evidence: c.proofs.map((p) => `${p.kind}:${p.where}`),
    });
  }
  // Cells the corrected inventory ADDED: rows that did not exist before.
  const beforeKeys = new Set(before.rows.map((r) => `${r.id} @ ${r.route}`));
  const added = rows
    .filter((r) => !beforeKeys.has(r.key))
    .map((r) => ({
      key: r.key,
      control: r.control,
      riskClass: r.riskClass,
      scope: r.scope,
      cells: Object.fromEntries(
        REQUIRED.map((k) => [k, r.checks[k].final ?? "MISSING"]),
      ),
    }));
  return { beforeMissing: before.gaps.length, cells: out, added };
}

// ---------------------------------------------------------------------------
// Output.
// ---------------------------------------------------------------------------

const mark = (c) =>
  c.final === null
    ? "—"
    : c.final === "NOT_APPLICABLE"
      ? "n/a"
      : c.proofs.map((p) => ({ SOURCE: "S", API: "A", RENDER: "R", E2E: "E" })[p.kind]).join("");

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      { total: rows.length, required: REQUIRED, rows, gaps, problems, closure: closure() },
      null,
      2,
    ),
  );
} else if (process.argv.includes("--closure")) {
  const c = closure();
  const out = [];
  out.push("# Admin mutation cells — before and after");
  out.push("");
  out.push("Generated by `node apps/web/scripts/admin-mutation-matrix.mjs --closure`.");
  out.push("Do not edit by hand.");
  out.push("");
  out.push(
    `The matrix recorded **${c?.beforeMissing ?? 0} cells without evidence** ` +
      "(docs/admin/evidence/mutation-matrix-before.json). Each is listed below with " +
      "its final disposition. `S` = call-site source, `A` = executed API test, " +
      "`R` = executed render test, `E` = executed browser test.",
  );
  out.push("");
  out.push("| # | Mutation | Route | Control | Method | Endpoint | Risk | Scope | Missing | Final | Evidence |");
  out.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const e = (s) => String(s ?? "—").replace(/\|/g, "\\|").replace(/\n/g, " ");
  (c?.cells ?? []).forEach((cell, i) => {
    out.push(
      `| ${i + 1} | \`${cell.id}\` | \`${cell.route}\` | ${e(cell.control)} | ${e(cell.method ?? cell.id.split(" ")[0])} | \`${e(cell.endpoint ?? cell.id.split(" ")[1])}\` | ${e(cell.riskClass)} | ${e(cell.scope)} | ${cell.check} | **${cell.final}** | ${e(
        cell.final === "NOT_APPLICABLE"
          ? cell.reason
          : (cell.evidence ?? []).join("; ") || cell.reason,
      )} |`,
    );
  });
  const missing = (c?.cells ?? []).filter((x) => x.final === "MISSING").length;
  out.push("");
  out.push(`**${(c?.cells ?? []).length} cells · ${missing} still MISSING**`);
  if (c?.added?.length) {
    out.push("");
    out.push("## Rows the corrected inventory added");
    out.push("");
    out.push(
      "These mutations were not in the earlier matrix: a GET health probe had been " +
        "matched in their place, and a loop-registered pair was matched as a template. " +
        "Every cell of every added row is listed so nothing enters the matrix unproven.",
    );
    out.push("");
    out.push("| Mutation @ route | Control | Risk | " + REQUIRED.join(" | ") + " |");
    out.push("| --- | --- | --- | " + REQUIRED.map(() => "---").join(" | ") + " |");
    for (const a of c.added) {
      out.push(
        `| \`${a.key}\` | ${e(a.control)} | ${e(a.riskClass)} | ` +
          REQUIRED.map((k) => a.cells[k]).join(" | ") +
          " |",
      );
    }
  }
  out.push("");
  console.log(out.join("\n"));
} else if (process.argv.includes("--markdown")) {
  const out = [];
  out.push("# Admin mutation matrix");
  out.push("");
  out.push("Generated by `node apps/web/scripts/admin-mutation-matrix.mjs --markdown`.");
  out.push("Do not edit by hand.");
  out.push("");
  out.push(
    "One row per (mutation, page). `S` = read from the call site, `A` = an executed",
  );
  out.push(
    "API test, `R` = an executed render test, `E` = an executed browser test, `n/a` =",
  );
  out.push("NOT_APPLICABLE with a recorded risk-based reason, `—` = no evidence.");
  out.push("");
  const head = [
    "Mutation",
    "Route",
    "Risk",
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
  for (const r of rows) {
    out.push(
      `| \`${r.id}\` | \`${r.route}\` | ${r.riskClass ?? "—"} | ` +
        REQUIRED.map((k) => mark(r.checks[k])).join(" | ") +
        ` | ${r.stepUp ? "yes" : "—"} |`,
    );
  }
  out.push("");
  out.push("## Risk classes and controls");
  out.push("");
  out.push("| Mutation | Route | Risk | Control | Scope |");
  out.push("| --- | --- | --- | --- | --- |");
  const e = (s) => String(s ?? "—").replace(/\|/g, "\\|").replace(/\n/g, " ");
  for (const r of rows) {
    out.push(`| \`${r.id}\` | \`${r.route}\` | ${e(r.riskClass)} | ${e(r.control)} | ${e(r.scope)} |`);
  }
  out.push("");
  out.push("## NOT_APPLICABLE, with reasons");
  out.push("");
  const na = rows.flatMap((r) =>
    REQUIRED.filter((k) => r.checks[k].final === "NOT_APPLICABLE").map((k) => ({ r, k })),
  );
  if (na.length === 0) out.push("None.");
  for (const { r, k } of na) out.push(`- \`${r.id}\` on \`${r.route}\` — ${k}: ${r.checks[k].reason}`);
  out.push("");
  out.push(`## Gaps (${gaps.length})`);
  out.push("");
  if (gaps.length === 0) out.push("None.");
  for (const g of gaps) out.push(`- \`${g.id}\` on \`${g.route}\` — ${g.check}`);
  if (problems.length > 0) {
    out.push("");
    out.push(`## Disposition problems (${problems.length})`);
    out.push("");
    for (const p of problems) out.push(`- ${p}`);
  }
  out.push("");
  console.log(out.join("\n"));
} else {
  const pad = (s, n) => String(s ?? "").padEnd(n).slice(0, n);
  console.log(`${rows.length} mutations`);
  const byCheck = {};
  for (const r of rows) {
    for (const k of REQUIRED) {
      byCheck[k] = byCheck[k] ?? { ok: 0, na: 0, gap: 0 };
      const f = r.checks[k].final;
      if (f === null) byCheck[k].gap += 1;
      else if (f === "NOT_APPLICABLE") byCheck[k].na += 1;
      else byCheck[k].ok += 1;
    }
  }
  for (const [k, v] of Object.entries(byCheck)) {
    console.log(
      `  ${pad(k, 28)} ${String(v.ok).padStart(3)} proven  ${String(v.na).padStart(3)} n/a  ${String(v.gap).padStart(3)} gap`,
    );
  }
  if (gaps.length > 0) {
    console.log(`\n${gaps.length} unproven cell(s):`);
    for (const g of gaps.slice(0, 80)) console.log(`  ${pad(g.key, 90)} ${g.check}`);
    if (gaps.length > 80) console.log(`  … and ${gaps.length - 80} more`);
  }
  if (problems.length > 0) {
    console.log(`\n${problems.length} disposition problem(s):`);
    for (const p of problems.slice(0, 80)) console.log(`  ${p}`);
  }
}

if (!process.argv.includes("--json") && !process.argv.includes("--markdown") && !process.argv.includes("--closure")) {
  process.exit(gaps.length > 0 || problems.length > 0 ? 1 : 0);
} else {
  process.exit(gaps.length > 0 || problems.length > 0 ? 1 : 0);
}
