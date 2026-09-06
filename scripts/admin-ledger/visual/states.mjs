/**
 * THE STATE MATRIX — which of the console's nineteen visual states each of the
 * 47 pages can be in, and what it renders for each.
 *
 * =============================================================================
 * WHY A LIST OF NINETEEN, AND WHY THESE NINETEEN
 * =============================================================================
 * "Handle your empty states" is not a checkable instruction, because a page
 * has more than one way of having nothing to show and they mean different
 * things. The console's own history is the argument: /admin's tiles rendered a
 * measured zero and an unmeasured signal identically, so an operator could not
 * tell "no failures today" from "we are not collecting this". Phase 2 named
 * that distinction; this is the full vocabulary it belongs to.
 *
 * Nineteen states, in four groups:
 *
 *   THE DATA
 *     1  LOADING            first read in flight, nothing on screen yet
 *     2  REFRESHING         a re-read over content that is already shown
 *     3  VALUE              the ordinary case: a figure, a list, a row
 *     4  MEASURED_ZERO      a real zero. NOT empty, and never coloured.
 *     5  EMPTY              nothing has ever been recorded here
 *     6  FILTERED_EMPTY     rows exist; none match the filter
 *     7  NOT_MEASURED       the signal is not instrumented at all
 *     8  PARTIAL            some sources answered, some did not
 *     9  TRUNCATED          a capped read, and the cap is disclosed
 *    10  STALE              shown data is older than the page claims to be
 *
 *   THE REFUSAL — four different reasons a page shows nothing, which an
 *   operator must be able to tell apart, because the remedy differs
 *    11  ERROR              the read failed; retryable
 *    12  DENIED             403: this operator may not see it
 *    13  PLAN_GATED         402: the workspace's plan does not include it
 *    14  UNAVAILABLE        the capability is absent in this deployment
 *
 *   THE ACTION
 *    15  BUSY               a mutation in flight, its control occupied
 *    16  DONE               the mutation succeeded, stated in words
 *    17  ACTION_FAILED      the mutation failed, and nothing changed
 *    18  STEP_UP_REQUIRED   the action needs a second factor first
 *    19  BLOCKED            the control is disabled, WITH the reason
 *
 * =============================================================================
 * HOW A PAGE'S ROW IS DECIDED
 * =============================================================================
 * From the SOURCE, by the construct that renders each state — because a state
 * like PLAN_GATED is only reachable with a fixture whose plan lacks the
 * feature, and STALE only after a workspace switch mid-flight. A page either
 * contains the code that can render a state or it cannot render it, and that
 * is a fact a file can be asked.
 *
 * `NOT_APPLICABLE` therefore has to earn itself: this prints the page-specific
 * reason drawn from what the page IS (no table, no mutation, no filter, static
 * content), and refuses to write the word without one.
 *
 * The browser sampling in `admin-states.spec.ts` and `composition.mjs` covers
 * the states that ARE reachable in the fixture; this covers all nineteen.
 *
 * Usage: node scripts/admin-ledger/visual/states.mjs
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROUTES = JSON.parse(
  readFileSync("docs/admin/phase7-routes.json", "utf8"),
).routes;

const ADMIN = "apps/web/app/(app)/admin";

/** The files that make up a route: its page, and every _section it imports. */
function filesFor(route) {
  const rel = route.replace(/^\/admin\/?/, "").replace(/\/:(\w+)$/, "/[$1]");
  const dir = rel === "" ? ADMIN : join(ADMIN, rel);
  const out = [];

  const pageFile = join(dir, "page.tsx");
  try {
    statSync(pageFile);
    out.push(pageFile);
  } catch {
    // A dynamic segment directory is named [id] / [slug].
    for (const guess of ["[id]", "[slug]"]) {
      const alt = join(dir.replace(/\/\[\w+\]$/, ""), guess, "page.tsx");
      try {
        statSync(alt);
        out.push(alt);
        break;
      } catch {
        /* keep looking */
      }
    }
  }
  if (out.length === 0) return out;

  // Every _sections file under the page's own directory, and its parent's.
  const pageDir = out[0].slice(0, out[0].lastIndexOf("\\") >= 0 ? out[0].lastIndexOf("\\") : out[0].lastIndexOf("/"));
  for (const base of [pageDir, pageDir.slice(0, Math.max(pageDir.lastIndexOf("/"), pageDir.lastIndexOf("\\")))]) {
    const sections = join(base, "_sections");
    try {
      for (const e of readdirSync(sections, { withFileTypes: true })) {
        if (e.isFile() && /\.tsx$/.test(e.name)) out.push(join(sections, e.name));
      }
    } catch {
      /* no sections */
    }
  }
  return [...new Set(out)];
}

/**
 * COMMENTS ARE NOT EVIDENCE.
 *
 * The header below has always claimed the patterns "match the CODE that puts a
 * state on the screen", and every one of them was run over the raw file
 * including its comments. So a page could satisfy a state by DISCUSSING it:
 * `/admin/platform/observability` passed DENIED on the strength of a paragraph
 * explaining that some retired URLs "return 403 to every caller" — a sentence
 * about the API's history, in a page that never distinguishes a refusal at all.
 *
 * That is a false PASS, which is worse than a false gap: a gap gets looked at.
 * Stripping comments first is the only way the header's own claim is true.
 * String and template literals are preserved, because the words a page renders
 * to a reader ARE evidence — "No sessions match these filters" is the filtered
 * state, written down.
 */
function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        if (src[i] === "\\") {
          out += src[i] + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * A FAILED READ THAT TELLS THE PAGE NOTHING ABOUT WHY.
 *
 * Two shapes, both found in this console, both of which make it impossible for
 * the page to distinguish a refusal from an outage no matter what it renders
 * afterwards:
 *
 *   `.catch(() => ({ sessions: [] }))`  substitutes an empty collection for a
 *                                       failed read, so a refusal arrives on
 *                                       screen as "none" — the one rendering
 *                                       an operator must never confuse with
 *                                       the all-clear.
 *   `} catch { setX(true) }`            discards the error object entirely, so
 *                                       a 403 and a 500 set the same flag.
 *
 * Scoped to catches that actually guard an `apiFetch`: a `catch {}` around a
 * clipboard write or a `new URL()` parse is neither of these things, and
 * `/admin/provisioning` has exactly that.
 */
function silentApiFailure(code) {
  for (const m of code.matchAll(/\.catch\(\s*\(\s*\)\s*=>\s*\(?\s*(\{[^{}]*\[\s*\]|\[\s*\])/g)) {
    if (/apiFetch\(/.test(code.slice(Math.max(0, m.index - 800), m.index))) {
      return true;
    }
  }
  for (const m of code.matchAll(/catch\s*\{/g)) {
    const before = code.slice(Math.max(0, m.index - 1500), m.index);
    if (!/apiFetch\(/.test(before)) continue;
    // The catch body, brace-matched.
    let depth = 0;
    let i = m.index + m[0].length - 1;
    let end = i;
    for (; i < code.length; i++) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (/set[A-Z]\w*\(/.test(code.slice(m.index, end))) return true;
  }
  return false;
}

/**
 * What construct proves a page can render a state.
 *
 * Deliberately specific. "the word Loading appears" would match a comment;
 * these match the CODE that puts a state on the screen.
 */
const EVIDENCE = {
  LOADING: [
    /state="loading"/, /<AdmSkeleton/, /loading=\{/, /kind: "loading"/,
    // "Loading pipeline health…" is a loading state. Requiring the ellipsis
    // to sit directly against the word reported eight pages as unhandled.
    /Loading[^"`\n]{0,40}…/, /\bloading\b\s*\?/, /setLoading\(true\)/,
    /\bisLoading\b/,
    /* The load-state union three pages carry — `{ status: "loading" }`
       branched on as `state.status === "loading"`. Reported as unhandled on
       analytics and automation, both of which render a full skeleton page
       from exactly that branch. And `loading…` lowercase, which is what
       media-graph's freshness pill says while the first snapshot is in
       flight; the pattern above required a capital L. */
    /status:\s*"loading"/, /status === "loading"/, /loading…/i,
  ],
  REFRESHING: [
    /refreshing/i, /isRefetching/, /busy\s*&&\s*data/, /Refresh/,
    /void load\(/, /\breload\(/,
  ],
  VALUE: [/<DataTable/, /<AdmKpi/, /<AdmFacts/, /\.map\(/],
  MEASURED_ZERO: [
    /state="VALUE"/, /MEASURED_ZERO/, /=== 0 \?/, /\?\? 0/, /count === 0/,
  ],
  EMPTY: [/state="empty"/, /<EmptyState/, /No .* yet/],
  FILTERED_EMPTY: [
    /state="filtered"/, /match these filters/, /match the current filters/,
    /filtered=\{/, /No matches/,
  ],
  NOT_MEASURED: [
    /state="not-measured"/, /NOT_MEASURED/, /Not measured/, /notMeasuredReason/,
  ],
  /**
   * PARTIAL — SOME SOURCES ANSWERED, AND THE PAGE STILL SHOWS WHAT IT HAS.
   *
   * GATE B. The patterns were the words `partial` / `degraded` / `some
   * sources`, which is a page SAYING the word rather than a page handling the
   * state. The invariant this protects is structural and B1 states it plainly:
   * "one failed card does not blank unrelated content."
   *
   * A page satisfies that by giving each read its OWN failure container, so
   * one failing leaves the others rendered. Two shapes do it in this console:
   *
   *   • `Promise.allSettled`, whose whole purpose is per-source outcomes;
   *   • two or more distinct setters called from separate catch blocks —
   *     which is what a page decomposed into `_sections/*` gets for free,
   *     each section owning its own `SectionState`.
   *
   * NOT a loosened bar. `Promise.all` behind a single `.catch` still fails
   * this, and that is exactly what it found: `/admin/platform/exports`
   * discarded an export list that had answered because the object-lock probe
   * beside it had not, and `/admin/platform/automation` threw away the rules
   * when the run history failed. Both are fixed; `partial-shared-catch` in the
   * fixtures keeps the rule honest.
   */
  PARTIAL: [
    /PARTIAL/, /partial/i, /some sources/i, /degraded/i,
    /Promise\.allSettled/,
    // Two or more DISTINCT setters written from catch blocks.
    (src) =>
      new Set(
        [...src.matchAll(/catch\s*\([\s\S]{0,400}?(set[A-Z]\w*)\(/g)].map(
          (m) => m[1],
        ),
      ).size >= 2,
  ],
  TRUNCATED: [/truncated/i, /\bcap\b/, /hasMore/, /nextCursor/, /limit/],
  /**
   * STALE — A RESPONSE THAT LANDS AFTER A WORKSPACE SWITCH IS DROPPED.
   *
   * GATE B. The patterns knew ONE of the two idioms this codebase uses.
   * `useTenantGuard` stamps and compares; the React idiom sets a `cancelled`
   * flag in an effect keyed on the workspace and checks it before writing
   * state. Both drop the old workspace's answer, and three routes doing the
   * second — analytics, automation, reliability — were reported as having no
   * guard at all.
   *
   * A generation ref serves the same purpose for a load that a MUTATION also
   * re-invokes, where an effect closure cannot reach: that is what
   * `/admin/platform/exports` and `/admin/platform/recovery` now use, and
   * before this pass they had neither idiom — whichever request finished last
   * decided what the page showed.
   *
   * A load with no guard at all still fails: `stale-unguarded` in the
   * fixtures.
   */
  STALE: [
    /isStale/, /useTenantGuard/, /stale/i,
    // The React idiom: a cancel flag set in cleanup and checked before a write.
    /cancelled\s*=\s*true[\s\S]{0,4000}?if \(cancelled\) return/,
    /if \(cancelled\) return[\s\S]{0,4000}?cancelled\s*=\s*true/,
    /(ignore|aborted)\s*=\s*true[\s\S]{0,4000}?if \((ignore|aborted)\)/,
  ],
  ERROR: [
    /state="error"/, /kind: "error"/, /toSafeUserError/, /classifyError/,
    /classifyFailure/, /Could not load/,
    // `notifyApiError` is the product's ONLY sanctioned error-display path, so
    // a page that reports failures through a toast handles ERROR. Omitting it
    // reported /admin/audit — which routes all six of its catch blocks
    // through it — as having no error state at all.
    /notifyApiError/, /We couldn't (load|verify)/,
  ],
  /**
   * DENIED — THE OPERATOR IS REFUSED, AND LEARNS THAT IT IS A REFUSAL.
   *
   * GATE B. The patterns were the literal spellings a page uses when it
   * PRODUCES the distinction — `kind: "denied"`, `403`, `permission_denied` —
   * and this console mostly does not produce it locally. It has two central
   * authorities that already do:
   *
   *   `classifyFailure`   the identity family's one classifier. It returns
   *                       `kind: "denied"` for a 403 or a concealing 404, and
   *                       `/admin/identity/access-reviews` and
   *                       `/admin/identity/permission-matrix` each branch on
   *                       `failure.kind === "denied"` to say so.
   *   `toSafeUserError`   the app-wide safe-feedback path, whose status bucket
   *                       maps 403 to "You don't have access to this area …
   *                       Ask a workspace admin for access". `notifyApiError`
   *                       is the same path through a toast. A page routing a
   *                       failure through either renders a refusal, not a
   *                       retryable fault — which is the invariant: refusal is
   *                       not generic failure.
   *
   * Eight routes were reported as having no denial state while every one of
   * them routes its failures through one of those two.
   *
   * NOT a free pass, and this is the half that matters: the sinks above can
   * only distinguish a 403 if they are HANDED the error. A read whose failure
   * is swallowed into an empty list, or caught without binding, has destroyed
   * that information before any sink sees it — so `silentApiFailure`
   * disqualifies the page outright, whatever else it contains.
   *
   * It found two, and both were real:
   *   `/admin/identity/runtime`     `.catch(() => ({ sessions: [] }))` on the
   *                                 live-session list — a refusal rendering as
   *                                 "No active sessions" during an incident.
   *   `/admin/platform/media-graph` `catch {}` with a fixed string, so a
   *                                 refused scope read "Metrics endpoint did
   *                                 not respond" and sent the operator to
   *                                 chase an outage that did not exist.
   * Both are fixed. The rule keeps them fixed.
   */
  DENIED: [
    (code) => {
      if (silentApiFailure(code)) return false;
      return [
        /kind: "denied"/,
        /=== "denied"/,
        /state="unavailable"/,
        /readScimDenial/,
        /statusCode === 403/,
        /status === 403/,
        /permission_denied/,
        /forbidden/i,
        /don't have access/,
        /DenialPanel/,
        /classifyFailure/,
        /toSafeUserError/,
        /notifyApiError/,
      ].some((p) => p.test(code));
    },
  ],
  PLAN_GATED: [
    /402/, /enterprise_feature_required/, /Not included in this plan/,
    /plan does not include/, /<AccessGate/,
  ],
  /**
   * UNAVAILABLE — A CAPABILITY THIS DEPLOYMENT MAY SIMPLY NOT HAVE.
   *
   * GATE B. `/Unavailable/` was CASE-SENSITIVE, and every page in this console
   * writes the word in a sentence: `/admin/platform/analytics` renders "Data
   * source unavailable — value omitted rather than estimated",
   * `/admin/billing` renders "Not connected", `/admin/security` renders
   * "not enabled", `/admin/platform/media-graph` distinguishes "instrument
   * missing" from a zero. Four routes that handle the state precisely, all
   * reported as gaps because of one capital letter.
   *
   * The alternatives below are the words this console actually uses, plus the
   * `status: "unavailable"` state member that three pages carry in their own
   * load-state union. Still nothing that a page rendering only data could
   * match — the fixture test holds that line.
   */
  UNAVAILABLE: [
    /state="unavailable"/, /status:\s*"unavailable"/, /unavailable/i,
    /not available/i, /not configured/i, /not connected/i, /not enabled/i,
    /no [a-z-]+ configured/i, /instrument missing/i,
  ],
  BUSY: [
    /busy/i, /\bmutating\b/, /loading=\{busy/, /disabled=\{.*busy/,
    /"pending"/, /Retrying…|Replaying…|Provisioning…|Probing…/,
  ],
  DONE: [
    /state="done"/, /tone="verified"/, /setSuccess/, /addToast\(/, /successBox/,
    /setNotice/, /setRegenNotice/,
  ],
  /**
   * ACTION_FAILED — A MUTATION WAS ATTEMPTED, DID NOT SUCCEED, AND THE READER
   * WAS TOLD.
   *
   * GATE B. The patterns here were `setMutationFailure`, `setRowResult`,
   * `rowResult` and `setActionResult` — four page-local STATE VARIABLE NAMES
   * from a handful of pages. That is not a definition of the state, it is one
   * page's implementation of it, and it reported twelve routes as having no
   * failed-mutation state while every one of them has one.
   *
   * Checked instead: does the file contain a mutating request whose catch
   * reaches the product's sanctioned error-display path? Both halves, in one
   * window, because a file that mutates somewhere and reports an unrelated
   * READ failure elsewhere does not handle this.
   *
   * `notifyApiError` / `toSafeUserError` are the ONLY sanctioned display path
   * in this product — raw `error.message` passthrough is banned app-wide — so
   * a mutation reporting through them is the canonical handling, not a
   * loosened bar. A page that mutates and SWALLOWS the failure still fails
   * this: `mutation-swallowed` in the fixtures proves it.
   */
  ACTION_FAILED: [
    /setMutationFailure/, /setRowResult/, /action failed/i, /rowResult/,
    /setActionResult/,
    // A mutating request, a catch, and a report — within one window.
    /method:\s*["'](?:POST|PUT|PATCH|DELETE)["'][\s\S]{0,1200}?catch\s*\([\s\S]{0,600}?(?:notifyApiError|toSafeUserError|describeRefusal|SectionError|addToast\([^)]*["']error["'])/,
    /catch\s*\([\s\S]{0,900}?(?:notifyApiError|toSafeUserError|describeRefusal)[\s\S]{0,1200}?method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/,
  ],
  STEP_UP_REQUIRED: [/StepUpModal/, /useStepUpAction/, /STEP_UP/, /step-up/i],
  BLOCKED: [
    /disabled=\{/, /disabledReason/, /caveat/, /aria-disabled/, /not-allowed/,
  ],
};

/**
 * A page-specific reason a state cannot occur, drawn from what the page IS.
 * Returns null when there is no defensible reason, which makes the cell a
 * finding rather than a NOT_APPLICABLE.
 */
/**
 * THE API'S OWN PLAN-GATED ENDPOINTS.
 *
 * Read from the route files that call the entitlement helper, so this stays
 * true as gates are added or removed instead of being a list that rots. A
 * whole FILE counts when it applies the gate in a shared authorizer — as
 * scim-admin does — which is conservative in the right direction: it raises
 * the obligation rather than excusing a page.
 */
/**
 * THE REVIEWED SCOPE DECISION for a route, or null.
 *
 * `adminScopeDispositions.ts` is the committed record of which admin surfaces
 * are workspace-scoped and which merely carry a teamId, each entry with the
 * evidence that settled it. Read here rather than re-decided: two authorities
 * disagreeing about a route's scope is worse than one.
 */
let SCOPE_DISPOSITIONS = null;
function scopeDisposition(route) {
  if (!SCOPE_DISPOSITIONS) {
    SCOPE_DISPOSITIONS = new Map();
    try {
      const src = readFileSync(
        "apps/web/lib/navigation/adminScopeDispositions.ts",
        "utf8",
      );
      for (const m of src.matchAll(
        /route:\s*"([^"]+)",[\s\S]*?decision:\s*"([A-Z_]+)"/g,
      )) {
        SCOPE_DISPOSITIONS.set(m[1], m[2]);
      }
    } catch {
      /* absent: every route simply has no disposition */
    }
  }
  return SCOPE_DISPOSITIONS.get(route) ?? null;
}

let PLAN_GATED_PATHS = null;
/**
 * WHICH ENDPOINTS APPLY A GIVEN GATE, ASKED OF THE API.
 *
 * Generalised from the plan-gate lookup because STEP_UP_REQUIRED has exactly
 * the same shape of question and exactly the same wrong answer available:
 * "every page that mutates owes a step-up state" is a guess about the server.
 * Most admin mutations are not step-up gated — the API calls
 * `requireStepUpForSensitiveAction` on the destructive few — so demanding the
 * state everywhere asks for a modal that can never be shown.
 */
function pathsApplyingGate(GATE) {
  // Relative to the repo root, like every other path in this script.
  const dir = "services/api/src/routes";
  const found = new Set();
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".routes.ts"));
  } catch {
    names = [];
  }
  /**
   * ATTRIBUTED TO THE ROUTE THAT APPLIES IT, NOT TO THE FILE.
   *
   * A first attempt counted every path in a file containing a gate, which is
   * conservative in the wrong way: `mfa-admin.routes.ts` gates exactly ONE of
   * its twenty handlers, so file-level attribution would demand a plan-gated
   * screen for eighteen reads that can never answer 402 — an unreachable
   * state asserted as a requirement.
   *
   * Each `app.<verb>("/v1/…")` registration owns the source from its own
   * declaration to the next one. A gate call inside that span gates that
   * path. `scim-admin` gates in a shared authorizer above its registrations,
   * so the span before the first route is attributed to every route in the
   * file — which is exactly right there, and is why that case is handled
   * explicitly rather than by luck.
   */
  for (const name of names) {
    let src = "";
    try {
      src = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    if (!GATE.test(src)) continue;

    const regs = [
      ...src.matchAll(/app\.(get|post|patch|put|delete)\(\s*\n?\s*["'](\/v1\/[^"']+)["']/g),
    ].map((m) => ({ index: m.index, path: m[2].replace(/:[A-Za-z0-9_]+/g, "") }));
    if (regs.length === 0) continue;

    // A gate BEFORE the first registration is a shared authorizer: it applies
    // to every route the file declares.
    const preamble = src.slice(0, regs[0].index);
    if (GATE.test(preamble.replace(/^import[\s\S]*?from[^\n]*\n/gm, ""))) {
      for (const r of regs) found.add(r.path);
      continue;
    }

    for (let i = 0; i < regs.length; i += 1) {
      const from = regs[i].index;
      const to = i + 1 < regs.length ? regs[i + 1].index : src.length;
      if (GATE.test(src.slice(from, to))) found.add(regs[i].path);
    }
  }
  return [...found];
}

const PLAN_GATE =
  /assertTeamAllowsEnterpriseFeature\(|resolveTeamEnterpriseFeatureGate\(|code:\s*["']enterprise_feature_required["']/;
function planGatedPaths() {
  if (!PLAN_GATED_PATHS) PLAN_GATED_PATHS = pathsApplyingGate(PLAN_GATE);
  return PLAN_GATED_PATHS;
}

/**
 * The API's ONE step-up primitive. `requireStepUpForSensitiveAction` is what
 * answers 401 `STEP_UP_REQUIRED`, and `StepUpModal` on the web side is what
 * catches it; a route that never calls it cannot produce the state, so a page
 * that only reaches such routes owes no modal.
 */
const STEP_UP_GATE = /requireStepUpForSensitiveAction\(|assertStepUpVerified\(/;
let STEP_UP_PATHS = null;
function stepUpGatedPaths() {
  if (!STEP_UP_PATHS) STEP_UP_PATHS = pathsApplyingGate(STEP_UP_GATE);
  return STEP_UP_PATHS;
}

function reasonFor(state, shape) {
  const {
    hasTable,
    hasFilter,
    hasMutation,
    hasKpi,
    isStatic,
    workspaceScoped,
    reads,
    hasOptionalCapability,
  } = shape;
  switch (state) {
    /* A PAGE THAT READS NOTHING CANNOT BE IN ANY READ STATE.
       The runbook catalog and reader compile their content into the page from
       a generated index: there is no request to be in flight, to fail, to
       answer partially, to be capped, or to go stale under a workspace
       switch. Reported as five gaps each before this reason existed. */
    case "LOADING":
    case "ERROR":
      if (reads === 0) {
        return "content is compiled into the page from a generated index: there is no read to be in flight or to fail";
      }
      break;

    /* --------------------------------------------------------------------
     * REFRESHING — THE SAME QUESTION, ASKED AGAIN, WITH ITS ANSWER STILL UP.
     *
     * GATE B. This shared the reads===0 test with LOADING and ERROR, and was
     * otherwise always applicable, which made it a synonym for "the page
     * reads something". It is not: refreshing is a distinct state only where
     * a page RE-ASKS a question it has already answered — a poll, a Refresh
     * control, or a re-read after a mutation — because only then is there a
     * previous answer on screen that the new one replaces.
     *
     * Five routes had no such mechanism. Every read on them is keyed to a
     * control, and changing the control asks a DIFFERENT question: analytics
     * for a different window, search for a different term, reliability for a
     * different status. Holding the previous figures on screen while that
     * loads would be showing numbers under a heading they were not measured
     * for, so those pages return to their loading state — correctly. Demanding
     * a "refreshing" treatment there asks for the opposite of the truth.
     *
     * `/admin/platform/observability` polls, so it keeps the obligation.
     * ------------------------------------------------------------------ */
    case "REFRESHING": {
      if (reads === 0) {
        return "content is compiled into the page from a generated index: there is no read to be in flight or to fail";
      }
      if (shape.rereadMechanism) return null;
      const keys = shape.readKeys.length
        ? shape.readKeys.join(", ")
        : "its route parameters";
      return `nothing here re-asks a question it has already answered: no poll, no refresh control, and no re-read after a mutation. Every read is keyed to ${keys}, and a change there is a different question whose answer replaces the one on screen rather than refreshing it`;
    }

    case "FILTERED_EMPTY":
      return hasFilter ? null : "no filter on this page";
    case "TRUNCATED":
      return hasTable ? null : "no list read to cap";
    case "MEASURED_ZERO":
      return hasKpi || hasTable ? null : "no counted figure on this page";
    case "BUSY":
    case "DONE":
    case "ACTION_FAILED":
    case "BLOCKED":
      return hasMutation ? null : "read-only page: no mutation to be in flight";

    /* --------------------------------------------------------------------
     * STEP_UP_REQUIRED — ASKED OF THE API, LIKE THE PLAN GATE.
     *
     * GATE B. This shared the "does the page mutate?" test with BUSY and DONE,
     * which is the same guess-about-the-server that PLAN_GATED made: it
     * demanded a step-up challenge from every page with a POST. Most admin
     * mutations are not step-up gated. The API calls
     * `requireStepUpForSensitiveAction` on the destructive few — emergency
     * revoke, restore validation, invitation governance — and answers a
     * structured 401 that `StepUpModal` catches; a route that never calls it
     * cannot produce the state, and asserting the modal anyway is asking for a
     * screen nobody can reach.
     *
     * Read out of the API's own call sites at sweep time, attributed to the
     * enclosing registration, so a new gate creates the obligation and a
     * removed one retires it.
     * ------------------------------------------------------------------ */
    case "STEP_UP_REQUIRED": {
      if (!hasMutation) {
        return "read-only page: no mutation to be in flight";
      }
      const gated = stepUpGatedPaths();
      const touches = shape.requestPaths.some((p) =>
        gated.some((g) => p.startsWith(g) || g.startsWith(p)),
      );
      return touches
        ? null
        : "none of this page's endpoints applies the API's step-up gate (`requireStepUpForSensitiveAction`), so no step-up challenge can reach it";
    }

    case "EMPTY":
      return hasTable || hasKpi ? null : "nothing on this page is a list";

    /* -------------------------------------------------------------------
     * THE FOUR THAT DEPEND ON WHAT THE PAGE IS SCOPED TO
     *
     * Reported as gaps on 130 cells before these reasons existed, and every
     * one of them was wrong in the same way: a PLATFORM-admin surface has no
     * workspace plan to be gated by, no workspace to switch out from under
     * it, and no in-page 403 to render — its authorization is enforced at
     * the route by the admin layout, so an operator who may not see it never
     * reaches the page at all. Asserting a page must render a state it
     * cannot reach is how a matrix reaches 47/47 by lowering the bar.
     * ------------------------------------------------------------------- */
    /* --------------------------------------------------------------------
     * PLAN_GATED — ASKED OF THE API, NOT INFERRED FROM THE PAGE.
     *
     * GATE B. The rule was "workspace-scoped pages owe this state", which is
     * a guess about the server dressed as a fact about the page. A 402 can
     * only arrive from an endpoint that applies a plan gate, and exactly
     * three route files in this API do:
     *
     *   mfa-admin        PATCH /v1/identity/mfa-admin/policy/:teamId
     *                    (mfaEnforcement) — implemented and proven this pass
     *   scim-admin       every route, gated in the shared authorizer (ssoScim)
     *   governance-      the retentionPolicy and legalHold mutations, which
     *   lifecycle        no /admin page reads
     *
     * So a page whose requests touch NONE of those paths cannot reach the
     * state, and asserting that it must render one is asking for a screen
     * nobody can ever see. `PLAN_GATED_PATHS` is read out of the API's own
     * gate call sites at sweep time rather than listed here, so a new gate
     * creates the obligation automatically and a removed one retires it.
     * ------------------------------------------------------------------ */
    case "PLAN_GATED": {
      if (!workspaceScoped) {
        return "platform-scoped surface: not gated by any workspace's plan";
      }
      const gated = planGatedPaths();
      const touches = shape.requestPaths.some((p) =>
        gated.some((g) => p.startsWith(g)),
      );
      return touches
        ? null
        : "none of this page's endpoints applies a plan gate — the three that " +
            "do in this API (mfa-admin's policy PATCH, every scim-admin route, " +
            "and governance-lifecycle's retention/legal-hold mutations) are not " +
            "among its requests, so no 402 can reach it";
    }
    case "DENIED":
      return workspaceScoped
        ? null
        : "platform-scoped surface: authorization is enforced at the route by the admin layout, not rendered as a page state";
    /* --------------------------------------------------------------------
     * STALE — ONLY A SURFACE WHOSE DATA BELONGS TO ONE WORKSPACE CAN GO STALE
     * UNDER A SWITCH.
     *
     * GATE B. Sending a `teamId` is not the same as READING one workspace's
     * data, and this repository already records which is which:
     * `apps/web/lib/navigation/adminScopeDispositions.ts` carries a reviewed
     * decision per route, each with the evidence behind it.
     *
     *   PLATFORM_AUDIT_CONTEXT       the rows are platform-wide; the teamId is
     *                                what an ACTION is recorded against. The
     *                                queues page's own header says failed jobs
     *                                "may originate from a different workspace
     *                                than the one the operator is currently
     *                                active in". Switching cannot invalidate
     *                                data that was never scoped.
     *   PLATFORM_WITH_TENANT_FILTER  platform-wide with a filter the operator
     *                                sets explicitly, which is not the active
     *                                workspace.
     *
     * Both are NOT_APPLICABLE, and the reason is the disposition's, not one
     * invented here. Anything else that reads the active workspace owes the
     * state — and five of them did: analytics, automation, exports, recovery
     * and reliability all read one workspace and dropped no late response, so
     * a switch mid-read applied workspace A's answer to workspace B.
     * ------------------------------------------------------------------ */
    case "STALE": {
      if (!workspaceScoped) {
        return "platform-scoped surface: no active workspace to change under a read in flight";
      }
      const d = scopeDisposition(shape.route);
      if (d === "PLATFORM_AUDIT_CONTEXT") {
        return "reviewed as PLATFORM_AUDIT_CONTEXT in adminScopeDispositions.ts: the rows are platform-wide and the teamId is only what an action is recorded against, so a workspace switch cannot make this read stale";
      }
      if (d === "PLATFORM_WITH_TENANT_FILTER") {
        return "reviewed as PLATFORM_WITH_TENANT_FILTER in adminScopeDispositions.ts: the read is platform-wide with a filter the operator sets explicitly, which is not the active workspace";
      }
      return null;
    }
    case "UNAVAILABLE":
      return hasOptionalCapability
        ? null
        : "every capability this page fronts is always present in a deployment that has the console";

    /* NOT_MEASURED is about an INSTRUMENTED signal that is absent. A page
     * with no metric has no signal to be missing; a table row is either
     * there or it is not, which is EMPTY. */
    case "NOT_MEASURED":
      return hasKpi ? null : "no measured signal on this page: its content is records, not metrics";

    /* PARTIAL means SOME sources answered. A page reading one endpoint is
     * either loaded or in ERROR; there is no half of one read. */
    case "PARTIAL":
      if (reads === 0) {
        return "content is compiled into the page: there are no sources to answer in part";
      }
      return reads > 1
        ? null
        : "reads a single source: there is no subset of one to be partial";

    default:
      return null;
  }
  return null;
}

mkdirSync("docs/admin/artifacts", { recursive: true });

const rows = [];
const gaps = [];

for (const route of ROUTES) {
  const files = filesFor(route);
  if (files.length === 0) {
    gaps.push(`${route}: no source file resolved`);
    continue;
  }
  /* Comments removed before anything is measured. See `stripComments`: the
     patterns claim to match code, and until this call they did not. */
  const src = stripComments(
    files.map((f) => readFileSync(f, "utf8")).join("\n"),
  );

  const shape = {
    /* The route itself, so `reasonFor` can consult the reviewed scope
       disposition for it. */
    route,
    hasTable: /<DataTable|<table|adm-table/.test(src),
    hasFilter: /<FilterBar|statusFilter|severityFilter|<select/.test(src),
    hasMutation: /method: "(POST|PUT|PATCH|DELETE)"/.test(src),
    hasKpi: /<AdmKpi|<MetricTile|AdminStat|app-metric/.test(src),
    isStatic: /RUNBOOK_INDEX|catalog\.generated|index\.generated/.test(src),
    /* A page is WORKSPACE-scoped when it READS the active workspace. Those
       are the ones a plan can gate, an operator can be refused within, and a
       workspace switch can make stale. The rest are platform surfaces.

       GATE B — THIS TEST USED TO MATCH AN OUTBOUND LINK.
       It read `/useTeamId|useTenantGuard|teamId=\$\{|\?teamId=/`, and the last
       two alternatives match

           href={`/admin/operations?teamId=${r.id}`}

       which is a page sending a reader somewhere else. `/admin/workspaces` and
       `/admin/workspaces/:id` are the PLATFORM's workspace directory and
       detail — they list every workspace and read no active one — and both
       were classified workspace-scoped on the strength of that link alone,
       which then demanded STALE, DENIED and PLAN_GATED states neither page can
       reach. Six of the 128 gaps were that one regex.

       AND SENDING A teamId IS NOT KNOWING THE ACTIVE ONE.
       `/admin/evidence-ops/records` holds `useState(params.get("teamId"))` —
       a workspace the operator typed or arrived with, used as a FILTER over
       platform-wide records. A page can only learn the ACTIVE workspace from
       one of the hooks below; a teamId from anywhere else is a filter, a row
       or a route parameter, and a workspace switch cannot invalidate it.

       So the test is the hooks, and only the hooks. */
    workspaceScoped:
      /\b(useTeamId|useTenantGuard|useActiveWorkspaceId|useActiveSpaceId)\b/.test(
        src,
      ),
    /* The endpoint PATHS this route requests, for the plan-gate lookup.
       Parameter placeholders are stripped so a path compares against the
       API's own registration by prefix. */
    requestPaths: [
      ...new Set(
        [...src.matchAll(/apiFetch\(\s*[`"']([^`"'?]+)/g)].map((m) =>
          m[1].replace(/\$\{[^}]*\}/g, "").replace(/\/+$/, ""),
        ),
      ),
    ],
    /* Does anything here re-ask a question it has already answered? A poll, a
       Refresh control the operator can press, or a re-read issued after a
       mutation. Not "does the page load" — see the REFRESHING reason. */
    rereadMechanism:
      /setInterval\(|isRefetching|refresh|Refresh|await load\(\)|void load\(\)|await reload\(|void reload\(/.test(
        src,
      ),
    /* What the reads ARE keyed to, so the reason can name them rather than
       assert a generality. The dependency arrays of the effects and callbacks
       that issue requests, minus the hooks and functions among them. */
    readKeys: (() => {
      const HOOKISH =
        /^(addToast|confirm|stamp|isStale|stepUp|load|reload|router|apiFetch|setState|notify)/;
      const keys = new Set();
      for (const m of src.matchAll(/\}\s*,\s*\[([^\]]*)\]\s*\)/g)) {
        const before = src.slice(Math.max(0, m.index - 4000), m.index);
        if (!/apiFetch\(/.test(before)) continue;
        /* The dep array must belong to the hook that ISSUES the request, not
           to a `useMemo` that happens to sit after one — otherwise a memo
           over the loaded data reports the data itself as a read key. */
        const opener = [...before.matchAll(/use(Effect|Callback|Memo)\(/g)].pop();
        if (!opener || opener[1] === "Memo") continue;
        if (!/apiFetch\(/.test(before.slice(opener.index))) continue;
        for (const raw of m[1].split(",")) {
          const id = raw.trim().split(".")[0];
          if (!id || HOOKISH.test(id)) continue;
          if (/^[A-Za-z_$][\w$]*$/.test(id)) keys.add(id);
        }
      }
      return [...keys];
    })(),
    /* Distinct endpoints read. PARTIAL needs more than one. */
    reads: new Set(
      [...src.matchAll(/apiFetch\(\s*[`"']([^`"'?]+)/g)].map((m) =>
        m[1].replace(/\$\{[^}]*\}/g, ":x"),
      ),
    ).size,
    /* A capability that a deployment may simply not have configured — an
       object-lock bucket, a KMS signer, an OTS anchor, an IdP.

       GATE B — THIS MATCHED FIELD NAMES. The pattern ran over the whole
       source, so `webhookSentAt: string | null` made `/admin/contact-sales`
       front a webhook capability, and a user row's auth `provider` column made
       `/admin/users` front an identity provider. Neither page has anything a
       deployment can fail to configure; both were then required to render an
       UNAVAILABLE state that cannot occur.

       A page FRONTS a capability when the capability is the subject of one of
       its requests, or when the page names it to the reader in prose. A word
       inside a camelCase identifier or a type field is neither. */
    hasOptionalCapability: (() => {
      const CAP =
        /object-?lock|\bkms\b|\bsigner|opentimestamps|\bots\b|\bsso\b|\bscim\b|\bidp\b|\bwebhook|\btransport\b|\bextension\b|pgvector/i;
      const requestPaths = [...src.matchAll(/apiFetch\(\s*[`"']([^`"'?]+)/g)].map(
        (m) => m[1],
      );
      if (requestPaths.some((p) => CAP.test(p))) return true;
      // Named to the reader: the capability word inside a rendered sentence,
      // i.e. a string literal of more than a couple of words.
      const prose = [...src.matchAll(/["'`]([^"'`\n]{12,160})["'`]/g)].map(
        (m) => m[1],
      );
      return prose.some((s) => CAP.test(s) && /\s/.test(s));
    })(),
  };

  const row = { route, files: files.length, shape, states: {} };
  for (const [state, patterns] of Object.entries(EVIDENCE)) {
    /*
      A PATTERN MAY BE A PREDICATE.

      Some states are STRUCTURAL rather than textual — PARTIAL is "each read
      owns its failure", which is a property of the code's shape and not a
      word it contains. A regex cannot ask "are there two distinct setters
      called from separate catch blocks", so an entry may be a function of the
      source instead. Everything else stays a regex.
    */
    const hit = patterns.find((p) =>
      typeof p === "function" ? p(src) : p.test(src),
    );
    if (hit) {
      row.states[state] = { verdict: "HANDLED", evidence: String(hit) };
      continue;
    }
    const reason = reasonFor(state, shape);
    if (reason) {
      row.states[state] = { verdict: "NOT_APPLICABLE", reason };
    } else {
      row.states[state] = { verdict: "UNHANDLED" };
      gaps.push(`${route}: ${state}`);
    }
  }
  rows.push(row);
}

const STATES = Object.keys(EVIDENCE);
writeFileSync(
  "docs/admin/artifacts/state-matrix.json",
  JSON.stringify({ states: STATES, rows, gaps }, null, 2),
  "utf8",
);

/* -------------------------------------------------------------- report --- */
const tally = Object.fromEntries(
  STATES.map((s) => [
    s,
    {
      handled: rows.filter((r) => r.states[s].verdict === "HANDLED").length,
      na: rows.filter((r) => r.states[s].verdict === "NOT_APPLICABLE").length,
      unhandled: rows.filter((r) => r.states[s].verdict === "UNHANDLED").length,
    },
  ]),
);

console.log(`routes: ${rows.length}   states: ${STATES.length}\n`);
console.log("state              handled  n/a  UNHANDLED");
for (const [s, t] of Object.entries(tally)) {
  console.log(
    `${s.padEnd(18)} ${String(t.handled).padStart(7)} ${String(t.na).padStart(4)} ${String(t.unhandled).padStart(10)}${t.unhandled ? "  <--" : ""}`,
  );
}
console.log(`\ncells: ${rows.length * STATES.length}`);
console.log(`unhandled cells: ${gaps.length}`);
if (gaps.length) {
  console.log("\nfirst 30:");
  for (const g of gaps.slice(0, 30)) console.log("  " + g);
}
console.log("\nartifact: docs/admin/artifacts/state-matrix.json");
process.exit(gaps.length ? 1 : 0);
